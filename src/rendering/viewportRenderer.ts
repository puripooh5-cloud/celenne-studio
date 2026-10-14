/**
 * Viewport renderers. WebGL2 is the primary path (GPU zoom/pan/rotation, texture tile cache,
 * shader checkerboard and 3D-LUT display color management); Canvas2D is the fallback.
 */
import type { RenderEngine, DisplayTile, LiftSetName } from './renderEngine';
import { DISPLAY_TILE } from './renderEngine';
import type { ViewTransform } from './viewport';
import { apply, Affine, multiply } from '../image-engine/matrix';

export interface DisplayLUT {
  size: number;
  /** RGB8 triplets, red fastest. */
  data: Uint8Array;
  id: string;
}

export interface RenderFrameOptions {
  pasteboard: [number, number, number];
  checkerSize: number;
  checkerLight: [number, number, number];
  checkerDark: [number, number, number];
  lut: DisplayLUT | null;
}

export interface ViewportRenderer {
  readonly kind: 'webgpu' | 'webgl2' | 'canvas2d';
  /** Set when the GPU device was lost; the view recreates its renderer. */
  readonly lost?: boolean;
  resize(cssW: number, cssH: number, dpr: number): void;
  /** Draws a frame; returns true when every visible tile was up to date. */
  render(engine: RenderEngine, view: ViewTransform, opts: RenderFrameOptions): boolean;
  dispose(): void;
  textureBytes(): number;
}

interface VisibleTile {
  level: number;
  tx: number;
  ty: number;
}

/** Determines visible tiles at the current level (and requests them from the engine). */
export function planTiles(engine: RenderEngine, view: ViewTransform, cssW: number, cssH: number): { level: number; tiles: VisibleTile[]; complete: boolean; draw: DisplayTile[] } {
  const doc = engine.doc;
  const maxLevel = engine.maxLevel();
  const level = view.level(maxLevel);
  const s = 1 << level;
  const vis = view.visibleDocRect(cssW, cssH);
  const x0 = Math.max(0, vis.x), y0 = Math.max(0, vis.y);
  const x1 = Math.min(doc.width, vis.x + vis.w), y1 = Math.min(doc.height, vis.y + vis.h);
  const tiles: VisibleTile[] = [];
  if (x1 <= x0 || y1 <= y0) return { level, tiles, complete: true, draw: [] };
  const ts = DISPLAY_TILE * s;
  const tx0 = Math.floor(x0 / ts), ty0 = Math.floor(y0 / ts), tx1 = Math.floor((x1 - 1) / ts), ty1 = Math.floor((y1 - 1) / ts);
  const center = view.screenToDoc(cssW / 2, cssH / 2);
  let complete = true;
  const draw: DisplayTile[] = [];
  const fallback = new Map<string, DisplayTile>();
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      tiles.push({ level, tx, ty });
      const t = engine.getTile(level, tx, ty);
      const cx = (tx + 0.5) * ts, cy = (ty + 0.5) * ts;
      const prio = Math.hypot(cx - center.x, cy - center.y) / ts;
      if (!t || t.stale) {
        engine.request(level, tx, ty, prio);
        complete = false;
      }
      if (!t) {
        // Progressive: show the closest coarser level that is available.
        for (let l = level + 1; l <= maxLevel; l++) {
          const sh = l - level;
          const ft = engine.getTile(l, tx >> sh, ty >> sh);
          if (ft) {
            fallback.set(`${l}:${tx >> sh}:${ty >> sh}`, ft);
            break;
          }
        }
      } else draw.push(t);
    }
  }
  engine.lastVisible = { level, tiles: tiles.map((t) => [t.tx, t.ty]) };
  return { level, tiles, complete, draw: [...[...fallback.values()].sort((a, b) => b.level - a.level), ...draw] };
}

export interface DrawItem {
  tile: DisplayTile;
  /** Texture cache key (lift sets have their own textures). */
  key: string;
  /** Offset in document px (moving set during a lift). */
  ox: number;
  oy: number;
  /** Only this document-px region of the tile is drawn (cells of a partly live lift). */
  clip?: { x: number; y: number; w: number; h: number };
}

/**
 * Where a draw item goes: its document-px origin, pyramid scale and the visible part of the tile in
 * tile pixels (clipped to the canvas and to the item's clip). null = nothing to draw.
 */
export function itemPlacement(it: DrawItem, doc: { width: number; height: number }): { x: number; y: number; s: number; cx0: number; cy0: number; cx1: number; cy1: number; whole: boolean } | null {
  const t = it.tile;
  const s = 1 << t.level;
  const x = t.tx * DISPLAY_TILE * s + it.ox, y = t.ty * DISPLAY_TILE * s + it.oy;
  if (!it.ox && !it.oy && !it.clip) return { x, y, s, cx0: 0, cy0: 0, cx1: t.w, cy1: t.h, whole: true };
  let X0 = 0, Y0 = 0, X1 = doc.width, Y1 = doc.height;
  if (it.clip) { X0 = Math.max(X0, it.clip.x); Y0 = Math.max(Y0, it.clip.y); X1 = Math.min(X1, it.clip.x + it.clip.w); Y1 = Math.min(Y1, it.clip.y + it.clip.h); }
  const cx0 = Math.max(0, (X0 - x) / s), cy0 = Math.max(0, (Y0 - y) / s);
  const cx1 = Math.min(t.w, (X1 - x) / s), cy1 = Math.min(t.h, (Y1 - y) / s);
  if (cx1 <= cx0 || cy1 <= cy0) return null;
  return { x, y, s, cx0, cy0, cx1, cy1, whole: false };
}

function tileRange(doc: { width: number; height: number }, rect: { x: number; y: number; w: number; h: number }, ts: number) {
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
  const x1 = Math.min(doc.width, rect.x + rect.w), y1 = Math.min(doc.height, rect.y + rect.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { tx0: Math.floor(x0 / ts), ty0: Math.floor(y0 / ts), tx1: Math.floor((x1 - 1) / ts), ty1: Math.floor((y1 - 1) / ts) };
}

/** What to draw this frame: exact tiles, or the lifted sets while a layer drag is in progress. */
export function framePlan(engine: RenderEngine, view: ViewTransform, cssW: number, cssH: number): { draw: DrawItem[]; complete: boolean } {
  const lift = engine.lift?.active ? engine.lift : null;
  if (lift?.settling) {
    const plan = planTiles(engine, view, cssW, cssH);
    if (plan.complete) engine.finishLift();
    else return { draw: liftDraws(engine, view, cssW, cssH), complete: false };
  }
  if (lift && !lift.settling) return { draw: liftDraws(engine, view, cssW, cssH), complete: true };
  const plan = planTiles(engine, view, cssW, cssH);
  return { draw: plan.draw.map((t) => ({ tile: t, key: `${t.level}:${t.tx}:${t.ty}`, ox: 0, oy: 0 })), complete: plan.complete };
}

function liftDraws(engine: RenderEngine, view: ViewTransform, cssW: number, cssH: number): DrawItem[] {
  const lift = engine.lift!;
  const level = view.level(engine.maxLevel());
  const ts = DISPLAY_TILE * (1 << level);
  const vis = view.visibleDocRect(cssW, cssH);
  const out: DrawItem[] = [];
  if (lift.live) return liveLiftDraws(engine, level, ts, vis);
  const add = (set: LiftSetName, rect: typeof vis, ox: number, oy: number) => {
    const rg = tileRange(engine.doc, rect, ts);
    if (!rg) return;
    for (let ty = rg.ty0; ty <= rg.ty1; ty++)
      for (let tx = rg.tx0; tx <= rg.tx1; tx++) {
        const t = engine.liftTile(set, level, tx, ty);
        if (t) out.push({ tile: t, key: `${set}:${level}:${tx}:${ty}`, ox, oy });
      }
  };
  add('below', vis, 0, 0);
  add('moving', { x: vis.x - lift.dx, y: vis.y - lift.dy, w: vis.w, h: vis.h }, lift.dx, lift.dy);
  add('above', vis, 0, 0);
  return out;
}

/**
 * A partly live lift, drawn cell by cell: live cells show the exact tile (re-rendered as the layers
 * move), the others the stacked sets clipped to the cell.
 */
function liveLiftDraws(engine: RenderEngine, level: number, ts: number, vis: { x: number; y: number; w: number; h: number }): DrawItem[] {
  const lift = engine.lift!;
  const out: DrawItem[] = [];
  const rg = tileRange(engine.doc, vis, ts);
  if (!rg) return out;
  const center = { x: vis.x + vis.w / 2, y: vis.y + vis.h / 2 };
  for (let ty = rg.ty0; ty <= rg.ty1; ty++)
    for (let tx = rg.tx0; tx <= rg.tx1; tx++) {
      const cell = { x: tx * ts, y: ty * ts, w: ts, h: ts };
      if (engine.isLiveTile(level, tx, ty)) {
        const t = engine.getTile(level, tx, ty);
        if (!t || t.stale) engine.request(level, tx, ty, Math.hypot(cell.x + ts / 2 - center.x, cell.y + ts / 2 - center.y) / ts - 1000);
        if (t) { out.push({ tile: t, key: `${level}:${tx}:${ty}`, ox: 0, oy: 0 }); continue; }
      }
      const below = engine.liftTile('below', level, tx, ty);
      if (below) out.push({ tile: below, key: `below:${level}:${tx}:${ty}`, ox: 0, oy: 0 });
      const src = tileRange(engine.doc, { x: cell.x - lift.dx, y: cell.y - lift.dy, w: ts, h: ts }, ts);
      if (src)
        for (let my = src.ty0; my <= src.ty1; my++)
          for (let mx = src.tx0; mx <= src.tx1; mx++) {
            const m = engine.liftTile('moving', level, mx, my);
            if (m) out.push({ tile: m, key: `moving:${level}:${mx}:${my}`, ox: lift.dx, oy: lift.dy, clip: cell });
          }
      const above = engine.liftTile('above', level, tx, ty);
      if (above) out.push({ tile: above, key: `above:${level}:${tx}:${ty}`, ox: 0, oy: 0 });
    }
  return out;
}

// ---------------------------------------------------------------------------------------------
// WebGL2
// ---------------------------------------------------------------------------------------------
const VS = `#version 300 es
in vec2 aPos; in vec2 aUV;
uniform vec2 uViewport;
out vec2 vUV;
void main() {
  vUV = aUV;
  vec2 ndc = aPos / uViewport * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}`;

const FS_TILE = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUV;
uniform sampler2D uTex;
uniform sampler3D uLut;
uniform float uLutSize;
uniform bool uUseLut;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUV);
  vec3 rgb = c.rgb;
  if (uUseLut) {
    vec3 p = rgb * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    rgb = texture(uLut, p).rgb;
  }
  outColor = vec4(rgb * c.a, c.a);
}`;

const FS_CHECKER = `#version 300 es
precision highp float;
uniform float uSize;
uniform vec3 uLight; uniform vec3 uDark;
uniform float uDpr;
out vec4 outColor;
void main() {
  vec2 p = floor(gl_FragCoord.xy / (uSize * uDpr));
  float k = mod(p.x + p.y, 2.0);
  outColor = vec4(mix(uLight, uDark, k), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.bindAttribLocation(p, 1, 'aUV');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}

interface TexEntry {
  tex: WebGLTexture;
  version: number;
  lastUsed: number;
}

export class WebGLViewportRenderer implements ViewportRenderer {
  readonly kind = 'webgl2' as const;
  private gl: WebGL2RenderingContext;
  private tileProg: WebGLProgram;
  private checkerProg: WebGLProgram;
  private vbo: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private textures = new Map<string, TexEntry>();
  private lutTex: WebGLTexture | null = null;
  private lutId = '';
  private clock = 0;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  maxTextures = 384;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.tileProg = compile(gl, VS, FS_TILE);
    this.checkerProg = compile(gl, VS, FS_CHECKER);
    this.vbo = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  static isSupported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch {
      return false;
    }
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private quad(m: Affine, x: number, y: number, w: number, h: number, u1: number, v1: number, u0 = 0, v0 = 0) {
    const p0 = apply(m, x, y), p1 = apply(m, x + w, y), p2 = apply(m, x + w, y + h), p3 = apply(m, x, y + h);
    const d = this.dpr;
    const data = new Float32Array([
      p0.x * d, p0.y * d, u0, v0,
      p1.x * d, p1.y * d, u1, v0,
      p2.x * d, p2.y * d, u1, v1,
      p0.x * d, p0.y * d, u0, v0,
      p2.x * d, p2.y * d, u1, v1,
      p3.x * d, p3.y * d, u0, v1,
    ]);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private ensureLut(lut: DisplayLUT | null) {
    const gl = this.gl;
    if (!lut) return false;
    if (this.lutId === lut.id && this.lutTex) return true;
    if (!this.lutTex) this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, lut.size, lut.size, lut.size, 0, gl.RGB, gl.UNSIGNED_BYTE, lut.data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    this.lutId = lut.id;
    return true;
  }

  private texFor(t: DisplayTile, nearest: boolean, k: string): WebGLTexture {
    const gl = this.gl;
    let e = this.textures.get(k);
    if (!e) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, DISPLAY_TILE, DISPLAY_TILE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      e = { tex, version: -1, lastUsed: 0 };
      this.textures.set(k, e);
    }
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    if (e.version !== t.version) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DISPLAY_TILE, DISPLAY_TILE, gl.RGBA, gl.UNSIGNED_BYTE, t.data);
      e.version = t.version;
    }
    const f = nearest ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    e.lastUsed = ++this.clock;
    return e.tex;
  }

  private evictTextures() {
    if (this.textures.size <= this.maxTextures) return;
    const sorted = [...this.textures.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < sorted.length - this.maxTextures; i++) {
      this.gl.deleteTexture(sorted[i][1].tex);
      this.textures.delete(sorted[i][0]);
    }
  }

  render(engine: RenderEngine, view: ViewTransform, opts: RenderFrameOptions): boolean {
    const gl = this.gl;
    const doc = engine.doc;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const [pr, pg, pb] = opts.pasteboard;
    gl.clearColor(pr, pg, pb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    const m = view.matrix();
    // Checkerboard under the canvas.
    gl.disable(gl.BLEND);
    gl.useProgram(this.checkerProg);
    gl.uniform2f(gl.getUniformLocation(this.checkerProg, 'uViewport'), this.canvas.width, this.canvas.height);
    gl.uniform1f(gl.getUniformLocation(this.checkerProg, 'uSize'), opts.checkerSize);
    gl.uniform1f(gl.getUniformLocation(this.checkerProg, 'uDpr'), this.dpr);
    gl.uniform3fv(gl.getUniformLocation(this.checkerProg, 'uLight'), opts.checkerLight);
    gl.uniform3fv(gl.getUniformLocation(this.checkerProg, 'uDark'), opts.checkerDark);
    this.quad(m, 0, 0, doc.width, doc.height, 1, 1);
    // Tiles.
    const plan = framePlan(engine, view, this.cssW, this.cssH);
    this.dropLiftTextures(!!engine.lift);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.tileProg);
    gl.uniform2f(gl.getUniformLocation(this.tileProg, 'uViewport'), this.canvas.width, this.canvas.height);
    const useLut = this.ensureLut(opts.lut);
    gl.uniform1i(gl.getUniformLocation(this.tileProg, 'uUseLut'), useLut ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.tileProg, 'uLutSize'), opts.lut?.size ?? 2);
    gl.uniform1i(gl.getUniformLocation(this.tileProg, 'uTex'), 0);
    gl.uniform1i(gl.getUniformLocation(this.tileProg, 'uLut'), 1);
    if (useLut) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    }
    gl.activeTexture(gl.TEXTURE0);
    for (const d of plan.draw) {
      const t = d.tile;
      // Offset (lifted) tiles are clipped to the canvas and to their cell, in tile pixel units.
      const p = itemPlacement(d, doc);
      if (!p) continue;
      const s = p.s;
      const nearest = view.zoom * s >= 1.999 || (view.zoom * s >= 0.999 && view.rotation === 0);
      this.texFor(t, nearest, d.key);
      const tm = multiply(m, [s, 0, 0, s, p.x, p.y]);
      if (p.whole) this.quad(tm, 0, 0, t.w, t.h, t.w / DISPLAY_TILE, t.h / DISPLAY_TILE);
      else this.quad(tm, p.cx0, p.cy0, p.cx1 - p.cx0, p.cy1 - p.cy0, p.cx1 / DISPLAY_TILE, p.cy1 / DISPLAY_TILE, p.cx0 / DISPLAY_TILE, p.cy0 / DISPLAY_TILE);
    }
    this.evictTextures();
    return plan.complete;
  }

  /** Lift-set textures are released as soon as the lift ends. */
  private dropLiftTextures(lifting: boolean) {
    if (lifting) { this.hadLift = true; return; }
    if (!this.hadLift) return;
    this.hadLift = false;
    for (const [k, e] of this.textures) if (/^(below|moving|above):/.test(k)) { this.gl.deleteTexture(e.tex); this.textures.delete(k); }
  }
  private hadLift = false;

  textureBytes(): number {
    return this.textures.size * DISPLAY_TILE * DISPLAY_TILE * 4;
  }

  dispose(): void {
    for (const e of this.textures.values()) this.gl.deleteTexture(e.tex);
    this.textures.clear();
    if (this.lutTex) this.gl.deleteTexture(this.lutTex);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// ---------------------------------------------------------------------------------------------
// Canvas2D fallback
// ---------------------------------------------------------------------------------------------
export class Canvas2DViewportRenderer implements ViewportRenderer {
  readonly kind = 'canvas2d' as const;
  private ctx: CanvasRenderingContext2D;
  private cache = new Map<string, { canvas: OffscreenCanvas | HTMLCanvasElement; version: number; lut: string; lastUsed: number }>();
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private clock = 0;
  private checker: CanvasPattern | null = null;
  private checkerKey = '';

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private tileCanvas(t: DisplayTile, lut: DisplayLUT | null, k: string) {
    let e = this.cache.get(k);
    const lutId = lut?.id ?? '';
    if (!e || e.version !== t.version || e.lut !== lutId) {
      const c = e?.canvas ?? (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(DISPLAY_TILE, DISPLAY_TILE) : Object.assign(document.createElement('canvas'), { width: DISPLAY_TILE, height: DISPLAY_TILE }));
      const cx = c.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
      let data = t.data;
      if (lut) {
        data = new Uint8ClampedArray(t.data);
        applyLutCPU(data, lut);
      }
      cx.putImageData(new ImageData(new Uint8ClampedArray(data), DISPLAY_TILE, DISPLAY_TILE), 0, 0);
      e = { canvas: c, version: t.version, lut: lutId, lastUsed: 0 };
      this.cache.set(k, e);
    }
    e.lastUsed = ++this.clock;
    return e.canvas;
  }

  render(engine: RenderEngine, view: ViewTransform, opts: RenderFrameOptions): boolean {
    const ctx = this.ctx;
    const d = this.dpr;
    const doc = engine.doc;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = `rgb(${opts.pasteboard.map((v) => Math.round(v * 255)).join(',')})`;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const m = view.matrix();
    const key = `${opts.checkerSize}:${opts.checkerLight}:${opts.checkerDark}:${d}`;
    if (!this.checker || this.checkerKey !== key) {
      const sz = Math.max(1, Math.round(opts.checkerSize * d));
      const c = document.createElement('canvas');
      c.width = c.height = sz * 2;
      const cc = c.getContext('2d')!;
      cc.fillStyle = `rgb(${opts.checkerLight.map((v) => Math.round(v * 255)).join(',')})`;
      cc.fillRect(0, 0, sz * 2, sz * 2);
      cc.fillStyle = `rgb(${opts.checkerDark.map((v) => Math.round(v * 255)).join(',')})`;
      cc.fillRect(sz, 0, sz, sz);
      cc.fillRect(0, sz, sz, sz);
      this.checker = ctx.createPattern(c, 'repeat');
      this.checkerKey = key;
    }
    // Checkerboard clipped to the canvas quad (screen-space pattern).
    ctx.save();
    ctx.beginPath();
    const corners = [apply(m, 0, 0), apply(m, doc.width, 0), apply(m, doc.width, doc.height), apply(m, 0, doc.height)];
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x * d, p.y * d) : ctx.moveTo(p.x * d, p.y * d)));
    ctx.closePath();
    ctx.fillStyle = this.checker!;
    ctx.fill();
    ctx.clip();
    const plan = framePlan(engine, view, this.cssW, this.cssH);
    if (!engine.lift) for (const k of this.cache.keys()) if (/^(below|moving|above):/.test(k)) this.cache.delete(k);
    for (const dItem of plan.draw) {
      const t = dItem.tile;
      const p = itemPlacement(dItem, doc);
      if (!p) continue;
      const s = p.s;
      const c = this.tileCanvas(t, opts.lut, dItem.key);
      const tm = multiply(m, [s, 0, 0, s, p.x, p.y]);
      ctx.setTransform(tm[0] * d, tm[1] * d, tm[2] * d, tm[3] * d, tm[4] * d, tm[5] * d);
      ctx.imageSmoothingEnabled = view.zoom * s < 1.999;
      const w = p.cx1 - p.cx0, h = p.cy1 - p.cy0;
      ctx.drawImage(c as CanvasImageSource, p.cx0, p.cy0, w, h, p.cx0, p.cy0, w, h);
    }
    ctx.restore();
    if (this.cache.size > 256) {
      const sorted = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (let i = 0; i < sorted.length - 256; i++) this.cache.delete(sorted[i][0]);
    }
    return plan.complete;
  }

  textureBytes(): number {
    return this.cache.size * DISPLAY_TILE * DISPLAY_TILE * 4;
  }

  dispose(): void {
    this.cache.clear();
  }
}

export function applyLutCPU(data: Uint8ClampedArray, lut: DisplayLUT): void {
  const n = lut.size, t = lut.data;
  for (let i = 0; i < data.length; i += 4) {
    const fx = (data[i] / 255) * (n - 1), fy = (data[i + 1] / 255) * (n - 1), fz = (data[i + 2] / 255) * (n - 1);
    const x = Math.round(fx), y = Math.round(fy), z = Math.round(fz);
    const o = ((z * n + y) * n + x) * 3;
    data[i] = t[o]; data[i + 1] = t[o + 1]; data[i + 2] = t[o + 2];
  }
}

export function createViewportRenderer(canvas: HTMLCanvasElement, preferGPU: boolean): ViewportRenderer {
  if (preferGPU) {
    try {
      return new WebGLViewportRenderer(canvas);
    } catch (e) {
      console.warn('WebGL2 unavailable, falling back to Canvas2D', e);
    }
  }
  return new Canvas2DViewportRenderer(canvas);
}

export type RendererChoice = 'auto' | 'webgpu' | 'webgl2' | 'canvas2d';

/**
 * Creates the viewport renderer for a fresh canvas: WebGPU (with the shared device) when chosen
 * or on Auto, else WebGL 2, else Canvas 2D. A canvas keeps its first context type, so the caller
 * passes `newCanvas` to get another canvas when a choice fails after touching the canvas.
 */
export async function createViewportRendererAsync(canvas: HTMLCanvasElement, choice: RendererChoice, newCanvas: () => HTMLCanvasElement): Promise<{ renderer: ViewportRenderer; canvas: HTMLCanvasElement }> {
  if (choice === 'auto' || choice === 'webgpu') {
    const { acquireGpu } = await import('../gpu/device');
    const { WebGPUViewportRenderer } = await import('./webgpuRenderer');
    const gpu = await acquireGpu();
    if (gpu) {
      try {
        return { renderer: new WebGPUViewportRenderer(canvas, gpu.device), canvas };
      } catch (e) {
        console.warn('WebGPU renderer unavailable, falling back to WebGL 2', e);
        canvas = newCanvas();
      }
    }
  }
  return { renderer: createViewportRenderer(canvas, choice !== 'canvas2d'), canvas };
}
