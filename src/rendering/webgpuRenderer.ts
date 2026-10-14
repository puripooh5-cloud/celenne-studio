/**
 * WebGPU viewport renderer: the same drawing as the WebGL 2 renderer (pasteboard, shader
 * checkerboard, zoom / pan / rotation, texture tile cache, 3D-LUT display colour management,
 * lifted layer sets), on the device shared with the GPU tile compositor. Tiles composited on the
 * GPU are sampled straight from their textures; CPU tiles are uploaded as before.
 */
import type { RenderEngine, DisplayTile } from './renderEngine';
import { DISPLAY_TILE } from './renderEngine';
import type { ViewTransform } from './viewport';
import { apply, Affine, multiply } from '../image-engine/matrix';
import { framePlan, itemPlacement, type DisplayLUT, type RenderFrameOptions, type ViewportRenderer } from './viewportRenderer';

const SHADER = /* wgsl */ `
struct U { viewport: vec2f, lutSize: f32, useLut: f32, light: vec4f, dark: vec4f, checker: f32, dpr: f32, _p: vec2f };
@group(0) @binding(0) var<uniform> u: U;
@group(1) @binding(0) var tileTex: texture_2d<f32>;
@group(1) @binding(1) var tileSamp: sampler;
@group(2) @binding(0) var lutTex: texture_3d<f32>;
@group(2) @binding(1) var lutSamp: sampler;

struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@location(0) p: vec2f, @location(1) uv: vec2f) -> V {
  var o: V;
  let ndc = p / u.viewport * 2.0 - 1.0;
  o.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  o.uv = uv;
  return o;
}

@fragment fn fsTile(v: V) -> @location(0) vec4f {
  let c = textureSample(tileTex, tileSamp, v.uv);
  var rgb = c.rgb;
  let lut = textureSample(lutTex, lutSamp, rgb * ((u.lutSize - 1.0) / u.lutSize) + 0.5 / u.lutSize).rgb;
  if (u.useLut > 0.5) { rgb = lut; }
  return vec4f(rgb * c.a, c.a);
}

@fragment fn fsChecker(v: V) -> @location(0) vec4f {
  let q = floor(v.pos.xy / (u.checker * u.dpr));
  let k = (q.x + q.y) - 2.0 * floor((q.x + q.y) / 2.0);
  return vec4f(mix(u.light.rgb, u.dark.rgb, k), 1.0);
}
`;

interface TexEntry {
  tex: GPUTexture;
  version: number;
  lastUsed: number;
  groups: [GPUBindGroup | null, GPUBindGroup | null];
}

export class WebGPUViewportRenderer implements ViewportRenderer {
  readonly kind = 'webgpu' as const;
  lost = false;
  private ctx: GPUCanvasContext;
  private format: GPUTextureFormat;
  private tilePipe: GPURenderPipeline;
  private checkerPipe: GPURenderPipeline;
  private uniforms: GPUBuffer;
  private uGroup: GPUBindGroup;
  private vbuf: GPUBuffer;
  private vcap = 6 * 4 * 256;
  private samplers: [GPUSampler, GPUSampler];
  private lutSampler: GPUSampler;
  private textures = new Map<string, TexEntry>();
  private gpuGroups = new WeakMap<GPUTexture, [GPUBindGroup | null, GPUBindGroup | null]>();
  private lut: { id: string; group: GPUBindGroup; tex: GPUTexture } | null = null;
  private dummyLut: GPUBindGroup;
  private clock = 0;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private hadLift = false;
  maxTextures = 384;

  constructor(private canvas: HTMLCanvasElement, readonly device: GPUDevice) {
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('WebGPU canvas context unavailable');
    this.ctx = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    const module = device.createShaderModule({ code: SHADER });
    const vertex: GPUVertexState = { module, entryPoint: 'vs', buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' }] }] };
    const g0 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    const g1 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
    const g2 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
    this.layouts = [g0, g1, g2];
    const blend: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    this.tilePipe = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [g0, g1, g2] }), vertex, fragment: { module, entryPoint: 'fsTile', targets: [{ format: this.format, blend }] }, primitive: { topology: 'triangle-list' } });
    this.checkerPipe = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [g0] }), vertex, fragment: { module, entryPoint: 'fsChecker', targets: [{ format: this.format }] }, primitive: { topology: 'triangle-list' } });
    this.uniforms = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uGroup = device.createBindGroup({ layout: g0, entries: [{ binding: 0, resource: { buffer: this.uniforms } }] });
    this.vbuf = device.createBuffer({ size: this.vcap * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.samplers = [
      device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
      device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
    ];
    this.lutSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
    const dl = device.createTexture({ size: [2, 2, 2], dimension: '3d', format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
    this.dummyLutTex = dl;
    this.dummyLut = device.createBindGroup({ layout: g2, entries: [{ binding: 0, resource: dl.createView() }, { binding: 1, resource: this.lutSampler }] });
    device.lost.then(() => { this.lost = true; });
  }

  private layouts: GPUBindGroupLayout[];
  private dummyLutTex: GPUTexture;

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

  private ensureLut(lut: DisplayLUT | null): GPUBindGroup | null {
    if (!lut) return null;
    if (this.lut?.id === lut.id) return this.lut.group;
    this.lut?.tex.destroy();
    const n = lut.size;
    const rgba = new Uint8Array(n * n * n * 4);
    for (let i = 0; i < n * n * n; i++) { rgba[i * 4] = lut.data[i * 3]; rgba[i * 4 + 1] = lut.data[i * 3 + 1]; rgba[i * 4 + 2] = lut.data[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
    const tex = this.device.createTexture({ size: [n, n, n], dimension: '3d', format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture: tex }, rgba, { bytesPerRow: n * 4, rowsPerImage: n }, [n, n, n]);
    const group = this.device.createBindGroup({ layout: this.layouts[2], entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: this.lutSampler }] });
    this.lut = { id: lut.id, group, tex };
    return group;
  }

  private tileGroup(t: DisplayTile, nearest: boolean, key: string): GPUBindGroup {
    const mode = nearest ? 1 : 0;
    if (t.gpu) {
      // Composited on the GPU: sample the tile texture directly.
      let g = this.gpuGroups.get(t.gpu.texture);
      if (!g) { g = [null, null]; this.gpuGroups.set(t.gpu.texture, g); }
      if (!g[mode]) g[mode] = this.device.createBindGroup({ layout: this.layouts[1], entries: [{ binding: 0, resource: t.gpu.view }, { binding: 1, resource: this.samplers[mode] }] });
      return g[mode]!;
    }
    let e = this.textures.get(key);
    if (!e) {
      const tex = this.device.createTexture({ size: [DISPLAY_TILE, DISPLAY_TILE], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      e = { tex, version: -1, lastUsed: 0, groups: [null, null] };
      this.textures.set(key, e);
    }
    if (e.version !== t.version) {
      this.device.queue.writeTexture({ texture: e.tex }, new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength), { bytesPerRow: DISPLAY_TILE * 4, rowsPerImage: DISPLAY_TILE }, [DISPLAY_TILE, DISPLAY_TILE]);
      e.version = t.version;
    }
    e.lastUsed = ++this.clock;
    if (!e.groups[mode]) e.groups[mode] = this.device.createBindGroup({ layout: this.layouts[1], entries: [{ binding: 0, resource: e.tex.createView() }, { binding: 1, resource: this.samplers[mode] }] });
    return e.groups[mode]!;
  }

  render(engine: RenderEngine, view: ViewTransform, opts: RenderFrameOptions): boolean {
    if (this.lost) return true;
    const d = this.dpr;
    const doc = engine.doc;
    const m = view.matrix();
    const verts: number[] = [];
    const quad = (mm: Affine, x: number, y: number, w: number, h: number, u1: number, v1: number, u0 = 0, v0 = 0) => {
      const p0 = apply(mm, x, y), p1 = apply(mm, x + w, y), p2 = apply(mm, x + w, y + h), p3 = apply(mm, x, y + h);
      verts.push(p0.x * d, p0.y * d, u0, v0, p1.x * d, p1.y * d, u1, v0, p2.x * d, p2.y * d, u1, v1, p0.x * d, p0.y * d, u0, v0, p2.x * d, p2.y * d, u1, v1, p3.x * d, p3.y * d, u0, v1);
    };
    quad(m, 0, 0, doc.width, doc.height, 1, 1);
    const plan = framePlan(engine, view, this.cssW, this.cssH);
    this.dropLiftTextures(!!engine.lift);
    const draws: GPUBindGroup[] = [];
    for (const it of plan.draw) {
      const t = it.tile;
      // Offset (lifted) tiles are clipped to the canvas and to their cell, in tile pixel units.
      const p = itemPlacement(it, doc);
      if (!p) continue;
      const s = p.s;
      const nearest = view.zoom * s >= 1.999 || (view.zoom * s >= 0.999 && view.rotation === 0);
      const tm = multiply(m, [s, 0, 0, s, p.x, p.y]);
      if (p.whole) quad(tm, 0, 0, t.w, t.h, t.w / DISPLAY_TILE, t.h / DISPLAY_TILE);
      else quad(tm, p.cx0, p.cy0, p.cx1 - p.cx0, p.cy1 - p.cy0, p.cx1 / DISPLAY_TILE, p.cy1 / DISPLAY_TILE, p.cx0 / DISPLAY_TILE, p.cy0 / DISPLAY_TILE);
      draws.push(this.tileGroup(t, nearest, it.key));
    }
    const q = this.device.queue;
    const vdata = Float32Array.from(verts);
    if (vdata.length > this.vcap) {
      while (this.vcap < vdata.length) this.vcap *= 2;
      this.vbuf.destroy();
      this.vbuf = this.device.createBuffer({ size: this.vcap * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    q.writeBuffer(this.vbuf, 0, vdata);
    const lutGroup = this.ensureLut(opts.lut);
    const u = new Float32Array(20);
    u[0] = this.canvas.width; u[1] = this.canvas.height; u[2] = opts.lut?.size ?? 2; u[3] = lutGroup ? 1 : 0;
    u.set([...opts.checkerLight, 1], 4); u.set([...opts.checkerDark, 1], 8); u[12] = opts.checkerSize; u[13] = d;
    q.writeBuffer(this.uniforms, 0, u);
    const ce = this.device.createCommandEncoder();
    const [pr, pg, pb] = opts.pasteboard;
    const pass = ce.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), clearValue: { r: pr, g: pg, b: pb, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setVertexBuffer(0, this.vbuf);
    pass.setPipeline(this.checkerPipe);
    pass.setBindGroup(0, this.uGroup);
    pass.draw(6, 1, 0);
    pass.setPipeline(this.tilePipe);
    pass.setBindGroup(0, this.uGroup);
    pass.setBindGroup(2, lutGroup ?? this.dummyLut);
    draws.forEach((g, i) => { pass.setBindGroup(1, g); pass.draw(6, 1, 6 + i * 6); });
    pass.end();
    q.submit([ce.finish()]);
    this.evictTextures();
    return plan.complete;
  }

  private evictTextures() {
    if (this.textures.size <= this.maxTextures) return;
    const sorted = [...this.textures.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < sorted.length - this.maxTextures; i++) {
      sorted[i][1].tex.destroy();
      this.textures.delete(sorted[i][0]);
    }
  }

  private dropLiftTextures(lifting: boolean) {
    if (lifting) { this.hadLift = true; return; }
    if (!this.hadLift) return;
    this.hadLift = false;
    for (const [k, e] of this.textures) if (/^(below|moving|above):/.test(k)) { e.tex.destroy(); this.textures.delete(k); }
  }

  textureBytes(): number {
    return this.textures.size * DISPLAY_TILE * DISPLAY_TILE * 4;
  }

  dispose(): void {
    for (const e of this.textures.values()) e.tex.destroy();
    this.textures.clear();
    this.lut?.tex.destroy();
    this.dummyLutTex.destroy();
    try { this.ctx.unconfigure(); } catch { /* already lost */ }
  }
}
