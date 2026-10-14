/** Filter application: destructive (pixels/masks/channels) or smart filters on smart objects. */
import { editColor, ensureCompanion, isCmykDoc, isLabDoc, labRgbView, labToRgbUnclamped, labViewColor, plateColor, rgbToLabUnclamped } from '../../color/plates';
import type { TiledRaster } from '../../image-engine/tiledRaster';
import type { RGB } from '../../color/types';
import { ui, useApp } from '../store';
import type { DocumentSession } from '../session';
import { need } from './common';
import { filterById } from '../../filters/builtin';
import type { FilterDef, FilterParams } from '../../filters/types';
import { runFilterAsync, runFilterSync } from '../../filters/runner';
import { ApplyFilterCommand } from '../../commands/rasterCommands';
import { emitTargetChange, RasterTarget, resolveTarget } from '../../commands/rasterTarget';
import { expand, intersect, isEmpty, Rect, translate, union } from '../../image-engine/rect';
import { rasterContentBounds } from '../../rendering/bounds';
import { editLayer } from '../../commands/layerCommands';
import { newId } from '../../document/ids';
import type { SmartFilter, SmartObjectLayer } from '../../document/types';
import { ensureDecoded, renderSmartObject } from '../../layers/smartObjects';
import type { LayerOverride } from '../../rendering/compositor';
import { readLayerContent } from '../../rendering/compositor';

export let lastFilter: { id: string; params: FilterParams } | null = null;

/**
 * The rasters a filter runs on, with the foreground / background it sees: CMYK layers run once per
 * plate (plate colours), Lab layers through an exact RGB view, everything else directly.
 */
function filterPlates(s: DocumentSession, target: RasterTarget, raster: TiledRaster): { raster: TiledRaster; fg: [number, number, number]; bg: [number, number, number] }[] {
  const { fg, bg } = useApp.getState();
  const tri = (c: RGB): [number, number, number] => [c.r, c.g, c.b];
  if (target.kind !== 'layer' || raster.channels !== 4) return [{ raster, fg: tri(fg), bg: tri(bg) }];
  if (isCmykDoc(s.doc)) {
    const k = ensureCompanion(raster);
    return [0, 1].map((p) => ({ raster: p ? k : raster, fg: tri(plateColor(s.doc, fg, p)), bg: tri(plateColor(s.doc, bg, p)) }));
  }
  if (isLabDoc(s.doc)) return [{ raster: labRgbView(raster), fg: tri(labViewColor(fg)), bg: tri(labViewColor(bg)) }];
  return [{ raster, fg: tri(fg), bg: tri(bg) }];
}

type Target = { kind: 'raster'; target: RasterTarget } | { kind: 'smart'; layer: SmartObjectLayer };

export function filterTarget(s: DocumentSession): Target | { error: string } {
  const qm = useApp.getState().quickMask;
  const l = s.activeLayer();
  if (!qm && !s.activeChannelId && !s.editMask && l?.kind === 'smartObject') return { kind: 'smart', layer: l };
  const t = s.paintTarget(qm);
  if (!t) return { error: s.paintBlockReason(qm) ?? 'The current layer cannot be filtered.' };
  if (t.kind === 'layer' && l && (l.locks.pixels || l.locks.all)) return { error: `"${l.name}" is locked.` };
  return { kind: 'raster', target: t };
}

/** Region (document px) to process for a raster target. */
function targetRegion(s: DocumentSession, t: RasterTarget): Rect | null {
  const r = resolveTarget(s.doc, t)!;
  const sel = s.doc.selection;
  const content = t.kind === 'layer' ? rasterContentBounds(r.raster) : null;
  let region: Rect | null = content ? translate(content, r.x, r.y) : s.doc.bounds;
  if (t.kind !== 'layer') region = s.doc.bounds;
  if (!sel.isEmpty() && t.kind !== 'selection') {
    const sb = sel.bounds(s.doc.bounds);
    region = region && sb ? intersect(region, sb) : null;
  }
  return region && !isEmpty(region) ? region : null;
}

export async function applyFilter(id: string, params: FilterParams): Promise<boolean> {
  const s = need();
  const def = filterById(id);
  if (!s || !def) return false;
  if (def.comingSoon) {
    ui.toast('info', `${def.name.replace('…', '')} is coming soon.`);
    return false;
  }
  const t = filterTarget(s);
  if ('error' in t) {
    ui.toast('warning', t.error);
    return false;
  }
  lastFilter = { id, params: { ...params } };
  if (t.kind === 'smart') {
    if (def.runAsync) {
      ui.toast('warning', 'Plugin filters cannot be applied as smart filters.', 'Rasterize the smart object to apply this filter to its pixels.');
      return false;
    }
    return addSmartFilter(s, t.layer, def, params);
  }

  const target = t.target;
  const res = resolveTarget(s.doc, target)!;
  const region = targetRegion(s, target);
  if (!region) {
    ui.toast('info', 'Nothing to filter in the selected area.');
    return false;
  }
  const pad = def.global ? 0 : def.padding(params);
  // Global filters see the whole content bounds so position-dependent effects are centered on it.
  const content = target.kind === 'layer' ? translate(rasterContentBounds(res.raster) ?? region, res.x, res.y) : s.doc.bounds;
  const work = def.global ? union(content, region)! : expand(region, pad);
  const lr = translate(work, -res.x, -res.y);
  const before = res.raster.snapshot();
  const name = def.name.replace('…', '');
  const p = ui.progress(`Applying ${name}… 0%`);
  const plates = filterPlates(s, target, res.raster);
  let cancel: (() => void) | null = null;
  ui.set((st) => ({ progress: st.progress.map((x) => (x.label.startsWith(`Applying ${name}`) ? { ...x, cancel: () => cancel?.() } : x)) }));
  try {
    const sel = s.doc.selection;
    const cov = !sel.isEmpty() && target.kind !== 'selection' ? sel.read(region) : null;
    const ch = res.channels;
    for (let k = 0; k < plates.length; k++) {
      const pl = plates[k];
      const input = pl.raster.readFloat(lr);
      const original = input.slice();
      const task = runFilterAsync(def, params, { w: work.w, h: work.h, ch, data: input }, { scale: 1, originX: work.x, originY: work.y, bounds: def.global ? content : region, foreground: pl.fg, background: pl.bg }, (f) => p.update((k + f) / plates.length, `Applying ${name}… ${Math.round(((k + f) / plates.length) * 100)}%`));
      cancel = () => task.cancel();
      const out = await task.promise;
      // Blend into the output region using the selection coverage.
      const result = original;
      for (let y = 0; y < region.h; y++)
        for (let x = 0; x < region.w; x++) {
          const wi = ((y + region.y - work.y) * work.w + (x + region.x - work.x)) * ch;
          const kk = cov ? cov[y * region.w + x] : 1;
          if (kk <= 0) continue;
          for (let c = 0; c < ch; c++) result[wi + c] += (out.data[wi + c] - result[wi + c]) * kk;
        }
      pl.raster.writeFloat(lr, result);
    }
    if (target.kind === 'layer') { res.raster.compact(); res.raster.companion?.compact(); }
    const after = res.raster.snapshot();
    s.push(new ApplyFilterCommand(def.name.replace('…', ''), target, before, after, work, { action: 'filter.apply', args: { id, params } }), true);
    emitTargetChange(s.doc, target, work);
    return true;
  } catch (e) {
    res.raster.restore(before);
    if ((e as Error).message !== 'Cancelled') ui.toast('error', `${def.name.replace('…', '')} failed`, (e as Error).message);
    return false;
  } finally {
    p.done();
  }
}

async function addSmartFilter(s: DocumentSession, layer: SmartObjectLayer, def: FilterDef, params: FilterParams): Promise<boolean> {
  if (!(await ensureDecoded(s.doc, layer))) {
    const src = s.doc.smartSources.get(layer.sourceId);
    ui.toast('warning', 'Smart filters need the smart object contents, which could not be decoded.', src?.decodeError ?? 'Rasterize the layer to filter its pixels.');
    return false;
  }
  const sf: SmartFilter = { id: newId('sf'), filterId: def.id, name: def.name.replace('…', ''), params: { ...params }, enabled: true, opacity: 1, blendMode: 'normal' };
  const cmd = editLayer(s.doc, layer.id, def.name.replace('…', ''), (l) => {
    const so = l as SmartObjectLayer;
    so.smartFilters = [...so.smartFilters, sf];
    renderSmartObject(s.doc, so);
  }, { action: 'filter.apply', args: { id: def.id, params } });
  if (cmd) s.push(cmd, true);
  return true;
}

/** Filter Gallery: applies a stack of filters in order as one step (or as smart filters). */
export async function applyFilterStack(stack: { id: string; params: FilterParams }[]): Promise<boolean> {
  const s = need();
  if (!s) return false;
  const items = stack.map((x) => ({ def: filterById(x.id), params: x.params })).filter((x): x is { def: FilterDef; params: FilterParams } => !!x.def && !x.def.comingSoon);
  if (!items.length) return false;
  if (items.length === 1) return applyFilter(items[0].def.id, items[0].params);
  const t = filterTarget(s);
  if ('error' in t) {
    ui.toast('warning', t.error);
    return false;
  }
  const record = { action: 'filter.gallery', args: { stack: items.map((x) => ({ id: x.def.id, params: { ...x.params } })) } };
  if (t.kind === 'smart') {
    if (items.some((x) => x.def.runAsync)) {
      ui.toast('warning', 'Plugin filters cannot be applied as smart filters.');
      return false;
    }
    if (!(await ensureDecoded(s.doc, t.layer))) {
      ui.toast('warning', 'Smart filters need the smart object contents, which could not be decoded.', s.doc.smartSources.get(t.layer.sourceId)?.decodeError);
      return false;
    }
    const added: SmartFilter[] = items.map((x) => ({ id: newId('sf'), filterId: x.def.id, name: x.def.name.replace('…', ''), params: { ...x.params }, enabled: true, opacity: 1, blendMode: 'normal' }));
    const cmd = editLayer(s.doc, t.layer.id, 'Filter Gallery', (l) => {
      const so = l as SmartObjectLayer;
      so.smartFilters = [...so.smartFilters, ...added];
      renderSmartObject(s.doc, so);
    }, record);
    if (cmd) s.push(cmd, true);
    return true;
  }
  const target = t.target;
  const res = resolveTarget(s.doc, target)!;
  const region = targetRegion(s, target);
  if (!region) {
    ui.toast('info', 'Nothing to filter in the selected area.');
    return false;
  }
  const content = target.kind === 'layer' ? translate(rasterContentBounds(res.raster) ?? region, res.x, res.y) : s.doc.bounds;
  const anyGlobal = items.some((x) => x.def.global);
  const pad = items.reduce((a, x) => a + (x.def.global ? 0 : x.def.padding(x.params)), 0);
  const work = anyGlobal ? union(content, expand(region, pad))! : expand(region, pad);
  const lr = translate(work, -res.x, -res.y);
  const before = res.raster.snapshot();
  const p = ui.progress('Filter Gallery… 0%');
  const plates = filterPlates(s, target, res.raster);
  try {
    const sel = s.doc.selection;
    const cov = !sel.isEmpty() && target.kind !== 'selection' ? sel.read(region) : null;
    const ch = res.channels;
    const steps = items.length * plates.length;
    for (let q = 0; q < plates.length; q++) {
      const pl = plates[q];
      const original = pl.raster.readFloat(lr);
      let current: Float32Array = original.slice();
      for (let k = 0; k < items.length; k++) {
        const { def, params } = items[k];
        const done = q * items.length + k;
        const task = runFilterAsync(def, params, { w: work.w, h: work.h, ch, data: current }, { scale: 1, originX: work.x, originY: work.y, bounds: def.global ? content : region, foreground: pl.fg, background: pl.bg }, (f) => p.update((done + f) / steps, `Filter Gallery… ${Math.round(((done + f) / steps) * 100)}%`));
        current = (await task.promise).data;
      }
      const result = original;
      for (let y = 0; y < region.h; y++)
        for (let x = 0; x < region.w; x++) {
          const wi = ((y + region.y - work.y) * work.w + (x + region.x - work.x)) * ch;
          const k = cov ? cov[y * region.w + x] : 1;
          if (k <= 0) continue;
          for (let c = 0; c < ch; c++) result[wi + c] += (current[wi + c] - result[wi + c]) * k;
        }
      pl.raster.writeFloat(lr, result);
    }
    if (target.kind === 'layer') { res.raster.compact(); res.raster.companion?.compact(); }
    s.push(new ApplyFilterCommand('Filter Gallery', target, before, res.raster.snapshot(), work, record), true);
    emitTargetChange(s.doc, target, work);
    return true;
  } catch (e) {
    res.raster.restore(before);
    if ((e as Error).message !== 'Cancelled') ui.toast('error', 'Filter Gallery failed', (e as Error).message);
    return false;
  } finally {
    p.done();
  }
}

export function updateSmartFilters(s: DocumentSession, layerId: string, label: string, mutate: (filters: SmartFilter[]) => SmartFilter[], enabled?: boolean): void {
  const cmd = editLayer(s.doc, layerId, label, (l) => {
    const so = l as SmartObjectLayer;
    so.smartFilters = mutate(structuredClone(so.smartFilters));
    if (enabled !== undefined) so.smartFiltersEnabled = enabled;
    renderSmartObject(s.doc, so);
  });
  if (cmd) s.push(cmd, true);
}

export function repeatLastFilter(): void {
  if (lastFilter) applyFilter(lastFilter.id, lastFilter.params);
}

// ---------------------------------------------------------------------------------------------
// Live preview on canvas
// ---------------------------------------------------------------------------------------------
const PREVIEW_ID = '__filterPreview';

export function setFilterPreview(s: DocumentSession, id: string | null, params: FilterParams | null): void {
  const l = s.activeLayer();
  const clear = () => {
    const prev = (s as unknown as Record<string, string | undefined>)[PREVIEW_ID];
    if (prev) s.engine.setOverride(prev, null, null);
    (s as unknown as Record<string, string | undefined>)[PREVIEW_ID] = undefined;
  };
  if (!id || !params || !l) return clear();
  const def = filterById(id);
  const t = filterTarget(s);
  if (!def || def.runAsync || 'error' in t || (t.kind === 'raster' && t.target.kind !== 'layer')) return clear();
  const layer = t.kind === 'smart' ? t.layer : l;
  const sel = s.doc.selection;
  const globalCache = new Map<number, { rect: Rect; data: Float32Array }>();
  const content = rasterContentBounds((layer as SmartObjectLayer).raster ?? (l as SmartObjectLayer).raster);
  const fg = useApp.getState().fg, bg = useApp.getState().bg;
  const lab = isLabDoc(s.doc);
  const ov: LayerOverride = {
    // Blur / sharpen previews are computed by the GPU compositor when it is active.
    gpu: ['gaussianBlur', 'boxBlur', 'unsharpMask'].includes(def.id) && t.kind !== 'smart' ? { filter: { id: def.id, params: { ...params } } } : undefined,
    read: (r, level, plate = 0) => {
      const scale = 1 / (1 << level);
      const ctxBase = { doc: s.doc, level, scale, opts: { level, plate } };
      const pfg = editColor(s.doc, fg, plate), pbg = editColor(s.doc, bg, plate);
      const base = { scale, originX: r.x, originY: r.y, bounds: content ? { x: (content.x + layer.x) * scale, y: (content.y + layer.y) * scale, w: content.w * scale, h: content.h * scale } : r, foreground: [pfg.r, pfg.g, pfg.b] as [number, number, number], background: [pbg.r, pbg.g, pbg.b] as [number, number, number] };
      // Lab: filters see (and return) the RGB view.
      const read = (rr: Rect) => { const v = readLayerContent(ctxBase, { ...layer, id: '__noop' } as never, rr); if (lab) labToRgbUnclamped(v); return v; };
      let filtered: Float32Array;
      const orig = read(r);
      if (def.global) {
        let g = globalCache.get(level * 2 + plate);
        if (!g && content) {
          const cr = { x: Math.floor((content.x + layer.x) * scale), y: Math.floor((content.y + layer.y) * scale), w: Math.ceil(content.w * scale) + 1, h: Math.ceil(content.h * scale) + 1 };
          const src = read(cr);
          g = { rect: cr, data: runFilterSync(def, params, { w: cr.w, h: cr.h, ch: 4, data: src }, { ...base, originX: cr.x, originY: cr.y }).data };
          globalCache.set(level * 2 + plate, g);
        }
        filtered = new Float32Array(r.w * r.h * 4);
        if (g) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
          const gx = r.x + x - g.rect.x, gy = r.y + y - g.rect.y;
          if (gx < 0 || gy < 0 || gx >= g.rect.w || gy >= g.rect.h) continue;
          filtered.set(g.data.subarray((gy * g.rect.w + gx) * 4, (gy * g.rect.w + gx) * 4 + 4), (y * r.w + x) * 4);
        }
      } else {
        const pad = Math.ceil(def.padding(params) * scale) + 1;
        const pr = expand(r, pad);
        const src = read(pr);
        const out = runFilterSync(def, params, { w: pr.w, h: pr.h, ch: 4, data: src }, { ...base, originX: pr.x, originY: pr.y });
        filtered = new Float32Array(r.w * r.h * 4);
        for (let y = 0; y < r.h; y++) filtered.set(out.data.subarray(((y + pad) * pr.w + pad) * 4, ((y + pad) * pr.w + pad + r.w) * 4), y * r.w * 4);
      }
      if (!sel.isEmpty()) {
        const cov = sel.mask.readFloat(r, level);
        for (let i = 0; i < r.w * r.h; i++) for (let c = 0; c < 4; c++) filtered[i * 4 + c] = orig[i * 4 + c] + (filtered[i * 4 + c] - orig[i * 4 + c]) * cov[i];
      }
      if (lab) rgbToLabUnclamped(filtered);
      return filtered;
    },
  };
  (s as unknown as Record<string, string | undefined>)[PREVIEW_ID] = layer.id;
  s.engine.setOverride(layer.id, ov, null);
}
