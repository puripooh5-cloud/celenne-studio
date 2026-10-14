/** Select menu operations. Every selection change is an undoable raster command. */
import { ui, useApp } from '../store';
import type { DocumentSession } from '../session';
import { need, needLayer, samplingImage } from './common';
import { editRaster } from '../../commands/rasterCommands';
import type { RecordedOp } from '../../history/history';
import { LambdaCommand } from '../../commands/layerCommands';
import type { RasterSnapshot } from '../../image-engine/tiledRaster';
import { TiledRaster } from '../../image-engine/tiledRaster';
import { borderSelection, colorRange, ColorRangeMode, combineRaster, contractSelection, expandSelection, feather, growSimilar, smoothSelection, traceContours, simplify } from '../../selection/ops';
import type { SelectionOp } from '../../selection/selection';
import { hasRaster } from '../../document/types';
import { newId } from '../../document/ids';
import { aiProvider } from '../../ai/provider';
import { errorText } from './common';
import type { VectorPath } from '../../vector/types';
import { rasterizePath } from '../../vector/rasterize';
import { pathBounds } from '../../vector/rasterize';
import { intersect, isEmpty } from '../../image-engine/rect';
import { autoRange, focusMap, FocusMap, focusMask } from '../../selection/focusArea';
import { compositeRegion } from '../../rendering/compositor';
import { resizeImage } from '../../image-engine/resample';
import { addMask, duplicateLayers } from './layerOps';

const lastSelection = new Map<string, RasterSnapshot>();

export function changeSelection(s: DocumentSession, label: string, fn: () => void, record?: RecordedOp): void {
  const before = s.doc.selection.snapshot();
  const cmd = editRaster(s.doc, { kind: 'selection' }, label, () => {
    fn();
    return null;
  }, record);
  if (cmd) s.push(cmd, true);
  if (!s.doc.selection.isEmpty()) lastSelection.set(s.id, s.doc.selection.snapshot());
  else lastSelection.set(s.id, before);
}

export function selectAll(): void {
  const s = need();
  if (s) changeSelection(s, 'Select All', () => s.doc.selection.selectAll(), { action: 'select.all' });
}

export function deselect(): void {
  const s = need();
  if (!s || s.doc.selection.isEmpty()) return;
  changeSelection(s, 'Deselect', () => s.doc.selection.clear(), { action: 'select.deselect' });
}

export function reselect(): void {
  const s = need();
  const snap = s ? lastSelection.get(s.id) : undefined;
  if (!s || !snap) return;
  changeSelection(s, 'Reselect', () => s.doc.selection.restore(snap), { action: 'select.reselect' });
}

export function inverse(): void {
  const s = need();
  if (s) changeSelection(s, 'Inverse', () => s.doc.selection.invert(), { action: 'select.inverse' });
}

type Modify = 'feather' | 'expand' | 'contract' | 'smooth' | 'border';

export function modify(kind: Modify, amount: number): void {
  const s = need();
  if (!s || s.doc.selection.isEmpty()) {
    ui.toast('info', 'Make a selection first.');
    return;
  }
  const c = s.doc.bounds;
  const label = { feather: 'Feather', expand: 'Expand', contract: 'Contract', smooth: 'Smooth', border: 'Border' }[kind];
  changeSelection(s, label, () => {
    const sel = s.doc.selection;
    if (kind === 'feather') feather(sel, c, amount);
    else if (kind === 'expand') expandSelection(sel, c, amount);
    else if (kind === 'contract') contractSelection(sel, c, amount);
    else if (kind === 'smooth') smoothSelection(sel, c, Math.max(1, Math.round(amount)));
    else borderSelection(sel, c, amount);
  }, { action: 'select.modify', args: { kind, amount } });
}

export function grow(similar: boolean): void {
  const s = need();
  if (!s || s.doc.selection.isEmpty()) return;
  const tol = useApp.getState().toolOptions.selection.tolerance;
  changeSelection(s, similar ? 'Similar' : 'Grow', () => growSimilar(s.doc.selection, samplingImage(s, true), s.doc.bounds, tol, !similar), { action: similar ? 'select.similar' : 'select.grow' });
}

export function applyColorRange(mode: ColorRangeMode, samples: [number, number, number][], fuzziness: number, invert: boolean, op: SelectionOp): void {
  const s = need();
  if (!s) return;
  const img = samplingImage(s, true);
  const p = ui.progress('Color Range…');
  setTimeout(() => {
    try {
      const m = colorRange(img, s.doc.bounds, mode, samples, fuzziness, invert);
      changeSelection(s, 'Color Range', () => combineRaster(s.doc.selection, m, op, s.doc.bounds), { action: 'select.colorRange', args: { mode, samples, fuzziness, invert, op } });
    } finally {
      p.done();
    }
  }, 16);
}

export async function selectSubject(kind: 'subject' | 'sky' = 'subject'): Promise<void> {
  const s = need();
  if (!s) return;
  const p = ui.progress(kind === 'sky' ? 'Selecting sky…' : 'Selecting subject…');
  try {
    const provider = aiProvider();
    const mask = kind === 'sky' ? await provider.selectSky(s) : await provider.selectSubject(s);
    changeSelection(s, kind === 'sky' ? 'Select Sky' : 'Select Subject', () => combineRaster(s.doc.selection, mask, 'replace', s.doc.bounds), { action: kind === 'sky' ? 'select.sky' : 'select.subject' });
    if (provider.kind === 'local') ui.toast('info', `${kind === 'sky' ? 'Sky' : 'Subject'} selected with the built-in local estimator.`, 'Configure an AI provider in Preferences › AI for higher quality results.', 4000);
  } catch (e) {
    ui.toast('error', 'Selection failed', errorText(e));
  } finally {
    p.done();
  }
}

/** Ctrl+click layer thumbnail: load layer transparency as a selection. */
export function loadLayerTransparency(layerId: string, op: SelectionOp = 'replace', fromMask = false): void {
  const s = need();
  const l = s?.doc.getLayer(layerId);
  if (!s || !l) return;
  const m = new TiledRaster(1, 8, 0);
  if (fromMask && l.mask) {
    m.restore(l.mask.raster.clone().snapshot());
  } else if (hasRaster(l)) {
    const b = l.raster.contentBounds();
    if (b) {
      const px = l.raster.readFloat(b);
      const a = new Float32Array(b.w * b.h);
      for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3];
      m.writeFloat({ x: b.x + l.x, y: b.y + l.y, w: b.w, h: b.h }, a);
    }
  } else if (l.vectorMask) {
    const pb = pathBounds(l.vectorMask.path);
    if (pb) {
      const r = intersect(pb, s.doc.bounds);
      if (!isEmpty(r)) m.writeFloat(r, rasterizePath(l.vectorMask.path, r));
    }
  }
  changeSelection(s, 'Load Selection', () => combineRaster(s.doc.selection, m, op, s.doc.bounds));
}

// ---------------------------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------------------------
export function saveSelectionToChannel(name?: string): void {
  const s = need();
  if (!s || s.doc.selection.isEmpty()) {
    ui.toast('info', 'Make a selection first.');
    return;
  }
  const ch = { id: newId('ch'), name: name ?? `Alpha ${s.doc.channels.length + 1}`, kind: 'alpha' as const, raster: s.doc.selection.mask.clone(), visible: false, color: { r: 1, g: 0, b: 0 }, opacity: 0.5, indicatesSelected: false };
  s.push(new LambdaCommand('Save Selection', (d) => { d.channels.push(ch); d.emit({ type: 'channels' }); }, (d) => { d.channels = d.channels.filter((c) => c.id !== ch.id); d.emit({ type: 'channels' }); }, { action: 'select.save' }));
}

export function loadChannelAsSelection(channelId: string, op: SelectionOp = 'replace', invert = false): void {
  const s = need();
  const ch = s?.doc.channels.find((c) => c.id === channelId);
  if (!s || !ch) return;
  const m = ch.raster.clone();
  changeSelection(s, 'Load Selection', () => {
    combineRaster(s.doc.selection, m, op, s.doc.bounds);
    if (invert) s.doc.selection.invert();
  }, { action: 'select.load', args: { channel: ch.name, op, invert } });
}

export function toggleQuickMask(): void {
  const s = need();
  if (!s) return;
  const on = !useApp.getState().quickMask;
  ui.set({ quickMask: on });
  s.engine.setView({ quickMask: on });
  if (on && s.doc.selection.isEmpty()) ui.toast('info', 'Quick Mask: paint with black to mask, white to select. Press Q to exit.', undefined, 3000);
}

// ---------------------------------------------------------------------------------------------
// Paths ↔ selection
// ---------------------------------------------------------------------------------------------
export function pathToSelection(path: VectorPath, op: SelectionOp = 'replace', featherPx = 0): void {
  const s = need();
  if (!s) return;
  const pb = pathBounds(path);
  if (!pb) return;
  const r = intersect(pb, s.doc.bounds);
  if (isEmpty(r)) return;
  const cov = rasterizePath(path, r);
  changeSelection(s, 'Make Selection', () => {
    const m = new TiledRaster(1, 8, 0);
    m.writeFloat(r, cov);
    combineRaster(s.doc.selection, m, op, s.doc.bounds);
    if (featherPx > 0) feather(s.doc.selection, s.doc.bounds, featherPx);
  });
}

export function selectionToPath(tolerance = 2): VectorPath | null {
  const s = need();
  if (!s || s.doc.selection.isEmpty()) return null;
  const b = s.doc.selection.bounds(s.doc.bounds);
  if (!b) return null;
  const v = s.doc.selection.read(b);
  const polys = traceContours(v, b.w, b.h).map((p) => simplify(p, tolerance));
  const path: VectorPath = { fillRule: 'evenodd', subpaths: [] };
  for (const p of polys) {
    const knots = [];
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i] + b.x, y = p[i + 1] + b.y;
      knots.push({ x, y, inX: x, inY: y, outX: x, outY: y, smooth: false });
    }
    if (knots.length >= 3) path.subpaths.push({ closed: true, op: 'combine', knots });
  }
  return path;
}

export { needLayer };

// ---------------------------------------------------------------------------------------------
// Focus Area
// ---------------------------------------------------------------------------------------------
export interface FocusAreaSpec {
  /** 0..1, null = automatic. */
  range: number | null;
  /** 0..1 */
  noise: number;
  soften: boolean;
  output: 'selection' | 'layerMask' | 'newLayerWithMask';
}

/** Analyses the visible image at a working resolution (≤ `maxSide` px). */
export function analyzeFocus(s: DocumentSession, noise: number, maxSide = 1024): { fm: FocusMap; level: number } {
  const b = s.doc.bounds;
  const level = Math.max(0, Math.ceil(Math.log2(Math.max(b.w, b.h) / maxSide)));
  const ls = 1 << level;
  const r = { x: 0, y: 0, w: Math.max(1, Math.ceil(b.w / ls)), h: Math.max(1, Math.ceil(b.h / ls)) };
  const img = compositeRegion(s.doc, r, { level });
  for (let i = 0; i < r.w * r.h; i++) { const a = img[i * 4 + 3]; if (a > 1e-6) { img[i * 4] /= a; img[i * 4 + 1] /= a; img[i * 4 + 2] /= a; } }
  return { fm: focusMap(img, r.w, r.h, noise), level };
}

export function focusArea(spec: FocusAreaSpec): void {
  const s = need();
  if (!s) return;
  const p = ui.progress('Focus Area…');
  try {
    const { fm } = analyzeFocus(s, spec.noise);
    const range = spec.range ?? autoRange(fm);
    const m = focusMask(fm, range, spec.soften);
    const W = s.doc.width, H = s.doc.height;
    const up = resizeImage(m, fm.w, fm.h, W, H, 'bilinear', 1);
    if (!spec.soften) for (let i = 0; i < up.length; i++) up[i] = up[i] >= 0.5 ? 1 : 0;
    const mask = new TiledRaster(1, 8, 0);
    mask.writeFloat({ x: 0, y: 0, w: W, h: H }, up);
    mask.compact();
    changeSelection(s, 'Focus Area', () => combineRaster(s.doc.selection, mask, 'replace', s.doc.bounds), { action: 'select.focusArea', args: { ...spec, range } as unknown as Record<string, unknown> });
    if (spec.output !== 'selection') {
      if (spec.output === 'newLayerWithMask') duplicateLayers();
      if (s.activeLayer()?.mask) ui.toast('info', 'The layer already has a mask; the focus area was left as a selection.');
      else {
        addMask('revealSelection');
        changeSelection(s, 'Deselect', () => s.doc.selection.clear());
      }
    }
  } catch (e) {
    ui.toast('error', 'Focus Area failed', errorText(e));
  } finally {
    p.done();
  }
}
