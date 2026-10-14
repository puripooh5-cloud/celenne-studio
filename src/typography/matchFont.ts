/**
 * Type ▸ Match Font: ranks installed fonts by how closely they reproduce a text sample in the
 * image. The user selects the text and types what it says; each candidate font renders that
 * text, and the ink shapes are compared on a normalized grid (blurred correlation plus an
 * aspect-ratio term). This is shape matching, not learned recognition: it needs the sample's
 * text and works best on a single line of clean text.
 */
import type { FontFaceInfo } from './fonts';

export interface FontMatch {
  face: FontFaceInfo;
  score: number;
}

const GW = 192, GH = 48;

/** Ink coverage (0..1) of a straight RGBA sample: pixels that differ from the dominant background. */
export function inkMask(rgba: Float32Array, w: number, h: number): Float32Array {
  const n = w * h;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = (0.3 * rgba[i * 4] + 0.59 * rgba[i * 4 + 1] + 0.11 * rgba[i * 4 + 2]) * rgba[i * 4 + 3] + (1 - rgba[i * 4 + 3]);
  // Background = the border's median luminance; ink = distance from it, normalized.
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(L[x], L[(h - 1) * w + x]);
  for (let y = 0; y < h; y++) border.push(L[y * w], L[y * w + w - 1]);
  border.sort((a, b) => a - b);
  const bg = border[Math.floor(border.length / 2)];
  let maxD = 1e-6;
  for (let i = 0; i < n; i++) maxD = Math.max(maxD, Math.abs(L[i] - bg));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0, (Math.abs(L[i] - bg) / maxD - 0.25) / 0.5));
  return out;
}

function bbox(m: Float32Array, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x] > 0.5) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Resamples the ink inside its bounding box onto the comparison grid (box filter), then blurs slightly. */
function normalize(m: Float32Array, w: number, h: number): { grid: Float32Array; aspect: number } | null {
  const b = bbox(m, w, h);
  if (!b) return null;
  const g = new Float32Array(GW * GH);
  for (let gy = 0; gy < GH; gy++)
    for (let gx = 0; gx < GW; gx++) {
      const sx0 = b.x + (gx / GW) * b.w, sx1 = b.x + ((gx + 1) / GW) * b.w;
      const sy0 = b.y + (gy / GH) * b.h, sy1 = b.y + ((gy + 1) / GH) * b.h;
      let acc = 0, cnt = 0;
      for (let y = Math.floor(sy0); y < Math.max(Math.floor(sy0) + 1, Math.ceil(sy1)); y++)
        for (let x = Math.floor(sx0); x < Math.max(Math.floor(sx0) + 1, Math.ceil(sx1)); x++) { acc += m[Math.min(h - 1, y) * w + Math.min(w - 1, x)]; cnt++; }
      g[gy * GW + gx] = acc / cnt;
    }
  // 3×3 blur for tolerance to small misalignment.
  const o = new Float32Array(g.length);
  for (let y = 0; y < GH; y++)
    for (let x = 0; x < GW; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= GW || yy >= GH) continue; s += g[yy * GW + xx]; c++; }
      o[y * GW + x] = s / c;
    }
  return { grid: o, aspect: b.w / b.h };
}

function correlation(a: Float32Array, b: Float32Array): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db + 1e-12);
}

/** Renders `text` in a face and returns its ink mask. */
function renderSample(face: FontFaceInfo, text: string): { m: Float32Array; w: number; h: number } | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const size = 64;
  const font = `${face.italic ? 'italic ' : ''}${face.weight} ${size}px "${face.family}"`;
  const meas = new OffscreenCanvas(4, 4).getContext('2d')!;
  meas.font = font;
  const tw = Math.ceil(meas.measureText(text).width) + size;
  const w = Math.min(4096, Math.max(8, tw)), h = size * 2;
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  g.font = font;
  g.fillStyle = '#000';
  g.fillText(text, size / 2, size * 1.3);
  const d = g.getImageData(0, 0, w, h).data;
  const m = new Float32Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] / 255;
  return { m, w, h };
}

/** Ranks candidate faces for an ink sample (see inkMask). */
export function matchFonts(sample: Float32Array, w: number, h: number, text: string, candidates: FontFaceInfo[], limit = 12): FontMatch[] {
  const t = text.trim();
  const ref = normalize(sample, w, h);
  if (!ref || !t) return [];
  const seen = new Set<string>();
  const out: FontMatch[] = [];
  for (const face of candidates) {
    const key = `${face.family}|${face.weight}|${face.italic}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = renderSample(face, t);
    if (!r) continue;
    const cand = normalize(r.m, r.w, r.h);
    if (!cand) continue;
    const shape = correlation(ref.grid, cand.grid);
    const aspect = Math.abs(Math.log(ref.aspect / cand.aspect));
    out.push({ face, score: shape - aspect * 0.8 });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
