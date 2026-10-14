/**
 * Decoded images → Celenne rasters and documents, keeping CMYK and Lab files in their own colour
 * space (two plates for CMYK, one for Lab) instead of converting them to RGB.
 */
import type { DecodedImage } from './raster';
import type { BitDepth } from '../image-engine/pixels';
import { TiledRaster } from '../image-engine/tiledRaster';
import type { ColorSpaceRef } from '../color/convertDocument';
import type { ColorProfileRef } from '../document/types';
import { CELENNE_CMYK_NAME } from '../color/cmykProfile';
import { matchBuiltin, parseIccInfo } from '../color/icc';

/** The colour space a decoded image's pixels are in. `note` explains a missing CMYK profile. */
export function imageSpace(img: DecodedImage): ColorSpaceRef & { note?: string } {
  const info = img.icc && img.icc.length > 128 ? parseIccInfo(img.icc) : null;
  if (img.native?.mode === 'cmyk') {
    if (info?.colorSpace === 'CMYK') return { mode: 'cmyk', profile: { name: info.description || 'Embedded CMYK profile', icc: img.icc!.slice(), builtin: matchBuiltin(info.description) } };
    return { mode: 'cmyk', profile: { name: CELENNE_CMYK_NAME, builtin: 'celenneCMYK' }, note: `The CMYK image has no embedded CMYK profile; it is interpreted with ${CELENNE_CMYK_NAME}. Assign the right profile with Edit ▸ Assign Profile.` };
  }
  if (img.native?.mode === 'lab') return { mode: 'lab', profile: { name: 'Lab Color (D50)', builtin: 'labD50' } };
  const gray = img.colorMode === 'grayscale';
  const cs = info?.colorSpace.trim();
  const okSpace = info && (gray ? cs === 'GRAY' || cs === 'RGB' : cs === 'RGB');
  const profile: ColorProfileRef = okSpace ? { name: info!.description || 'Embedded profile', icc: img.icc!.slice(), builtin: matchBuiltin(info!.description) } : { name: 'sRGB IEC61966-2.1', builtin: 'srgb' };
  return { mode: gray && info?.colorSpace === 'GRAY' ? 'grayscale' : 'rgb', profile };
}

/** The image as a raster (plates for CMYK / Lab) at `depth` (default: the image's depth). */
export function rasterFromImage(img: DecodedImage, depth: BitDepth = img.depth): TiledRaster {
  const plates = img.native?.plates ?? [img.data];
  const rasters = plates.map((p) => {
    const r = TiledRaster.fromPixels(img.width, img.height, 4, img.depth, p);
    if (depth === img.depth) return r;
    const out = new TiledRaster(4, depth);
    const all = { x: 0, y: 0, w: img.width, h: img.height };
    out.writeFloat(all, r.readFloat(all));
    return out;
  });
  rasters[0].companion = rasters[1] ?? null;
  return rasters[0];
}
