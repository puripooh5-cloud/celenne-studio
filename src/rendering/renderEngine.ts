/**
 * RenderEngine — viewport-driven, tiled, progressive rendering for one document.
 *
 *  Document change → dirty rects → display tiles marked stale (still drawable) →
 *  visible tiles re-rendered in priority order within a per-frame time budget →
 *  viewport uploads changed tiles to GPU textures.
 *
 * Tiles exist per pyramid level; only tiles the viewport requests are ever rendered, so a 16K
 * document at "fit on screen" renders ~20 low-level tiles, not 4096 full-resolution ones.
 */
import type { GpuCompositor } from '../gpu/compositor';
import { applyInkAppearance, needsInkDisplay } from './inkView';
import { blendIfActive, blendIfUsesUnderlying, channelsRestricted } from './blendIf';
import type { DocumentChange, CelenneDocument } from '../document/document';
import type { Layer, LayerId } from '../document/types';
import type { Rect } from '../image-engine/rect';
import { expand, intersect, isEmpty } from '../image-engine/rect';
import { compositeRegion, LayerOverride, layerInfluencePadding } from './compositor';
import { isCmykDoc } from '../color/plates';
import { layerVisualBounds, isUnbounded } from './bounds';
import { linearToSrgb } from '../color/convert';
import { translateLayerDeep } from '../document/translate';
import { hasEnabledEffect } from '../effects/types';

export const DISPLAY_TILE = 256;

export interface DisplayTile {
  level: number;
  tx: number;
  ty: number;
  /** Straight-alpha RGBA8 (document color space, display-ready encoding). */
  data: Uint8ClampedArray;
  /** Increments on every re-render (GPU upload key). */
  version: number;
  stale: boolean;
  lastUsed: number;
  /** Actual pixel size of the tile (edge tiles may be smaller). */
  w: number;
  h: number;
  /** Set when the tile was composited on the GPU: its pixels live in this texture, not in `data`. */
  gpu?: { texture: GPUTexture; view: GPUTextureView; storage: GPUTextureView };
}

/** The GPU compositor shared by every document's engine (null = CPU compositing). */
let activeGpu: GpuCompositor | null = null;
const engines = new Set<RenderEngine>();

/** Switches GPU compositing on (a compositor) or off (null) for every open document. */
export function setGpuCompositor(c: GpuCompositor | null): void {
  if (activeGpu === c) return;
  const old = activeGpu;
  for (const e of engines) e.releaseGpuTiles(old);
  activeGpu = c;
  for (const e of engines) e.invalidateAll();
}

export function gpuCompositor(): GpuCompositor | null {
  return activeGpu;
}

/** Visible colour channels: R G B (Gray, Lab L a b, CMYK C M Y) and `k` (CMYK Black). */
export type ChannelView = { r: boolean; g: boolean; b: boolean; k?: boolean };

export interface ViewOptions {
  /** Show a layer mask instead of the composite (Alt-click on mask thumbnail). */
  maskOfLayer: LayerId | null;
  channels: ChannelView;
  /** Overlay alpha channels / quick mask (rendered into tiles). */
  quickMask: boolean;
  quickMaskColor: [number, number, number, number];
  visibleAlphaChannels: string[];
  /** Soft-proof hook (applied per tile when set). */
  proof: ((rgba: Uint8ClampedArray) => void) | null;
  /** CMYK documents: ink (C M Y K, 0..255) → display RGB8, set by the viewport (profile / proofing). */
  cmykDisplay?: ((ink: Uint8Array, n: number) => Uint8Array) | null;
  /** The grid `cmykDisplay` evaluates (color/cmykDisplayGrid.ts); the GPU display path uses it too. */
  cmykGrid?: Float32Array | null;
}

const key = (l: number, x: number, y: number) => `${l}:${x}:${y}`;

export type LiftSetName = 'below' | 'moving' | 'above';

/**
 * Interactive "lift" of layers being dragged: the document is split into three cached tile sets
 * (everything below the moving layers, the moving layers alone, everything above). The viewport
 * draws them stacked with the moving set offset by the drag delta, so a drag costs no compositing
 * per pointer move. Only used when that stacking is equivalent to the real composite
 * (normal-blend layers, also inside plain groups; see liftPartition). A lift can be prepared
 * speculatively while the pointer hovers a layer (Move tool), so a drag starts without a hitch.
 *
 * Layers above that do not stack normally (blend modes, adjustments with a bounded extent) make the
 * tiles they cover "live": those tiles are composited exactly on every move while the rest of the
 * view still uses the stacked sets.
 */
export interface LiftState {
  ids: Set<LayerId>;
  dx: number;
  dy: number;
  sets: Record<LiftSetName, Map<string, DisplayTile>>;
  overrides: Record<LiftSetName, Map<LayerId, LayerOverride>>;
  /** Doc-px extent of each set's content ('all' = unbounded, null = empty). */
  extent: Record<LiftSetName, Rect | 'all' | null>;
  /** Region (doc px) covered by the moving layers at lift start; invalidated when the lift ends. */
  startBounds: Rect | null;
  /** After the drop: keep showing the lift until the exact tiles are rendered. */
  settling: boolean;
  /** Prepared at pointer-down; becomes active (drawn) once its tiles are ready after movement starts. */
  active: boolean;
  /** Movement has started: activate as soon as preparation completes. */
  wantActive: boolean;
  /** Visible tiles still to pre-render while the lift is being prepared. */
  prep: { set: LiftSetName; level: number; tx: number; ty: number }[];
  /** View level the preparation was made for (-1: none). */
  level: number;
  /** Doc-px region of the layers above that do not stack normally: tiles there are rendered exactly. */
  live: Rect | null;
}

function isNormalStack(l: Layer): boolean {
  if (!l.visible) return true;
  if (l.kind === 'adjustment') return false;
  // Depends on the pixels below it.
  if (blendIfUsesUnderlying(l.advanced.blendIf) || !(l.advanced.channels[0] && l.advanced.channels[1] && l.advanced.channels[2])) return false;
  if (l.kind === 'group') return (l.blendMode === 'passThrough' || l.blendMode === 'normal') && l.children.every(isNormalStack);
  return l.blendMode === 'normal';
}

/** Splits the root children into below / moving / above, or returns null when lifting would not be exact. */
function spanUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * A group the moving layers sit in can be looked through when compositing it is the same as
 * compositing its children in place: Pass Through or Normal at full opacity, with no mask, effects,
 * knockout or Blend If. (A Normal group is isolated; that is still exact as long as the layers above
 * the moving ones are a normal stack, which liftPartition requires anyway.)
 */
function transparentGroup(g: Layer): boolean {
  if (g.kind !== 'group' || !g.visible || g.clipping) return false;
  if (!(g.blendMode === 'passThrough' || g.blendMode === 'normal') || g.opacity < 1) return false;
  if ((g.mask && g.mask.enabled && g.mask.density > 0) || (g.vectorMask && g.vectorMask.enabled)) return false;
  if (hasEnabledEffect(g.effects) || blendIfActive(g.advanced.blendIf) || channelsRestricted(g.advanced) || g.advanced.knockout !== 'none') return false;
  return !g.children.some((c) => c.visible && c.advanced.knockout !== 'none');
}

/**
 * Splits the document into below / moving / above, or returns null when lifting would not be
 * exact. The moving layers may sit inside groups (see transparentGroup); each set is a list of
 * "units" — layers composited as a whole — in stacking order, so hiding every unit outside a set
 * renders exactly that set.
 */
export function liftPartition(doc: CelenneDocument, ids: LayerId[], opts: { live?: boolean } = {}): (Record<LiftSetName, Layer[]> & { live: Layer[] }) | null {
  if (!ids.length) return null;
  const moving = new Set(ids);
  const units: Layer[] = [];
  let ok = true;
  const contains = (g: Layer): boolean => g.kind === 'group' && g.children.some((c) => moving.has(c.id) || contains(c));
  const walk = (g: Layer & { children: Layer[] }) => {
    for (const c of g.children) {
      if (!moving.has(c.id) && contains(c)) {
        if (!transparentGroup(c)) ok = false;
        walk(c as Layer & { children: Layer[] });
      } else units.push(c);
    }
  };
  walk(doc.root);
  if (!ok) return null;
  const idx = ids.map((id) => units.findIndex((l) => l.id === id));
  if (idx.some((i) => i < 0)) return null;
  const lo = Math.min(...idx), hi = Math.max(...idx);
  for (let i = lo; i <= hi; i++) if (units[i].visible && !moving.has(units[i].id)) return null; // not contiguous
  for (const i of idx) {
    const l = units[i];
    if (l.clipping || !l.visible) return null;
    if (!(l.blendMode === 'normal' || (l.kind === 'group' && l.blendMode === 'passThrough'))) return null;
    if (l.kind === 'adjustment' || isUnbounded(l)) return null;
    if (!isNormalStack(l)) return null; // e.g. Blend If on the underlying pixels
    // Something clipped onto a moving layer would change with it.
    const sibs = l.parent?.children ?? doc.root.children;
    const next = sibs.slice(sibs.indexOf(l) + 1).find((s) => s.visible);
    if (next?.clipping) return null;
  }
  const above = units.slice(hi + 1);
  // Layers above that depend on what is below them: exact only where they are rendered live.
  const live = above.filter((l) => !isNormalStack(l));
  if (live.length && !opts.live) return null;
  return { below: units.slice(0, lo), moving: units.slice(lo, hi + 1), above, live };
}

export class RenderEngine {
  private tiles = new Map<string, DisplayTile>();
  private queue: { level: number; tx: number; ty: number; prio: number }[] = [];
  private queued = new Set<string>();
  private overrides = new Map<LayerId, LayerOverride>();
  lift: LiftState | null = null;
  private unsub: () => void;
  private clock = 0;
  maxBytes = 512 * 1024 * 1024;
  view: ViewOptions = {
    maskOfLayer: null,
    channels: { r: true, g: true, b: true },
    quickMask: false,
    quickMaskColor: [1, 0, 0, 0.5],
    visibleAlphaChannels: [],
    proof: null,
  };
  /** Called after tiles were (re)rendered. */
  onUpdate: (() => void) | null = null;
  renderedTiles = 0;
  lastRenderMs = 0;

  constructor(readonly doc: CelenneDocument) {
    this.unsub = doc.on((changes) => this.handleChanges(changes));
    engines.add(this);
  }

  dispose(): void {
    this.unsub();
    this.releaseGpuTiles(activeGpu);
    engines.delete(this);
    this.tiles.clear();
    this.queue = [];
    this.queued.clear();
  }

  levelSize(level: number): { w: number; h: number } {
    const s = 1 << level;
    return { w: Math.ceil(this.doc.width / s), h: Math.ceil(this.doc.height / s) };
  }

  maxLevel(): number {
    let l = 0;
    while (Math.max(this.doc.width, this.doc.height) / (1 << l) > DISPLAY_TILE && l < 12) l++;
    return l;
  }

  // -------------------------------------------------------------------------------------------
  // Invalidation
  // -------------------------------------------------------------------------------------------
  private handleChanges(changes: DocumentChange[]) {
    const lift = this.lift;
    if (lift && !lift.settling) {
      const onlyMoving = changes.every((c) => (c.type === 'pixels' || c.type === 'mask') && lift.ids.has(c.layerId));
      // Moving layers only change position during a lift; the lifted sets already show that.
      if (onlyMoving && lift.active) return;
      // While a dragged lift is still being prepared, moves render the normal way (the sets stay
      // valid: they are defined at the lift-start position). Anything else — including edits made
      // while a lift is only prepared speculatively — invalidates the cached sets.
      if (!onlyMoving || !lift.wantActive) this.dropLift();
    }
    let rects: Rect[] = [];
    let all = false;
    for (const c of changes) {
      switch (c.type) {
        case 'pixels':
        case 'mask': {
          const layer = this.doc.getLayer(c.layerId);
          if (!layer) { all = true; break; }
          const pad = layerInfluencePadding(layer) + 1;
          if (c.rect) rects.push(expand(c.rect, pad));
          else {
            const b = isUnbounded(layer) ? null : layerVisualBounds(layer);
            if (b) rects.push(expand(b, pad));
            else all = true;
          }
          break;
        }
        case 'layer':
        case 'structure':
        case 'canvas':
          all = true;
          break;
        case 'selection':
          if (this.view.quickMask) all = true;
          break;
        case 'channels':
          if (this.view.visibleAlphaChannels.length || this.view.quickMask || needsInkDisplay(this.doc)) all = true;
          break;
      }
    }
    if (changes.some((c) => c.type === 'canvas')) {
      this.releaseGpuTiles(activeGpu);
      this.tiles.clear();
      this.queue = [];
      this.queued.clear();
    }
    if (all) rects = [this.doc.bounds];
    for (const r of rects) this.invalidate(r);
  }

  /** Marks display tiles overlapping `r` (document px) as stale. */
  invalidate(r: Rect | null): void {
    const docR = r ?? this.doc.bounds;
    for (const t of this.tiles.values()) {
      const s = 1 << t.level;
      const tr = { x: t.tx * DISPLAY_TILE * s, y: t.ty * DISPLAY_TILE * s, w: DISPLAY_TILE * s, h: DISPLAY_TILE * s };
      if (!isEmpty(intersect(tr, docR))) t.stale = true;
    }
    this.onUpdate?.();
  }

  invalidateAll(): void {
    this.invalidate(null);
  }

  /** Live preview override for a layer (transform drag, filter preview...). */
  setOverride(id: LayerId, ov: LayerOverride | null, dirty: Rect | null = null): void {
    if (ov) this.overrides.set(id, ov);
    else this.overrides.delete(id);
    this.invalidate(dirty);
  }

  // -------------------------------------------------------------------------------------------
  // Lift (interactive layer drag)
  // -------------------------------------------------------------------------------------------
  /** Starts a lift for top-level layers. Returns false when lifting would not be exact. */
  beginLift(ids: LayerId[], startBounds: Rect | null): boolean {
    this.dropLift();
    const v = this.view;
    // Inks (Duotone, Multichannel, spot channels) are applied to the whole composite, not per lift set.
    if (v.maskOfLayer || v.quickMask || v.visibleAlphaChannels.length || v.proof || !(v.channels.r && v.channels.g && v.channels.b) || needsInkDisplay(this.doc)) return false;
    if (this.overrides.size) return false;
    const part = liftPartition(this.doc, ids, { live: true });
    if (!part) return false;
    const units = [...part.below, ...part.moving, ...part.above];
    const hideAllBut = (keep: Layer[]) => {
      const m = new Map<LayerId, LayerOverride>();
      const k = new Set(keep.map((l) => l.id));
      for (const l of units) if (!k.has(l.id)) m.set(l.id, { hidden: true });
      return m;
    };
    const extentOf = (ls: Layer[]): Rect | 'all' | null => {
      let u: Rect | null = null;
      for (const l of ls) {
        if (!l.visible) continue;
        const b = layerVisualBounds(l);
        if (!b) { if (isUnbounded(l) || l.kind === 'group') return 'all'; continue; }
        const pad = layerInfluencePadding(l);
        u = u ? spanUnion(u, expand(b, pad)) : expand(b, pad);
      }
      return u;
    };
    const live = extentOf(part.live);
    if (live === 'all') return false; // e.g. an adjustment layer over everything: nothing to gain
    this.lift = {
      ids: new Set(ids),
      dx: 0,
      dy: 0,
      sets: { below: new Map(), moving: new Map(), above: new Map() },
      overrides: { below: hideAllBut(part.below), moving: hideAllBut(part.moving), above: hideAllBut(part.above) },
      extent: { below: extentOf(part.below), moving: extentOf(part.moving), above: extentOf(part.above) },
      startBounds,
      settling: false,
      active: false,
      wantActive: false,
      prep: [],
      level: this.lastVisible?.level ?? -1,
      live,
    };
    // Pre-render the sets for the tiles currently on screen in spare frame time.
    const vis = this.lastVisible;
    if (vis) for (const set of ['moving', 'above', 'below'] as const) for (const [tx, ty] of vis.tiles) this.lift.prep.push({ set, level: vis.level, tx, ty });
    return true;
  }

  /** A prepared (not yet shown) lift of exactly these layers, still valid for the current view level. */
  preparedLift(ids: LayerId[], level: number): boolean {
    const l = this.lift;
    if (!l || l.active || l.settling || l.wantActive || l.level !== level) return false;
    return ids.length === l.ids.size && ids.every((id) => l.ids.has(id));
  }

  /** Discards a prepared lift that was never shown (tool switch, hover over another layer). */
  dropPreparedLift(): void {
    if (this.lift && !this.lift.active && !this.lift.wantActive) this.dropLift();
  }

  /** Movement started: show the lift as soon as its tiles are ready (no frame hitch). */
  activateLift(): void {
    const lift = this.lift;
    if (!lift) return;
    lift.wantActive = true;
    if (!lift.prep.length) this.showLift();
  }

  private showLift() {
    const lift = this.lift!;
    if (lift.active) return;
    lift.active = true;
    this.onUpdate?.();
  }

  /** Tiles the viewport last displayed (used to pre-render lift sets). */
  lastVisible: { level: number; tiles: [number, number][] } | null = null;

  /** Current drag offset (tracked from the first move, also while the lift is still preparing). */
  setLiftOffset(dx: number, dy: number): void {
    const lift = this.lift;
    if (!lift) return;
    const px = lift.dx, py = lift.dy;
    lift.dx = dx;
    lift.dy = dy;
    // Live tiles show the exact composite: re-render where the moving layers were and are now.
    const m = lift.extent.moving;
    if (lift.live && m && m !== 'all') {
      for (const r of [{ ...m, x: m.x + px, y: m.y + py }, { ...m, x: m.x + dx, y: m.y + dy }]) {
        const hit = intersect(expand(r, 1), lift.live);
        if (!isEmpty(hit)) this.invalidate(hit);
      }
    }
    if (lift.active) this.onUpdate?.();
  }

  /** Whether display tile (level, tx, ty) lies in the lift's live region. */
  isLiveTile(level: number, tx: number, ty: number): boolean {
    const live = this.lift?.live;
    if (!live) return false;
    const s = DISPLAY_TILE << level;
    return !isEmpty(intersect({ x: tx * s, y: ty * s, w: s, h: s }, live));
  }

  /** Ends the drag: exact tiles for the affected region are re-rendered while the lift stays visible. */
  endLift(finalBounds: Rect | null): void {
    const lift = this.lift;
    if (!lift) return;
    if (!lift.active) {
      // Never shown: the moves were rendered the normal way.
      this.dropLift();
      return;
    }
    lift.settling = true;
    const pad = Math.max(0, ...[...lift.ids].map((id) => { const l = this.doc.getLayer(id); return l ? layerInfluencePadding(l) : 0; })) + 1;
    for (const r of [lift.startBounds, finalBounds]) if (r) this.invalidate(expand(r, pad));
    if (!lift.startBounds || !finalBounds) this.invalidateAll();
  }

  /** Called by the viewport once the exact tiles are complete. */
  finishLift(): void {
    this.dropLift();
    this.onUpdate?.();
  }

  /** Ends a lift and frees its GPU tile textures. */
  private dropLift(): void {
    const lift = this.lift;
    this.lift = null;
    if (!lift || !activeGpu) return;
    for (const set of Object.values(lift.sets)) for (const t of set.values()) if (t) activeGpu.releaseTile(t);
  }

  /** Frees every GPU tile texture (compositor switched or lost); the tiles re-render. */
  releaseGpuTiles(c: GpuCompositor | null): void {
    for (const t of this.tiles.values()) {
      if (!t.gpu) continue;
      if (c) c.releaseTile(t);
      else t.gpu = undefined;
      t.stale = true;
    }
    if (this.lift) {
      for (const set of Object.values(this.lift.sets)) for (const t of set.values()) if (t?.gpu) { if (c) c.releaseTile(t); else t.gpu = undefined; }
      this.lift = null;
    }
  }

  /** Lifted tile for one set (rendered on demand, cached for the lift's lifetime). null = empty. */
  liftTile(set: LiftSetName, level: number, tx: number, ty: number): DisplayTile | null {
    const lift = this.lift;
    if (!lift) return null;
    const k = key(level, tx, ty);
    const cache = lift.sets[set];
    if (cache.has(k)) return cache.get(k) ?? null;
    const { w: lw, h: lh } = this.levelSize(level);
    const r = { x: tx * DISPLAY_TILE, y: ty * DISPLAY_TILE, w: Math.min(DISPLAY_TILE, lw - tx * DISPLAY_TILE), h: Math.min(DISPLAY_TILE, lh - ty * DISPLAY_TILE) };
    const s = 1 << level;
    const r0 = { x: r.x * s - s, y: r.y * s - s, w: (r.w + 2) * s, h: (r.h + 2) * s };
    // Moving content is defined at its lift-start position.
    const touches = (e: Rect | 'all' | null, dx = 0, dy = 0) => e === 'all' || (!!e && !isEmpty(intersect({ x: e.x - dx, y: e.y - dy, w: e.w, h: e.h }, r0)));
    if (r.w <= 0 || r.h <= 0 || !touches(lift.extent[set])) {
      cache.set(k, null as unknown as DisplayTile);
      return null;
    }
    if (set === 'below' && !touches(lift.extent.moving) && !touches(lift.extent.above)) {
      // Nothing moving or above here at lift start: the exact tile already is the "below" image.
      const exact = this.tiles.get(k);
      if (exact && !exact.stale && !exact.gpu) {
        const copy: DisplayTile = { ...exact, data: exact.data.slice(), version: 1, lastUsed: ++this.clock };
        cache.set(k, copy);
        return copy;
      }
    }
    const tile: DisplayTile = { level, tx, ty, data: new Uint8ClampedArray(DISPLAY_TILE * DISPLAY_TILE * 4), version: 1, stale: false, lastUsed: ++this.clock, w: Math.max(0, r.w), h: Math.max(0, r.h) };
    {
      // Moving tiles are defined at the lift-start position (the viewport adds the offset).
      const shift = set === 'moving' && (lift.dx || lift.dy);
      const moving = shift ? [...lift.ids].map((id) => this.doc.getLayer(id)).filter((l): l is Layer => !!l) : [];
      for (const l of moving) translateLayerDeep(l, -lift.dx, -lift.dy);
      try {
        this.renderInto(tile, r, level, lift.overrides[set]);
      } finally {
        for (const l of moving) translateLayerDeep(l, lift.dx, lift.dy);
      }
    }
    lift.sets[set].set(k, tile);
    return tile;
  }

  getOverride(id: LayerId): LayerOverride | undefined {
    return this.overrides.get(id);
  }

  hasOverrides(): boolean {
    return this.overrides.size > 0;
  }

  setView(v: Partial<ViewOptions>): void {
    this.view = { ...this.view, ...v };
    this.invalidateAll();
  }

  // -------------------------------------------------------------------------------------------
  // Tile access / scheduling
  // -------------------------------------------------------------------------------------------
  getTile(level: number, tx: number, ty: number): DisplayTile | undefined {
    const t = this.tiles.get(key(level, tx, ty));
    if (t) t.lastUsed = ++this.clock;
    return t;
  }

  /** Requests tiles needed for display. Priority: lower = sooner. */
  request(level: number, tx: number, ty: number, prio: number): void {
    const k = key(level, tx, ty);
    const t = this.tiles.get(k);
    if (t && !t.stale) return;
    if (this.queued.has(k)) {
      const q = this.queue.find((e) => e.level === level && e.tx === tx && e.ty === ty);
      if (q && prio < q.prio) q.prio = prio;
      return;
    }
    this.queued.add(k);
    this.queue.push({ level, tx, ty, prio });
  }

  hasPendingWork(): boolean {
    return this.queue.length > 0 || !!this.lift?.prep.length;
  }

  clearQueue(): void {
    this.queue = [];
    this.queued.clear();
  }

  /** Renders queued tiles until `budgetMs` elapses. Returns the number of tiles rendered. */
  process(budgetMs = 10): number {
    if (!this.queue.length && !this.lift?.prep.length) return 0;
    const start = performance.now();
    // A lift being dragged goes first: once shown, the drag needs no per-frame tile rendering at
    // all. A speculative one (pointer hovering) only uses time the visible tiles do not need.
    const lift = this.lift;
    while (lift && lift.prep.length && (lift.wantActive || !this.queue.length) && performance.now() - start <= budgetMs) {
      const j = lift.prep.shift()!;
      this.liftTile(j.set, j.level, j.tx, j.ty);
    }
    if (lift && lift.wantActive && !lift.active && !lift.prep.length) this.showLift();
    const lifted = !!(lift?.active && !lift.settling);
    if (lifted && !lift!.live) {
      // Exact tiles are stale by design while lifted; re-render them after the drop.
      this.lastRenderMs = performance.now() - start;
      return 0;
    }
    this.queue.sort((a, b) => a.prio - b.prio);
    let n = 0;
    // While lifted, only live tiles are rendered (the others wait for the drop).
    const waiting: typeof this.queue = [];
    while (this.queue.length) {
      const job = this.queue.shift()!;
      if (lifted && !this.isLiveTile(job.level, job.tx, job.ty)) { waiting.push(job); continue; }
      this.queued.delete(key(job.level, job.tx, job.ty));
      const existing = this.tiles.get(key(job.level, job.tx, job.ty));
      if (existing && !existing.stale) continue;
      this.renderTile(job.level, job.tx, job.ty);
      n++;
      if (performance.now() - start > budgetMs) break;
    }
    if (waiting.length) this.queue.push(...waiting);
    this.lastRenderMs = performance.now() - start;
    this.renderedTiles += n;
    if (n) {
      this.evict();
      this.onUpdate?.();
    }
    return n;
  }

  /** Synchronously renders a full level (used for export previews / navigator). */
  renderLevelSync(level: number): void {
    const { w, h } = this.levelSize(level);
    for (let ty = 0; ty * DISPLAY_TILE < h; ty++) for (let tx = 0; tx * DISPLAY_TILE < w; tx++) {
      const t = this.tiles.get(key(level, tx, ty));
      if (!t || t.stale) this.renderTile(level, tx, ty);
    }
  }

  private renderTile(level: number, tx: number, ty: number): DisplayTile {
    const { w: lw, h: lh } = this.levelSize(level);
    const r = { x: tx * DISPLAY_TILE, y: ty * DISPLAY_TILE, w: Math.min(DISPLAY_TILE, lw - tx * DISPLAY_TILE), h: Math.min(DISPLAY_TILE, lh - ty * DISPLAY_TILE) };
    const k = key(level, tx, ty);
    let tile = this.tiles.get(k);
    if (!tile) {
      tile = { level, tx, ty, data: new Uint8ClampedArray(DISPLAY_TILE * DISPLAY_TILE * 4), version: 0, stale: true, lastUsed: ++this.clock, w: r.w, h: r.h };
      this.tiles.set(k, tile);
    }
    tile.w = r.w;
    tile.h = r.h;
    if (r.w <= 0 || r.h <= 0) {
      tile.stale = false;
      return tile;
    }
    const v = this.view;
    if (v.maskOfLayer) {
      if (tile.gpu) activeGpu?.releaseTile(tile);
      this.toDisplay(this.renderMaskView(v.maskOfLayer, r, level), r, tile.data, level, true);
    } else this.renderInto(tile, r, level, this.overrides);
    tile.version++;
    tile.stale = false;
    tile.lastUsed = ++this.clock;
    return tile;
  }

  /** Composites into a display tile: on the GPU when possible, otherwise with the CPU compositor. */
  private renderInto(tile: DisplayTile, r: Rect, level: number, overrides: Map<LayerId, LayerOverride>): void {
    const gpu = activeGpu;
    if (gpu && gpu.renderDisplayTile(this.doc, this.view, r, level, overrides, tile)) return;
    if (tile.gpu) { if (gpu) gpu.releaseTile(tile); else tile.gpu = undefined; }
    this.compositeToDisplay(r, level, overrides, tile.data);
  }

  private renderMaskView(layerId: LayerId, r: Rect, level: number): Float32Array {
    const l = this.doc.getLayer(layerId);
    const out = new Float32Array(r.w * r.h * 4);
    if (!l?.mask) return out;
    const s = 1 << level;
    const m = l.mask.raster.readFloat({ x: r.x - Math.round(l.mask.x / s), y: r.y - Math.round(l.mask.y / s), w: r.w, h: r.h }, level);
    for (let i = 0; i < m.length; i++) {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = m[i];
      out[i * 4 + 3] = 1;
    }
    return out;
  }

  private compositeToDisplay(r: Rect, level: number, overrides: Map<LayerId, LayerOverride>, out: Uint8ClampedArray) {
    if (isCmykDoc(this.doc)) {
      const p0 = compositeRegion(this.doc, r, { level, overrides, plate: 0 });
      const p1 = compositeRegion(this.doc, r, { level, overrides, plate: 1 });
      this.cmykToDisplay(p0, p1, r, out, level);
      return;
    }
    const buf = compositeRegion(this.doc, r, { level, overrides });
    const v = this.view;
    if (needsInkDisplay(this.doc) && ((v.channels.r && v.channels.g && v.channels.b) || this.doc.canvas.colorMode === 'multichannel')) {
      // Duotone / Multichannel / spot channels: how the inks print (sRGB, see CanvasView's display LUT).
      const n = r.w * r.h;
      for (let i = 0; i < n; i++) { const a = buf[i * 4 + 3]; if (a > 1e-7) { buf[i * 4] /= a; buf[i * 4 + 1] /= a; buf[i * 4 + 2] /= a; } }
      applyInkAppearance(this.doc, buf, r, level, true);
      for (let i = 0; i < n; i++) { const a = buf[i * 4 + 3]; buf[i * 4] *= a; buf[i * 4 + 1] *= a; buf[i * 4 + 2] *= a; }
      this.toDisplay(buf, r, out, level, true);
      return;
    }
    this.toDisplay(buf, r, out, level);
  }

  /** CMYK plates (premultiplied inverted ink) → display RGBA8, with channel view and overlays. */
  private cmykToDisplay(p0: Float32Array, p1: Float32Array, r: Rect, out: Uint8ClampedArray, level: number) {
    const v = this.view;
    const ch = v.channels;
    const on = [ch.r, ch.g, ch.b, ch.k !== false];
    const count = on.filter(Boolean).length;
    const n = r.w * r.h;
    const ink = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const a = p0[i * 4 + 3];
      if (a <= 1e-6) continue;
      const k = 1 / a;
      ink[i * 4] = on[0] ? (1 - p0[i * 4] * k) * 255 + 0.5 : 0;
      ink[i * 4 + 1] = on[1] ? (1 - p0[i * 4 + 1] * k) * 255 + 0.5 : 0;
      ink[i * 4 + 2] = on[2] ? (1 - p0[i * 4 + 2] * k) * 255 + 0.5 : 0;
      ink[i * 4 + 3] = on[3] ? (1 - p1[i * 4] * (p1[i * 4 + 3] > 1e-6 ? 1 / p1[i * 4 + 3] : 0)) * 255 + 0.5 : 0;
    }
    let rgb: Uint8Array;
    if (count === 1) {
      // A single channel shows as gray: 100 % ink = black.
      const c = on.indexOf(true);
      rgb = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = 255 - ink[i * 4 + c];
    } else if (v.cmykDisplay) rgb = v.cmykDisplay(ink, n);
    else {
      rgb = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        const kk = 1 - ink[i * 4 + 3] / 255;
        rgb[i * 3] = (255 - ink[i * 4]) * kk; rgb[i * 3 + 1] = (255 - ink[i * 4 + 1]) * kk; rgb[i * 3 + 2] = (255 - ink[i * 4 + 2]) * kk;
      }
    }
    // Reuse the RGB display path for overlays (quick mask, alpha channels): feed it straight RGB.
    const buf = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      buf[i * 4] = rgb[i * 3] / 255; buf[i * 4 + 1] = rgb[i * 3 + 1] / 255; buf[i * 4 + 2] = rgb[i * 3 + 2] / 255; buf[i * 4 + 3] = p0[i * 4 + 3];
    }
    if (count === 4) applyInkAppearance(this.doc, buf, r, level, true); // spot channels over the inks
    for (let i = 0; i < n; i++) { const a = buf[i * 4 + 3]; buf[i * 4] *= a; buf[i * 4 + 1] *= a; buf[i * 4 + 2] *= a; }
    this.toDisplay(buf, r, out, level, true);
  }

  /** Premultiplied float → straight RGBA8, with channel view, overlays and proofing. */
  private toDisplay(buf: Float32Array, r: Rect, out: Uint8ClampedArray, level: number, allChannels = false) {
    // `allChannels`: the buffer is already display RGB (CMYK) or a mask: no channel view or linear decoding.
    const linear = !allChannels && this.doc.canvas.bitDepth === 32;
    const v = this.view;
    const ch = allChannels ? { r: true, g: true, b: true } : v.channels;
    const lab = this.doc.canvas.colorMode === 'lab';
    const single = [ch.r, ch.g, ch.b].filter(Boolean).length === 1;
    const s = 1 << level;
    let qm: Float32Array | null = null;
    if (v.quickMask) qm = this.doc.selection.mask.readFloat({ x: r.x, y: r.y, w: r.w, h: r.h }, level);
    const alphaOverlays = v.visibleAlphaChannels
      .map((id) => this.doc.channels.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({ c, data: c.raster.readFloat({ x: r.x, y: r.y, w: r.w, h: r.h }, level) }));
    if (!linear && !single && ch.r && ch.g && ch.b && !qm && !alphaOverlays.length) {
      // Common case: plain composite → straight RGBA8.
      for (let y = 0; y < r.h; y++) {
        let i = y * r.w * 4, o = y * DISPLAY_TILE * 4;
        for (let x = 0; x < r.w; x++, i += 4, o += 4) {
          const a = buf[i + 3];
          if (a > 1e-6) {
            const k = 255 / a;
            out[o] = buf[i] * k; out[o + 1] = buf[i + 1] * k; out[o + 2] = buf[i + 2] * k; out[o + 3] = a * 255;
          } else out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
        }
      }
      if (v.proof && !allChannels) v.proof(out);
      return;
    }
    out.fill(0);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const i = y * r.w + x;
        const o = (y * DISPLAY_TILE + x) * 4;
        const a = buf[i * 4 + 3];
        let R = 0, G = 0, B = 0;
        if (a > 1e-6) {
          const k = 1 / a;
          R = buf[i * 4] * k; G = buf[i * 4 + 1] * k; B = buf[i * 4 + 2] * k;
          if (linear) { R = linearToSrgb(Math.max(0, R)); G = linearToSrgb(Math.max(0, G)); B = linearToSrgb(Math.max(0, B)); }
        }
        if (single) {
          const g = ch.r ? R : ch.g ? G : B;
          // Lab: show the channel as lightness with neutral a / b (the display LUT reads Lab).
          if (lab) { R = g; G = B = 128 / 255; }
          else R = G = B = g;
        } else if (!(ch.r && ch.g && ch.b)) {
          // Hidden channels: zero (RGB) or neutral (Lab a / b; Lab L shows as mid gray).
          if (!ch.r) R = lab ? 0.5 : 0;
          if (!ch.g) G = lab ? 128 / 255 : 0;
          if (!ch.b) B = lab ? 128 / 255 : 0;
        }
        let A = a;
        for (const ov of alphaOverlays) {
          const m = ov.c.indicatesSelected ? ov.data[i] : 1 - ov.data[i];
          const k = m * ov.c.opacity;
          R += (ov.c.color.r - R) * k; G += (ov.c.color.g - G) * k; B += (ov.c.color.b - B) * k;
          A = Math.max(A, k);
        }
        if (qm) {
          const k = (1 - qm[i]) * v.quickMaskColor[3];
          R += (v.quickMaskColor[0] - R) * k; G += (v.quickMaskColor[1] - G) * k; B += (v.quickMaskColor[2] - B) * k;
          A = Math.max(A, k);
        }
        out[o] = R * 255; out[o + 1] = G * 255; out[o + 2] = B * 255; out[o + 3] = A * 255;
      }
    }
    void s;
    if (v.proof && !allChannels) v.proof(out);
  }

  private evict() {
    const bytesPer = DISPLAY_TILE * DISPLAY_TILE * 4;
    const max = Math.max(64, Math.floor(this.maxBytes / bytesPer));
    if (this.tiles.size <= max) return;
    const sorted = [...this.tiles.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < sorted.length - max; i++) {
      const t = sorted[i][1];
      if (t.gpu) activeGpu?.releaseTile(t);
      this.tiles.delete(sorted[i][0]);
    }
  }

  purge(): void {
    this.releaseGpuTiles(activeGpu);
    this.tiles.clear();
    this.clearQueue();
  }

  cacheBytes(): number {
    return this.tiles.size * DISPLAY_TILE * DISPLAY_TILE * 4;
  }

  tileCount(): number {
    return this.tiles.size;
  }
}
