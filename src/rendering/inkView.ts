/**
 * How inks look: Duotone documents (gray data through their inks), Multichannel documents (every
 * channel an ink on white paper) and spot channels printed over the image.
 */
import type { CelenneDocument } from '../document/document';
import type { AlphaChannel } from '../document/types';
import type { Rect } from '../image-engine/rect';
import { applyDuotone, inkFilter, mixInks, overprintSpot } from '../color/inks';
import { labToSrgb } from '../color/plates';

/** True when the document's appearance is not its stored values (Duotone, Multichannel). */
export function hasInkAppearance(doc: CelenneDocument): boolean {
  return !!doc.canvas.duotone || doc.canvas.colorMode === 'multichannel';
}

/** Spot channels shown printed over the image (all channels of a Multichannel document are inks). */
export function printedSpotChannels(doc: CelenneDocument): AlphaChannel[] {
  return doc.channels.filter((c) => c.kind === 'spot' && c.visible);
}

/**
 * Straight RGBA `buf` (the composite of `r` at `level`) → how it prints, in sRGB: Duotone inks,
 * Multichannel inks on paper, and (with `spots`) visible spot channels.
 */
export function applyInkAppearance(doc: CelenneDocument, buf: Float32Array, r: Rect, level: number, spots: boolean): void {
  const n = r.w * r.h;
  if (doc.canvas.colorMode === 'multichannel') {
    // Paper, then the channels as overprinted inks (opaque spot inks cover what is below).
    const inks = printedSpotChannels(doc);
    const filters = inks.map((c) => inkFilter(c.color));
    const values = inks.map((c) => c.raster.readFloat({ x: r.x, y: r.y, w: r.w, h: r.h }, level));
    const cov = new Array<number>(inks.length);
    const transparent = inks.map((c) => !(c.solidity && c.solidity > 0));
    const tf = filters.filter((_, k) => transparent[k]);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let k = 0; k < inks.length; k++) if (transparent[k]) cov[m++] = 1 - values[k][i];
      const c = tf.length ? labToSrgb(mixInks(tf, cov.slice(0, m))) : { r: 1, g: 1, b: 1 };
      buf[i * 4] = c.r; buf[i * 4 + 1] = c.g; buf[i * 4 + 2] = c.b; buf[i * 4 + 3] = 1;
    }
    inks.forEach((c, k) => { if (!transparent[k]) overprintSpot(buf, values[k], c.color, c.solidity ?? 0, n); });
    return;
  }
  if (doc.canvas.duotone) applyDuotone(doc.canvas.duotone, buf, n);
  if (spots) for (const c of printedSpotChannels(doc)) overprintSpot(buf, c.raster.readFloat({ x: r.x, y: r.y, w: r.w, h: r.h }, level), c.color, c.solidity ?? 0, n);
}

/** Whether the display needs the ink path (Duotone, Multichannel or printed spot channels). */
export function needsInkDisplay(doc: CelenneDocument): boolean {
  return hasInkAppearance(doc) || printedSpotChannels(doc).length > 0;
}
