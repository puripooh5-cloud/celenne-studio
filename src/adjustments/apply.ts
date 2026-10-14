/**
 * Adjustment evaluation. `prepareAdjustment` compiles parameters into LUTs / closures once
 * (cached by parameter object identity — commands replace the object on edit, which
 * invalidates the cache automatically). `applyAdjustmentToPremultiplied` produces straight
 * adjusted colors for a premultiplied backdrop span; the compositor then blends the result
 * with the adjustment layer's blend mode, opacity and mask.
 */
import type { Adjustment, CurvePoint, HueSatRange, LevelsChannel, Lut3D } from './types';
import { hslToRgb, linearToSrgb, rgbToHsl, srgbToLinear } from '../color/convert';
import { BRIGHTNESS_CURVES, BRIGHTNESS_MIN, BRIGHTNESS_STEP, CONTRAST_CURVES, CONTRAST_MIN } from './brightnessContrastTables';
import { buildGradientLUT } from '../color/gradient';
import { inflateSync } from 'fflate';
import { VIBRANCE_LEVELS, VIBRANCE_TABLES } from './vibranceTables';

export const LUT_N = 1024;
const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

/** Per-pixel processor over straight RGB (in/out arrays of length 3 reused). */
type PixelFn = (c: Float32Array) => void;

export interface PreparedAdjustment {
  /** true when output only depends on each channel independently (LUT-able). */
  pixel: PixelFn;
}

function lookup(lut: Float32Array, v: number): number {
  const x = clamp(v) * (LUT_N - 1);
  const i = x | 0;
  const f = x - i;
  return i >= LUT_N - 1 ? lut[LUT_N - 1] : lut[i] + (lut[i + 1] - lut[i]) * f;
}

export function lutFrom(fn: (x: number) => number): Float32Array {
  const l = new Float32Array(LUT_N);
  for (let i = 0; i < LUT_N; i++) l[i] = clamp(fn(i / (LUT_N - 1)));
  return l;
}

// ---------------------------------------------------------------------------------------------
// Curves: natural cubic spline through control points (Photoshop-style).
// ---------------------------------------------------------------------------------------------
export function curveLUT(points: CurvePoint[]): Float32Array {
  const pts = [...points].sort((a, b) => a.x - b.x).map((p) => ({ x: p.x / 255, y: p.y / 255 }));
  if (pts.length === 0) return lutFrom((x) => x);
  if (pts.length === 1) return lutFrom(() => pts[0].y);
  const n = pts.length;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  // Second derivatives (natural spline).
  const y2 = new Array(n).fill(0), u = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const sig = (xs[i] - xs[i - 1]) / (xs[i + 1] - xs[i - 1]);
    const p = sig * y2[i - 1] + 2;
    y2[i] = (sig - 1) / p;
    const d = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]);
    u[i] = ((6 * d) / (xs[i + 1] - xs[i - 1]) - sig * u[i - 1]) / p;
  }
  for (let k = n - 2; k >= 0; k--) y2[k] = y2[k] * y2[k + 1] + u[k];
  return lutFrom((x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (xs[m] > x) hi = m;
      else lo = m;
    }
    const h = xs[hi] - xs[lo];
    if (h <= 0) return ys[lo];
    const a = (xs[hi] - x) / h, b = (x - xs[lo]) / h;
    return a * ys[lo] + b * ys[hi] + ((a * a * a - a) * y2[lo] + (b * b * b - b) * y2[hi]) * (h * h) / 6;
  });
}

export function levelsLUT(c: LevelsChannel): Float32Array {
  const ib = c.inBlack / 255, iw = c.inWhite / 255, ob = c.outBlack / 255, ow = c.outWhite / 255;
  const g = Math.max(0.01, c.gamma);
  return lutFrom((x) => {
    const t = clamp((x - ib) / Math.max(1e-6, iw - ib));
    return ob + (ow - ob) * Math.pow(t, 1 / g);
  });
}

function hueWeight(h: number, r: [number, number, number, number]): number {
  // Handles wrap-around ranges (e.g. reds 315..45).
  const norm = (v: number) => ((v % 360) + 360) % 360;
  const [a, b, c, d] = r.map(norm);
  const inArc = (x: number, from: number, to: number) => (from <= to ? x >= from && x <= to : x >= from || x <= to);
  const dist = (from: number, to: number) => norm(to - from);
  const x = norm(h);
  if (inArc(x, b, c)) return 1;
  if (inArc(x, a, b)) return dist(a, x) / Math.max(1e-6, dist(a, b));
  if (inArc(x, c, d)) return 1 - dist(c, x) / Math.max(1e-6, dist(c, d));
  return 0;
}

/**
 * Hue / Saturation (Photoshop, measured on the full RGB cube): hue rotates in HSL; a negative
 * saturation scales HSL saturation; a positive one pushes each channel away from the HSL
 * lightness L by 1/α − 1, with α = S when S + s ≥ 1, else 1 − s (S = the pixel's HSL saturation).
 */
/** Saturation increase strength for a +sat (percent) edit: s / (1 − s). */
const satBoost = (sat: number) => (sat >= 100 ? 1e6 : (sat / 100) / (1 - sat / 100));

/**
 * Hue / Saturation / Lightness on one pixel. A decrease scales HSL saturation; an increase pushes
 * the channels away from the HSL lightness by `boost` (satBoost), at most to full saturation.
 * Colour ranges pass the boost summed over ranges by weight (Photoshop scales the boost, not the
 * slider value).
 */
function applyHueSat(c: Float32Array, hue: number, sat: number, light: number, boost = sat > 0 ? satBoost(sat) : 0, range = false) {
  const hsl = rgbToHsl({ r: c[0], g: c[1], b: c[2] });
  hsl.h += hue;
  const s = sat / 100;
  if (s < 0) hsl.s = clamp(hsl.s * (1 + s));
  const rgb = hslToRgb(hsl);
  let r = rgb.r, g = rgb.g, b = rgb.b;
  // Lightness before the saturation increase (Photoshop, measured with both edited). Master
  // Lightness moves toward white / black; Lightness in a colour range toward the brightest /
  // darkest channel.
  const l = light / 100;
  if (range) {
    if (l > 0) { const mx = Math.max(r, g, b); r += (mx - r) * l; g += (mx - g) * l; b += (mx - b) * l; }
    else if (l < 0) { const mn = Math.min(r, g, b); r += (r - mn) * l; g += (g - mn) * l; b += (b - mn) * l; }
  } else if (l > 0) { r += (1 - r) * l; g += (1 - g) * l; b += (1 - b) * l; }
  else if (l < 0) { r *= 1 + l; g *= 1 + l; b *= 1 + l; }
  if (boost > 0) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), L = (mx + mn) / 2;
    const S = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * L - 1));
    const alpha = Math.min(1 / Math.max(1e-6, S) - 1, boost);
    r = clamp(r + (r - L) * alpha); g = clamp(g + (g - L) * alpha); b = clamp(b + (b - L) * alpha);
  }
  c[0] = r; c[1] = g; c[2] = b;
}

function sampleLut3D(lut: Lut3D, c: Float32Array) {
  const n = lut.size, d = lut.data;
  const fx = clamp(c[0]) * (n - 1), fy = clamp(c[1]) * (n - 1), fz = clamp(c[2]) * (n - 1);
  const x0 = Math.min(n - 2, fx | 0), y0 = Math.min(n - 2, fy | 0), z0 = Math.min(n - 2, fz | 0);
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const idx = (x: number, y: number, z: number) => ((z * n + y) * n + x) * 3;
  for (let ch = 0; ch < 3; ch++) {
    const c000 = d[idx(x0, y0, z0) + ch], c100 = d[idx(x0 + 1, y0, z0) + ch];
    const c010 = d[idx(x0, y0 + 1, z0) + ch], c110 = d[idx(x0 + 1, y0 + 1, z0) + ch];
    const c001 = d[idx(x0, y0, z0 + 1) + ch], c101 = d[idx(x0 + 1, y0, z0 + 1) + ch];
    const c011 = d[idx(x0, y0 + 1, z0 + 1) + ch], c111 = d[idx(x0 + 1, y0 + 1, z0 + 1) + ch];
    const c00 = c000 + (c100 - c000) * tx, c10 = c010 + (c110 - c010) * tx;
    const c01 = c001 + (c101 - c001) * tx, c11 = c011 + (c111 - c011) * tx;
    const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
    c[ch] = c0 + (c1 - c0) * tz;
  }
}

function setLuminance(c: Float32Array, target: number) {
  const d = target - lum(c[0], c[1], c[2]);
  let r = c[0] + d, g = c[1] + d, b = c[2] + d;
  const l = lum(r, g, b), n = Math.min(r, g, b), x = Math.max(r, g, b);
  if (n < 0) { const k = l / (l - n || 1e-9); r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k; }
  if (x > 1) { const k = (1 - l) / (x - l || 1e-9); r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k; }
  c[0] = r; c[1] = g; c[2] = b;
}

/** sRGB (IEC 61966-2.1) linear → XYZ D50, Bradford-adapted as in ICC profiles, and back. */
const SRGB_TO_D50 = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
const D50_TO_SRGB = invert3(SRGB_TO_D50);

function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}
function mul3(a: number[], b: number[]): number[] {
  const o: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  return o;
}

/**
 * Photo Filter (Photoshop, measured on the RGB cube with four colours at three densities; within
 * 1/255): the filter colour is mixed with white in linear light by the density, and each pixel is
 * multiplied by it in XYZ (D50, the ICC connection space) relative to white, like a white-balance
 * shift. As one matrix on linear sRGB: D50→sRGB · diag(filter XYZ / white XYZ) · sRGB→D50.
 * Preserve Luminosity then restores the pixel's luminosity as the Luminosity blend mode does
 * (within 9/255 on saturated colours at the gamut edge, 0.4 on average).
 */
export function photoFilterMatrix(adj: Extract<Adjustment, { type: 'photoFilter' }>): number[] {
  const d = clamp(adj.density / 100);
  const f = [adj.color.r, adj.color.g, adj.color.b].map((v) => 1 - d + d * srgbToLinear(clamp(v)));
  const xyz = (v: number[]) => [0, 1, 2].map((r) => SRGB_TO_D50[r * 3] * v[0] + SRGB_TO_D50[r * 3 + 1] * v[1] + SRGB_TO_D50[r * 3 + 2] * v[2]);
  const fx = xyz(f), wx = xyz([1, 1, 1]);
  const k = [fx[0] / wx[0], 0, 0, 0, fx[1] / wx[1], 0, 0, 0, fx[2] / wx[2]];
  return mul3(D50_TO_SRGB, mul3(k, SRGB_TO_D50));
}

/**
 * Vibrance (Photoshop, measured). The Vibrance slider has no simple formula: it keeps highly
 * saturated colours, moves weak ones most, protects reds and oranges (skin) when increasing, and
 * pivots on different channels depending on saturation. Celenne uses Photoshop's own output,
 * measured on the 32-step RGB cube at ten levels (vibranceTables.ts), interpolated between levels
 * and between cube colours (on random colours: 0.4/255 on average, under 6 at the extremes).
 * The Saturation slider is then exact: in linear light, colours are scaled away from or toward
 * their luminance with ProPhoto RGB's weights (0.288, 0.7119, 0.0001), as Photoshop does even in
 * sRGB documents; so −100 turns pure blue black.
 */
let vibranceRaw: Uint8Array | null = null;
const vibranceLuts = new Map<number, Lut3D>();
export function vibranceLut(vibrance: number): Lut3D | null {
  const v = Math.max(-100, Math.min(100, Math.round(vibrance)));
  if (v === 0) return null;
  const hit = vibranceLuts.get(v);
  if (hit) return hit;
  vibranceRaw ??= inflateSync(Uint8Array.from(atob(VIBRANCE_TABLES), (ch) => ch.charCodeAt(0)));
  const N = 32 * 32 * 32, L = VIBRANCE_LEVELS;
  // Bracketing levels (0 is the identity).
  const keys = [...L, 0].sort((a, b) => a - b);
  let j = 0;
  while (keys[j + 1] < v) j++;
  const k0 = keys[j], k1 = keys[j + 1], w = (v - k0) / (k1 - k0);
  const level = (k: number, ch: number, i: number, input: number) => (k === 0 ? input : (input + vibranceRaw![(L.indexOf(k) * 3 + ch) * N + i]) & 255);
  const data = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const inp = [i & 31, (i >> 5) & 31, i >> 10].map((k) => Math.round((k * 255) / 31));
    // Levels are mixed in linear light.
    for (let ch = 0; ch < 3; ch++) data[i * 3 + ch] = linearToSrgb(srgbToLinear(level(k0, ch, i, inp[ch]) / 255) * (1 - w) + srgbToLinear(level(k1, ch, i, inp[ch]) / 255) * w);
  }
  const lut = { size: 32, data };
  vibranceLuts.set(v, lut);
  return lut;
}

const PROPHOTO_Y = [0.288, 0.7119, 0.0001];
function vibranceSaturation(c: Float32Array, s: number) {
  const r = srgbToLinear(clamp(c[0])), g = srgbToLinear(clamp(c[1])), b = srgbToLinear(clamp(c[2]));
  const Y = PROPHOTO_Y[0] * r + PROPHOTO_Y[1] * g + PROPHOTO_Y[2] * b;
  c[0] = linearToSrgb(clamp(Y + (r - Y) * (1 + s)));
  c[1] = linearToSrgb(clamp(Y + (g - Y) * (1 + s)));
  c[2] = linearToSrgb(clamp(Y + (b - Y) * (1 + s)));
}

/** The single per-channel LUT of Brightness/Contrast and Exposure (shared with the GPU path). */
/**
 * Colour Balance per channel (Photoshop, measured on ramps and their combinations): a Levels
 * curve with input black = −shadows (when negative), input white = 255 − highlights (when
 * positive) and gamma 2^((midtones + shadows/2 + highlights/2) / 100). The gamma curve is
 * evaluated as 12 linear segments (an empirical fit: Photoshop limits the slope near black;
 * within 4/255 at ±100).
 * Preserve Luminosity (measured on the RGB cube): Photoshop shifts each range's three values
 * before building the curves, so the same colour change is made with the least change in
 * brightness: shadows so that none is positive (−max), highlights so that none is negative
 * (−min), midtones by the midpoint of their highest and lowest (−(max + min) / 2).
 */
export function colorBalanceLUTs(adj: Extract<Adjustment, { type: 'colorBalance' }>): Float32Array[] {
  const SEG = 12;
  const shift = (v: number[], by: number) => (adj.preserveLuminosity ? v.map((x) => x - by) : v);
  const sh = shift(adj.shadows, Math.max(...adj.shadows));
  const mid = shift(adj.midtones, (Math.max(...adj.midtones) + Math.min(...adj.midtones)) / 2);
  const hi = shift(adj.highlights, Math.min(...adj.highlights));
  return [0, 1, 2].map((ch) => {
    const s = sh[ch], m = mid[ch], h = hi[ch];
    const b = Math.max(0, -s) / 255, w = 1 - Math.max(0, h) / 255;
    const ig = 1 / Math.pow(2, (m + (adj.preserveLuminosity ? 0 : s / 2 + h / 2)) / 100);
    const knot = (i: number) => Math.pow(i / SEG, ig);
    // Black point above the white point (opposite extreme shifts): a step at the white point.
    if (w <= b) return lutFrom((x) => (x >= w ? 1 : 0));
    return lutFrom((x) => {
      const t = clamp((x - b) / Math.max(1e-6, w - b)) * SEG;
      const i = Math.min(SEG - 1, Math.floor(t));
      return knot(i) + (knot(i + 1) - knot(i)) * (t - i);
    });
  });
}

/** Exposure on linear (32-bit) values: no encoding and no clamp above 1, as in Photoshop's HDR mode. */
export function exposureLinearPixel(adj: Extract<Adjustment, { type: 'exposure' }>): (c: Float32Array) => void {
  const mul = Math.pow(2, adj.exposure), off = adj.offset, ig = 1 / Math.max(0.01, adj.gamma);
  return (c) => { for (let i = 0; i < 3; i++) c[i] = Math.pow(Math.max(0, c[i] * mul + off), ig); };
}

export function toneLUT(adj: Extract<Adjustment, { type: 'brightnessContrast' | 'exposure' }>): Float32Array {
  if (adj.type === 'exposure') {
    // 8/16-bit (Photoshop, measured): values decoded with a plain 2.2 gamma, then exposure, offset
    // and gamma correction in that order. 32-bit documents use exposurePixel (linear, unclamped).
    const mul = Math.pow(2, adj.exposure), off = adj.offset, ig = 1 / Math.max(0.01, adj.gamma);
    return lutFrom((x) => Math.pow(Math.pow(Math.max(0, Math.pow(x, 2.2) * mul + off), ig), 1 / 2.2));
  }
  const ct = adj.contrast / 100;
  if (adj.useLegacy) return lutFrom((x) => (x + adj.brightness / 255 - 0.5) * (ct >= 0 ? 1 / Math.max(0.01, 1 - ct) : 1 + ct) + 0.5);
  // Modern: Photoshop's measured curves (brightness, then contrast), interpolated between steps.
  const bCurve = measuredCurve(BRIGHTNESS_CURVES, BRIGHTNESS_MIN, adj.brightness);
  const cCurve = measuredCurve(CONTRAST_CURVES, CONTRAST_MIN, adj.contrast);
  return lutFrom((x) => cCurve(bCurve(x)));
}

const decodedCurves = new Map<string, Uint8Array>();
/** A measured 256-entry curve family at `value` (interpolated between rows), as a 0..1 function. */
function measuredCurve(rows: string[], min: number, value: number): (x: number) => number {
  const row = (i: number) => {
    const k = rows[Math.max(0, Math.min(rows.length - 1, i))];
    let d = decodedCurves.get(k);
    if (!d) { d = Uint8Array.from(atob(k), (c) => c.charCodeAt(0)); decodedCurves.set(k, d); }
    return d;
  };
  const f = (value - min) / BRIGHTNESS_STEP;
  const i = Math.max(0, Math.min(rows.length - 2, Math.floor(f))), w = Math.max(0, Math.min(1, f - i));
  const a = row(i), b = row(i + 1);
  return (x) => {
    const p = Math.max(0, Math.min(255, x * 255)), j = Math.min(254, Math.floor(p)), u = p - j;
    const va = a[j] + (a[j + 1] - a[j]) * u, vb = b[j] + (b[j + 1] - b[j]) * u;
    return (va + (vb - va) * w) / 255;
  };
}

// ---------------------------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------------------------
const cache = new WeakMap<object, PreparedAdjustment>();

export function prepareAdjustment(adj: Adjustment): PreparedAdjustment {
  const hit = cache.get(adj);
  if (hit) return hit;
  const p = { pixel: build(adj) };
  cache.set(adj, p);
  return p;
}

function build(adj: Adjustment): PixelFn {
  switch (adj.type) {
    case 'curves': {
      const m = curveLUT(adj.rgb), r = curveLUT(adj.red), g = curveLUT(adj.green), b = curveLUT(adj.blue);
      return (c) => { c[0] = lookup(m, lookup(r, c[0])); c[1] = lookup(m, lookup(g, c[1])); c[2] = lookup(m, lookup(b, c[2])); };
    }
    case 'levels': {
      const m = levelsLUT(adj.rgb), r = levelsLUT(adj.red), g = levelsLUT(adj.green), b = levelsLUT(adj.blue);
      return (c) => { c[0] = lookup(m, lookup(r, c[0])); c[1] = lookup(m, lookup(g, c[1])); c[2] = lookup(m, lookup(b, c[2])); };
    }
    case 'brightnessContrast':
    case 'exposure': {
      const lut = toneLUT(adj);
      return (c) => { c[0] = lookup(lut, c[0]); c[1] = lookup(lut, c[1]); c[2] = lookup(lut, c[2]); };
    }
    case 'vibrance': {
      const lut = vibranceLut(adj.vibrance), s = adj.saturation / 100;
      return (c) => {
        if (lut) sampleLut3D(lut, c);
        if (s) vibranceSaturation(c, s);
      };
    }
    case 'hueSaturation': {
      if (adj.colorize) {
        // Colorize (Photoshop, measured): HSL with the pixel's HSL lightness, then the given hue and
        // saturation (0..100 %); Lightness shifts L first.
        const h = adj.master.hue < 0 ? adj.master.hue + 360 : adj.master.hue;
        const sat = clamp(adj.master.saturation / 100);
        const light = adj.master.lightness / 100;
        return (c) => {
          let L = (Math.max(c[0], c[1], c[2]) + Math.min(c[0], c[1], c[2])) / 2;
          if (light > 0) L += (1 - L) * light;
          else L *= 1 + light;
          const rgb = hslToRgb({ h, s: sat, l: L });
          c[0] = rgb.r; c[1] = rgb.g; c[2] = rgb.b;
        };
      }
      const ranges: HueSatRange[] = adj.ranges.filter((r) => r.hue || r.saturation || r.lightness);
      const m = adj.master;
      return (c) => {
        // Colour ranges (Photoshop, measured): grays have no hue and are left alone; Lightness in a
        // range moves the channels toward the brightest one (up) or the darkest one (down).
        if (ranges.length && Math.max(c[0], c[1], c[2]) > Math.min(c[0], c[1], c[2])) {
          const h = rgbToHsl({ r: c[0], g: c[1], b: c[2] }).h;
          let dh = 0, ds = 0, dl = 0, boost = 0;
          for (const r of ranges) {
            const w = hueWeight(h, r.range);
            if (w <= 0) continue;
            dh += r.hue * w; dl += r.lightness * w;
            if (r.saturation < 0) ds += r.saturation * w; else boost += w * satBoost(r.saturation);
          }
          if (dh || ds || dl || boost) applyHueSat(c, dh, ds, dl, boost, true);
        }
        if (m.hue || m.saturation || m.lightness) applyHueSat(c, m.hue, m.saturation, m.lightness);
      };
    }
    case 'colorBalance': {
      const luts = colorBalanceLUTs(adj);
      return (c) => {
        for (let ch = 0; ch < 3; ch++) c[ch] = lookup(luts[ch], c[ch]);
      };
    }
    case 'blackWhite': {
      const w = { reds: adj.reds / 100, yellows: adj.yellows / 100, greens: adj.greens / 100, cyans: adj.cyans / 100, blues: adj.blues / 100, magentas: adj.magentas / 100 };
      const tint = adj.tintColor;
      return (c) => {
        const r = c[0], g = c[1], b = c[2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const mid = r + g + b - mx - mn;
        let primary: number, secondary: number;
        if (mx === r) { primary = w.reds; secondary = mn === b ? w.yellows : w.magentas; }
        else if (mx === g) { primary = w.greens; secondary = mn === b ? w.yellows : w.cyans; }
        else { primary = w.blues; secondary = mn === r ? w.magentas : w.cyans; }
        const gray = clamp(mn + (mid - mn) * secondary + (mx - mid) * primary);
        if (adj.tint) {
          c[0] = tint.r; c[1] = tint.g; c[2] = tint.b;
          setLuminance(c, gray);
        } else {
          c[0] = c[1] = c[2] = gray;
        }
      };
    }
    case 'photoFilter': {
      const T = photoFilterMatrix(adj);
      return (c) => {
        const L0 = lum(c[0], c[1], c[2]);
        const r = srgbToLinear(clamp(c[0])), g = srgbToLinear(clamp(c[1])), b = srgbToLinear(clamp(c[2]));
        c[0] = linearToSrgb(clamp(T[0] * r + T[1] * g + T[2] * b));
        c[1] = linearToSrgb(clamp(T[3] * r + T[4] * g + T[5] * b));
        c[2] = linearToSrgb(clamp(T[6] * r + T[7] * g + T[8] * b));
        if (adj.preserveLuminosity) setLuminance(c, L0);
      };
    }
    case 'channelMixer': {
      const R = adj.red.map((v) => v / 100), G = adj.green.map((v) => v / 100), B = adj.blue.map((v) => v / 100), K = adj.gray.map((v) => v / 100);
      return (c) => {
        const r = c[0], g = c[1], b = c[2];
        if (adj.monochrome) {
          const v = clamp(r * K[0] + g * K[1] + b * K[2] + K[3]);
          c[0] = c[1] = c[2] = v;
        } else {
          c[0] = clamp(r * R[0] + g * R[1] + b * R[2] + R[3]);
          c[1] = clamp(r * G[0] + g * G[1] + b * G[2] + G[3]);
          c[2] = clamp(r * B[0] + g * B[1] + b * B[2] + B[3]);
        }
      };
    }
    case 'colorLookup': {
      const lut = adj.lut;
      if (!lut) return () => {};
      return (c) => sampleLut3D(lut, c);
    }
    case 'invert':
      return (c) => { c[0] = 1 - c[0]; c[1] = 1 - c[1]; c[2] = 1 - c[2]; };
    case 'posterize': {
      // Photoshop (measured): level = floor(x·n / 256) on 0..255 values, output floor(level·255 / (n − 1)).
      const n = Math.max(2, Math.min(255, Math.round(adj.levels)));
      return (c) => {
        for (let i = 0; i < 3; i++) {
          const level = Math.min(n - 1, Math.floor((Math.max(0, c[i]) * 255 + 1e-4) * n / 256));
          c[i] = Math.floor((level * 255) / (n - 1) + 1e-6) / 255;
        }
      };
    }
    case 'threshold': {
      const t = adj.level / 255;
      return (c) => { const v = lum(c[0], c[1], c[2]) >= t ? 1 : 0; c[0] = c[1] = c[2] = v; };
    }
    case 'gradientMap': {
      const lut = buildGradientLUT(adj.gradient, adj.reverse, 1024);
      return (c) => {
        const i = Math.round(clamp(lum(c[0], c[1], c[2])) * 1023) * 4;
        c[0] = lut[i]; c[1] = lut[i + 1]; c[2] = lut[i + 2];
      };
    }
    case 'selectiveColor': {
      const rel = adj.mode === 'relative';
      const cols = adj.colors;
      return (c) => {
        const r = c[0], g = c[1], b = c[2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), mid = r + g + b - mx - mn;
        const weights: [keyof typeof cols, number][] = [];
        if (mx === r && mx > mid) weights.push(['reds', mx - mid]);
        if (mx === g && mx > mid) weights.push(['greens', mx - mid]);
        if (mx === b && mx > mid) weights.push(['blues', mx - mid]);
        if (mn === b && mid > mn) weights.push(['yellows', mid - mn]);
        if (mn === r && mid > mn) weights.push(['cyans', mid - mn]);
        if (mn === g && mid > mn) weights.push(['magentas', mid - mn]);
        if (mn > 0.5) weights.push(['whites', (mn - 0.5) * 2]);
        if (mx < 0.5) weights.push(['blacks', (0.5 - mx) * 2]);
        weights.push(['neutrals', clamp(1 - (Math.abs(mx - 0.5) + Math.abs(mn - 0.5)))]);
        // Photoshop (measured on the RGB cube, every range and ink): each range's change is made in
        // full and clipped to 0..1 first, then blended in by the range's weight. Black adds to each
        // ink as ((−1 − ink) · black − ink); Relative scales the change by the existing ink.
        const v = [r, g, b];
        const out = [r, g, b];
        for (const [key, w] of weights) {
          if (w <= 0) continue;
          const a = cols[key];
          const adjs = [a.c / 100, a.m / 100, a.y / 100];
          const k = a.k / 100;
          for (let i = 0; i < 3; i++) {
            const d = ((-1 - adjs[i]) * k - adjs[i]) * (rel ? 1 - v[i] : 1);
            out[i] += w * (clamp(v[i] + d) - v[i]);
          }
        }
        c[0] = clamp(out[0]); c[1] = clamp(out[1]); c[2] = clamp(out[2]);
      };
    }
  }
}

/**
 * Evaluates an adjustment for `n` premultiplied backdrop pixels; writes straight RGB into `out`
 * (4 floats per pixel, alpha copied).
 */
export function applyAdjustmentToPremultiplied(adj: Adjustment, src: Float32Array, out: Float32Array, n: number): void {
  const fn = prepareAdjustment(adj).pixel;
  const c = new Float32Array(3);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = src[o + 3];
    out[o + 3] = a;
    if (a <= 0) continue;
    const inv = 1 / a;
    c[0] = src[o] * inv; c[1] = src[o + 1] * inv; c[2] = src[o + 2] * inv;
    fn(c);
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
  }
}

/** Destructive variant for straight RGBA buffers (Image > Adjustments on pixels). */
export function applyAdjustmentToStraight(adj: Adjustment, buf: Float32Array, n: number, coverage?: Float32Array): void {
  const fn = prepareAdjustment(adj).pixel;
  const c = new Float32Array(3);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const k = coverage ? coverage[i] : 1;
    if (buf[o + 3] <= 0 || k <= 0) continue;
    c[0] = buf[o]; c[1] = buf[o + 1]; c[2] = buf[o + 2];
    fn(c);
    buf[o] += (c[0] - buf[o]) * k;
    buf[o + 1] += (c[1] - buf[o + 1]) * k;
    buf[o + 2] += (c[2] - buf[o + 2]) * k;
  }
}

/** Parses an Adobe/Resolve .cube 3D LUT. */
export function parseCubeLUT(text: string): Lut3D {
  let size = 0;
  const values: number[] = [];
  let domainMin = [0, 0, 0], domainMax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === 'LUT_3D_SIZE') size = parseInt(parts[1], 10);
    else if (key === 'DOMAIN_MIN') domainMin = parts.slice(1, 4).map(Number);
    else if (key === 'DOMAIN_MAX') domainMax = parts.slice(1, 4).map(Number);
    else if (/^[-+0-9.eE]+$/.test(parts[0]) && parts.length >= 3) values.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!size || size < 2 || size > 256) throw new Error('Unsupported .cube file: missing or invalid LUT_3D_SIZE');
  if (values.length !== size * size * size * 3) throw new Error(`Invalid .cube file: expected ${size ** 3} entries, found ${values.length / 3}`);
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const ch = i % 3;
    data[i] = (values[i] - domainMin[ch]) / (domainMax[ch] - domainMin[ch] || 1);
  }
  return { size, data };
}
