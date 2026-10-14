/** Slices: create/edit/delete (undoable), slices from guides, and Export Slices (ZIP of PNGs). */
import { zipSync } from 'fflate';
import { ui } from '../store';
import { need } from './common';
import { LambdaCommand } from '../../commands/layerCommands';
import { newId } from '../../document/ids';
import type { SliceDef } from '../../document/types';
import type { CelenneDocument } from '../../document/document';
import { intersect, isEmpty, Rect } from '../../image-engine/rect';
import { flattenToPixels } from '../../rendering/flatten';
import { encodePNG } from '../../formats/codecs';
import { platform } from '../platform/platform';

/** Replaces the document's slice list as one undoable step. */
function setSlices(label: string, next: SliceDef[]): void {
  const s = need();
  if (!s) return;
  const before = structuredClone(s.doc.slices);
  const after = structuredClone(next);
  s.push(new LambdaCommand(label, (d) => { d.slices = structuredClone(after); d.emit({ type: 'guides' }); }, (d) => { d.slices = structuredClone(before); d.emit({ type: 'guides' }); }));
  ui.bump('viewRev');
}

function clampRect(doc: CelenneDocument, r: Rect): Rect {
  return intersect({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }, doc.bounds);
}

export function nextSliceName(doc: CelenneDocument): string {
  const base = doc.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'slice';
  let i = doc.slices.length + 1;
  while (doc.slices.some((s) => s.name === `${base}_${String(i).padStart(2, '0')}`)) i++;
  return `${base}_${String(i).padStart(2, '0')}`;
}

export function addSlice(r: Rect): SliceDef | null {
  const s = need();
  if (!s) return null;
  const rect = clampRect(s.doc, r);
  if (isEmpty(rect) || rect.w < 2 || rect.h < 2) return null;
  const sl: SliceDef = { id: newId('slice'), name: nextSliceName(s.doc), rect };
  setSlices('Slice', [...s.doc.slices, sl]);
  return sl;
}

export function updateSlice(id: string, patch: Partial<SliceDef>, label = 'Edit Slice'): void {
  const s = need();
  if (!s) return;
  setSlices(label, s.doc.slices.map((x) => (x.id === id ? { ...x, ...patch, rect: patch.rect ? clampRect(s.doc, patch.rect) : x.rect } : x)));
}

export function deleteSlice(id: string): void {
  const s = need();
  if (!s || !s.doc.slices.some((x) => x.id === id)) return;
  setSlices('Delete Slice', s.doc.slices.filter((x) => x.id !== id));
}

export function clearSlices(): void {
  const s = need();
  if (!s || !s.doc.slices.length) return;
  setSlices('Delete All Slices', []);
}

/** Slices From Guides: one slice per cell of the guide grid (replaces the existing slices). */
export function slicesFromGuides(): void {
  const s = need();
  if (!s) return;
  const d = s.doc;
  const xs = [0, ...d.guides.filter((g) => g.orientation === 'vertical').map((g) => Math.round(g.position)), d.width].filter((v, i, a) => v >= 0 && v <= d.width && a.indexOf(v) === i).sort((a, b) => a - b);
  const ys = [0, ...d.guides.filter((g) => g.orientation === 'horizontal').map((g) => Math.round(g.position)), d.height].filter((v, i, a) => v >= 0 && v <= d.height && a.indexOf(v) === i).sort((a, b) => a - b);
  if (xs.length < 3 && ys.length < 3) {
    ui.toast('info', 'Add guides first: slices are created from the cells between guides.');
    return;
  }
  const base = d.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'slice';
  const list: SliceDef[] = [];
  for (let j = 0; j + 1 < ys.length; j++)
    for (let i = 0; i + 1 < xs.length; i++) {
      const r = { x: xs[i], y: ys[j], w: xs[i + 1] - xs[i], h: ys[j + 1] - ys[j] };
      if (r.w > 0 && r.h > 0) list.push({ id: newId('slice'), name: `${base}_${String(list.length + 1).padStart(2, '0')}`, rect: r });
    }
  setSlices('Slices From Guides', list);
}

/** File ▸ Export ▸ Export Slices: one PNG per slice (the whole image when there are none), zipped. */
export async function exportSlices(): Promise<void> {
  const s = need();
  if (!s) return;
  const d = s.doc;
  const slices = d.slices.length ? d.slices : [{ id: 'all', name: d.name.replace(/\.[^.]+$/, '') || 'image', rect: d.bounds }];
  const path = await platform().chooseSavePath(`${d.name.replace(/\.[^.]+$/, '')}_slices.zip`, [{ name: 'ZIP archive', extensions: ['zip'] }]);
  if (!path) return;
  const p = ui.progress('Exporting slices…');
  try {
    const f = flattenToPixels(d, { depth: 8 });
    const files: Record<string, Uint8Array> = {};
    const used = new Set<string>();
    slices.forEach((sl, k) => {
      const r = intersect(sl.rect, d.bounds);
      if (isEmpty(r)) return;
      const px = new Uint8ClampedArray(r.w * r.h * 4);
      for (let y = 0; y < r.h; y++) px.set((f.data as Uint8ClampedArray).subarray(((r.y + y) * f.width + r.x) * 4, ((r.y + y) * f.width + r.x + r.w) * 4), y * r.w * 4);
      let name = (sl.name || `slice_${k + 1}`).replace(/[\\/:*?"<>|]+/g, '_');
      while (used.has(name)) name += '_';
      used.add(name);
      files[`${name}.png`] = encodePNG(r.w, r.h, px, 8, { resolution: d.canvas.resolution });
      p.update((k + 1) / slices.length);
    });
    await platform().writePath(path, zipSync(files, { level: 0 }));
    ui.toast('success', `Exported ${Object.keys(files).length} slice${Object.keys(files).length === 1 ? '' : 's'}.`);
  } catch (e) {
    ui.toast('error', 'Export Slices failed', (e as Error).message);
  } finally {
    p.done();
  }
}
