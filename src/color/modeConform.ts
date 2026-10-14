/**
 * Keeps Indexed Color and Bitmap documents true to their mode after every edit:
 *  - the document holds a single pixel layer (as in Photoshop); any step that adds layers or
 *    other layer kinds is reverted and dropped from history;
 *  - edited pixels are snapped to the colour table (Indexed) or to pure black / white
 *    (Bitmap). Tiles are copy-on-write, so only tiles created by the edit are visited.
 */
import type { CelenneDocument } from '../document/document';
import type { History } from '../history/history';
import { Tile, TILE_SIZE, keyToTile } from '../image-engine/tiledRaster';
import { NearestPalette, snapBitmap, snapIndexed } from './indexed';

const conformed = new WeakSet<Tile>();
const palettes = new WeakMap<number[], NearestPalette>();

export function isSingleLayerMode(doc: CelenneDocument): boolean {
  return doc.canvas.colorMode === 'indexed' || doc.canvas.colorMode === 'bitmap';
}

/** Why the document's layer structure is not allowed in its mode, or null. */
export function structureProblem(doc: CelenneDocument): string | null {
  if (!isSingleLayerMode(doc)) return null;
  const mode = doc.canvas.colorMode === 'indexed' ? 'Indexed Color' : 'Bitmap';
  const kids = doc.root.children;
  if (kids.length !== 1 || kids[0].kind !== 'pixel') return `${mode} documents have a single pixel layer. Convert to RGB Color (Image ▸ Mode) to use layers.`;
  const l = kids[0];
  if (l.mask || l.vectorMask) return `${mode} documents cannot have layer masks.`;
  return null;
}

/** Snaps the pixels of tiles changed since the last call. Returns true when pixels changed. */
export function conformPixels(doc: CelenneDocument): boolean {
  if (!isSingleLayerMode(doc)) return false;
  const l = doc.root.children[0];
  if (!l || l.kind !== 'pixel') return false;
  const bitmap = doc.canvas.colorMode === 'bitmap';
  const table = doc.canvas.colorTable ?? [0, 0, 0, 255, 255, 255];
  let np = palettes.get(table);
  if (!np) { np = new NearestPalette(table); palettes.set(table, np); }
  const transparent = !!doc.canvas.colorTableTransparent;
  const r = l.raster;
  let changed = false;
  const pending = [...r.tiles.entries()].filter(([, t]) => !conformed.has(t));
  for (const [k] of pending) {
    const [tx, ty] = keyToTile(k);
    const rect = { x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE };
    const f = r.readFloat(rect);
    const px = new Uint8ClampedArray(f.length);
    for (let i = 0; i < f.length; i++) px[i] = f[i] * 255 + 0.5;
    // Pixels outside the canvas are irrelevant to the mode but are snapped too (they reappear on canvas moves).
    const did = bitmap ? snapBitmap(px) : snapIndexed(px, np, transparent);
    if (did) {
      for (let i = 0; i < f.length; i++) f[i] = px[i] / 255;
      r.writeFloat(rect, f);
      changed = true;
    }
  }
  for (const t of r.tiles.values()) conformed.add(t);
  return changed;
}

/** Marks every current tile as conformed (after a conversion that produced mode-exact pixels). */
export function markConformed(doc: CelenneDocument): void {
  for (const l of doc.root.children) if (l.kind === 'pixel') for (const t of l.raster.tiles.values()) conformed.add(t);
}

/**
 * History hook: returns a message when the last step was rejected, otherwise snaps pixels.
 */
export function conformAfterStep(doc: CelenneDocument, history: History): string | null {
  if (!isSingleLayerMode(doc)) return null;
  const problem = structureProblem(doc);
  if (problem) {
    history.rejectLast();
    return problem;
  }
  if (conformPixels(doc)) doc.emit({ type: 'layer', layerId: doc.root.children[0].id });
  return null;
}
