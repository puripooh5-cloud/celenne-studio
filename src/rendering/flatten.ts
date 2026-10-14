/** Full-resolution flattening in horizontal strips (bounded memory for very large documents). */
import type { CelenneDocument } from '../document/document';
import { allocPixels, BitDepth, fromFloat, PixelArray } from '../image-engine/pixels';
import type { Rect } from '../image-engine/rect';
import { compositeRegion, CompositeOptions } from './compositor';
import { isCmykDoc, isLabDoc, platesToRgb } from '../color/plates';
import { applyInkAppearance, hasInkAppearance } from './inkView';

export interface FlattenOptions extends Partial<CompositeOptions> {
  region?: Rect;
  depth?: BitDepth;
  onProgress?: (fraction: number) => void;
  shouldCancel?: () => boolean;
  /** Output straight (default) or premultiplied alpha. */
  premultiplied?: boolean;
  /**
   * How the document prints, in sRGB: Duotone inks and Multichannel inks (image formats and
   * previews). Without it Duotone gives its Grayscale data and Multichannel an empty composite.
   */
  inks?: boolean;
}

/**
 * Flattens the document. RGB and Gray documents give their own values. CMYK and Lab documents
 * give their sRGB appearance (for image formats, previews and analysis) — unless `plate` is set,
 * which returns that plate's stored values (PSD / TIFF writers, smart object sources).
 */
export function flattenToPixels(doc: CelenneDocument, o: FlattenOptions = {}): { width: number; height: number; depth: BitDepth; data: PixelArray } {
  const r = o.region ?? doc.bounds;
  const depth = o.depth ?? doc.canvas.bitDepth;
  const out = allocPixels(depth, r.w * r.h * 4);
  const appearance = o.plate === undefined && (isCmykDoc(doc) || isLabDoc(doc));
  const stripH = Math.max(16, Math.min(512, Math.floor((8 * 1024 * 1024) / Math.max(1, r.w * 16))));
  const unpremultiply = (buf: Float32Array, n: number) => {
    for (let i = 0; i < n; i++) {
      const a = buf[i * 4 + 3];
      if (a > 1e-7) {
        const k = 1 / a;
        buf[i * 4] *= k; buf[i * 4 + 1] *= k; buf[i * 4 + 2] *= k;
      }
    }
  };
  for (let y = 0; y < r.h; y += stripH) {
    if (o.shouldCancel?.()) throw new Error('Cancelled');
    const h = Math.min(stripH, r.h - y);
    const strip = { x: r.x, y: r.y + y, w: r.w, h };
    const n = r.w * h;
    let buf: Float32Array;
    if (appearance) {
      const plates = [compositeRegion(doc, strip, { level: 0, ...o, plate: 0 })];
      if (isCmykDoc(doc)) plates.push(compositeRegion(doc, strip, { level: 0, ...o, plate: 1 }));
      for (const p of plates) unpremultiply(p, n);
      buf = platesToRgb(doc, plates, n);
      if (o.premultiplied) for (let i = 0; i < n; i++) { const a = buf[i * 4 + 3]; buf[i * 4] *= a; buf[i * 4 + 1] *= a; buf[i * 4 + 2] *= a; }
    } else {
      buf = compositeRegion(doc, strip, { level: 0, ...o });
      if (o.inks && hasInkAppearance(doc)) {
        unpremultiply(buf, n);
        applyInkAppearance(doc, buf, strip, 0, false);
        if (o.premultiplied) for (let i = 0; i < n; i++) { const a = buf[i * 4 + 3]; buf[i * 4] *= a; buf[i * 4 + 1] *= a; buf[i * 4 + 2] *= a; }
      } else if (!o.premultiplied) unpremultiply(buf, n);
    }
    if (depth !== 32) for (let i = 0; i < buf.length; i++) buf[i] = buf[i] < 0 ? 0 : buf[i] > 1 ? 1 : buf[i];
    fromFloat(buf, out, 0, y * r.w * 4, n * 4);
    o.onProgress?.((y + h) / r.h);
  }
  return { width: r.w, height: r.h, depth, data: out };
}

export function hasTransparency(data: PixelArray): boolean {
  const max = data instanceof Float32Array ? 1 : data instanceof Uint16Array ? 65535 : 255;
  for (let i = 3; i < data.length; i += 4) if (data[i] < max) return true;
  return false;
}
