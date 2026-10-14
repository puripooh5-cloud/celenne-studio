/** Gradient evaluation (color + opacity stops with midpoints) and geometric gradient rendering. */
import type { Gradient, GradientType } from './types';
import type { Rect } from '../image-engine/rect';

export const LUT_SIZE = 2048;

/**
 * Photoshop's gradient evaluation, measured against Photoshop 26.5 (tests/fixtures/photoshop):
 *  - a stop's midpoint sets where the blend from the previous stop reaches 50 %, with a linear
 *    warp on each side;
 *  - Smoothness s blends straight interpolation with a per-channel cubic (Hermite) curve whose
 *    tangent at an inner stop is the mean of the neighbouring value changes and, at the end stops,
 *    half the segment's change (uniform Catmull-Rom); the tangents are mixed as D·(1 − s) + T·s;
 *  - the Classic method interpolates the colour values, Linear interpolates linear light and
 *    Perceptual interpolates in Oklab.
 * Two-stop gradients and Classic / Linear gradients match within 1/255; Perceptual gradients of
 * three or more stops whose colour reverses direction at a stop can differ by a few levels.
 */
function warpMid(u: number, mid: number): number {
  const m = Math.max(0.005, Math.min(0.995, mid));
  return u < m ? (0.5 * u) / m : 0.5 + (0.5 * (u - m)) / (1 - m);
}

const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c: number) => { const v = Math.max(0, Math.min(1, c)); return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; };
function toOklab(r: number, g: number, b: number): number[] {
  const R = s2l(r), G = s2l(g), B = s2l(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab(L: number, a: number, b: number): number[] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [l2s(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), l2s(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), l2s(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

/** Values of sorted stops at t (one entry per channel), Photoshop's interpolation. */
function sampleStops<T extends { location: number; midpoint: number }>(stops: T[], vals: number[][], t: number, smooth: number): number[] {
  const n = stops.length;
  if (t <= stops[0].location) return vals[0];
  if (t >= stops[n - 1].location) return vals[n - 1];
  let i = 0;
  while (i < n - 2 && t >= stops[i + 1].location) i++;
  const a = stops[i], b = stops[i + 1];
  const span = b.location - a.location;
  const u = warpMid(span <= 0 ? 1 : (t - a.location) / span, b.midpoint);
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const out = new Array<number>(vals[i].length);
  for (let c = 0; c < out.length; c++) {
    const p0 = vals[i][c], p1 = vals[i + 1][c], d = p1 - p0;
    if (smooth <= 0) { out[c] = p0 + d * u; continue; }
    const t0 = i === 0 ? d / 2 : (vals[i][c] - vals[i - 1][c] + d) / 2;
    const t1 = i + 1 === n - 1 ? d / 2 : (d + vals[i + 2][c] - vals[i + 1][c]) / 2;
    const m0 = d * (1 - smooth) + t0 * smooth, m1 = d * (1 - smooth) + t1 * smooth;
    out[c] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
  }
  return out;
}

/**
 * RGBA float lookup table of `size` entries. `plates`: the stop colours are plate values (CMYK /
 * Lab documents), which are always interpolated directly (Classic).
 */
export function buildGradientLUT(g: Gradient, reverse = false, size = LUT_SIZE, plates = false): Float32Array {
  const lut = new Float32Array(size * 4);
  const cs = [...g.colorStops].sort((a, b) => a.location - b.location);
  const as = [...g.alphaStops].sort((a, b) => a.location - b.location);
  const smooth = Math.max(0, Math.min(1, g.smoothness ?? 0));
  const method = plates ? 'classic' : g.interpolation ?? 'classic';
  const enc = (c: { r: number; g: number; b: number }) => (method === 'perceptual' ? toOklab(c.r, c.g, c.b) : method === 'linear' ? [s2l(c.r), s2l(c.g), s2l(c.b)] : [c.r, c.g, c.b]);
  const cv = cs.map((s) => enc(s.color));
  const av = as.map((s) => [s.opacity]);
  for (let i = 0; i < size; i++) {
    let t = i / (size - 1);
    if (reverse) t = 1 - t;
    let c = cs.length ? sampleStops(cs, cv, t, smooth) : [0, 0, 0];
    if (method === 'perceptual') c = fromOklab(c[0], c[1], c[2]);
    else if (method === 'linear') c = [l2s(c[0]), l2s(c[1]), l2s(c[2])];
    const a = as.length ? sampleStops(as, av, t, smooth) : [1];
    lut[i * 4] = Math.max(0, Math.min(1, c[0]));
    lut[i * 4 + 1] = Math.max(0, Math.min(1, c[1]));
    lut[i * 4 + 2] = Math.max(0, Math.min(1, c[2]));
    lut[i * 4 + 3] = Math.max(0, Math.min(1, a[0]));
  }
  return lut;
}

export interface GradientGeometry {
  type: GradientType;
  /** Start and end point (document px). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Position along the gradient (0..1, unclamped for linear). */
export function gradientT(g: GradientGeometry, x: number, y: number): number {
  const dx = g.x1 - g.x0, dy = g.y1 - g.y0;
  const len2 = dx * dx + dy * dy || 1e-9;
  const px = x - g.x0, py = y - g.y0;
  switch (g.type) {
    case 'linear':
      return (px * dx + py * dy) / len2;
    case 'radial':
      return Math.sqrt((px * px + py * py) / len2);
    case 'angle': {
      // Clockwise on screen from the gradient's direction, as in Photoshop.
      const a0 = Math.atan2(dy, dx);
      let a = Math.atan2(py, px) - a0;
      a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      return a / (Math.PI * 2);
    }
    case 'reflected':
      return Math.abs((px * dx + py * dy) / len2);
    case 'diamond': {
      const len = Math.sqrt(len2);
      const ux = dx / len, uy = dy / len;
      const u = Math.abs(px * ux + py * uy), v = Math.abs(-px * uy + py * ux);
      return (u + v) / len;
    }
  }
}

function hashNoise(x: number, y: number): number {
  let h = (Math.imul(x | 0, 1597334677) ^ Math.imul(y | 0, 3812015801)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return ((h >>> 0) / 4294967296) - 0.5;
}

/**
 * Renders a gradient into straight RGBA floats for `r` given at pyramid `scale`
 * (r is in scaled coordinates; geometry is in document px).
 */
export function renderGradient(geom: GradientGeometry, lut: Float32Array, r: Rect, scale = 1, dither = false, out?: Float32Array): Float32Array {
  const n = r.w * r.h;
  const dst = out ?? new Float32Array(n * 4);
  const inv = 1 / scale;
  const last = lut.length / 4 - 1;
  // Photoshop samples a gradient at the pixel's corner (x, y), not its centre.
  for (let y = 0; y < r.h; y++) {
    const dy = (r.y + y) * inv;
    for (let x = 0; x < r.w; x++) {
      const dx = (r.x + x) * inv;
      let t = gradientT(geom, dx, dy);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const i = Math.round(t * last) * 4;
      const o = (y * r.w + x) * 4;
      if (dither) {
        const nz = hashNoise(r.x + x, r.y + y) / 255;
        dst[o] = lut[i] + nz;
        dst[o + 1] = lut[i + 1] + nz;
        dst[o + 2] = lut[i + 2] + nz;
      } else {
        dst[o] = lut[i];
        dst[o + 1] = lut[i + 1];
        dst[o + 2] = lut[i + 2];
      }
      dst[o + 3] = lut[i + 3];
    }
  }
  return dst;
}

/** Converts an angle/scale "gradient fill" spec to endpoints spanning a box (PS-style fill layers & overlays). */
export function geometryFromAngle(type: GradientType, angleDeg: number, scalePct: number, box: Rect, offsetX = 0, offsetY = 0): GradientGeometry {
  const cx = box.x + box.w / 2 + (offsetX / 100) * box.w;
  const cy = box.y + box.h / 2 + (offsetY / 100) * box.h;
  const a = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(a), uy = -Math.sin(a);
  // Half-length (Photoshop, measured): half the line through the box centre along the angle,
  // clipped to the box — for every gradient style.
  const half = Math.min(Math.abs(ux) > 1e-9 ? box.w / 2 / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? box.h / 2 / Math.abs(uy) : Infinity);
  const L = half * (scalePct / 100);
  if (type === 'linear') return { type, x0: cx - ux * L, y0: cy - uy * L, x1: cx + ux * L, y1: cy + uy * L };
  return { type, x0: cx, y0: cy, x1: cx + ux * L, y1: cy + uy * L };
}
