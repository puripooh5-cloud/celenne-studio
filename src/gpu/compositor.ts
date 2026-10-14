/**
 * GPU tile compositor (WebGPU compute). Mirrors the CPU reference compositor
 * (rendering/compositor.ts) operation for operation: the layer tree is walked on the CPU with the
 * same visibility / clipping / skipping rules, and every compositing step becomes one compute
 * dispatch on premultiplied f32 tile buffers.
 *
 *  - Layer pixels are uploaded once per raster tile (and pyramid level) into texture-array
 *    atlases and re-used until the tile changes (Tile.rev); only edited tiles are re-uploaded.
 *  - Masks, vector masks and feathering are evaluated by the CPU code (layerCoverage) and uploaded
 *    as coverage tiles; gradient / pattern fills and live-preview overrides likewise.
 *  - Adjustments, blend modes (all 27, Dissolve included), Blend If, channel restrictions,
 *    clipping groups, isolated and pass-through groups, CMYK plates and Lab documents run on the
 *    GPU.
 *  - Anything else (layer effects, knockout, very large colour lookup tables, view modes such as
 *    single channels or overlays) makes the tile fall back to the CPU compositor, so the result is
 *    never wrong — only that tile is slower.
 *
 * Display tiles stay on the GPU: the WebGPU viewport samples the tile texture directly.
 */
import type { CelenneDocument } from '../document/document';
import type { GroupLayer, Layer, LayerId } from '../document/types';
import { hasRaster } from '../document/types';
import type { Rect } from '../image-engine/rect';
import { tileRange, type TiledRaster } from '../image-engine/tiledRaster';
import { compositeRegion, hasEffects, isHidden, labBlends, layerCoverage, mayAffect, modeOf, opacityOf, readLayerContent, renderFillLayer, type CompositeOptions, type Ctx, type LayerOverride } from '../rendering/compositor';
import { blendIfActive, channelsRestricted } from '../rendering/blendIf';
import { isCmykDoc, isLabDoc, plateColor } from '../color/plates';
import { needsInkDisplay } from '../rendering/inkView';
import type { DisplayTile, ViewOptions } from '../rendering/renderEngine';
import { ADJ, adjustPipeline, BLEND_IDS, FLAG, OP, OUTPUT_WGSL, PARAM_STRIDE, PIPELINE_OF, SRC, WGSL_MODULES } from './shaders';
import { encodeAdjustment } from './adjustEncode';
import { CMYK_GRID_N } from '../color/cmykDisplayGrid';
import { filterById } from '../filters/builtin';
import { boxesForGauss, gaussianKernel } from '../image-engine/blur';
import { fillIsSpecial } from '../image-engine/blend';

const TS = 256;
const EMPTY = 0xffffffff;
const BUF_BYTES = TS * TS * 16;

class Unsupported extends Error {}

/** Bytes per atlas page: larger single textures are unreliable on some drivers. */
const PAGE_BYTES = 32 << 20;

/**
 * Texture-array atlas of 256×256 tiles with LRU slots, split into pages of at most 32 MB that are
 * created on demand. Slot ids are (binding id << 24 | layer).
 */
class Atlas {
  readonly pages: (GPUTexture | null)[];
  readonly views: GPUTextureView[];
  readonly layers: number;
  private owners: (object | string | null)[];
  private revs: number[];
  private used: number[];
  private index = new Map<object | string, number>();
  constructor(private device: GPUDevice, readonly format: GPUTextureFormat, readonly ids: number[], private bytesPerPixel: number, placeholder: GPUTextureView, private onPage: () => void) {
    this.layers = Math.max(8, Math.min(device.limits.maxTextureArrayLayers, Math.floor(PAGE_BYTES / (TS * TS * bytesPerPixel))));
    this.pages = ids.map(() => null);
    this.views = ids.map(() => placeholder);
    const n = this.layers * ids.length;
    this.owners = new Array(n).fill(null);
    this.revs = new Array(n).fill(-1);
    this.used = new Array(n).fill(-1);
  }

  private page(p: number): GPUTexture {
    let t = this.pages[p];
    if (!t) {
      t = this.device.createTexture({ size: { width: TS, height: TS, depthOrArrayLayers: this.layers }, format: this.format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      this.pages[p] = t;
      this.views[p] = t.createView({ dimension: '2d-array' });
      this.onPage();
    }
    return t;
  }

  /** Slot id holding `key` at revision `rev`; uploads when needed. */
  slot(key: object | string, rev: number, serial: number, upload: () => { data: ArrayBufferView; w: number; h: number }): number {
    let s = this.index.get(key);
    if (s === undefined || this.revs[s] !== rev) {
      if (s === undefined) {
        s = this.victim(serial);
        const old = this.owners[s];
        if (old !== null) this.index.delete(old);
        this.owners[s] = key;
        this.index.set(key, s);
      }
      const u = upload();
      // A plain byte view of the samples (some WebGPU bindings reject Uint8ClampedArray).
      const bytes = new Uint8Array(u.data.buffer, u.data.byteOffset, u.data.byteLength);
      const p = Math.floor(s / this.layers);
      this.device.queue.writeTexture({ texture: this.page(p), origin: { x: 0, y: 0, z: s % this.layers } }, bytes, { bytesPerRow: u.w * this.bytesPerPixel, rowsPerImage: u.h }, { width: u.w, height: u.h, depthOrArrayLayers: 1 });
      this.revs[s] = rev;
    }
    this.used[s] = serial;
    return (this.ids[Math.floor(s / this.layers)] << 24) | (s % this.layers);
  }

  private victim(serial: number): number {
    // Free slots in existing pages first, then a new page, then the least recently used slot.
    const allocated = this.pages.filter(Boolean).length;
    for (let i = 0; i < allocated * this.layers; i++) if (this.owners[i] === null) return i;
    if (allocated < this.pages.length) return allocated * this.layers;
    let best = -1, bestUsed = Infinity;
    for (let i = 0; i < this.owners.length; i++) {
      if (this.used[i] === serial) continue; // pinned by the tile being encoded
      if (this.used[i] < bestUsed) { bestUsed = this.used[i]; best = i; }
    }
    if (best < 0) throw new Unsupported('GPU atlas is full for this tile');
    return best;
  }

  bytes(): number {
    return this.pages.filter(Boolean).length * this.layers * TS * TS * this.bytesPerPixel;
  }

  destroy(): void {
    for (const t of this.pages) t?.destroy();
  }
}

interface SrcDesc {
  src: number;
  buf?: GPUBuffer;
  solid?: [number, number, number, number];
  rx0?: number; ry0?: number; gx0?: number; gy0?: number; gw?: number; gh?: number; grid?: number;
  srcOff?: number;
  groupUnpremul?: boolean;
}

type Pipe = keyof typeof WGSL_MODULES | `filter:${'gather' | 'blurH' | 'blurV' | 'straighten' | 'unsharp' | 'crop' | 'selmix'}`;

interface Op {
  pipe: Pipe;
  dst: GPUBuffer;
  src: GPUBuffer | null;
  under: GPUBuffer | null;
  w: number;
  h: number;
}

/** Per-tile encoding state. */
class Encoding {
  params: ArrayBuffer[] = [];
  ops: Op[] = [];
  data: number[] = [];
  upload: Float32Array[] = [];
  uploadLen = 0;
  free: GPUBuffer[] = [];
  taken: GPUBuffer[] = [];
  constructor(readonly serial: number) {}
  /** Appends u32 / f32 words to the data buffer; returns their offset. */
  pushU32(values: ArrayLike<number>): number { const o = this.data.length; for (let i = 0; i < values.length; i++) this.data.push(values[i] >>> 0); return o; }
  pushF32(values: Float32Array): number { return this.pushU32(new Uint32Array(values.buffer, values.byteOffset, values.length)); }
  /** Appends straight RGBA content for the src upload buffer; returns its offset in vec4 units. */
  pushUpload(v: Float32Array): number { const o = this.uploadLen; this.upload.push(v); this.uploadLen += v.length / 4; return o; }
}

export interface GpuCompositorStats {
  gpuTiles: number;
  cpuTiles: number;
  /** Live previews (filters, adjustments) computed on the GPU. */
  gpuPreviews: number;
  lastFallback: string | null;
}

export class GpuCompositor {
  private pipelines: Partial<Record<Pipe, GPUComputePipeline>> = {};
  private pipelineLayout: GPUPipelineLayout;
  private outPipeline: GPUComputePipeline;
  private layout: GPUBindGroupLayout;
  private outLayout: GPUBindGroupLayout;
  private atlases: Atlas[];
  private cov: Atlas;
  private paramBuf: GPUBuffer;
  private paramCap = 64;
  private dataBuf: GPUBuffer;
  private dataCap = 1 << 16;
  private uploadBuf: GPUBuffer;
  private uploadCap = TS * TS * 4;
  private outParam: GPUBuffer;
  private dummy: GPUBuffer;
  private pool: GPUBuffer[] = [];
  private ids = new WeakMap<GPUBuffer, number>();
  private nextId = 1;
  private groups = new Map<string, GPUBindGroup>();
  private serial = 0;
  private lutCache = new WeakMap<object, { tex: GPUTexture; view: GPUTextureView; n: number }>();
  private dummyLut: GPUTextureView;
  private tileTextures = new Set<GPUTexture>();
  readonly stats: GpuCompositorStats = { gpuTiles: 0, cpuTiles: 0, gpuPreviews: 0, lastFallback: null };
  disposed = false;

  constructor(readonly device: GPUDevice) {
    const d = device;
    const storage = (i: number, type: GPUBufferBindingType) => ({ binding: i, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const tex = (i: number, sampleType: GPUTextureSampleType) => ({ binding: i, visibility: GPUShaderStage.COMPUTE, texture: { sampleType, viewDimension: '2d-array' as GPUTextureViewDimension } });
    const f = 'float' as GPUTextureSampleType, uf = 'unfilterable-float' as GPUTextureSampleType;
    this.layout = d.createBindGroupLayout({
      entries: [
        storage(0, 'storage'), storage(1, 'read-only-storage'), storage(2, 'read-only-storage'),
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', minBindingSize: 128 } },
        storage(4, 'read-only-storage'),
        tex(5, f), tex(6, f), tex(7, f), tex(8, 'uint'), tex(9, 'uint'), tex(10, uf), tex(11, uf), tex(12, uf),
      ],
    });
    this.outLayout = d.createBindGroupLayout({
      entries: [
        storage(0, 'read-only-storage'), storage(1, 'read-only-storage'),
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
      ],
    });
    this.pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.pipeline('misc');
    this.pipeline('span');
    this.outPipeline = d.createComputePipeline({ layout: d.createPipelineLayout({ bindGroupLayouts: [this.outLayout] }), compute: { module: d.createShaderModule({ code: OUTPUT_WGSL }), entryPoint: 'main' } });
    // Placeholder views for pages not created yet (one per sample type).
    const ph = (format: GPUTextureFormat) => d.createTexture({ size: [1, 1, 1], format, usage: GPUTextureUsage.TEXTURE_BINDING }).createView({ dimension: '2d-array' });
    const phF = ph('rgba8unorm'), phU = ph('rgba16uint'), phX = ph('rgba32float'), phC = ph('r32float');
    const page = () => this.groups.clear();
    // Binding ids (see shaders.ts atlasSample): 0..2 = 8-bit pages, 3..4 = 16-bit, 5 = 32-bit; coverage 0..1.
    this.atlases = [new Atlas(d, 'rgba8unorm', [0, 1, 2], 4, phF, page), new Atlas(d, 'rgba16uint', [3, 4], 8, phU, page), new Atlas(d, 'rgba32float', [5], 16, phX, page)];
    this.cov = new Atlas(d, 'r32float', [0, 1], 4, phC, page);
    this.paramBuf = this.mkBuffer(PARAM_STRIDE * this.paramCap, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.dataBuf = this.mkBuffer(this.dataCap * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.uploadBuf = this.mkBuffer(this.uploadCap * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.outParam = this.mkBuffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.dummy = this.mkBuffer(16, GPUBufferUsage.STORAGE);
    const lut = d.createTexture({ size: [2, 2, 2], format: 'rgba32float', dimension: '3d', usage: GPUTextureUsage.TEXTURE_BINDING });
    this.dummyLut = lut.createView();
  }

  /** Compute pipelines are compiled on first use ("module" or "module:entry"). */
  private pipeline(k: Pipe): GPUComputePipeline {
    let p = this.pipelines[k];
    if (!p) {
      const [mod, entry] = k.split(':') as [keyof typeof WGSL_MODULES, string | undefined];
      let module = this.modules[mod];
      if (!module) module = this.modules[mod] = this.device.createShaderModule({ code: WGSL_MODULES[mod] });
      p = this.device.createComputePipeline({ layout: this.pipelineLayout, compute: { module, entryPoint: entry ?? 'main' } });
      this.pipelines[k] = p;
    }
    return p;
  }
  private modules: Partial<Record<keyof typeof WGSL_MODULES, GPUShaderModule>> = {};

  private mkBuffer(size: number, usage: number): GPUBuffer {
    const b = this.device.createBuffer({ size, usage });
    this.ids.set(b, this.nextId++);
    return b;
  }

  // -------------------------------------------------------------------------------------------
  // Eligibility
  // -------------------------------------------------------------------------------------------
  /** Whether the display view can be produced by the GPU path (otherwise the CPU renders the tile). */
  viewSupported(doc: CelenneDocument, v: ViewOptions): string | null {
    if (v.maskOfLayer) return 'mask view';
    if (v.quickMask || v.visibleAlphaChannels.length) return 'overlays';
    if (v.proof) return 'soft proof';
    if (!(v.channels.r && v.channels.g && v.channels.b) || (isCmykDoc(doc) && v.channels.k === false)) return 'channel view';
    if (needsInkDisplay(doc)) return 'ink display';
    const m = doc.canvas.colorMode;
    if (!['rgb', 'grayscale', 'cmyk', 'lab', 'indexed', 'bitmap'].includes(m)) return 'colour mode';
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Public entry points
  // -------------------------------------------------------------------------------------------
  /**
   * Composites a display tile on the GPU into `tile.gpu`. Returns false (nothing submitted) when the
   * tile needs the CPU path.
   */
  renderDisplayTile(doc: CelenneDocument, view: ViewOptions, r: Rect, level: number, overrides: Map<LayerId, LayerOverride>, tile: DisplayTile): boolean {
    if (this.disposed) return false;
    const why = this.viewSupported(doc, view);
    if (why) { this.fallback(why); return false; }
    const enc = new Encoding(++this.serial);
    try {
      const plates = isCmykDoc(doc) ? [0, 1] : [0];
      const bufs = plates.map((plate) => this.encodeComposite(enc, doc, r, { level, overrides, plate }));
      const target = this.tileTexture(tile);
      const mode = isCmykDoc(doc) ? (view.cmykDisplay ? 2 : 3) : doc.canvas.bitDepth === 32 ? 1 : 0;
      // CMYK through the profile: the same grid the CPU display evaluates (proofing has none: CPU).
      if (mode === 2 && !view.cmykGrid) throw new Unsupported('CMYK proofing');
      const lut = mode === 2 ? this.cmykLut(view.cmykGrid!) : null;
      this.submit(enc, (pass) => {
        this.device.queue.writeBuffer(this.outParam, 0, Uint32Array.of(r.w, r.h, mode, lut?.n ?? 2));
        pass.setPipeline(this.outPipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
          layout: this.outLayout,
          entries: [
            { binding: 0, resource: { buffer: bufs[0] } }, { binding: 1, resource: { buffer: bufs[1] ?? bufs[0] } },
            { binding: 2, resource: { buffer: this.outParam } }, { binding: 3, resource: target.storage },
            { binding: 4, resource: lut?.view ?? this.dummyLut },
          ],
        }));
        pass.dispatchWorkgroups(Math.ceil(r.w / 16), Math.ceil(r.h / 16));
      });
      this.stats.gpuTiles++;
      return true;
    } catch (e) {
      this.release(enc);
      if (e instanceof Unsupported) { this.fallback(e.message); return false; }
      throw e;
    }
  }

  /** The premultiplied composite of `r` (as compositeRegion returns it), read back (tests, benchmarks). */
  async compositeRead(doc: CelenneDocument, r: Rect, opts: CompositeOptions): Promise<Float32Array | null> {
    const enc = new Encoding(++this.serial);
    let buf: GPUBuffer;
    try {
      buf = this.encodeComposite(enc, doc, r, opts);
    } catch (e) {
      this.release(enc);
      if (e instanceof Unsupported) return null;
      throw e;
    }
    const bytes = r.w * r.h * 16;
    const read = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.submit(enc, null, (ce) => ce.copyBufferToBuffer(buf, 0, read, 0, bytes));
    await read.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    read.destroy();
    return out;
  }

  /** Reads a GPU display tile back as straight RGBA8 (tests). */
  async readTile(tile: DisplayTile): Promise<Uint8Array> {
    const t = tile.gpu!;
    const bpr = TS * 4;
    const read = this.device.createBuffer({ size: bpr * TS, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const ce = this.device.createCommandEncoder();
    ce.copyTextureToBuffer({ texture: t.texture }, { buffer: read, bytesPerRow: bpr }, [TS, TS]);
    this.device.queue.submit([ce.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const out = new Uint8Array(read.getMappedRange().slice(0));
    read.unmap();
    read.destroy();
    return out;
  }

  releaseTile(tile: DisplayTile): void {
    if (!tile.gpu) return;
    this.tileTextures.delete(tile.gpu.texture);
    tile.gpu.texture.destroy();
    tile.gpu = undefined;
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.tileTextures) t.destroy();
    this.tileTextures.clear();
    for (const a of [...this.atlases, this.cov]) a.destroy();
    for (const b of this.pool) b.destroy();
    this.pool = [];
  }

  private fallback(why: string) {
    this.stats.cpuTiles++;
    this.stats.lastFallback = why;
  }

  private tileTexture(tile: DisplayTile): { texture: GPUTexture; storage: GPUTextureView } {
    if (!tile.gpu) {
      const texture = this.device.createTexture({ size: [TS, TS], format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
      this.tileTextures.add(texture);
      tile.gpu = { texture, view: texture.createView(), storage: texture.createView() };
    }
    return { texture: tile.gpu.texture, storage: tile.gpu.storage };
  }

  // -------------------------------------------------------------------------------------------
  // Encoding
  // -------------------------------------------------------------------------------------------
  /** A pixel buffer of at least `px` pixels (tile-sized by default; padded preview regions are larger). */
  private take(enc: Encoding, px = TS * TS): GPUBuffer {
    const bytes = px <= TS * TS ? BUF_BYTES : 1 << Math.ceil(Math.log2(px * 16));
    const pick = (list: GPUBuffer[]) => { const i = list.findIndex((b) => b.size === bytes); return i < 0 ? undefined : list.splice(i, 1)[0]; };
    const b = pick(enc.free) ?? pick(this.pool) ?? this.mkBuffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    enc.taken.push(b);
    return b;
  }
  private give(enc: Encoding, b: GPUBuffer) { enc.free.push(b); }
  private release(enc: Encoding) {
    for (const b of enc.taken) if (!this.pool.includes(b)) this.pool.push(b);
    enc.taken = []; enc.free = [];
    // Large preview buffers are not kept around.
    for (let i = this.pool.length - 1; i >= 0; i--) if (this.pool[i].size > BUF_BYTES) { this.pool[i].destroy(); this.pool.splice(i, 1); }
  }

  private encodeComposite(enc: Encoding, doc: CelenneDocument, r: Rect, opts: CompositeOptions): GPUBuffer {
    if (r.w > TS || r.h > TS) throw new Unsupported('region larger than a tile');
    const ctx: Ctx = { doc, level: opts.level, scale: 1 / (1 << opts.level), opts, stopped: false, plate: opts.plate ?? 0 };
    const out = this.take(enc);
    this.op(enc, { kind: OP.clear }, out, null, null, r);
    this.children(enc, ctx, opts.root ?? doc.root, out, r);
    return out;
  }

  private children(enc: Encoding, ctx: Ctx, group: GroupLayer, dst: GPUBuffer, r: Rect) {
    const kids = group.children;
    if (kids.some((k) => k.advanced.knockout !== 'none' && !isHidden(ctx, k))) throw new Unsupported('knockout');
    for (let i = 0; i < kids.length; i++) {
      if (ctx.stopped) return;
      const layer = kids[i];
      if (ctx.opts.stopAt && layer.id === ctx.opts.stopAt) { ctx.stopped = true; return; }
      let j = i + 1;
      while (j < kids.length && kids[j].clipping) j++;
      const clipped = kids.slice(i + 1, j);
      if (layer.clipping && i > 0) continue;
      if (isHidden(ctx, layer)) { i = j - 1; continue; }
      if (!mayAffect(ctx, layer, r)) { i = j - 1; continue; }
      const visibleClipped = clipped.filter((c) => !isHidden(ctx, c));
      if (visibleClipped.length) this.clipGroup(enc, ctx, layer, visibleClipped, dst, r);
      else this.layer(enc, ctx, layer, dst, r);
      i = j - 1;
    }
  }

  private layer(enc: Encoding, ctx: Ctx, layer: Layer, dst: GPUBuffer, r: Rect) {
    const opacity = opacityOf(ctx, layer);
    const mode = modeOf(ctx, layer);
    if (opacity <= 0 && !(layer.kind === 'group' && mode === 'passThrough')) return;
    if (layer.kind === 'adjustment') {
      const adj = ctx.opts.overrides?.get(layer.id)?.adjustment ?? layer.adjustment;
      this.adjust(enc, ctx, layer, adj, mode, opacity * layer.fillOpacity, dst, r);
      return;
    }
    if (layer.kind === 'group' && mode === 'passThrough' && !hasEffects(ctx, layer)) {
      const cov = this.coverage(enc, ctx, layer, r);
      if (opacity >= 1 && cov === EMPTY) { this.children(enc, ctx, layer, dst, r); return; }
      const copy = this.take(enc);
      this.op(enc, { kind: OP.copy }, copy, dst, null, r);
      this.children(enc, { ...ctx, stopped: false }, layer, copy, r);
      this.op(enc, { kind: OP.lerp, opacity, cov }, dst, copy, null, r);
      this.give(enc, copy);
      return;
    }
    if (hasEffects(ctx, layer)) throw new Unsupported('layer effects');
    const restricted = channelsRestricted(layer.advanced) && layer.kind !== 'group';
    let before: GPUBuffer | null = null;
    if (restricted) { before = this.take(enc); this.op(enc, { kind: OP.copy }, before, dst, null, r); }
    const src = this.maskedSource(enc, ctx, layer, r);
    const cov = ctx.opts.overrides?.get(layer.id)?.includesMask ? EMPTY : this.coverage(enc, ctx, layer, r);
    const fill = layer.kind === 'group' ? 1 : layer.fillOpacity;
    const m = mode === 'passThrough' ? 'normal' : mode;
    const sp = fillIsSpecial(m, fill) && !labBlends(ctx, m);
    this.op(enc, { kind: OP.span, mode: m, opacity: sp ? opacity : opacity * fill, fill: sp ? fill : 1, hdr: ctx.doc.canvas.bitDepth === 32, cov, src, blendIf: layer, underIsDst: true, lab: labBlends(ctx, m) }, dst, src.buf ?? null, null, r);
    if (src.buf) this.give(enc, src.buf);
    if (before) {
      const c = layer.advanced.channels;
      this.op(enc, { kind: OP.restrict, chan: (c[0] ? 1 : 0) | (c[1] ? 2 : 0) | (c[2] ? 4 : 0) }, dst, before, null, r);
      this.give(enc, before);
    }
  }

  private clipGroup(enc: Encoding, ctx: Ctx, base: Layer, clipped: Layer[], dst: GPUBuffer, r: Rect) {
    if (base.kind === 'adjustment') {
      this.layer(enc, ctx, base, dst, r);
      for (const c of clipped) this.layer(enc, ctx, c, dst, r);
      return;
    }
    if (hasEffects(ctx, base)) throw new Unsupported('layer effects');
    const tmp = this.take(enc);
    this.op(enc, { kind: OP.clear }, tmp, null, null, r);
    const baseOpacity = opacityOf(ctx, base);
    const baseMode = modeOf(ctx, base);
    {
      const src = this.maskedSource(enc, ctx, base, r);
      const cov = ctx.opts.overrides?.get(base.id)?.includesMask ? EMPTY : this.coverage(enc, ctx, base, r);
      // Blend If of the base compares against the backdrop outside the clipping group.
      this.op(enc, { kind: OP.span, mode: 'normal', opacity: base.kind === 'group' ? 1 : base.fillOpacity, cov, src, blendIf: base, underIsDst: false }, tmp, src.buf ?? null, dst, r);
      if (src.buf) this.give(enc, src.buf);
    }
    for (const c of clipped) {
      const op = opacityOf(ctx, c);
      const mode = modeOf(ctx, c);
      if (c.kind === 'adjustment') {
        const adj = ctx.opts.overrides?.get(c.id)?.adjustment ?? c.adjustment;
        this.adjust(enc, ctx, c, adj, mode, op * c.fillOpacity, tmp, r);
        continue;
      }
      if (hasEffects(ctx, c)) throw new Unsupported('layer effects');
      const src = this.maskedSource(enc, ctx, c, r);
      const cov = ctx.opts.overrides?.get(c.id)?.includesMask ? EMPTY : this.coverage(enc, ctx, c, r);
      const fill = c.kind === 'group' ? 1 : c.fillOpacity;
      const mm = mode === 'passThrough' ? 'normal' : mode;
      const sp = fillIsSpecial(mm, fill) && !labBlends(ctx, mm);
      this.op(enc, { kind: OP.atop, mode: mm, opacity: sp ? op : op * fill, fill: sp ? fill : 1, hdr: ctx.doc.canvas.bitDepth === 32, cov, src, blendIf: c, underIsDst: true, lab: labBlends(ctx, mm) }, tmp, src.buf ?? null, null, r);
      if (src.buf) this.give(enc, src.buf);
    }
    const bm = baseMode === 'passThrough' ? 'normal' : baseMode;
    this.op(enc, { kind: OP.span, mode: bm, opacity: baseOpacity, cov: EMPTY, src: { src: SRC.premultiplied, buf: tmp }, lab: labBlends(ctx, bm) }, dst, tmp, null, r);
    this.give(enc, tmp);
  }

  private adjust(enc: Encoding, ctx: Ctx, layer: Layer, adj: import('../adjustments/types').Adjustment, mode: Layer['blendMode'], opacity: number, dst: GPUBuffer, r: Rect) {
    const key = isCmykDoc(ctx.doc) ? (ctx.plate === 1 ? 'cmyk1' : 'cmyk0') : isLabDoc(ctx.doc) ? 'lab' : 'rgb';
    // 32-bit Exposure works on unclamped linear values (no table).
    const e = adj.type === 'exposure' && ctx.doc.canvas.bitDepth === 32
      ? { code: ADJ.exposureLinear, wrap: 0, values: Float32Array.of(Math.pow(2, adj.exposure), adj.offset, 1 / Math.max(0.01, adj.gamma)) }
      : encodeAdjustment(adj, key);
    if (!e) throw new Unsupported(`adjustment ${adj.type}`);
    const base = e.values.length ? enc.pushF32(e.values) : 0;
    const cov = this.coverage(enc, ctx, layer, r);
    this.op(enc, { kind: OP.adjust, mode, opacity, cov, adjCode: e.code, adjWrap: e.wrap, adjBase: base, lab: labBlends(ctx, mode) }, dst, null, null, r);
    void ADJ;
  }

  /** The layer's straight content (masks are applied in the shader through `cov`). */
  private maskedSource(enc: Encoding, ctx: Ctx, layer: Layer, r: Rect): SrcDesc {
    if (layer.kind === 'group') {
      const buf = this.take(enc);
      this.op(enc, { kind: OP.clear }, buf, null, null, r);
      this.children(enc, { ...ctx, stopped: false }, layer, buf, r);
      return { src: SRC.premultiplied, buf, groupUnpremul: true };
    }
    const ov = ctx.opts.overrides?.get(layer.id);
    if (ov?.read) {
      const g = ov.gpu && hasRaster(layer) ? this.previewSource(enc, ctx, layer, r, ov.gpu) : null;
      if (g) this.stats.gpuPreviews++;
      return g ?? this.uploadSource(enc, ov.read(r, ctx.level, ctx.plate));
    }
    if (hasRaster(layer)) {
      const raster: TiledRaster | null = ctx.plate === 1 ? layer.raster.companion : layer.raster;
      if (!raster || raster.channels !== 4 || raster.fill !== 0) return this.uploadSource(enc, readLayerContent(ctx, layer, r));
      return this.atlasSource(enc, raster, layer, r, ctx.level);
    }
    if (layer.kind === 'fill') {
      if (layer.fill.type === 'solid') {
        const c = plateColor(ctx.doc, layer.fill.color, ctx.plate);
        return { src: SRC.solid, solid: [c.r, c.g, c.b, 1] };
      }
      return this.uploadSource(enc, renderFillLayer(ctx.doc, layer, r, ctx.scale, ctx.plate));
    }
    return { src: SRC.none };
  }

  // -------------------------------------------------------------------------------------------
  // Live previews on the GPU (destructive adjustments and blur / sharpen filters)
  // -------------------------------------------------------------------------------------------
  /** Raw dispatch of a filter entry point with P fields by name. */
  private raw(enc: Encoding, pipe: Pipe, f: { w: number; h: number; flags?: number; mode?: number; chan?: number; adjBase?: number; opacity?: number; solid0?: number; cov?: number; srcW?: number; srcOff?: number; atlas?: SrcDesc }, dst: GPUBuffer, src: GPUBuffer | null, under: GPUBuffer | null) {
    const pb = new ArrayBuffer(PARAM_STRIDE);
    const u = new Uint32Array(pb), fl = new Float32Array(pb), i32 = new Int32Array(pb);
    u[1] = f.mode ?? 0; u[3] = f.flags ?? 0; u[4] = f.w; u[5] = f.h;
    fl[8] = f.opacity ?? 1; u[9] = f.cov ?? EMPTY; u[10] = f.chan ?? 0; fl[12] = f.solid0 ?? 0;
    const a = f.atlas;
    if (a) { i32[16] = a.rx0!; i32[17] = a.ry0!; i32[18] = a.gx0!; i32[19] = a.gy0!; u[20] = a.gw!; u[21] = a.gh!; u[22] = a.grid!; }
    u[23] = f.adjBase ?? 0; u[26] = f.srcW ?? f.w; u[27] = f.srcOff ?? 0;
    enc.params.push(pb);
    enc.ops.push({ pipe, dst, src, under, w: f.w, h: f.h });
  }

  /** Selection coverage for `r` (null = no selection). */
  private selectionCoverage(enc: Encoding, ctx: Ctx, r: Rect): number {
    const sel = ctx.doc.selection;
    if (sel.isEmpty()) return EMPTY;
    const key = `sel|${this.objId(sel.mask)}:${sel.mask.version}|${ctx.level}|${r.x},${r.y},${r.w},${r.h}`;
    return this.cov.slot(key, 0, enc.serial, () => ({ data: sel.mask.readFloat(r, ctx.level), w: r.w, h: r.h }));
  }

  /** The layer's pixels of `region` gathered into a buffer (straight, or premultiplied). */
  private gatherLayer(enc: Encoding, ctx: Ctx, layer: Layer & { raster: TiledRaster; x: number; y: number }, region: Rect, premultiply: boolean): GPUBuffer | null {
    const raster = ctx.plate === 1 ? layer.raster.companion : layer.raster;
    if (!raster || raster.channels !== 4 || raster.fill !== 0) return null;
    const atlas = this.atlasSource(enc, raster, layer, region, ctx.level);
    const buf = this.take(enc, region.w * region.h);
    this.raw(enc, 'filter:gather', { w: region.w, h: region.h, flags: premultiply ? 16 : 0, atlas }, buf, null, null);
    return buf;
  }

  private previewSource(enc: Encoding, ctx: Ctx, layer: Layer & { raster: TiledRaster; x: number; y: number }, r: Rect, g: NonNullable<LayerOverride['gpu']>): SrcDesc | null {
    if (isLabDoc(ctx.doc)) return null; // Lab previews run through the RGB view on the CPU
    if (g.adjustment) {
      const key = isCmykDoc(ctx.doc) ? (ctx.plate === 1 ? 'cmyk1' : 'cmyk0') : 'rgb';
      const e = encodeAdjustment(g.adjustment, key);
      if (!e) return null;
      const buf = this.gatherLayer(enc, ctx, layer, r, true);
      if (!buf) return null;
      const base = e.values.length ? enc.pushF32(e.values) : 0;
      // applyDocAdjustmentStraight blended by the selection = applyAdjustedSpan (Normal) on the premultiplied pixels.
      this.op(enc, { kind: OP.adjust, mode: 'normal', opacity: 1, cov: this.selectionCoverage(enc, ctx, r), adjCode: e.code, adjWrap: e.wrap, adjBase: base }, buf, null, null, r);
      return { src: SRC.premultiplied, buf };
    }
    const fdef = g.filter ? filterById(g.filter.id) : undefined;
    if (!fdef || !g.filter || !['gaussianBlur', 'boxBlur', 'unsharpMask'].includes(fdef.id)) return null;
    const p = g.filter.params as Record<string, number>;
    const pad = Math.ceil(fdef.padding(p as never) * ctx.scale) + 1;
    const pr = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
    if (pr.w * pr.h > 16e6) return null;
    const premul = fdef.space === 'premultiplied';
    const a = this.gatherLayer(enc, ctx, layer, pr, premul);
    if (!a) return null;
    const dims = { w: pr.w, h: pr.h };
    /** Separable passes over `buf` (result back in `buf`). */
    const gauss = (buf: GPUBuffer, sigma: number) => {
      if (sigma <= 0.05) return;
      const tmp = this.take(enc, pr.w * pr.h);
      if (sigma <= 3) {
        const k = gaussianKernel(sigma);
        const base = enc.pushF32(k);
        const rad = (k.length - 1) >> 1;
        this.raw(enc, 'filter:blurH', { ...dims, mode: 0, chan: rad, adjBase: base }, tmp, buf, null);
        this.raw(enc, 'filter:blurV', { ...dims, mode: 0, chan: rad, adjBase: base }, buf, tmp, null);
      } else for (const b of boxesForGauss(sigma, 3)) box(buf, tmp, (b - 1) / 2);
      this.give(enc, tmp);
    };
    const box = (buf: GPUBuffer, tmp: GPUBuffer, rad: number) => {
      if (rad < 0.5) return;
      const ri = Math.round(rad);
      this.raw(enc, 'filter:blurH', { ...dims, mode: 1, chan: ri }, tmp, buf, null);
      this.raw(enc, 'filter:blurV', { ...dims, mode: 1, chan: ri }, buf, tmp, null);
    };
    let result = a;
    const radius = (p.radius ?? 0) * ctx.scale;
    if (fdef.id === 'gaussianBlur') gauss(a, radius);
    else if (fdef.id === 'boxBlur') { const tmp = this.take(enc, pr.w * pr.h); box(a, tmp, radius); this.give(enc, tmp); }
    else {
      // Unsharp Mask: straight values; blurred copy, then original + (original − blurred) · amount.
      const blurred = this.take(enc, pr.w * pr.h);
      this.raw(enc, 'filter:crop', { ...dims, srcW: pr.w, srcOff: 0 }, blurred, a, null);
      gauss(blurred, Math.max(0.3, radius));
      result = this.take(enc, pr.w * pr.h);
      this.raw(enc, 'filter:unsharp', { ...dims, opacity: (p.amount ?? 100) / 100, solid0: (p.threshold ?? 0) / 255 }, result, a, blurred);
      this.give(enc, blurred);
    }
    if (premul) this.raw(enc, 'filter:straighten', dims, result, null, null);
    const out = this.take(enc);
    this.raw(enc, 'filter:crop', { w: r.w, h: r.h, srcW: pr.w, srcOff: pad * pr.w + pad }, out, result, null);
    if (result !== a) this.give(enc, result);
    this.give(enc, a);
    const sel = this.selectionCoverage(enc, ctx, r);
    if (sel !== EMPTY) {
      const orig = this.gatherLayer(enc, ctx, layer, r, false)!;
      this.raw(enc, 'filter:selmix', { w: r.w, h: r.h, cov: sel }, out, orig, null);
      this.give(enc, orig);
    }
    return { src: SRC.straight, buf: out, srcOff: 0 };
  }

  private uploadSource(enc: Encoding, content: Float32Array): SrcDesc {
    return { src: SRC.straight, srcOff: enc.pushUpload(content) };
  }

  private atlasSource(enc: Encoding, raster: TiledRaster, layer: Layer & { x: number; y: number }, r: Rect, level: number): SrcDesc {
    const s = 1 << level;
    const rx0 = r.x - Math.round(layer.x / s), ry0 = r.y - Math.round(layer.y / s);
    const { tx0, ty0, tx1, ty1 } = tileRange({ x: rx0, y: ry0, w: r.w, h: r.h });
    const atlas = raster.depth === 8 ? this.atlases[0] : raster.depth === 16 ? this.atlases[1] : this.atlases[2];
    const grid: number[] = [];
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const lt = raster.levelTile(level, tx, ty);
        grid.push(lt ? atlas.slot(lt.obj, lt.rev, enc.serial, () => ({ data: lt.data, w: TS, h: TS })) : EMPTY);
      }
    return { src: SRC.atlas, rx0, ry0, gx0: tx0, gy0: ty0, gw: tx1 - tx0 + 1, gh: ty1 - ty0 + 1, grid: enc.pushU32(grid) };
  }

  private covKeys = new WeakMap<object, number>();
  private objId(o: object): number {
    let v = this.covKeys.get(o);
    if (v === undefined) { v = this.nextId++; this.covKeys.set(o, v); }
    return v;
  }

  /** Mask + vector mask coverage of the layer for `r` (CPU-evaluated, cached on the GPU). */
  private coverage(enc: Encoding, ctx: Ctx, layer: Layer, r: Rect): number {
    const m = layer.mask, vm = layer.vectorMask;
    const hasMask = !!(m && m.enabled && m.density > 0);
    const hasVm = !!(vm && vm.enabled && vm.path.subpaths.length);
    if (!hasMask && !hasVm) return EMPTY;
    const key = `${this.objId(layer)}|${ctx.level}|${r.x},${r.y},${r.w},${r.h}|${hasMask ? `${this.objId(m!.raster)}:${m!.raster.version}:${m!.x}:${m!.y}:${m!.feather}:${m!.density}` : ''}|${hasVm ? `${this.objId(vm!.path)}:${JSON.stringify(vm!.path.subpaths).length}:${vm!.feather}:${vm!.density}:${vm!.invert}` : ''}`;
    return this.cov.slot(key, 0, enc.serial, () => {
      const c = layerCoverage(ctx, layer, r)!;
      return { data: c, w: r.w, h: r.h };
    });
  }

  private op(enc: Encoding, o: {
    kind: number; mode?: string; opacity?: number; cov?: number; src?: SrcDesc; blendIf?: Layer; underIsDst?: boolean; lab?: boolean;
    chan?: number; adjCode?: number; adjWrap?: number; adjBase?: number; fill?: number; hdr?: boolean;
  }, dst: GPUBuffer, src: GPUBuffer | null, under: GPUBuffer | null, r: Rect) {
    const pb = new ArrayBuffer(PARAM_STRIDE);
    const u = new Uint32Array(pb), f = new Float32Array(pb), i32 = new Int32Array(pb);
    const sd = o.src ?? { src: SRC.none };
    let flags = 0;
    if (o.lab) flags |= FLAG.labBlend;
    if (o.underIsDst) flags |= FLAG.underIsDst;
    if (sd.groupUnpremul) flags |= FLAG.groupUnpremul;
    if (o.hdr) flags |= FLAG.hdr;
    let biBase = 0;
    const bi = o.blendIf?.advanced.blendIf;
    if (bi && blendIfActive(bi)) {
      flags |= FLAG.blendIf;
      const isDef = (q: number[]) => q[0] <= 0 && q[1] <= 0 && q[2] >= 255 && q[3] >= 255;
      const vals: number[] = [];
      for (const c of [bi.gray, bi.red, bi.green, bi.blue]) vals.push(isDef(c.thisLayer) ? 0 : 1, (under || o.underIsDst) && !isDef(c.underlying) ? 1 : 0, ...c.thisLayer, ...c.underlying);
      biBase = enc.pushF32(Float32Array.from(vals));
    }
    u[0] = o.kind; u[1] = BLEND_IDS[o.mode ?? 'normal'] ?? 0; u[2] = sd.src; u[3] = flags;
    u[4] = r.w; u[5] = r.h; i32[6] = r.x; i32[7] = r.y;
    f[8] = o.opacity ?? 1; u[9] = o.cov ?? EMPTY; u[10] = o.chan ?? 7; u[11] = o.adjCode ?? 0;
    const solid = sd.solid ?? [0, 0, 0, 0];
    f[12] = solid[0]; f[13] = solid[1]; f[14] = solid[2]; f[15] = solid[3];
    i32[16] = sd.rx0 ?? 0; i32[17] = sd.ry0 ?? 0; i32[18] = sd.gx0 ?? 0; i32[19] = sd.gy0 ?? 0;
    u[20] = sd.gw ?? 0; u[21] = sd.gh ?? 0; u[22] = sd.grid ?? 0; u[23] = o.adjBase ?? 0;
    u[24] = o.adjWrap ?? 0; u[25] = biBase; u[26] = r.w; u[27] = sd.srcOff ?? 0;
    f[28] = o.fill ?? 1;
    enc.params.push(pb);
    // CPU-uploaded content lives in the upload buffer.
    const srcBuf = sd.src === SRC.straight ? sd.buf ?? this.uploadBuf : src;
    enc.ops.push({ pipe: o.kind === OP.adjust ? adjustPipeline(o.adjCode ?? 0) : PIPELINE_OF[o.kind], dst, src: srcBuf, under, w: r.w, h: r.h });
  }

  private group(dst: GPUBuffer, src: GPUBuffer | null, under: GPUBuffer | null, op: number): GPUBindGroup {
    const s = src ?? this.dummy, u = under ?? this.dummy;
    const key = `${op}|${this.ids.get(dst)}|${this.ids.get(s)}|${this.ids.get(u)}|${this.ids.get(this.paramBuf)}|${this.ids.get(this.dataBuf)}|${this.ids.get(this.uploadBuf)}`;
    let g = this.groups.get(key);
    if (!g) {
      g = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: dst } }, { binding: 1, resource: { buffer: s } }, { binding: 2, resource: { buffer: u } },
          { binding: 3, resource: { buffer: this.paramBuf, offset: op * PARAM_STRIDE, size: 128 } }, { binding: 4, resource: { buffer: this.dataBuf } },
          { binding: 5, resource: this.atlases[0].views[0] }, { binding: 6, resource: this.atlases[0].views[1] }, { binding: 7, resource: this.atlases[0].views[2] },
          { binding: 8, resource: this.atlases[1].views[0] }, { binding: 9, resource: this.atlases[1].views[1] },
          { binding: 10, resource: this.atlases[2].views[0] },
          { binding: 11, resource: this.cov.views[0] }, { binding: 12, resource: this.cov.views[1] },
        ],
      });
      if (this.groups.size > 2048) this.groups.clear();
      this.groups.set(key, g);
    }
    return g;
  }

  private ensureCapacity(enc: Encoding) {
    const grow = (cur: number, need: number) => { let c = cur; while (c < need) c *= 2; return c; };
    if (enc.ops.length > this.paramCap) {
      this.paramCap = grow(this.paramCap, enc.ops.length);
      this.paramBuf.destroy();
      this.paramBuf = this.mkBuffer(PARAM_STRIDE * this.paramCap, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      this.groups.clear();
    }
    if (enc.data.length + 4 > this.dataCap) {
      this.dataCap = grow(this.dataCap, enc.data.length + 4);
      this.dataBuf.destroy();
      this.dataBuf = this.mkBuffer(this.dataCap * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.groups.clear();
    }
    if (enc.uploadLen > this.uploadCap) {
      this.uploadCap = grow(this.uploadCap, enc.uploadLen);
      this.uploadBuf.destroy();
      this.uploadBuf = this.mkBuffer(this.uploadCap * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.groups.clear();
    }
  }

  private submit(enc: Encoding, after: ((pass: GPUComputePassEncoder) => void) | null, tail?: (ce: GPUCommandEncoder) => void) {
    this.ensureCapacity(enc);
    const q = this.device.queue;
    if (enc.params.length) {
      const all = new Uint8Array(enc.params.length * PARAM_STRIDE);
      enc.params.forEach((pb, i) => all.set(new Uint8Array(pb), i * PARAM_STRIDE));
      q.writeBuffer(this.paramBuf, 0, all);
    }
    if (enc.data.length) q.writeBuffer(this.dataBuf, 0, Uint32Array.from(enc.data));
    if (enc.uploadLen) {
      const all = new Float32Array(enc.uploadLen * 4);
      let o = 0;
      for (const v of enc.upload) { all.set(v, o); o += v.length; }
      q.writeBuffer(this.uploadBuf, 0, all);
    }
    const ce = this.device.createCommandEncoder();
    const pass = ce.beginComputePass();
    let current: string | null = null;
    enc.ops.forEach((op, i) => {
      if (op.pipe !== current) { pass.setPipeline(this.pipeline(op.pipe)); current = op.pipe; }
      pass.setBindGroup(0, this.group(op.dst, op.src, op.under, i));
      pass.dispatchWorkgroups(Math.ceil(op.w / 16), Math.ceil(op.h / 16));
    });
    if (after) after(pass);
    pass.end();
    tail?.(ce);
    q.submit([ce.finish()]);
    this.release(enc);
  }

  /** CMYK → display RGB as an 18⁴ grid (ink steps of 15) built from the profile transform. */
  /** The CMYK display grid as a 3D texture (C, M; Y and K share the depth axis). */
  private cmykLut(grid: Float32Array): { view: GPUTextureView; n: number } {
    const hit = this.lutCache.get(grid);
    if (hit) return hit;
    const n = CMYK_GRID_N;
    const count = n ** 4;
    const rgba = new Float32Array(count * 4);
    for (let j = 0; j < count; j++) { rgba[j * 4] = grid[j * 3]; rgba[j * 4 + 1] = grid[j * 3 + 1]; rgba[j * 4 + 2] = grid[j * 3 + 2]; rgba[j * 4 + 3] = 1; }
    const tex = this.device.createTexture({ size: [n, n, n * n], format: 'rgba32float', dimension: '3d', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture: tex }, rgba, { bytesPerRow: n * 16, rowsPerImage: n }, [n, n, n * n]);
    const e = { tex, view: tex.createView(), n };
    this.lutCache.set(grid, e);
    return e;
  }
}

/** The CPU reference for the same region (tests and the CPU fallback use it). */
export const cpuComposite = compositeRegion;
