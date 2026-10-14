/**
 * Patterns are stored as RGB. CMYK and Lab documents composite them per plate: each pattern is
 * converted once through the document profile and cached per pattern raster, mode and plate.
 */
import type { CelenneDocument } from '../document/document';
import type { PatternDef } from '../document/types';
import { TiledRaster } from '../image-engine/tiledRaster';
import { isCmykDoc, isLabDoc, registerPlatePatterns, rgbToPlates } from '../color/plates';

const cache = new WeakMap<TiledRaster, Map<string, TiledRaster>>();

export function platePatterns(doc: CelenneDocument, plate: number): Map<string, PatternDef> {
  if (!isCmykDoc(doc) && !isLabDoc(doc)) return doc.patterns;
  const key = `${doc.canvas.colorMode}:${plate}:${doc.profile.name}:${doc.profile.icc?.length ?? 0}`;
  const out = new Map<string, PatternDef>();
  for (const [id, p] of doc.patterns) {
    let m = cache.get(p.raster);
    if (!m) { m = new Map(); cache.set(p.raster, m); }
    let r = m.get(key);
    if (!r) {
      const n = p.width * p.height;
      const px = p.raster.readFloat({ x: 0, y: 0, w: p.width, h: p.height });
      const plates = rgbToPlates(doc, px, n);
      r = TiledRaster.fromPixels(p.width, p.height, 4, 32, plates[plate] ?? plates[0]);
      m.set(key, r);
    }
    out.set(id, { ...p, raster: r });
  }
  return out;
}

registerPlatePatterns(platePatterns);
