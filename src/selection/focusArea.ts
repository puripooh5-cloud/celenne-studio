/**
 * Select ▸ Focus Area: selects the parts of the image that are in focus.
 *
 * Sharpness is the local energy of the Laplacian (after a noise-suppressing pre-blur), pooled
 * over a window proportional to the image size and normalized to 0..1. The "In-Focus Range"
 * sets the sharpness threshold (Auto picks it with Otsu's method); the mask is cleaned with a
 * small open/close and optionally softened with an edge-aware (guided) filter.
 */
import { boxBlur, gaussianBlur } from '../image-engine/blur';
import { guidedRefine } from '../ai/local';

export interface FocusMap {
  w: number;
  h: number;
  /** Sharpness 0..1 per pixel. */
  map: Float32Array;
  /** Straight RGBA of the analysed image (guide for soft edges). */
  rgba: Float32Array;
}

/** Computes the sharpness map of a straight RGBA float image. `noise` 0..1 suppresses grain. */
export function focusMap(rgba: Float32Array, w: number, h: number, noise: number): FocusMap {
  const n = w * h;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = (0.3 * rgba[i * 4] + 0.59 * rgba[i * 4 + 1] + 0.11 * rgba[i * 4 + 2]) * rgba[i * 4 + 3];
  gaussianBlur(L, w, h, 1, 0.5 + noise * 2.5);
  const e = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = L[y * w + x];
      const l = L[y * w + Math.max(0, x - 1)], r = L[y * w + Math.min(w - 1, x + 1)];
      const u = L[Math.max(0, y - 1) * w + x], d = L[Math.min(h - 1, y + 1) * w + x];
      const lap = l + r + u + d - 4 * c;
      e[y * w + x] = lap * lap;
    }
  const rad = Math.max(3, Math.round(Math.max(w, h) / 90));
  boxBlur(e, w, h, 1, rad);
  boxBlur(e, w, h, 1, rad);
  for (let i = 0; i < n; i++) e[i] = Math.sqrt(e[i]);
  // Normalize by a high percentile (robust to a few extreme edges).
  const sorted = Float32Array.from(e).sort();
  const p = sorted[Math.min(n - 1, Math.floor(n * 0.98))] || 1e-6;
  for (let i = 0; i < n; i++) e[i] = Math.min(1, e[i] / p);
  return { w, h, map: e, rgba };
}

/** Otsu threshold of the sharpness map, returned as an In-Focus Range (0..1, higher = more selected). */
export function autoRange(f: FocusMap): number {
  const bins = new Float64Array(256);
  for (const v of f.map) bins[Math.min(255, Math.floor(v * 255))]++;
  const total = f.map.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * bins[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += bins[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * bins[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return Math.max(0, Math.min(1, 1 - t / 255));
}

/** Selection coverage for an In-Focus Range. */
export function focusMask(f: FocusMap, range: number, soften: boolean): Float32Array {
  const { w, h, map } = f;
  const n = w * h;
  const t = Math.max(0.001, 1 - range);
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = map[i] >= t ? 1 : 0;
  // Close small holes, then open away specks (box blur + re-threshold).
  const r = Math.max(2, Math.round(Math.max(w, h) / 200));
  boxBlur(m, w, h, 1, r);
  for (let i = 0; i < n; i++) m[i] = m[i] > 0.35 ? 1 : 0;
  boxBlur(m, w, h, 1, r);
  for (let i = 0; i < n; i++) m[i] = m[i] > 0.65 ? 1 : 0;
  if (!soften) return m;
  return guidedRefine(f.rgba, m, w, h, Math.max(2, Math.round(Math.max(w, h) / 150)));
}

/**
 * Noise level 0..1 from the median absolute diagonal high-pass (Donoho's robust estimator):
 * texture and edges are sparse in that band, sensor grain is everywhere.
 */
export function estimateNoise(rgba: Float32Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  const L = (x: number, y: number) => { const i = (y * w + x) * 4; return 0.3 * rgba[i] + 0.59 * rgba[i + 1] + 0.11 * rgba[i + 2]; };
  const v: number[] = [];
  for (let y = 0; y + 1 < h; y += 2)
    for (let x = 0; x + 1 < w; x += 2) v.push(Math.abs(L(x, y) - L(x + 1, y) - L(x, y + 1) + L(x + 1, y + 1)) / 2);
  v.sort((a, b) => a - b);
  const sigma = v[Math.floor(v.length / 2)] / 0.6745;
  return Math.max(0, Math.min(1, sigma * 12));
}
