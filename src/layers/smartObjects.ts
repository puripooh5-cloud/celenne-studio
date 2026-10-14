/**
 * Smart objects: embedded/linked sources rendered non-destructively through a quad transform
 * and an editable smart-filter stack. The source is never modified by transforms or filters.
 */
import { imageSpace, rasterFromImage } from '../formats/decodedRaster';
import { isCmykDoc, isLabDoc } from '../color/plates';
import { convertRasterSpace, spaceOfDoc } from '../color/convertDocument';
import type { CelenneDocument } from '../document/document';
import type { SmartObjectLayer, SmartObjectSource } from '../document/types';
import { TiledRaster } from '../image-engine/tiledRaster';
import { applyH, invertH, quadBounds, rectToQuad } from '../image-engine/matrix';
import { Rect, roundOut } from '../image-engine/rect';
import { evalGrid, isIdentityGrid, meshBounds, meshWarpRegion, sampleMesh } from '../image-engine/warp';
import { warpRaster } from '../image-engine/resample';
import { decodeImageFile } from '../formats/codecs';
import { importPsd } from '../psd/import';
import { flattenToPixels } from '../rendering/flatten';
import { filterById } from '../filters/builtin';
import { runFilterSync } from '../filters/runner';
import { compositeSpan } from '../image-engine/blend';

export async function decodeSmartSource(src: SmartObjectSource, bytes?: Uint8Array): Promise<NonNullable<SmartObjectSource['decoded']>> {
  const data = bytes ?? src.data;
  if (!data) throw new Error(src.kind === 'linked' ? `Linked file "${src.name}" is not available. Relink it via Layer › Smart Objects › Relink to File.` : 'Smart object data is missing.');
  const t = src.fileType.toLowerCase();
  const isPsd = t === 'psd' || t === 'psb' || (data[0] === 0x38 && data[1] === 0x42 && data[2] === 0x50 && data[3] === 0x53);
  if (isPsd) {
    const r = importPsd(data, src.name);
    const d = r.doc;
    if (isCmykDoc(d) || isLabDoc(d)) {
      // Native contents: stored values per plate, with their colour space.
      const f0 = flattenToPixels(d, { plate: 0 });
      const raster = TiledRaster.fromPixels(f0.width, f0.height, 4, f0.depth, f0.data);
      if (isCmykDoc(d)) { const f1 = flattenToPixels(d, { plate: 1 }); raster.companion = TiledRaster.fromPixels(f1.width, f1.height, 4, f1.depth, f1.data); }
      return { width: f0.width, height: f0.height, raster, space: { mode: d.canvas.colorMode, profile: d.profile } };
    }
    const flat = flattenToPixels(d);
    return { width: flat.width, height: flat.height, raster: TiledRaster.fromPixels(flat.width, flat.height, 4, flat.depth, flat.data), space: { mode: d.canvas.colorMode, profile: d.profile } };
  }
  if (/^(ai|pdf|eps)$/.test(t)) throw new Error(`Vector smart object sources (${t.toUpperCase()}) cannot be rendered yet; the stored rendering is kept. [Coming Soon]`);
  const img = await decodeImageFile(data, src.name.includes('.') ? src.name : `${src.name}.${t}`);
  const space = imageSpace(img);
  return { width: img.width, height: img.height, raster: rasterFromImage(img), space: { mode: space.mode, profile: space.profile } };
}

/** Decodes the layer's source if needed. Returns false (and keeps preserved pixels) on failure. */
export async function ensureDecoded(doc: CelenneDocument, layer: SmartObjectLayer): Promise<boolean> {
  const src = doc.smartSources.get(layer.sourceId);
  if (!src) return false;
  if (src.decoded) return true;
  if (src.decodeError) return false;
  try {
    src.decoded = await decodeSmartSource(src);
    return true;
  } catch (e) {
    src.decodeError = (e as Error).message;
    return false;
  }
}

/** Renders the smart object from its source (requires a decoded source). */
export function renderSmartObject(doc: CelenneDocument, layer: SmartObjectLayer): void {
  const src = doc.smartSources.get(layer.sourceId);
  const dec = src?.decoded;
  if (!dec) return; // keep the preserved (Photoshop-rendered) pixels
  const H = rectToQuad(layer.sourceWidth, layer.sourceHeight, layer.quad);
  // The source may be decoded at a different pixel size than declared (e.g. vector/placed scale).
  const sx = dec.width / layer.sourceWidth, sy = dec.height / layer.sourceHeight;
  const inv = invertH(H);
  const scaleInv: typeof inv = [sx * inv[0], sx * inv[1], sx * inv[2], sy * inv[3], sy * inv[4], sy * inv[5], inv[6], inv[7], inv[8]];
  let dst: Rect;
  const warp = layer.warp && !isIdentityGrid(layer.warp, { x: 0, y: 0, w: layer.sourceWidth, h: layer.sourceHeight }) ? layer.warp : null;
  const mesh = warp ? sampleMesh((u, v) => { const p = evalGrid(warp, u, v); return applyH(H, p.x, p.y); }) : null;
  if (mesh) dst = meshBounds(mesh);
  else {
    const qb = quadBounds(layer.quad);
    dst = roundOut(qb.x, qb.y, qb.x + qb.w, qb.y + qb.h);
  }
  // Source → (envelope) → quad → document, for each plate of the contents.
  const place = (r: TiledRaster) => mesh
    ? meshWarpRegion({ raster: r, ox: 0, oy: 0, bounds: { x: 0, y: 0, w: dec.width, h: dec.height } }, { x: 0, y: 0, w: dec.width, h: dec.height }, mesh, dst)
    : warpRaster(r, { x: 0, y: 0, w: dec.width, h: dec.height }, scaleInv, dst, 'bicubic');
  let px = place(dec.raster);
  const srcSpace = dec.space ?? { mode: 'rgb' as const, profile: { name: 'sRGB IEC61966-2.1', builtin: 'srgb' as const } };
  const nativeK = dec.raster.companion ? place(dec.raster.companion) : null;
  const filterAll = (input: Float32Array): Float32Array => {
    let px = input;
    if (layer.smartFiltersEnabled) {
      for (const f of layer.smartFilters) {
        if (!f.enabled) continue;
        const def = filterById(f.filterId);
        if (!def || def.runAsync) continue;
        const filtered = runFilterSync(def, f.params as never, { w: dst.w, h: dst.h, ch: 4, data: px.slice() }, { scale: 1, originX: dst.x, originY: dst.y, bounds: dst, foreground: [0, 0, 0], background: [1, 1, 1] });
        if (f.opacity >= 1 && f.blendMode === 'normal') px = filtered.data;
        else {
          // Blend the filtered result over the unfiltered one (smart filter blending options).
          const base = new Float32Array(px.length);
          for (let i = 0; i < dst.w * dst.h; i++) { const a = px[i * 4 + 3]; base[i * 4] = px[i * 4] * a; base[i * 4 + 1] = px[i * 4 + 1] * a; base[i * 4 + 2] = px[i * 4 + 2] * a; base[i * 4 + 3] = a; }
          compositeSpan(f.blendMode, base, 0, filtered.data, 0, dst.w * dst.h, { opacity: f.opacity });
          for (let i = 0; i < dst.w * dst.h; i++) { const a = base[i * 4 + 3]; if (a > 1e-6) { base[i * 4] /= a; base[i * 4 + 1] /= a; base[i * 4 + 2] /= a; } }
          px = base;
        }
      }
    }
    return px;
  };
  px = filterAll(px);
  const nativeKf = nativeK ? filterAll(nativeK) : null;
  const raster = new TiledRaster(4, doc.canvas.bitDepth);
  const full = { x: 0, y: 0, w: dst.w, h: dst.h };
  raster.writeFloat(full, px);
  if (nativeKf) {
    raster.companion = new TiledRaster(4, doc.canvas.bitDepth);
    raster.companion.writeFloat(full, nativeKf);
  }
  // Contents in another colour space are converted into the document's.
  convertRasterSpace(raster, srcSpace, spaceOfDoc(doc));
  raster.companion?.compact();
  raster.compact();
  layer.raster = raster;
  layer.x = dst.x;
  layer.y = dst.y;
  layer.usingPreservedPixels = false;
  layer.rev++;
}
