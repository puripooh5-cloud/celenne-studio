/**
 * Free Transform (Ctrl+T) and quick transforms.
 *
 * The transform is kept as an affine matrix M (base rectangle → parallelogram) until the user
 * distorts or applies perspective, at which point it becomes a free quad (homography).
 * Preview: render-engine overrides resample the original rasters at the display level.
 * Commit: pixels resample once (bicubic); text, shapes, vector masks and smart objects are
 * transformed parametrically (non-destructive).
 *
 * Warp (Edit ▸ Transform ▸ Warp) replaces the matrix with a 4×4 Bézier envelope over the base
 * rectangle; smart objects keep the warp as a parameter (source-space envelope).
 * Transform Selection uses the same controller on the selection outline only.
 */
import { ensureCompanion, isCmykDoc } from '../color/plates';
import type { Tool, ToolHost, ToolPointer } from './tool';
import { editor } from '../app/editor';
import { ui } from '../app/store';
import type { DocumentSession } from '../app/session';
import type { Layer, LayerId } from '../document/types';
import { hasRaster } from '../document/types';
import { cloneLayer } from '../document/clone';
import { Affine, affineToHomography, apply, applyH, decompose, Homography, invert, invertH, isAffineQuad, multiply, multiplyH, Point, Quad, rectToQuad, rotation, scaling, translation } from '../image-engine/matrix';
import type { Rect } from '../image-engine/rect';
import { union } from '../image-engine/rect';
import { layerContentBounds } from '../rendering/bounds';
import { rasterContentBounds } from '../rendering/bounds';
import { warpRaster } from '../image-engine/resample';
import { warpLayerRaster, transformLayer } from '../app/ops/imageOps';
import { CompositeCommand, ReplaceLayerCommand, TransformLayerCommand } from '../commands/layerCommands';
import { updateAppearance } from '../layers/appearance';
import { RasterEditCommand } from '../commands/rasterCommands';
import type { RasterSnapshot } from '../image-engine/tiledRaster';
import { TiledRaster } from '../image-engine/tiledRaster';
import { dragSurface, evalGrid, fitGrid, inverseGrid, isIdentityGrid, meshWarpLayerRaster, meshWarpRegion, presetGrid, rectGrid, sampleMesh, WarpGrid, WarpPreset } from '../image-engine/warp';
import { traceContours } from '../selection/ops';

type Handle = { kind: 'corner'; i: number } | { kind: 'edge'; i: number } | { kind: 'move' } | { kind: 'rotate' } | { kind: 'ref' } | { kind: 'warpPoint'; i: number } | { kind: 'surface'; u: number; v: number };
export type TransformKind = 'free' | 'scale' | 'rotate' | 'skew' | 'distort' | 'perspective' | 'warp';

/** Envelope points shown as handles: corners and their tangent handles (interior points follow surface drags). */
const WARP_HANDLES = [0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15];
const CORNER_FOLLOWERS: Record<number, number[]> = { 0: [1, 4, 5], 3: [2, 7, 6], 12: [8, 13, 9], 15: [11, 14, 10] };

interface FloatState {
  layerId: LayerId;
  before: RasterSnapshot;
  cut: RasterSnapshot;
  float: TiledRaster;
  selBefore: RasterSnapshot;
}

interface State {
  session: DocumentSession;
  ids: LayerId[];
  base: Rect;
  M: Affine;
  quad: Quad | null;
  ref: Point;
  kind: TransformKind;
  originals: Map<LayerId, Layer>;
  float: FloatState | null;
  /** Warp envelope (document space) while in warp mode; `preset` is null for a custom envelope. */
  warp: { grid: WarpGrid; preset: WarpPreset | null } | null;
  /** Transform Selection: only the selection outline is transformed. */
  selOnly: { before: RasterSnapshot; mask: TiledRaster; polys: number[][] } | null;
}

let st: State | null = null;

export function transformState(): Readonly<State> | null {
  return st;
}

/** True while Select ▸ Transform Selection is running (the canvas hides the normal ants). */
export function transformingSelection(): boolean {
  return !!st?.selOnly;
}

function baseQuad(b: Rect): Quad {
  return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }];
}

function currentQuad(s: State): Quad {
  if (s.warp) { const g = s.warp.grid; return [g[0], g[3], g[15], g[12]]; }
  return s.quad ?? (baseQuad(s.base).map((p) => apply(s.M, p.x, p.y)) as Quad);
}

/** Homography: original document coordinates → transformed document coordinates. */
function homography(s: State): Homography {
  if (!s.quad) return affineToHomography(s.M);
  return multiplyH(rectToQuad(s.base.w, s.base.h, s.quad), [1, 0, -s.base.x, 0, 1, -s.base.y, 0, 0, 1]);
}

/** Forward map of the current warp over the base rectangle (u, v ∈ [0, 1] → document). */
function warpMap(s: State): (u: number, v: number) => Point {
  const g = s.warp!.grid;
  return (u, v) => evalGrid(g, u, v);
}

function rasterLayers(l: Layer): Layer[] {
  if (l.kind === 'group') return l.children.flatMap(rasterLayers);
  return hasRaster(l) ? [l] : [];
}

/** Composites straight RGBA `fl` over `base` in place. */
function overInPlace(base: Float32Array, fl: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) {
    const sa = fl[i * 4 + 3];
    if (sa <= 0) continue;
    const da = base[i * 4 + 3], oa = sa + da * (1 - sa);
    for (let c = 0; c < 3; c++) base[i * 4 + c] = (fl[i * 4 + c] * sa + base[i * 4 + c] * da * (1 - sa)) / oa;
    base[i * 4 + 3] = oa;
  }
}

/** A mask as a straight RGBA raster (value in R, opaque) for resampling. */
function maskAsRgba(m: { raster: TiledRaster }): { raster: TiledRaster; bounds: Rect } | null {
  const mb = rasterContentBounds(m.raster) ?? m.raster.tileBounds();
  if (!mb) return null;
  const v = m.raster.readFloat(mb);
  const rgba = new Float32Array(mb.w * mb.h * 4);
  for (let i = 0; i < v.length; i++) { rgba[i * 4] = v[i]; rgba[i * 4 + 3] = 1; }
  const tmp = new TiledRaster(4, 32, 0);
  tmp.writeFloat(mb, rgba);
  return { raster: tmp, bounds: mb };
}

function updatePreview(s: State): void {
  if (s.selOnly) return; // outline only (drawn by the overlay)
  const eng = s.session.engine;
  const H = homography(s);
  const inv = invertH(H);
  const mesh = s.warp ? sampleMesh(warpMap(s)) : null;
  const base = s.base;
  const targets = s.float ? [s.session.doc.getLayer(s.float.layerId)!] : s.ids.flatMap((id) => rasterLayers(s.originals.get(id)!));
  for (const l of targets) {
    const orig = s.float ? null : (l as Layer & { raster: TiledRaster });
    // Text layers are not warped by the envelope (see commitTransform).
    const skip = !!mesh && !s.float && l.kind === 'text';
    // CMYK: each plate previews from its own raster (bounds from plate 0).
    const cmyk = isCmykDoc(s.session.doc);
    const plateOf = (r: TiledRaster, plate: number) => (plate && cmyk ? ensureCompanion(r) : r);
    eng.setOverride(l.id, skip ? null : {
      includesMask: !s.float,
      read: (r, level, plate = 0) => {
        const sc = 1 << level;
        const scale: Homography = [sc, 0, 0, 0, sc, 0, 0, 0, 1];
        if (s.float) {
          // Cut layer + transformed floating pixels.
          const live = s.session.doc.getLayer(s.float.layerId) as Layer & { raster: TiledRaster; x: number; y: number };
          const out = plateOf(live.raster, plate).readFloat({ x: r.x - Math.round(live.x / sc), y: r.y - Math.round(live.y / sc), w: r.w, h: r.h }, level);
          const fb = rasterContentBounds(s.float.float);
          if (!fb) return out;
          const fr = plateOf(s.float.float, plate);
          const fl = mesh ? meshWarpRegion({ raster: fr, ox: 0, oy: 0, bounds: fb }, base, mesh, r, level) : warpRaster(fr, fb, multiplyH(inv, scale), r, 'bilinear');
          overInPlace(out, fl, r.w * r.h);
          return out;
        }
        const src = orig!;
        const b = rasterContentBounds(src.raster);
        if (!b) return new Float32Array(r.w * r.h * 4);
        const sr = plateOf(src.raster, plate);
        const px = mesh
          ? meshWarpRegion({ raster: sr, ox: src.x, oy: src.y, bounds: b }, base, mesh, r, level)
          : warpRaster(sr, b, multiplyH([1, 0, -src.x, 0, 1, -src.y, 0, 0, 1], multiplyH(inv, scale)), r, 'bilinear');
        if (src.mask && src.mask.enabled) {
          const m = src.mask;
          const tmp = maskAsRgba(m);
          if (tmp) {
            const mv = mesh && m.linked
              ? meshWarpRegion({ raster: tmp.raster, ox: m.x, oy: m.y, bounds: tmp.bounds }, base, mesh, r, level)
              : warpRaster(tmp.raster, tmp.bounds, multiplyH([1, 0, -m.x, 0, 1, -m.y, 0, 0, 1], multiplyH(m.linked && !mesh ? inv : [1, 0, 0, 0, 1, 0, 0, 0, 1], scale)), r, 'bilinear');
            for (let i = 0; i < r.w * r.h; i++) {
              const val = m.raster.fill + (mv[i * 4] - m.raster.fill) * mv[i * 4 + 3];
              px[i * 4 + 3] *= 1 - m.density * (1 - val);
            }
          } else if (m.raster.fill < 1) for (let i = 0; i < r.w * r.h; i++) px[i * 4 + 3] *= 1 - m.density * (1 - m.raster.fill);
        }
        return px;
      },
    }, null);
  }
  eng.invalidateAll();
}

function clearPreview(s: State): void {
  if (s.selOnly) return;
  const ids = s.float ? [s.float.layerId] : s.ids.flatMap((id) => rasterLayers(s.originals.get(id)!).map((l) => l.id));
  for (const id of ids) s.session.engine.setOverride(id, null, null);
  s.session.engine.invalidateAll();
}

export function beginTransform(kind: TransformKind = 'free'): void {
  const s = editor.active;
  if (!s) return;
  if (st) {
    if (kind === 'warp' && !st.warp) setWarpMode();
    return;
  }
  const sel = s.doc.selection;
  const active = s.activeLayer();
  if (!active) return;
  if (active.locks.position || active.locks.all) {
    ui.toast('info', `"${active.name}" is locked.`);
    return;
  }
  if (kind === 'warp') {
    const layers = s.selectedLayers();
    if (layers.length && layers.every((l) => l.kind === 'text')) {
      ui.openDialog('warpText');
      return;
    }
  }
  let base: Rect | null = null;
  let float: FloatState | null = null;
  let ids: LayerId[] = [];
  const selRect = !sel.isEmpty() && active.kind === 'pixel' ? sel.bounds(s.doc.bounds) : null;
  if (selRect && active.kind === 'pixel') {
    // Transform selected pixels (floating).
    const r = selRect;
    if (isCmykDoc(s.doc)) ensureCompanion(active.raster);
    const before = active.raster.snapshot();
    const lr = { x: r.x - active.x, y: r.y - active.y, w: r.w, h: r.h };
    const cov = sel.read(r);
    const floatR = new TiledRaster(4, active.raster.depth);
    // Cut the selected pixels into a floating raster (every plate).
    const cutPlate = (src: TiledRaster, dst: TiledRaster) => {
      const px = src.readFloat(lr);
      const fpx = px.slice();
      for (let i = 0; i < r.w * r.h; i++) { fpx[i * 4 + 3] *= cov[i]; px[i * 4 + 3] *= 1 - cov[i]; }
      src.writeFloat(lr, px);
      dst.writeFloat(r, fpx);
    };
    cutPlate(active.raster, floatR);
    if (active.raster.companion) cutPlate(active.raster.companion, (floatR.companion = new TiledRaster(4, active.raster.depth)));
    float = { layerId: active.id, before, cut: active.raster.snapshot(), float: floatR, selBefore: sel.snapshot() };
    base = rasterContentBounds(floatR);
    ids = [active.id];
  } else {
    const layers = s.selectedLayers().filter((l) => !l.locks.position && !l.locks.all);
    for (const l of layers) base = union(base, layerContentBounds(l) ?? undefined);
    ids = layers.map((l) => l.id);
  }
  if (!base || base.w <= 0 || base.h <= 0) {
    if (float) s.doc.getLayer(float.layerId) && (s.doc.getLayer(float.layerId) as Layer & { raster: TiledRaster }).raster.restore(float.before);
    ui.toast('info', 'Nothing to transform (the layer is empty).');
    return;
  }
  const originals = new Map<LayerId, Layer>();
  for (const id of ids) originals.set(id, cloneLayer(s.doc.getLayer(id)!));
  st = { session: s, ids, base, M: [1, 0, 0, 1, 0, 0], quad: null, ref: { x: base.x + base.w / 2, y: base.y + base.h / 2 }, kind: kind === 'warp' ? 'free' : kind, originals, float, warp: null, selOnly: null };
  s.mode = { kind: 'transform', layerIds: ids };
  if (kind === 'warp') setWarpMode();
  else updatePreview(st);
  s.notify();
  ui.bump('viewRev');
}

/** Select ▸ Transform Selection: transforms (or warps) the selection outline, not the pixels. */
export function beginTransformSelection(): void {
  const s = editor.active;
  if (!s || st) return;
  const sel = s.doc.selection;
  const b = sel.bounds(s.doc.bounds);
  if (!b) { ui.toast('info', sel.isEmpty() ? 'There is no selection to transform.' : 'The selection is outside the canvas.'); return; }
  // Work on a copy limited to the canvas (select-all and inverted selections have an infinite fill).
  const mask = new TiledRaster(1, 8, 0);
  mask.writeFloat(b, sel.read(b));
  const level = Math.max(0, Math.ceil(Math.log2(Math.sqrt((b.w * b.h) / 4e6))));
  const sc = 1 << level;
  const lr = { x: Math.floor(b.x / sc), y: Math.floor(b.y / sc), w: Math.ceil((b.x + b.w) / sc) - Math.floor(b.x / sc), h: Math.ceil((b.y + b.h) / sc) - Math.floor(b.y / sc) };
  const polys = traceContours(mask.readFloat(lr, level), lr.w, lr.h).map((p) => p.map((v, i) => (v + (i % 2 ? lr.y : lr.x)) * sc));
  st = { session: s, ids: [], base: b, M: [1, 0, 0, 1, 0, 0], quad: null, ref: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, kind: 'free', originals: new Map(), float: null, warp: null, selOnly: { before: sel.snapshot(), mask, polys } };
  s.mode = { kind: 'transform', layerIds: [] };
  s.notify();
  ui.bump('viewRev');
}

/** Switches the running transform to warp mode (the current transform becomes the envelope). */
export function setWarpMode(): void {
  const s = st;
  if (!s || s.warp) return;
  const H = homography(s);
  s.warp = { grid: rectGrid(s.base).map((p) => applyH(H, p.x, p.y)), preset: null };
  s.M = [1, 0, 0, 1, 0, 0];
  s.quad = null;
  updatePreview(s);
  s.session.notify();
  ui.bump('viewRev');
}

/** Applies a warp preset (options bar) to the running warp. */
export function setWarpPreset(p: WarpPreset): void {
  const s = st;
  if (!s || !s.warp) return;
  s.warp = { grid: p.style === 'none' ? rectGrid(s.base) : presetGrid(p, s.base), preset: p };
  updatePreview(s);
  ui.bump('viewRev');
}

export function warpState(): { preset: WarpPreset | null } | null {
  return st?.warp ? { preset: st.warp.preset } : null;
}

export function cancelTransform(): void {
  const s = st;
  if (!s) return;
  clearPreview(s);
  if (s.float) {
    const l = s.session.doc.getLayer(s.float.layerId) as Layer & { raster: TiledRaster } | null;
    l?.raster.restore(s.float.before);
    s.session.doc.selection.restore(s.float.selBefore);
    s.session.doc.emit({ type: 'structure' }, { type: 'selection' });
  }
  s.session.mode = { kind: 'none' };
  st = null;
  s.session.notify();
  ui.bump('viewRev');
}

/** Resamples a single-channel mask (selection) through the current transform. */
function transformMask(s: State, mask: TiledRaster, mesh: Float64Array | null, H: Homography): TiledRaster {
  const w = mesh ? meshWarpLayerRaster(mask, 0, 0, s.base, mesh) : warpLayerRaster(mask, 0, 0, H, 'bilinear');
  const out = new TiledRaster(1, 8, 0);
  const b = rasterContentBounds(w.raster);
  if (b) out.writeFloat({ x: b.x + w.x, y: b.y + w.y, w: b.w, h: b.h }, w.raster.readFloat(b));
  return out;
}

export function commitTransform(): void {
  const s = st;
  if (!s) return;
  const doc = s.session.doc;
  const H = homography(s);
  const mesh = s.warp && !isIdentityGrid(s.warp.grid, s.base) ? sampleMesh(warpMap(s)) : null;
  const isAffine = !s.quad || isAffineQuad(s.quad);
  const identity = s.warp ? !mesh : !s.quad && s.M.every((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) < 1e-9);
  const label = s.selOnly ? 'Transform Selection' : s.warp ? 'Warp' : 'Free Transform';
  clearPreview(s);
  s.session.mode = { kind: 'none' };
  st = null;
  if (identity) {
    if (s.float) {
      const l = doc.getLayer(s.float.layerId) as Layer & { raster: TiledRaster };
      l.raster.restore(s.float.before);
      doc.selection.restore(s.float.selBefore);
      doc.emit({ type: 'structure' }, { type: 'selection' });
    }
    s.session.notify();
    ui.bump('viewRev');
    return;
  }
  if (s.selOnly) {
    doc.selection.restore(transformMask(s, s.selOnly.mask, mesh, H).snapshot());
    s.session.push(new RasterEditCommand(label, { kind: 'selection' }, s.selOnly.before, doc.selection.snapshot(), null), true);
    doc.emit({ type: 'selection' });
    s.session.notify();
    ui.bump('viewRev');
    return;
  }
  if (s.float) {
    const l = doc.getLayer(s.float.layerId) as Layer & { raster: TiledRaster; x: number; y: number };
    const w = mesh ? meshWarpLayerRaster(s.float.float, 0, 0, s.base, mesh) : warpLayerRaster(s.float.float, 0, 0, H, 'bicubic');
    const wb = rasterContentBounds(w.raster);
    if (wb) {
      const dst = { x: wb.x + w.x, y: wb.y + w.y, w: wb.w, h: wb.h };
      const lr = { x: dst.x - l.x, y: dst.y - l.y, w: dst.w, h: dst.h };
      const place = (from: TiledRaster, into: TiledRaster) => {
        const cur = into.readFloat(lr);
        overInPlace(cur, from.readFloat(wb), dst.w * dst.h);
        into.writeFloat(lr, cur);
      };
      place(w.raster, l.raster);
      if (w.raster.companion) place(w.raster.companion, ensureCompanion(l.raster));
    }
    const after = l.raster.snapshot();
    // Transform the selection outline too.
    const selMask = new TiledRaster(1, 8, 0);
    selMask.restore(s.float.selBefore);
    doc.selection.restore(transformMask(s, selMask, mesh, H).snapshot());
    const selAfter = doc.selection.snapshot();
    s.session.push(new CompositeCommand(label, [new RasterEditCommand(label, { kind: 'layer', layerId: l.id }, s.float.before, after, null), new RasterEditCommand(label, { kind: 'selection' }, s.float.selBefore, selAfter, null)]), true);
    doc.emit({ type: 'structure' }, { type: 'selection' });
    return;
  }
  if (mesh) {
    const skipped = new Set<string>();
    const cmds: ReplaceLayerCommand[] = [];
    for (const id of s.ids) {
      const before = s.originals.get(id)!;
      if (!doc.getLayer(id)) continue;
      const after = cloneLayer(before);
      applyWarp(s.session, after, s.base, s.warp!.grid, mesh, skipped);
      cmds.push(new TransformLayerCommand(label, before, after));
    }
    if (skipped.size) ui.toast('info', `${[...skipped].join(', ')} ${skipped.size === 1 ? 'was' : 'were'} not warped. Use Type ▸ Warp Text… for text, or convert the layer to a smart object first.`);
    s.session.push(new CompositeCommand(label, cmds));
    s.session.notify();
    return;
  }
  const hasText = s.ids.some((id) => containsKind(s.originals.get(id)!, 'text'));
  if (!isAffine && hasText) ui.toast('warning', 'Distort and perspective cannot be applied to text layers without rasterizing; text was transformed with the closest affine transform.');
  const cmds: ReplaceLayerCommand[] = [];
  for (const id of s.ids) {
    const before = s.originals.get(id)!;
    const live = doc.getLayer(id);
    if (!live) continue;
    const after = cloneLayer(before);
    applyHomography(s.session, after, H, isAffine);
    cmds.push(new TransformLayerCommand('Free Transform', before, after));
  }
  const cmd = new CompositeCommand('Free Transform', cmds, { action: 'edit.freeTransformApply', args: { matrix: Array.from(H), affine: isAffine } });
  s.session.push(cmd);
  s.session.notify();
}

/** Applies a document-space warp envelope to a (detached) layer object. */
function applyWarp(s: DocumentSession, l: Layer, base: Rect, grid: WarpGrid, mesh: Float64Array, skipped: Set<string>): void {
  const doc = s.doc;
  const mapPt = (x: number, y: number) => evalGrid(grid, (x - base.x) / base.w, (y - base.y) / base.h);
  const warpPath = (p: { subpaths: { knots: { x: number; y: number; inX: number; inY: number; outX: number; outY: number }[] }[] }) => {
    for (const sp of p.subpaths)
      for (const k of sp.knots) {
        const a = mapPt(k.x, k.y), i = mapPt(k.inX, k.inY), o = mapPt(k.outX, k.outY);
        k.x = a.x; k.y = a.y; k.inX = i.x; k.inY = i.y; k.outX = o.x; k.outY = o.y;
      }
  };
  if (l.kind === 'text') { skipped.add(`"${l.name}"`); return; }
  if (l.mask && l.mask.linked) {
    const r = meshWarpLayerRaster(l.mask.raster, l.mask.x, l.mask.y, base, mesh);
    l.mask = { ...l.mask, raster: r.raster, x: r.x, y: r.y };
  }
  if (l.vectorMask && l.vectorMask.linked) warpPath(l.vectorMask.path);
  switch (l.kind) {
    case 'group':
      for (const c of l.children) applyWarp(s, c, base, grid, mesh, skipped);
      break;
    case 'pixel':
    case 'video': {
      const r = meshWarpLayerRaster(l.raster, l.x, l.y, base, mesh);
      l.raster = r.raster; l.x = r.x; l.y = r.y;
      break;
    }
    case 'shape':
      warpPath(l.path);
      l.origin = l.origin ? { ...l.origin, kind: 'custom' } : null;
      updateAppearance(doc, l);
      break;
    case 'smartObject': {
      // Non-destructive: the envelope is kept in source space and composed with the quad.
      const Hq = rectToQuad(l.sourceWidth, l.sourceHeight, l.quad);
      const Hqi = invertH(Hq);
      const g0 = l.warp ?? rectGrid({ x: 0, y: 0, w: l.sourceWidth, h: l.sourceHeight });
      l.warp = fitGrid((u, v) => {
        const p = evalGrid(g0, u, v);
        const d = applyH(Hq, p.x, p.y);
        const w = mapPt(d.x, d.y);
        return applyH(Hqi, w.x, w.y);
      });
      if (doc.smartSources.get(l.sourceId)?.decoded) updateAppearance(doc, l);
      else {
        const r = meshWarpLayerRaster(l.raster, l.x, l.y, base, mesh);
        l.raster = r.raster; l.x = r.x; l.y = r.y;
      }
      break;
    }
  }
  l.rev++;
}

/** Applies a document-space homography to layers as one history step (macro replay). */
export function transformLayersByMatrix(session: DocumentSession, ids: LayerId[], H: Homography, affine: boolean): boolean {
  const cmds: ReplaceLayerCommand[] = [];
  for (const id of ids) {
    const live = session.doc.getLayer(id);
    if (!live || live.locks.all || live.locks.position) continue;
    const before = cloneLayer(live);
    const after = cloneLayer(live);
    applyHomography(session, after, H, affine);
    cmds.push(new TransformLayerCommand('Free Transform', before, after));
  }
  if (!cmds.length) return false;
  session.push(new CompositeCommand('Free Transform', cmds, { action: 'edit.freeTransformApply', args: { matrix: Array.from(H), affine } }));
  session.notify();
  return true;
}

function containsKind(l: Layer, k: Layer['kind']): boolean {
  return l.kind === k || (l.kind === 'group' && l.children.some((c) => containsKind(c, k)));
}

function transformPathH(p: { subpaths: { knots: { x: number; y: number; inX: number; inY: number; outX: number; outY: number }[] }[] }, H: Homography) {
  for (const s of p.subpaths)
    for (const k of s.knots) {
      const a = applyH(H, k.x, k.y), i = applyH(H, k.inX, k.inY), o = applyH(H, k.outX, k.outY);
      k.x = a.x; k.y = a.y; k.inX = i.x; k.inY = i.y; k.outX = o.x; k.outY = o.y;
    }
}

/** Applies a document-space homography to a (detached) layer object. */
function applyHomography(s: DocumentSession, l: Layer, H: Homography, affine: boolean): void {
  const doc = s.doc;
  const A: Affine = [H[0], H[3], H[1], H[4], H[2], H[5]];
  if (l.mask && l.mask.linked) {
    const r = warpLayerRaster(l.mask.raster, l.mask.x, l.mask.y, H, 'bicubic');
    l.mask = { ...l.mask, raster: r.raster, x: r.x, y: r.y };
  }
  if (l.vectorMask && l.vectorMask.linked) transformPathH(l.vectorMask.path, H);
  switch (l.kind) {
    case 'group':
      for (const c of l.children) applyHomography(s, c, H, affine);
      break;
    case 'pixel':
    case 'video': {
      const r = warpLayerRaster(l.raster, l.x, l.y, H, 'bicubic');
      l.raster = r.raster;
      l.x = r.x;
      l.y = r.y;
      break;
    }
    case 'text':
      l.text.transform = multiply(A, l.text.transform);
      updateAppearance(doc, l);
      break;
    case 'shape':
      transformPathH(l.path, H);
      l.origin = l.origin && affine && Math.abs(A[1]) < 1e-9 && Math.abs(A[2]) < 1e-9 ? { ...l.origin, x: A[0] * l.origin.x + A[4], y: A[3] * l.origin.y + A[5], w: l.origin.w * Math.abs(A[0]), h: l.origin.h * Math.abs(A[3]) } : l.origin ? { ...l.origin, kind: 'custom' } : null;
      updateAppearance(doc, l);
      break;
    case 'smartObject': {
      l.quad = l.quad.map((p) => applyH(H, p.x, p.y)) as Quad;
      if (doc.smartSources.get(l.sourceId)?.decoded) updateAppearance(doc, l);
      else {
        const r = warpLayerRaster(l.raster, l.x, l.y, H, 'bicubic');
        l.raster = r.raster; l.x = r.x; l.y = r.y;
      }
      break;
    }
  }
  l.rev++;
}

/** Rotate 90/180 and flips of the selected layers (around their bounds center). */
export function quickTransformLayer(kind: 'rotate180' | 'rotate90cw' | 'rotate90ccw' | 'flipH' | 'flipV'): void {
  const s = editor.active;
  if (!s) return;
  const layers = s.selectedLayers().filter((l) => !l.locks.position && !l.locks.all);
  let b: Rect | null = null;
  for (const l of layers) b = union(b, layerContentBounds(l) ?? undefined);
  if (!b) return;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const lin: Affine = kind === 'rotate180' ? [-1, 0, 0, -1, 0, 0] : kind === 'rotate90cw' ? [0, 1, -1, 0, 0, 0] : kind === 'rotate90ccw' ? [0, -1, 1, 0, 0, 0] : kind === 'flipH' ? [-1, 0, 0, 1, 0, 0] : [1, 0, 0, -1, 0, 0];
  let m = multiply(translation(cx, cy), multiply(lin, translation(-cx, -cy)));
  // Keep pixel alignment for 90° rotations of odd-sized content.
  m = [m[0], m[1], m[2], m[3], Math.round(m[4]), Math.round(m[5])];
  const cmds = layers.map((l) => {
    const before = cloneLayer(l);
    const after = cloneLayer(l);
    transformLayer(s.doc, after, m, 'nearest', null);
    return new TransformLayerCommand(kind, before, after);
  });
  s.push(new CompositeCommand({ rotate180: 'Rotate 180°', rotate90cw: 'Rotate 90° CW', rotate90ccw: 'Rotate 90° CCW', flipH: 'Flip Horizontal', flipV: 'Flip Vertical' }[kind], cmds, { action: `edit.transform.${kind}` }));
}

// ---------------------------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------------------------
/** Envelope outline in document space (sampled Bézier boundary). */
function envelopeOutline(g: WarpGrid): Point[] {
  const pts: Point[] = [];
  const n = 16;
  for (let i = 0; i < n; i++) pts.push(evalGrid(g, i / n, 0));
  for (let i = 0; i < n; i++) pts.push(evalGrid(g, 1, i / n));
  for (let i = n; i > 0; i--) pts.push(evalGrid(g, i / n, 1));
  for (let i = n; i > 0; i--) pts.push(evalGrid(g, 0, i / n));
  return pts;
}

/** Maps a document point through the running transform (for outlines). */
function mapPoint(s: State, x: number, y: number, H: Homography): Point {
  if (s.warp) return evalGrid(s.warp.grid, (x - s.base.x) / s.base.w, (y - s.base.y) / s.base.h);
  return applyH(H, x, y);
}

function handleAt(s: State, sx: number, sy: number, dx = 0, dy = 0): Handle | null {
  const v = s.session.view;
  if (s.warp) {
    const g = s.warp.grid;
    for (const i of [0, 3, 12, 15, ...WARP_HANDLES]) {
      const p = v.docToScreen(g[i].x, g[i].y);
      if (Math.hypot(p.x - sx, p.y - sy) < 7) return { kind: 'warpPoint', i };
    }
    if (pointInPoly(envelopeOutline(g).map((p) => v.docToScreen(p.x, p.y)), sx, sy)) {
      const uv = inverseGrid(g, s.base, dx, dy);
      return { kind: 'surface', u: uv.u, v: uv.v };
    }
    return null;
  }
  const q = currentQuad(s).map((p) => v.docToScreen(p.x, p.y));
  const r = v.docToScreen(s.ref.x, s.ref.y);
  if (Math.hypot(r.x - sx, r.y - sy) < 7) return { kind: 'ref' };
  for (let i = 0; i < 4; i++) if (Math.hypot(q[i].x - sx, q[i].y - sy) < 7) return { kind: 'corner', i };
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    if (Math.hypot((a.x + b.x) / 2 - sx, (a.y + b.y) / 2 - sy) < 7) return { kind: 'edge', i };
  }
  if (pointInPoly(q, sx, sy)) return { kind: 'move' };
  for (let i = 0; i < 4; i++) if (Math.hypot(q[i].x - sx, q[i].y - sy) < 28) return { kind: 'rotate' };
  return { kind: 'rotate' };
}

function pointInPoly(q: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i], b = q[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export class TransformController implements Tool {
  id = 'move' as const;
  private drag: { h: Handle; start: ToolPointer; M: Affine; quad: Quad | null; ref: Point; grid: WarpGrid | null } | null = null;

  busy() {
    return !!this.drag;
  }

  cursor(_h: ToolHost, p: ToolPointer | null): string {
    if (!st || !p) return 'default';
    const hdl = handleAt(st, p.sx, p.sy, p.x, p.y);
    if (!hdl) return 'default';
    if (hdl.kind === 'warpPoint') return 'pointer';
    if (hdl.kind === 'surface') return 'grab';
    if (hdl.kind === 'move') return 'move';
    if (hdl.kind === 'rotate') return 'alias';
    if (hdl.kind === 'ref') return 'crosshair';
    return p.mod ? 'default' : 'nwse-resize';
  }

  down(_h: ToolHost, p: ToolPointer) {
    if (!st) return;
    const hdl = handleAt(st, p.sx, p.sy, p.x, p.y);
    if (!hdl) return;
    this.drag = { h: hdl, start: p, M: [...st.M] as Affine, quad: st.quad ? (st.quad.map((q) => ({ ...q })) as Quad) : null, ref: { ...st.ref }, grid: st.warp ? st.warp.grid.map((q) => ({ ...q })) : null };
  }

  move(h: ToolHost, p: ToolPointer) {
    const d = this.drag;
    const s = st;
    if (!d || !s) return;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (s.warp && d.grid && (d.h.kind === 'warpPoint' || d.h.kind === 'surface')) {
      const g0 = d.grid;
      let g: WarpGrid;
      if (d.h.kind === 'warpPoint') {
        g = g0.map((q) => ({ ...q }));
        for (const k of [d.h.i, ...(CORNER_FOLLOWERS[d.h.i] ?? [])]) g[k] = { x: g0[k].x + dx, y: g0[k].y + dy };
      } else g = dragSurface(g0, d.h.u, d.h.v, dx, dy);
      s.warp = { grid: g, preset: null };
      updatePreview(s);
      ui.bump('viewRev');
      h.redraw();
      return;
    }
    const kind = s.kind;
    const wantsDistort = d.h.kind === 'corner' && ((p.mod && !(p.alt && p.shift)) || kind === 'distort');
    const wantsPerspective = d.h.kind === 'corner' && ((p.mod && p.alt && p.shift) || kind === 'perspective');
    const wantsSkew = d.h.kind === 'edge' && ((p.mod && p.shift) || kind === 'skew' || (p.mod && !p.shift));
    if (d.h.kind === 'ref') {
      s.ref = { x: d.ref.x + dx, y: d.ref.y + dy };
    } else if (d.h.kind === 'move') {
      let mx = dx, my = dy;
      if (p.shift) { if (Math.abs(mx) > Math.abs(my)) my = 0; else mx = 0; }
      if (d.quad) s.quad = d.quad.map((q) => ({ x: q.x + mx, y: q.y + my })) as Quad;
      else s.M = multiply(translation(mx, my), d.M);
      s.ref = { x: d.ref.x + mx, y: d.ref.y + my };
    } else if (d.h.kind === 'rotate' || kind === 'rotate') {
      const a0 = Math.atan2(d.start.y - d.ref.y, d.start.x - d.ref.x), a1 = Math.atan2(p.y - d.ref.y, p.x - d.ref.x);
      let da = a1 - a0;
      if (p.shift) da = Math.round(da / (Math.PI / 12)) * (Math.PI / 12);
      const R = multiply(translation(d.ref.x, d.ref.y), multiply(rotation(da), translation(-d.ref.x, -d.ref.y)));
      if (d.quad) s.quad = d.quad.map((q) => apply(R, q.x, q.y)) as Quad;
      else s.M = multiply(R, d.M);
    } else if (wantsDistort || wantsPerspective || (d.quad && d.h.kind === 'corner')) {
      const q = (d.quad ?? (baseQuad(s.base).map((pt) => apply(d.M, pt.x, pt.y)) as Quad)).map((pt) => ({ ...pt })) as Quad;
      const i = (d.h as { i: number }).i;
      q[i] = { x: q[i].x + dx, y: q[i].y + dy };
      if (wantsPerspective) {
        // Move the adjacent corner symmetrically (along the dominant axis).
        const j = Math.abs(dx) > Math.abs(dy) ? (i ^ 3) : (i ^ 1);
        const orig = (d.quad ?? (baseQuad(s.base).map((pt) => apply(d.M, pt.x, pt.y)) as Quad))[j];
        q[j] = Math.abs(dx) > Math.abs(dy) ? { x: orig.x - dx, y: orig.y } : { x: orig.x, y: orig.y - dy };
      }
      s.quad = q;
    } else if (wantsSkew) {
      const i = (d.h as { i: number }).i;
      const inv = invert(d.M);
      const l0 = apply(inv, d.start.x, d.start.y), l1 = apply(inv, p.x, p.y);
      const b = s.base;
      const horizontal = i === 0 || i === 2;
      const fixedY = i === 0 ? b.y + b.h : b.y, fixedX = i === 1 ? b.x : b.x + b.w;
      const K: Affine = horizontal ? [1, 0, (l1.x - l0.x) / (i === 0 ? -b.h : b.h), 1, 0, 0] : [1, (l1.y - l0.y) / (i === 3 ? -b.w : b.w), 0, 1, 0, 0];
      const pivot = horizontal ? { x: 0, y: fixedY } : { x: fixedX, y: 0 };
      s.M = multiply(d.M, multiply(translation(pivot.x, pivot.y), multiply(K, translation(-pivot.x, -pivot.y))));
    } else if (d.h.kind === 'corner' || d.h.kind === 'edge') {
      // Scale in the base (untransformed) space.
      const inv = invert(d.M);
      const lp = apply(inv, p.x, p.y);
      const b = s.base;
      const corners = baseQuad(b);
      const refL = apply(inv, d.ref.x, d.ref.y);
      let sx = 1, sy = 1, fx: number, fy: number;
      if (d.h.kind === 'corner') {
        const i = d.h.i;
        const opp = corners[(i + 2) % 4];
        const fixed = p.alt ? refL : opp;
        fx = fixed.x; fy = fixed.y;
        const c = corners[i];
        sx = (lp.x - fx) / (c.x - fx || 1e-9);
        sy = (lp.y - fy) / (c.y - fy || 1e-9);
        if (p.shift) { const k = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = Math.sign(sx || 1) * Math.abs(k); sy = Math.sign(sy || 1) * Math.abs(k); }
      } else {
        const i = d.h.i;
        const mid = [{ x: b.x + b.w / 2, y: b.y }, { x: b.x + b.w, y: b.y + b.h / 2 }, { x: b.x + b.w / 2, y: b.y + b.h }, { x: b.x, y: b.y + b.h / 2 }][i];
        const opp = [{ x: 0, y: b.y + b.h }, { x: b.x, y: 0 }, { x: 0, y: b.y }, { x: b.x + b.w, y: 0 }][i];
        fx = p.alt ? refL.x : opp.x;
        fy = p.alt ? refL.y : opp.y;
        if (i === 0 || i === 2) sy = (lp.y - fy) / (mid.y - fy || 1e-9);
        else sx = (lp.x - fx) / (mid.x - fx || 1e-9);
        if (p.shift) { if (i === 0 || i === 2) sx = Math.abs(sy); else sy = Math.abs(sx); }
      }
      s.M = multiply(d.M, multiply(translation(fx, fy), multiply(scaling(sx, sy), translation(-fx, -fy))));
    }
    updatePreview(s);
    ui.bump('viewRev');
    h.redraw();
  }

  up() {
    this.drag = null;
    ui.bump('viewRev');
  }

  doubleClick() {
    commitTransform();
  }

  keyDown(_h: ToolHost, e: KeyboardEvent): boolean {
    if (e.key === 'Enter') { commitTransform(); return true; }
    if (e.key === 'Escape') { cancelTransform(); return true; }
    return false;
  }

  cancel() {
    this.drag = null;
  }

  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    const s = st;
    if (!s) return;
    const v = h.session.view;
    g.save();
    if (s.selOnly) {
      // Transformed selection outline.
      const H = homography(s);
      g.beginPath();
      for (const poly of s.selOnly.polys)
        for (let i = 0; i < poly.length; i += 2) {
          const m = mapPoint(s, poly[i], poly[i + 1], H);
          const sp = v.docToScreen(m.x, m.y);
          if (i === 0) g.moveTo(sp.x, sp.y); else g.lineTo(sp.x, sp.y);
        }
      g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
      g.setLineDash([4, 4]); g.strokeStyle = '#000'; g.stroke();
      g.setLineDash([]);
    }
    if (s.warp) {
      const grid = s.warp.grid;
      const toS = (p: Point) => v.docToScreen(p.x, p.y);
      g.strokeStyle = '#3d8bfd';
      g.lineWidth = 1;
      // Envelope grid lines (thirds).
      g.beginPath();
      for (let k = 0; k <= 3; k++) {
        for (let i = 0; i <= 24; i++) { const p = toS(evalGrid(grid, i / 24, k / 3)); if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }
        for (let i = 0; i <= 24; i++) { const p = toS(evalGrid(grid, k / 3, i / 24)); if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }
      }
      g.stroke();
      // Tangent handles.
      g.beginPath();
      for (const [c, fs] of Object.entries(CORNER_FOLLOWERS)) {
        const a = toS(grid[Number(c)]);
        for (const f of fs.slice(0, 2)) { const b = toS(grid[f]); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); }
      }
      g.stroke();
      g.fillStyle = '#fff';
      for (const i of WARP_HANDLES) {
        const p = toS(grid[i]);
        if (i === 0 || i === 3 || i === 12 || i === 15) { g.fillRect(p.x - 4, p.y - 4, 8, 8); g.strokeRect(p.x - 4, p.y - 4, 8, 8); }
        else { g.beginPath(); g.arc(p.x, p.y, 3.5, 0, Math.PI * 2); g.fill(); g.stroke(); }
      }
      g.restore();
      return;
    }
    const q = currentQuad(s).map((p) => v.docToScreen(p.x, p.y));
    g.strokeStyle = '#3d8bfd';
    g.lineWidth = 1;
    g.beginPath();
    q.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.stroke();
    g.fillStyle = '#fff';
    const pts = [...q, ...q.map((p, i) => ({ x: (p.x + q[(i + 1) % 4].x) / 2, y: (p.y + q[(i + 1) % 4].y) / 2 }))];
    for (const p of pts) { g.fillRect(p.x - 4, p.y - 4, 8, 8); g.strokeRect(p.x - 4, p.y - 4, 8, 8); }
    const r = v.docToScreen(s.ref.x, s.ref.y);
    g.beginPath();
    g.arc(r.x, r.y, 5, 0, Math.PI * 2);
    g.moveTo(r.x - 8, r.y); g.lineTo(r.x + 8, r.y); g.moveTo(r.x, r.y - 8); g.lineTo(r.x, r.y + 8);
    g.stroke();
    g.restore();
  }
}

export const transformController = new TransformController();
editor.registerModeController('transform', transformController);

/** Numeric values for the options bar. */
export function transformNumbers(): { x: number; y: number; w: number; h: number; angle: number; skew: number; free: boolean } | null {
  const s = st;
  if (!s || s.warp) return null;
  if (s.quad) return { x: s.ref.x, y: s.ref.y, w: 100, h: 100, angle: 0, skew: 0, free: true };
  const d = decompose(s.M);
  return { x: s.ref.x, y: s.ref.y, w: d.scaleX * 100, h: d.scaleY * 100, angle: (d.rotation * 180) / Math.PI, skew: (d.skewX * 180) / Math.PI, free: false };
}

/** Sets numeric transform values (from the options bar). */
export function setTransformNumbers(v: { x?: number; y?: number; w?: number; h?: number; angle?: number; skew?: number }): void {
  const s = st;
  if (!s || s.quad || s.warp) return;
  const cur = transformNumbers()!;
  const cx = s.base.x + s.base.w / 2, cy = s.base.y + s.base.h / 2;
  const nx = v.x ?? cur.x, ny = v.y ?? cur.y;
  const sx = (v.w ?? cur.w) / 100, sy = (v.h ?? cur.h) / 100;
  const ang = ((v.angle ?? cur.angle) * Math.PI) / 180, sk = ((v.skew ?? cur.skew) * Math.PI) / 180;
  // Reference point stays at its base-relative position.
  const refBase = apply(invert(s.M), s.ref.x, s.ref.y);
  let M = multiply(rotation(ang), multiply([1, 0, Math.tan(sk), 1, 0, 0], scaling(sx, sy)));
  M = multiply(M, translation(-cx, -cy));
  M = multiply(translation(cx, cy), M);
  const refNow = apply(M, refBase.x, refBase.y);
  s.M = multiply(translation(nx - refNow.x, ny - refNow.y), M);
  s.ref = { x: nx, y: ny };
  updatePreview(s);
  ui.bump('viewRev');
}
