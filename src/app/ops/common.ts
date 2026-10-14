/** Shared helpers for application operations. */
import { isCmykDoc, isLabDoc, platesToRgb, readPlates } from '../../color/plates';
import type { TiledRaster } from '../../image-engine/tiledRaster';
import { editor } from '../editor';
import { ui, useApp } from '../store';
import type { DocumentSession } from '../session';
import type { Layer } from '../../document/types';
import { compositeRegion } from '../../rendering/compositor';
import type { Rect } from '../../image-engine/rect';
import { LazyImage } from '../../selection/ops';
import { hasRaster } from '../../document/types';

export function need(): DocumentSession | null {
  const s = editor.active;
  if (!s) ui.toast('info', 'Open or create a document first.');
  return s;
}

export function needLayer(): { s: DocumentSession; l: Layer } | null {
  const s = need();
  if (!s) return null;
  const l = s.activeLayer();
  if (!l) {
    ui.toast('info', 'Select a layer first.');
    return null;
  }
  return { s, l };
}

export function quickMask(): boolean {
  return useApp.getState().quickMask;
}

/** Straight composite of one plate (document values) for a region (all visible layers). */
export function compositeStraightPlate(s: DocumentSession, r: Rect, plate = 0): Float32Array {
  const buf = compositeRegion(s.doc, r, { level: 0, plate });
  for (let i = 0; i < r.w * r.h; i++) {
    const a = buf[i * 4 + 3];
    if (a > 1e-7) { buf[i * 4] /= a; buf[i * 4 + 1] /= a; buf[i * 4 + 2] /= a; }
  }
  return buf;
}

/**
 * Straight RGBA appearance of the composite (all visible layers): document values for RGB and
 * Gray documents, sRGB for CMYK and Lab documents (for analysis: selections, sampling, patterns).
 */
export function compositeStraight(s: DocumentSession, r: Rect): Float32Array {
  if (!isCmykDoc(s.doc) && !isLabDoc(s.doc)) return compositeStraightPlate(s, r, 0);
  const plates = [compositeStraightPlate(s, r, 0)];
  if (isCmykDoc(s.doc)) plates.push(compositeStraightPlate(s, r, 1));
  return platesToRgb(s.doc, plates, r.w * r.h);
}

/** Straight RGBA appearance of a raster-backed layer's pixels (see compositeStraight). */
export function layerAppearance(s: DocumentSession, l: Layer & { raster: TiledRaster; x: number; y: number }, r: Rect): Float32Array {
  const rr = { x: r.x - l.x, y: r.y - l.y, w: r.w, h: r.h };
  if (!isCmykDoc(s.doc) && !isLabDoc(s.doc)) return l.raster.readFloat(rr);
  return platesToRgb(s.doc, readPlates(s.doc, l.raster, rr), r.w * r.h);
}

/** Sampling image: all visible layers (composite) or the active layer, as appearance RGB. */
export function samplingImage(s: DocumentSession, allLayers: boolean): LazyImage {
  const l = s.activeLayer();
  if (!allLayers && l && hasRaster(l)) {
    return new LazyImage(s.doc.bounds, (r) => layerAppearance(s, l, r));
  }
  return new LazyImage(s.doc.bounds, (r) => compositeStraight(s, r));
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function uniqueLayerName(s: DocumentSession, base: string): string {
  const names = new Set(s.doc.allLayers().map((l) => l.name));
  if (!names.has(base)) return base;
  let i = 2;
  const stem = base.replace(/ \d+$/, '');
  while (names.has(`${stem} ${i}`)) i++;
  return `${stem} ${i}`;
}

export function nextLayerName(s: DocumentSession, prefix = 'Layer'): string {
  let i = 1;
  const names = new Set(s.doc.allLayers().map((l) => l.name));
  while (names.has(`${prefix} ${i}`)) i++;
  return `${prefix} ${i}`;
}

/** Insertion point above the active layer (or at top of root). */
export function insertionPoint(s: DocumentSession): { parentId: string; index: number } {
  const a = s.activeLayer();
  if (!a || !a.parent) return { parentId: 'root', index: s.doc.root.children.length };
  if (a.kind === 'group' && a.expanded && a.children.length === 0) return { parentId: a.id, index: 0 };
  return { parentId: a.parent.id, index: a.parent.children.indexOf(a) + 1 };
}
