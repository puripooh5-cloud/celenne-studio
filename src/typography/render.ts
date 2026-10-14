/**
 * Text layout and rasterization. Horizontal text is drawn by Celenne's own engine
 * (engineRender.ts) once HarfBuzz and the installed fonts are available; this file's Canvas 2D
 * path (OffscreenCanvas text shaping) draws vertical text, text on a path, and any text while the
 * engine or one of its fonts is still loading.
 *
 * Layout model: paragraphs → words → lines. Point text wraps only at explicit line breaks;
 * paragraph text wraps to the box width. Style runs may change font, size, color, tracking and
 * baseline per character range. The result is rendered through the layer's text transform.
 */
import type { CharacterStyle, ParagraphStyle, TextData } from './types';
import { fonts } from './fonts';
import { apply, Affine, multiply } from '../image-engine/matrix';
import type { Rect } from '../image-engine/rect';
import { roundOut } from '../image-engine/rect';
import { meshBounds, meshWarpRegion, presetMap, sampleMesh, WARP_STYLES, WarpPreset, WarpStyle } from '../image-engine/warp';
import { TiledRaster } from '../image-engine/tiledRaster';
import { flattenTextPath, pointAtDistance, spanOnFlat } from './pathText';
import { appFaces, engineFontsReady } from './engine/appFonts';
import { drawEngineLayout, engineHandles, inkBounds, renderEngineText } from './engineRender';
import { layoutEngine } from './engine/layout';

type Ctx = OffscreenCanvasRenderingContext2D;

interface Glyphs {
  text: string;
  style: CharacterStyle;
  width: number;
  ascent: number;
  descent: number;
}

interface Line {
  pieces: Glyphs[];
  width: number;
  ascent: number;
  descent: number;
  lineHeight: number;
  para: ParagraphStyle;
  lastOfParagraph: boolean;
  spaces: number;
}

/** A vertical-text piece: one upright character, or a run of rotated (sideways) characters. */
interface VPiece {
  text: string;
  style: CharacterStyle;
  /** Column centre line and top of the piece, in text space. */
  x: number;
  y: number;
  upright: boolean;
  advance: number;
}

/** A glyph placed on a path: centre of its baseline and the tangent angle. */
interface PGlyph {
  text: string;
  style: CharacterStyle;
  x: number;
  y: number;
  angle: number;
  advance: number;
}

export interface TextLayout {
  lines: Line[];
  /** Type on a path: the placed glyphs. */
  onPath?: PGlyph[];
  /** Vertical orientation: the placed pieces (columns run right to left). */
  vertical?: VPiece[];
  /** Text-space bounds. */
  bounds: { x: number; y: number; w: number; h: number };
  /** Baseline Y of the first line in text space (point text origin is on the first baseline). */
  firstBaseline: number;
}

export function fontCss(s: CharacterStyle, sizeOverride?: number): string {
  const size = sizeOverride ?? s.fontSize;
  const fam = fonts.isAvailable(s.postScriptName ?? '', s.fontFamily) ? s.fontFamily : fonts.substitute(s.fontFamily, s.fontWeight);
  const italic = s.italic ? 'italic ' : '';
  return `${italic}${Math.round(s.fontWeight)} ${Math.max(0.5, size)}px "${fam}", sans-serif`;
}

function effectiveSize(s: CharacterStyle): number {
  return s.baseline === 'normal' ? s.fontSize : s.fontSize * 0.58;
}

function applyCase(t: string, s: CharacterStyle): string {
  return s.textCase === 'allCaps' ? t.toUpperCase() : t;
}

function setFont(ctx: Ctx, s: CharacterStyle) {
  ctx.font = fontCss(s, effectiveSize(s));
  const c = ctx as unknown as { letterSpacing?: string; fontKerning?: string; fontVariantCaps?: string; textRendering?: string };
  c.letterSpacing = `${(s.tracking / 1000) * s.fontSize}px`;
  c.fontKerning = s.kerning === 'none' ? 'none' : 'normal';
  c.fontVariantCaps = s.textCase === 'smallCaps' ? 'small-caps' : 'normal';
  c.textRendering = s.ligatures ? 'optimizeLegibility' : 'optimizeSpeed';
}

function measure(ctx: Ctx, text: string, s: CharacterStyle): Glyphs {
  setFont(ctx, s);
  const t = applyCase(text, s);
  const m = ctx.measureText(t);
  const size = s.fontSize;
  return {
    text: t,
    style: s,
    width: m.width * s.horizontalScale,
    ascent: (m.fontBoundingBoxAscent ?? size * 0.8) * s.verticalScale,
    descent: (m.fontBoundingBoxDescent ?? size * 0.2) * s.verticalScale,
  };
}

/** Splits text into styled segments per paragraph. */
function paragraphs(t: TextData): { segments: { text: string; style: CharacterStyle }[]; para: ParagraphStyle }[] {
  const out: { segments: { text: string; style: CharacterStyle }[]; para: ParagraphStyle }[] = [];
  const text = t.text;
  // Style lookup per character index.
  const styleAt: CharacterStyle[] = [];
  let idx = 0;
  for (const r of t.runs) for (let i = 0; i < r.length && idx < text.length; i++) styleAt[idx++] = r.style;
  const lastStyle = t.runs[t.runs.length - 1]?.style;
  while (idx < text.length) styleAt[idx++] = lastStyle ?? t.runs[0]?.style;
  const paraAt: ParagraphStyle[] = [];
  idx = 0;
  for (const p of t.paragraphs) for (let i = 0; i < p.length && idx < text.length + 1; i++) paraAt[idx++] = p.style;
  let start = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    const segs: { text: string; style: CharacterStyle }[] = [];
    let cur = '';
    let curStyle: CharacterStyle | undefined;
    for (let i = 0; i < line.length; i++) {
      const st = styleAt[start + i] ?? lastStyle!;
      if (curStyle && st !== curStyle) {
        segs.push({ text: cur, style: curStyle });
        cur = '';
      }
      curStyle = st;
      cur += line[i];
    }
    if (curStyle) segs.push({ text: cur, style: curStyle });
    if (!segs.length) segs.push({ text: '', style: styleAt[start] ?? lastStyle ?? t.runs[0].style });
    out.push({ segments: segs, para: paraAt[start] ?? t.paragraphs[t.paragraphs.length - 1]?.style ?? t.paragraphs[0].style });
    start += line.length + 1;
  }
  return out;
}

/** Characters set upright in vertical text by CJK conventions (kept for reference; Photoshop sets all upright). */
export function isUpright(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3134f);
}

function layoutVertical(ctx: Ctx, t: TextData): TextLayout {
  const box = t.kind === 'paragraph' && t.box ? t.box : null;
  const maxH = box ? box.h : Infinity;
  type Col = { pieces: VPiece[]; length: number; pitch: number; para: ParagraphStyle };
  const cols: Col[] = [];
  for (const p of paragraphs(t)) {
    let col: Col = { pieces: [], length: 0, pitch: 0, para: p.para };
    const push = () => { cols.push(col); col = { pieces: [], length: 0, pitch: 0, para: p.para }; };
    for (const seg of p.segments) {
      const chars = [...applyCase(seg.text, seg.style)];
      let i = 0;
      while (i < chars.length) {
        // Photoshop sets every character upright in vertical text (spaces advance by their width).
        const up = true;
        const j = i + 1;
        const text = chars[i];
        const st = seg.style;
        const track = (st.tracking / 1000) * st.fontSize;
        const advance = /\s/.test(text) ? measure(ctx, text, st).width + track : st.fontSize * st.verticalScale + track;
        if (col.pieces.length && col.length + advance > maxH) push();
        col.pieces.push({ text, style: st, x: 0, y: col.length, upright: up, advance });
        col.length += advance;
        col.pitch = Math.max(col.pitch, st.leading ?? st.fontSize * 1.2);
        i = j;
      }
    }
    if (!col.pitch) col.pitch = p.segments[0].style.leading ?? p.segments[0].style.fontSize * 1.2;
    push();
  }
  // Columns right to left; alignment runs along the column (left = top).
  const out: VPiece[] = [];
  let cx = box ? box.x + box.w - (cols[0]?.pitch ?? 0) / 2 : 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  cols.forEach((c, i) => {
    if (i) cx -= (cols[i - 1].pitch + c.pitch) / 2;
    const a = c.para.align;
    const room = box ? box.h : 0;
    const off = a === 'center' || a === 'justifyCenter' ? (box ? (room - c.length) / 2 : -c.length / 2) : a === 'right' || a === 'justifyRight' ? (box ? room - c.length : -c.length) : 0;
    const y0 = (box ? box.y : 0) + off;
    for (const pc of c.pieces) out.push({ ...pc, x: cx, y: y0 + pc.y });
    minX = Math.min(minX, cx - c.pitch / 2); maxX = Math.max(maxX, cx + c.pitch / 2);
    minY = Math.min(minY, y0); maxY = Math.max(maxY, y0 + Math.max(c.length, 1));
  });
  const bounds = box ? { ...box } : { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  return { lines: [], vertical: out, bounds, firstBaseline: 0 };
}

/** Type on a path: one line of glyphs, each centred on the path at its advance position. */
function layoutOnPath(ctx: Ctx, t: TextData): TextLayout {
  const tp = t.path!;
  const f = flattenTextPath(tp.subpath, tp.flip);
  const glyphs: { text: string; style: CharacterStyle; advance: number }[] = [];
  const paras = paragraphs(t);
  paras.forEach((p, i) => {
    if (i) glyphs.push({ text: ' ', style: p.segments[0].style, advance: measure(ctx, ' ', p.segments[0].style).width });
    for (const seg of p.segments) {
      const chars = [...applyCase(seg.text, seg.style)];
      // Advances from prefix widths keep the font's kerning (short runs; per character otherwise).
      const kern = chars.length <= 400;
      let prev = 0;
      for (let k = 0; k < chars.length; k++) {
        const w = kern ? measure(ctx, chars.slice(0, k + 1).join(''), seg.style).width : measure(ctx, chars[k], seg.style).width;
        glyphs.push({ text: chars[k], style: seg.style, advance: kern ? w - prev : w });
        prev = w;
      }
    }
  });
  const total = glyphs.reduce((a, g) => a + g.advance, 0);
  const align = paras[0]?.para.align ?? 'left';
  const placed: PGlyph[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  if (f) {
    const { a: s0, b: s1 } = spanOnFlat(tp, f);
    let x = align === 'center' || align === 'justifyCenter' ? (s0 + s1) / 2 - total / 2 : align === 'right' || align === 'justifyRight' ? s1 - total : s0;
    for (const g of glyphs) {
      const gx = x;
      x += g.advance;
      // Glyphs that do not fit between the markers are hidden (overflow), as in Photoshop.
      if (gx < s0 - 0.5 || gx + g.advance > s1 + 0.5) continue;
      const pt = pointAtDistance(f, gx + g.advance / 2);
      if (!pt) continue;
      placed.push({ ...g, ...pt });
      const s = g.style;
      const asc = s.fontSize * 0.9 + Math.max(0, s.baselineShift), desc = s.fontSize * 0.3 + Math.max(0, -s.baselineShift);
      const c = Math.cos(pt.angle), sn = Math.sin(pt.angle), hw = g.advance / 2;
      for (const [u, v] of [[-hw, -asc], [hw, -asc], [hw, desc], [-hw, desc]]) grow(pt.x + u * c - v * sn, pt.y + u * sn + v * c);
    }
    for (const m of [s0, s1]) {
      const p0 = pointAtDistance(f, m);
      if (p0) grow(p0.x, p0.y);
    }
  }
  if (minX > maxX) { minX = maxX = 0; minY = maxY = 0; }
  return { lines: [], onPath: placed, bounds: { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }, firstBaseline: 0 };
}

/** Total advance of path text (text-space px). */
export function pathTextAdvance(t: TextData): number {
  if (typeof OffscreenCanvas === 'undefined' || !t.path) return 0;
  const ctx = new OffscreenCanvas(4, 4).getContext('2d') as Ctx;
  let total = 0;
  paragraphs(t).forEach((p, i) => {
    if (i) total += measure(ctx, ' ', p.segments[0].style).width;
    for (const seg of p.segments) total += measure(ctx, applyCase(seg.text, seg.style), seg.style).width;
  });
  return total;
}

export function layoutText(ctx: Ctx, t: TextData): TextLayout {
  if (t.path) return layoutOnPath(ctx, t);
  if (t.orientation === 'vertical') return layoutVertical(ctx, t);
  const maxW = t.kind === 'paragraph' && t.box ? t.box.w : Infinity;
  const lines: Line[] = [];
  for (const p of paragraphs(t)) {
    const avail = maxW - p.para.indentStart - p.para.indentEnd;
    let line: Line = { pieces: [], width: 0, ascent: 0, descent: 0, lineHeight: 0, para: p.para, lastOfParagraph: false, spaces: 0 };
    let firstLine = true;
    const pushLine = () => {
      const lh = Math.max(...line.pieces.map((g) => g.style.leading ?? g.style.fontSize * 1.2), 0) || (p.segments[0].style.leading ?? p.segments[0].style.fontSize * 1.2);
      line.lineHeight = lh;
      if (!line.pieces.length) {
        const g = measure(ctx, ' ', p.segments[0].style);
        line.ascent = g.ascent;
        line.descent = g.descent;
      }
      lines.push(line);
      line = { pieces: [], width: 0, ascent: 0, descent: 0, lineHeight: 0, para: p.para, lastOfParagraph: false, spaces: 0 };
      firstLine = false;
    };
    // Tokenize into words (keeping trailing spaces) with their styles.
    const tokens: { text: string; style: CharacterStyle }[] = [];
    for (const seg of p.segments) {
      const parts = seg.text.match(/\S+\s*|\s+/g) ?? [''];
      for (const w of parts) tokens.push({ text: w, style: seg.style });
    }
    for (const tok of tokens) {
      const g = measure(ctx, tok.text, tok.style);
      const indent = firstLine ? p.para.indentFirst : 0;
      const trimmed = measure(ctx, tok.text.replace(/\s+$/, ''), tok.style).width;
      if (line.pieces.length && line.width + trimmed + indent > avail) pushLine();
      line.pieces.push(g);
      line.width += g.width;
      line.spaces += (tok.text.match(/\s/g) ?? []).length;
      line.ascent = Math.max(line.ascent, g.ascent - (g.style.baselineShift || 0));
      line.descent = Math.max(line.descent, g.descent + (g.style.baselineShift || 0));
    }
    line.lastOfParagraph = true;
    pushLine();
    lines[lines.length - 1].lastOfParagraph = true;
  }
  // Vertical metrics.
  let y = 0;
  let firstBaseline = 0;
  let minX = Infinity, maxX = -Infinity;
  lines.forEach((ln, i) => {
    if (i === 0) {
      firstBaseline = ln.ascent;
      y = 0;
    } else y += ln.lineHeight;
    (ln as Line & { baseline: number }).baseline = firstBaseline + y;
    const w = trimRight(ln);
    const bx = alignX(ln, w, maxW);
    minX = Math.min(minX, bx);
    maxX = Math.max(maxX, bx + (isJustified(ln) && maxW < Infinity ? maxW - ln.para.indentStart - ln.para.indentEnd : w));
    if (ln.lastOfParagraph) y += ln.para.spaceAfter;
  });
  const last = lines[lines.length - 1] as Line & { baseline: number };
  const height = (last?.baseline ?? 0) + (last?.descent ?? 0);
  let bounds: { x: number; y: number; w: number; h: number };
  if (t.kind === 'paragraph' && t.box) bounds = { ...t.box };
  else {
    // Point text: origin at the first baseline, x anchor depends on alignment.
    bounds = { x: minX, y: -firstBaseline, w: Math.max(1, maxX - minX), h: Math.max(1, height) };
  }
  return { lines, bounds, firstBaseline };
}

function trimRight(ln: Line): number {
  if (!ln.pieces.length) return 0;
  const lastPiece = ln.pieces[ln.pieces.length - 1];
  const trailing = lastPiece.text.length - lastPiece.text.replace(/\s+$/, '').length;
  if (!trailing) return ln.width;
  return ln.width - (lastPiece.width * trailing) / Math.max(1, lastPiece.text.length);
}

function isJustified(ln: Line): boolean {
  const a = ln.para.align;
  if (a === 'justifyAll') return true;
  return a.startsWith('justify') && !ln.lastOfParagraph;
}

function alignX(ln: Line, width: number, maxW: number): number {
  const p = ln.para;
  if (maxW === Infinity) {
    // Point text: alignment is relative to the origin.
    if (p.align === 'center' || p.align === 'justifyCenter') return -width / 2;
    if (p.align === 'right' || p.align === 'justifyRight') return -width;
    return p.indentStart;
  }
  const avail = maxW - p.indentStart - p.indentEnd;
  const justified = isJustified(ln);
  if (justified) return p.indentStart;
  const lastAlign = p.align === 'justifyCenter' ? 'center' : p.align === 'justifyRight' ? 'right' : p.align === 'justifyLeft' ? 'left' : p.align;
  if (lastAlign === 'center') return p.indentStart + (avail - width) / 2;
  if (lastAlign === 'right') return p.indentStart + avail - width;
  return p.indentStart;
}

export interface RenderedText {
  /** Straight RGBA8 pixels. */
  data: Uint8ClampedArray;
  /** Document-space rectangle of the pixels. */
  rect: Rect;
  /** Drawn by Celenne's text engine (otherwise by the browser's text renderer). */
  engine: boolean;
  /** The engine was waiting for a font: drawn by the browser for now, worth re-rendering later. */
  pending?: boolean;
}

/** The Warp Text preset of a text layer, or null when it is not warped (or uses an unsupported style). */
export function textWarpPreset(t: TextData): WarpPreset | null {
  const w = t.warp;
  if (t.path) return null;
  if (!w || !w.style || w.style === 'none' || !WARP_STYLES.some((s) => s.id === w.style)) return null;
  const p: WarpPreset = { style: w.style as WarpStyle, bend: w.value ?? 0, horizontalDistortion: w.perspective ?? 0, verticalDistortion: w.perspectiveOther ?? 0, orientation: w.rotate === 'vertical' ? 'vertical' : 'horizontal' };
  return p.bend || p.horizontalDistortion || p.verticalDistortion ? p : null;
}

/** Renders a text layer into document space. Returns null when no canvas is available. */
export function renderText(t: TextData): RenderedText | null {
  const pad = Math.ceil(Math.max(...t.runs.map((r) => r.style.fontSize), 12) * 0.5);
  const warp = textWarpPreset(t);
  let pending = false;
  if (engineFontsReady() && engineHandles(t)) {
    if (warp) {
      const L = layoutEngine(t, appFaces);
      if (!L.missing) {
        const ink = inkBounds(L);
        // Warp Text maps the text's box (paragraph box, or the lines' extent) like Photoshop.
        const b = t.kind === 'paragraph' && t.box ? L.bounds : ink ?? L.bounds;
        return renderWarpedText(t, b, pad, warp, (view, w, h) => drawEngineLayout(L, view, w, h, t.antiAlias), true);
      }
      pending = true;
    } else {
      const e = renderEngineText(t, appFaces);
      if (e === 'pending') pending = true;
      else if (e) return { data: e.data, rect: e.rect, engine: true };
    }
  }
  if (typeof OffscreenCanvas === 'undefined') return null;
  const measureCanvas = new OffscreenCanvas(4, 4);
  const mctx = measureCanvas.getContext('2d') as Ctx;
  const layout = layoutText(mctx, t);
  const b = layout.bounds;
  const m: Affine = t.transform;
  const drawCanvas = (view: Affine, w: number, h: number) => {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d') as Ctx;
    drawLayout(g, t, layout, view);
    return g.getImageData(0, 0, w, h).data;
  };
  if (warp) { const r = renderWarpedText(t, b, pad, warp, drawCanvas, false); return r && { ...r, pending }; }
  const corners = [apply(m, b.x - pad, b.y - pad), apply(m, b.x + b.w + pad, b.y - pad), apply(m, b.x + b.w + pad, b.y + b.h + pad), apply(m, b.x - pad, b.y + b.h + pad)];
  const rect = roundOut(Math.min(...corners.map((c) => c.x)), Math.min(...corners.map((c) => c.y)), Math.max(...corners.map((c) => c.x)), Math.max(...corners.map((c) => c.y)));
  if (rect.w <= 0 || rect.h <= 0 || rect.w * rect.h > 16384 * 16384) return null;
  const canvas = new OffscreenCanvas(rect.w, rect.h);
  const ctx = canvas.getContext('2d') as Ctx;
  drawLayout(ctx, t, layout, multiply([1, 0, 0, 1, -rect.x, -rect.y], m));
  const id = ctx.getImageData(0, 0, rect.w, rect.h);
  if (t.antiAlias === 'none') for (let i = 3; i < id.data.length; i += 4) id.data[i] = id.data[i] >= 128 ? 255 : 0;
  return { data: id.data, rect, engine: false, pending };
}

/** Warp Text: renders flat in text space, then resamples through the warp and the layer transform. */
function renderWarpedText(t: TextData, b: { x: number; y: number; w: number; h: number }, pad: number, preset: WarpPreset, draw: (view: Affine, w: number, h: number) => Uint8ClampedArray, engine: boolean): RenderedText | null {
  const m = t.transform;
  const pb = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  // Render at the transform's scale so the warp does not upsample.
  const k = Math.max(0.05, Math.min(16, Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))));
  const W = Math.ceil(pb.w * k), H = Math.ceil(pb.h * k);
  if (W <= 0 || H <= 0 || W * H > 16384 * 16384) return null;
  const flat = draw([k, 0, 0, k, -pb.x * k, -pb.y * k], W, H);
  const f = new Float32Array(W * H * 4);
  for (let i = 0; i < f.length; i++) f[i] = flat[i] / 255;
  const src = new TiledRaster(4, 32, 0);
  src.writeFloat({ x: 0, y: 0, w: W, h: H }, f);
  const bw = Math.max(1, b.w), bh = Math.max(1, b.h);
  const map = presetMap(preset, bh / bw);
  const mesh = sampleMesh((u, v) => {
    const q = map((pb.x + u * pb.w - b.x) / bw, (pb.y + v * pb.h - b.y) / bh);
    return apply(m, b.x + q.x * bw, b.y + q.y * bh);
  });
  const rect = meshBounds(mesh);
  if (rect.w <= 0 || rect.h <= 0 || rect.w * rect.h > 16384 * 16384) return null;
  const out = meshWarpRegion({ raster: src, ox: 0, oy: 0, bounds: { x: 0, y: 0, w: W, h: H } }, { x: 0, y: 0, w: W, h: H }, mesh, rect);
  const data = new Uint8ClampedArray(out.length);
  for (let i = 0; i < out.length; i++) data[i] = out[i] * 255;
  if (t.antiAlias === 'none') for (let i = 3; i < data.length; i += 4) data[i] = data[i] >= 128 ? 255 : 0;
  return { data, rect, engine };
}

function drawVertical(ctx: Ctx, layout: TextLayout, view: Affine): void {
  for (const pc of layout.vertical ?? []) {
    const s = pc.style;
    setFont(ctx, s);
    ctx.setTransform(view[0], view[1], view[2], view[3], view[4], view[5]);
    ctx.translate(pc.x, pc.y);
    ctx.fillStyle = `rgba(${Math.round(s.color.r * 255)},${Math.round(s.color.g * 255)},${Math.round(s.color.b * 255)},${s.color.a})`;
    if (pc.upright) {
      ctx.scale(s.horizontalScale, s.verticalScale);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
    } else {
      // Sideways (rotated 90° clockwise), centred on the column.
      ctx.rotate(Math.PI / 2);
      ctx.scale(s.horizontalScale, s.verticalScale);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
    }
    if (s.fauxItalic) ctx.transform(1, 0, -0.1763, 1, 0, 0); // 10°, as Photoshop
    ctx.fillText(pc.text, 0, 0);
    if (s.fauxBold) { ctx.lineWidth = s.fontSize * 0.04; ctx.strokeStyle = ctx.fillStyle; ctx.strokeText(pc.text, 0, 0); }
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawOnPath(ctx: Ctx, layout: TextLayout, view: Affine): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const g of layout.onPath ?? []) {
    const s = g.style;
    setFont(ctx, s);
    const shift = s.baseline === 'superscript' ? -s.fontSize * 0.33 : s.baseline === 'subscript' ? s.fontSize * 0.14 : 0;
    ctx.setTransform(view[0], view[1], view[2], view[3], view[4], view[5]);
    ctx.translate(g.x, g.y);
    ctx.rotate(g.angle);
    ctx.translate(-g.advance / 2, -s.baselineShift + shift);
    ctx.scale(s.horizontalScale, s.verticalScale);
    if (s.fauxItalic) ctx.transform(1, 0, -0.1763, 1, 0, 0); // 10°, as Photoshop
    ctx.fillStyle = `rgba(${Math.round(s.color.r * 255)},${Math.round(s.color.g * 255)},${Math.round(s.color.b * 255)},${s.color.a})`;
    ctx.fillText(g.text, 0, 0);
    if (s.fauxBold) { ctx.lineWidth = s.fontSize * 0.04; ctx.strokeStyle = ctx.fillStyle; ctx.strokeText(g.text, 0, 0); }
    const w = g.advance / s.horizontalScale;
    if (s.underline) ctx.fillRect(0, s.fontSize * 0.12, w, Math.max(1, s.fontSize * 0.06));
    if (s.strikethrough) ctx.fillRect(0, -s.fontSize * 0.28, w, Math.max(1, s.fontSize * 0.06));
  }
}

/** Draws the laid-out text; `view` maps text space to canvas pixels. */
function drawLayout(ctx: Ctx, t: TextData, layout: TextLayout, view: Affine): void {
  const aa = t.antiAlias;
  (ctx as unknown as { fontSmooth?: string }).fontSmooth = aa === 'none' ? 'never' : 'auto';
  if (layout.vertical) { drawVertical(ctx, layout, view); return; }
  if (layout.onPath) { drawOnPath(ctx, layout, view); return; }
  const maxW = t.kind === 'paragraph' && t.box ? t.box.w : Infinity;
  for (const ln of layout.lines as (Line & { baseline: number })[]) {
    const width = trimRight(ln);
    let x = alignX(ln, width, maxW);
    const justified = isJustified(ln) && maxW < Infinity;
    const extra = justified && ln.spaces > 0 ? (maxW - ln.para.indentStart - ln.para.indentEnd - width) / Math.max(1, ln.spaces - (/\s$/.test(ln.pieces[ln.pieces.length - 1]?.text ?? '') ? 1 : 0)) : 0;
    const baseY = (t.kind === 'paragraph' && t.box ? t.box.y : 0) + ln.baseline + (t.kind === 'paragraph' ? 0 : -layout.firstBaseline);
    for (const g of ln.pieces) {
      const s = g.style;
      setFont(ctx, s);
      const shift = s.baseline === 'superscript' ? -s.fontSize * 0.33 : s.baseline === 'subscript' ? s.fontSize * 0.14 : 0;
      const by = baseY - s.baselineShift + shift;
      ctx.setTransform(view[0], view[1], view[2], view[3], view[4], view[5]);
      ctx.translate(x, by);
      ctx.scale(s.horizontalScale, s.verticalScale);
      if (s.fauxItalic) ctx.transform(1, 0, -0.1763, 1, 0, 0); // 10°, as Photoshop
      ctx.fillStyle = `rgba(${Math.round(s.color.r * 255)},${Math.round(s.color.g * 255)},${Math.round(s.color.b * 255)},${s.color.a})`;
      const drawText = g.text;
      if (extra && justified) {
        // Distribute justification space at word boundaries.
        let cx = 0;
        const words = drawText.split(/(\s+)/);
        for (const w of words) {
          if (!w) continue;
          ctx.fillText(w, cx, 0);
          if (s.fauxBold) { ctx.lineWidth = s.fontSize * 0.04; ctx.strokeStyle = ctx.fillStyle; ctx.strokeText(w, cx, 0); }
          cx += ctx.measureText(w).width + (/^\s+$/.test(w) ? (extra * w.length) / s.horizontalScale : 0);
        }
        x += g.width + extra * (drawText.match(/\s/g) ?? []).length;
      } else {
        ctx.fillText(drawText, 0, 0);
        if (s.fauxBold) { ctx.lineWidth = s.fontSize * 0.04; ctx.strokeStyle = ctx.fillStyle; ctx.strokeText(drawText, 0, 0); }
        x += g.width;
      }
      const tw = ctx.measureText(drawText).width;
      if (s.underline) ctx.fillRect(0, s.fontSize * 0.12, tw, Math.max(1, s.fontSize * 0.06));
      if (s.strikethrough) ctx.fillRect(0, -s.fontSize * 0.28, tw, Math.max(1, s.fontSize * 0.06));
    }
  }
}

/** Text-space box of the layout, for editing overlays. */
export function measureTextBox(t: TextData): { x: number; y: number; w: number; h: number } | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const ctx = new OffscreenCanvas(4, 4).getContext('2d') as Ctx;
  return layoutText(ctx, t).bounds;
}
