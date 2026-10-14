/**
 * Offscreen rendering at display zoom levels, matching the viewport pipeline:
 * zoom ≤ 1 uses the pyramid level (50% = level 1), zoom > 1 magnifies level 0 with nearest
 * neighbour sampling (as the viewport does when zoomed in).
 */
import { isCmykDoc, isLabDoc, platesToRgb } from '../../src/color/plates';
import type { CelenneDocument } from '../../src/document/document';
import { compositeRegionPlates, compositeRegion } from '../../src/rendering/compositor';

export const ZOOMS = [0.5, 1, 2] as const;

/** Largest render size handled by visual regression (bigger documents are cropped to a window). */
const MAX_SIDE = 2048;

/** Premultiplied RGB appearance (CMYK / Lab plates converted). */
function appearance(doc: CelenneDocument, r: { x: number; y: number; w: number; h: number }, level: number): Float32Array {
  if (!isCmykDoc(doc) && !isLabDoc(doc)) return compositeRegion(doc, r, { level });
  const n = r.w * r.h;
  const plates = compositeRegionPlates(doc, r, { level });
  for (const p of plates) for (let i = 0; i < n; i++) { const a = p[i * 4 + 3]; if (a > 1e-7) { p[i * 4] /= a; p[i * 4 + 1] /= a; p[i * 4 + 2] /= a; } }
  const rgb = platesToRgb(doc, plates, n);
  for (let i = 0; i < n; i++) { const a = rgb[i * 4 + 3]; rgb[i * 4] *= a; rgb[i * 4 + 1] *= a; rgb[i * 4 + 2] *= a; }
  return rgb;
}

export function renderAtZoom(doc: CelenneDocument, zoom: number): { width: number; height: number; data: Uint8ClampedArray } | null {
  const level = zoom < 1 ? Math.round(Math.log2(1 / zoom)) : 0;
  const s = 1 << level;
  const lw = Math.ceil(doc.width / s), lh = Math.ceil(doc.height / s);
  const mag = zoom > 1 ? Math.round(zoom) : 1;
  // Very large canvases (PSB) are compared on a fixed window at the origin.
  const rw = Math.min(lw, Math.floor(MAX_SIDE / mag)), rh = Math.min(lh, Math.floor(MAX_SIDE / mag));
  const premul = appearance(doc, { x: 0, y: 0, w: rw, h: rh }, level);
  const W = rw * mag, H = rh * mag;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = ((Math.floor(y / mag) * rw) + Math.floor(x / mag)) * 4, o = (y * W + x) * 4;
      const a = premul[i + 3];
      // Composite over white so references are opaque and easy to inspect.
      out[o] = (premul[i] + (1 - a)) * 255 + 0.5;
      out[o + 1] = (premul[i + 1] + (1 - a)) * 255 + 0.5;
      out[o + 2] = (premul[i + 2] + (1 - a)) * 255 + 0.5;
      out[o + 3] = 255;
    }
  return { width: W, height: H, data: out };
}

export interface DiffResult {
  width: number;
  height: number;
  /** Largest per-channel difference (0..255). */
  maxDelta: number;
  meanDelta: number;
  /** Fraction of pixels whose largest channel difference exceeds `threshold`. */
  changedFraction: number;
  sizeMismatch: boolean;
}

export function diffImages(a: { width: number; height: number; data: ArrayLike<number> }, b: { width: number; height: number; data: ArrayLike<number> }, threshold = 2): DiffResult {
  if (a.width !== b.width || a.height !== b.height) return { width: a.width, height: a.height, maxDelta: 255, meanDelta: 255, changedFraction: 1, sizeMismatch: true };
  let max = 0, sum = 0, changed = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    let pm = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]);
      sum += d;
      if (d > pm) pm = d;
    }
    if (pm > max) max = pm;
    if (pm > threshold) changed++;
  }
  return { width: a.width, height: a.height, maxDelta: max, meanDelta: sum / (n * 3), changedFraction: changed / n, sizeMismatch: false };
}
