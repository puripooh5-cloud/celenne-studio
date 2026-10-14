/**
 * Printing inks: Photoshop colour records, Duotone specifications and the overprint model used
 * to show Duotone documents, spot channels and Multichannel documents.
 *
 *  - Colour records (10 bytes): u16 colour space + 4 × u16 (RGB / HSB / CMYK / Lab / Gray as in
 *    the Photoshop file-format specification; custom spaces such as PANTONE are a black box).
 *  - Duotone specification = Photoshop's Duotone Options (.ado) layout, which is also what a
 *    Duotone PSD stores as its colour-mode data: version, plate count, 4 ink colours, 4 Pascal
 *    names (64 bytes each), 4 transfer curves (13 × i16 0..1000 / −1, + override), dot gain,
 *    11 overprint colours.
 *  - Resource 1066 (Alternate Duotone Colors): readable ink colours (usually Lab) for custom inks
 *    and Photoshop's own rendering of the duotone as 256 Lab entries indexed by gray level.
 *
 * Display model (Photoshop's, measured against its stored renderings of 74 files: 1–4 inks,
 * random colours and curves, computed and custom overprints; mean 0.39 ΔE, at most 1.3 ΔE, which
 * is about the precision of the stored 8-bit Lab rendering):
 *  - transfer curves are natural cubic splines through the defined points;
 *  - a fixed dot gain, coverage' = 1 − (1 − c)^1.735 (50 % → 70 %, Photoshop's default spot
 *    "Dot Gain 20%"); the dot-gain field of the specification is ignored, as in Photoshop;
 *  - colours are XYZ relative to paper, negative components clamped to 0;
 *  - the printed colour interpolates paper, the solid inks and the overprint colours with Demichel
 *    weights (a Neugebauer model) in XYZ. A computed overprint is the inks' filters multiplied, so
 *    without custom overprints this is the inks overprinted as filters.
 * Files saved by Photoshop are shown with its own rendering until their inks are edited.
 */
import type { RGB } from './types';
import { colorFromCmyk, colorFromLab, exactLab, labToSrgb, srgbToLab, type LabValue } from './plates';
import { CELENNE_CMYK_NAME } from './cmykProfile';

// ---------------------------------------------------------------------------------------------
// Colour records
// ---------------------------------------------------------------------------------------------
export type ColorRecord = [number, number, number, number, number];

const s16 = (v: number) => (v >= 32768 ? v - 65536 : v);

/** A Photoshop colour record as a UI colour (null for custom / undefined spaces). */
export function colorFromRecord(rec: ColorRecord): RGB | null {
  const [space, a, b, c, d] = rec;
  switch (space) {
    case 0: return { r: a / 65535, g: b / 65535, b: c / 65535 };
    case 1: return hsb(a / 65535, b / 65535, c / 65535);
    case 2: return colorFromCmyk([1 - a / 65535, 1 - b / 65535, 1 - c / 65535, 1 - d / 65535], { name: CELENNE_CMYK_NAME, builtin: 'celenneCMYK' });
    case 7: return colorFromLab([a / 100, s16(b) / 100, s16(c) / 100]);
    case 8: { const g = 1 - a / 10000; return { r: g, g, b: g }; }
    default: return null;
  }
}

function hsb(h: number, s: number, v: number): RGB {
  const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  return { r, g, b };
}

/** A UI colour as a Photoshop colour record (Lab, which every reader understands). */
export function recordFromColor(c: RGB): ColorRecord {
  const [L, a, b] = labOf(c);
  const s = (v: number) => { const x = Math.round(Math.max(-12800, Math.min(12700, v * 100))); return x < 0 ? x + 65536 : x; };
  return [7, Math.round(Math.max(0, Math.min(10000, L * 100))), s(a), s(b), 0];
}

const labOf = (c: RGB): LabValue => exactLab(c) ?? srgbToLab(c);

// ---------------------------------------------------------------------------------------------
// Duotone specification
// ---------------------------------------------------------------------------------------------
/** Input positions of the 13 transfer-curve values (% of tone, 0 = paper, 100 = solid). */
export const DUOTONE_CURVE_X = [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
export const NULL_CURVE = [0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1000];

export interface DuotoneInk {
  name: string;
  /** Display colour (sRGB, with exact Lab when known). */
  color: RGB;
  /** 13 values 0..1000 (‰ ink) at DUOTONE_CURVE_X, −1 = no point (first and last always set). */
  curve: number[];
  /** The ink's original colour record (custom inks such as PANTONE), kept while `color` is unchanged. */
  record?: ColorRecord;
  recordColor?: RGB;
}

export interface DuotoneSpec {
  inks: DuotoneInk[];
  /**
   * Overprint colours: 1 (duotone), 4 (tritone) or 11 (quadtone), in Photoshop's order
   * (`overprintSets`); null or missing = computed from the inks.
   */
  overprints: (RGB | null)[];
  /** Photoshop's rendering (resource 1066: 256 × L a b bytes by gray level), valid while unedited. */
  rendering?: number[];
  /** The original colour-mode data, written back unchanged while the spec is unedited. */
  raw?: number[];
}

export const OVERPRINT_COUNT = [0, 0, 1, 4, 11];
/**
 * Ink combinations of the overprint colours, in Photoshop's order: the tritone order, then the
 * combinations with ink 4 (measured by giving every quadtone slot its own colour).
 */
export function overprintSets(n: number): number[][] {
  if (n === 2) return [[0, 1]];
  if (n === 3) return [[0, 1], [0, 2], [1, 2], [0, 1, 2]];
  if (n === 4) return [[0, 1], [0, 2], [1, 2], [0, 1, 2], [0, 3], [1, 3], [2, 3], [0, 1, 3], [0, 2, 3], [1, 2, 3], [0, 1, 2, 3]];
  return [];
}

/** "1+2", "1+2+3", … for an ink combination. */
export const overprintLabel = (set: number[]) => set.map((i) => i + 1).join('+');

/**
 * Overprints carried over to another ink count: combinations that still exist keep their custom
 * colour (the tritone slots are a prefix of the quadtone ones).
 */
export function remapOverprints(overprints: (RGB | null)[], from: number, to: number): (RGB | null)[] {
  const old = overprintSets(from).map((s) => s.join());
  return overprintSets(to).map((s) => { const k = old.indexOf(s.join()); return k >= 0 ? overprints[k] ?? null : null; });
}

/** The overprint colours with the computed ones filled in (what Overprint Colors shows). */
export function effectiveOverprints(spec: DuotoneSpec): RGB[] {
  const filters = spec.inks.map((i) => inkFilter(i.color));
  return overprintSets(spec.inks.length).map((set, k) => {
    const c = spec.overprints[k];
    if (c) return c;
    const X = [1, 1, 1];
    for (const i of set) for (let ch = 0; ch < 3; ch++) X[ch] *= filters[i][ch];
    return labToSrgb(labFromFilter(X));
  });
}

/** Parses a Duotone specification (colour-mode data) and, when present, resource 1066. */
export function parseDuotone(data: Uint8Array, alt?: Uint8Array): DuotoneSpec | null {
  if (data.length < 524) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint16(0) !== 1) return null;
  const count = dv.getUint16(2);
  if (count < 1 || count > 4) return null;
  const rec = (o: number): ColorRecord => [dv.getUint16(o), dv.getUint16(o + 2), dv.getUint16(o + 4), dv.getUint16(o + 6), dv.getUint16(o + 8)];
  const altColors = parseAltColors(alt);
  const inks: DuotoneInk[] = [];
  for (let i = 0; i < count; i++) {
    const record = rec(4 + i * 10);
    const nameAt = 44 + i * 64;
    const len = Math.min(63, data[nameAt]);
    let name = '';
    for (let k = 0; k < len; k++) name += String.fromCharCode(data[nameAt + 1 + k]);
    const curve: number[] = [];
    for (let k = 0; k < 13; k++) curve.push(dv.getInt16(300 + i * 28 + k * 2));
    if (curve[0] < 0) curve[0] = 0;
    if (curve[12] < 0) curve[12] = 1000;
    // Photoshop's alternate (Lab) colour is what it shows the ink as; the record may be a custom space.
    const color = (altColors[i] ? colorFromRecord(altColors[i]) : null) ?? colorFromRecord(record) ?? { r: 0, g: 0, b: 0 };
    inks.push({ name: name || `Ink ${i + 1}`, color, curve: curve.map((v) => (v < -1 ? -1 : Math.min(1000, v))), record, recordColor: color });
  }
  const overprints: (RGB | null)[] = [];
  // An undefined record (colour space 0xFFFF, what Photoshop writes for unedited overprints) = computed.
  for (let i = 0; i < OVERPRINT_COUNT[count]; i++) overprints.push(colorFromRecord(rec(414 + i * 10)));
  const rendering = parseAltRendering(alt);
  return { inks, overprints, rendering: rendering ?? undefined, raw: [...data] };
}

function parseAltColors(alt?: Uint8Array): ColorRecord[] {
  if (!alt || alt.length < 4) return [];
  const dv = new DataView(alt.buffer, alt.byteOffset, alt.byteLength);
  const n = Math.min(4, dv.getUint16(2));
  const out: ColorRecord[] = [];
  for (let i = 0; i < n && 4 + i * 10 + 10 <= alt.length; i++) {
    const o = 4 + i * 10;
    out.push([dv.getUint16(o), dv.getUint16(o + 2), dv.getUint16(o + 4), dv.getUint16(o + 6), dv.getUint16(o + 8)]);
  }
  return out;
}

function parseAltRendering(alt?: Uint8Array): number[] | null {
  if (!alt || alt.length < 4) return null;
  const dv = new DataView(alt.buffer, alt.byteOffset, alt.byteLength);
  const o = 4 + dv.getUint16(2) * 10;
  if (o + 2 > alt.length) return null;
  const n = dv.getUint16(o);
  if (n !== 256 || o + 2 + n * 3 > alt.length) return null;
  return [...alt.subarray(o + 2, o + 2 + n * 3)];
}

/** Encodes the colour-mode data (the unchanged original while the spec is unedited). */
export function encodeDuotone(spec: DuotoneSpec): Uint8Array {
  if (spec.raw) return Uint8Array.from(spec.raw);
  const out = new Uint8Array(524);
  const dv = new DataView(out.buffer);
  const n = Math.max(1, Math.min(4, spec.inks.length));
  dv.setUint16(0, 1);
  dv.setUint16(2, n);
  const putRec = (o: number, r: ColorRecord) => r.forEach((v, k) => dv.setUint16(o + k * 2, v & 0xffff));
  for (let i = 0; i < 4; i++) {
    const ink = spec.inks[i];
    putRec(4 + i * 10, ink ? inkRecord(ink) : [0xffff, 0, 0, 0, 0]);
    if (ink) {
      const name = ink.name.slice(0, 63);
      out[44 + i * 64] = name.length;
      for (let k = 0; k < name.length; k++) out[44 + i * 64 + 1 + k] = name.charCodeAt(k) < 256 ? name.charCodeAt(k) : 63;
    }
    const curve = ink?.curve ?? NULL_CURVE;
    for (let k = 0; k < 13; k++) dv.setInt16(300 + i * 28 + k * 2, curve[k]);
  }
  dv.setUint16(412, 20);
  for (let i = 0; i < 11; i++) {
    const c = spec.overprints[i];
    putRec(414 + i * 10, c && i < OVERPRINT_COUNT[n] ? recordFromColor(c) : [0xffff, 0, 0, 0, 0]);
  }
  return out;
}

const inkRecord = (ink: DuotoneInk): ColorRecord => (ink.record && ink.recordColor && sameColor(ink.recordColor, ink.color) ? ink.record : recordFromColor(ink.color));
const sameColor = (a: RGB, b: RGB) => a.r === b.r && a.g === b.g && a.b === b.b;

/** Resource 1066: readable (Lab) ink colours and the rendering, for other applications. */
export function alternateDuotoneResource(spec: DuotoneSpec): Uint8Array {
  const n = spec.inks.length;
  const out = new Uint8Array(4 + n * 10 + 2 + 768);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 1);
  dv.setUint16(2, n);
  spec.inks.forEach((ink, i) => recordFromColor(ink.color).forEach((v, k) => dv.setUint16(4 + i * 10 + k * 2, v)));
  dv.setUint16(4 + n * 10, 256);
  const lab = duotoneLabTable(spec);
  out.set(lab, 6 + n * 10);
  return out;
}

/** Marks the spec as edited: the stored Photoshop rendering and original bytes no longer apply. */
export function editedDuotone(spec: DuotoneSpec, patch: Partial<DuotoneSpec>): DuotoneSpec {
  return { inks: spec.inks, overprints: spec.overprints, ...patch, rendering: undefined, raw: undefined };
}

/**
 * Evaluates a 13-point transfer curve at tone t (0 = paper … 1 = solid): a natural cubic spline
 * through the defined points, clamped to 0..1 (Photoshop's interpolation; a monotone spline was
 * up to 4 ΔE off on steep curve ends).
 */
export function evalCurve(curve: number[], t: number): number {
  const { xs, ys, m } = splineOf(curve);
  const last = xs.length - 1;
  if (t <= xs[0]) return ys[0];
  if (t >= xs[last]) return ys[last];
  let k = 0;
  while (t > xs[k + 1]) k++;
  const x0 = xs[k], x1 = xs[k + 1], h = x1 - x0;
  const v = (m[k] * (x1 - t) ** 3 + m[k + 1] * (t - x0) ** 3) / (6 * h) + (ys[k] / h - (m[k] * h) / 6) * (x1 - t) + (ys[k + 1] / h - (m[k + 1] * h) / 6) * (t - x0);
  return Math.max(0, Math.min(1, v));
}

interface Spline { xs: number[]; ys: number[]; m: number[] }
const splineCache = new Map<string, Spline>();
/** The defined points and the natural spline's second derivatives, cached by curve. */
function splineOf(curve: number[]): Spline {
  const key = curve.join();
  const hit = splineCache.get(key);
  if (hit) return hit;
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < 13; i++) if (curve[i] >= 0 || i === 0 || i === 12) { xs.push(DUOTONE_CURVE_X[i] / 100); ys.push(Math.max(0, curve[i]) / 1000); }
  const n = xs.length;
  const m = new Array<number>(n).fill(0);
  // Tridiagonal (Thomas) solve for the interior points; m = 0 at both ends (natural spline).
  const c = new Array<number>(n).fill(0), d = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i];
    const r = 6 * ((ys[i + 1] - ys[i]) / h1 - (ys[i] - ys[i - 1]) / h0);
    const den = 2 * (h0 + h1) - h0 * c[i - 1];
    c[i] = h1 / den;
    d[i] = (r - h0 * d[i - 1]) / den;
  }
  for (let i = n - 2; i >= 1; i--) m[i] = d[i] - c[i] * m[i + 1];
  const sp = { xs, ys, m };
  if (splineCache.size > 256) splineCache.clear();
  splineCache.set(key, sp);
  return sp;
}

// ---------------------------------------------------------------------------------------------
// Overprint model
// ---------------------------------------------------------------------------------------------
const W50 = [0.9642, 1, 0.8249];
const fInv = (t: number) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27));
const fLab = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

/** An ink as a filter: XYZ (D50) relative to paper, negative components clamped to 0. */
export function inkFilter(c: RGB): [number, number, number] {
  const [L, a, b] = labOf(c);
  const fy = (L + 16) / 116;
  return [Math.max(0, fInv(fy + a / 500)), Math.max(0, fInv(fy)), Math.max(0, fInv(fy - b / 200))];
}

function labFromFilter(X: ArrayLike<number>): LabValue {
  const fx = fLab(X[0]), fy = fLab(X[1]), fz = fLab(X[2]);
  void W50;
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Dot gain applied to nominal ink coverage before mixing: Photoshop's spot "Dot Gain N%" curve,
 * which takes 50 % to 50 + N % — coverage' = 1 − (1 − c)^γ with γ = −log2(0.5 − N/100). Measured:
 * Photoshop with the default 20 % renders as γ = 1.735 (formula 1.737); the psd-tools sample,
 * saved with a 15 % setting (Photoshop's Japan presets), as γ ≈ 1.5 (formula 1.515).
 */
export const dotGainExponent = (pct: number) => -Math.log2(0.5 - Math.max(0, Math.min(40, pct)) / 100);
let spotGain = 20;
let gainExponent = dotGainExponent(spotGain);
/** Sets the spot dot gain (%) used to display Duotone and Multichannel inks; true when it changed. */
export function setSpotDotGain(pct: number): boolean {
  const v = Number.isFinite(pct) ? Math.max(0, Math.min(40, pct)) : 20;
  if (v === spotGain) return false;
  spotGain = v;
  gainExponent = dotGainExponent(v);
  return true;
}
export const spotDotGain = () => spotGain;
export const dotGain = (c: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, c)), gainExponent);

/** Overprinted inks (filters with coverage 0..1) → Lab. */
export function mixInks(filters: [number, number, number][], coverage: number[]): LabValue {
  let X = 1, Y = 1, Z = 1;
  for (let i = 0; i < filters.length; i++) {
    const c = dotGain(coverage[i]);
    X *= 1 - c + c * filters[i][0]; Y *= 1 - c + c * filters[i][1]; Z *= 1 - c + c * filters[i][2];
  }
  return labFromFilter([X, Y, Z]);
}

/**
 * The 2ⁿ Neugebauer primaries of a spec (XYZ relative to paper, indexed by ink bit mask): paper,
 * the solid inks, and the overprints (custom, or the inks' filters multiplied).
 */
function duotonePrimaries(spec: DuotoneSpec): Float64Array {
  const n = spec.inks.length;
  const filters = spec.inks.map((i) => inkFilter(i.color));
  const out = new Float64Array((1 << n) * 3);
  for (let mask = 0; mask < 1 << n; mask++) {
    const X = [1, 1, 1];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) for (let ch = 0; ch < 3; ch++) X[ch] *= filters[i][ch];
    out.set(X, mask * 3);
  }
  overprintSets(n).forEach((set, k) => {
    const c = spec.overprints[k];
    if (c) out.set(inkFilter(c), set.reduce((m, i) => m | (1 << i), 0) * 3);
  });
  return out;
}

/** The printed colour (Lab) for nominal ink coverages: Demichel-weighted primaries in XYZ. */
function mixDuotone(primaries: Float64Array, coverage: number[]): LabValue {
  const n = coverage.length;
  const c = coverage.map(dotGain);
  const X = [0, 0, 0];
  for (let mask = 0; mask < 1 << n; mask++) {
    let w = 1;
    for (let i = 0; i < n; i++) w *= mask & (1 << i) ? c[i] : 1 - c[i];
    if (w === 0) continue;
    for (let ch = 0; ch < 3; ch++) X[ch] += w * primaries[mask * 3 + ch];
  }
  return labFromFilter(X);
}

/** The duotone as 256 Lab byte triples by gray level (0 = solid … 255 = paper). */
export function duotoneLabTable(spec: DuotoneSpec): Uint8Array {
  const out = new Uint8Array(768);
  if (spec.rendering?.length === 768) { out.set(spec.rendering); return out; }
  const prim = duotonePrimaries(spec);
  for (let g = 0; g < 256; g++) {
    const t = 1 - g / 255;
    const [L, a, b] = mixDuotone(prim, spec.inks.map((ink) => evalCurve(ink.curve, t)));
    out[g * 3] = Math.round(Math.max(0, Math.min(100, L)) * 2.55);
    out[g * 3 + 1] = Math.round(Math.max(0, Math.min(255, a + 128)));
    out[g * 3 + 2] = Math.round(Math.max(0, Math.min(255, b + 128)));
  }
  return out;
}

const tableCache = new WeakMap<DuotoneSpec, { gain: number; table: Float32Array }>();
/** The duotone's sRGB appearance by gray level: 1024 entries × RGB (0..1). */
export function duotoneRgbTable(spec: DuotoneSpec): Float32Array {
  const hit = tableCache.get(spec);
  if (hit && hit.gain === spotGain) return hit.table;
  const N = 1024;
  const out = new Float32Array(N * 3);
  const prim = duotonePrimaries(spec);
  const lab = spec.rendering?.length === 768 ? spec.rendering : null;
  for (let i = 0; i < N; i++) {
    const g = i / (N - 1);
    let L: number, a: number, b: number;
    if (lab) {
      // Photoshop's own rendering, interpolated between its 256 entries.
      const x = g * 255, k = Math.min(254, Math.floor(x)), f = x - k;
      const at = (j: number, c: number) => lab[j * 3 + c];
      L = ((1 - f) * at(k, 0) + f * at(k + 1, 0)) / 2.55;
      a = (1 - f) * at(k, 1) + f * at(k + 1, 1) - 128;
      b = (1 - f) * at(k, 2) + f * at(k + 1, 2) - 128;
    } else [L, a, b] = mixDuotone(prim, spec.inks.map((ink) => evalCurve(ink.curve, 1 - g)));
    const c = labToSrgb([L, a, b]);
    out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b;
  }
  tableCache.set(spec, { gain: spotGain, table: out });
  return out;
}

/** Straight gray (0..1) → duotone sRGB, in place on an RGBA buffer (R = G = B = gray). */
export function applyDuotone(spec: DuotoneSpec, buf: Float32Array, n = buf.length / 4, premultiplied = false): void {
  const t = duotoneRgbTable(spec);
  for (let i = 0; i < n; i++) {
    const a = buf[i * 4 + 3];
    let g = buf[i * 4];
    if (premultiplied) g = a > 1e-7 ? g / a : 1;
    const k = Math.round(Math.max(0, Math.min(1, g)) * 1023) * 3;
    const m = premultiplied ? a : 1;
    buf[i * 4] = t[k] * m; buf[i * 4 + 1] = t[k + 1] * m; buf[i * 4 + 2] = t[k + 2] * m;
  }
}

/** A gray UI colour as it looks in the duotone. */
export function duotoneColor(spec: DuotoneSpec, gray: number): RGB {
  const t = duotoneRgbTable(spec);
  const k = Math.round(Math.max(0, Math.min(1, gray)) * 1023) * 3;
  return { r: t[k], g: t[k + 1], b: t[k + 2] };
}

/** Default spec for Image ▸ Mode ▸ Duotone: black plus a second ink on a lighter curve. */
export function defaultDuotone(): DuotoneSpec {
  return {
    inks: [
      { name: 'Black', color: colorFromLab([10, 0, 0]), curve: [0, -1, -1, -1, -1, -1, 400, -1, -1, -1, -1, -1, 1000] },
      { name: 'Ink 2', color: colorFromLab([55, 30, 55]), curve: [0, -1, -1, -1, -1, -1, 350, -1, -1, 700, -1, -1, 1000] },
    ],
    overprints: [null],
  };
}

// ---------------------------------------------------------------------------------------------
// Spot inks (spot channels and Multichannel documents)
// ---------------------------------------------------------------------------------------------
/**
 * Prints a spot ink over straight sRGB `rgb` (RGBA): `value` is the channel (1 = no ink, as in
 * Photoshop channels), `solidity` 0 = transparent ink (multiplies), 1 = opaque ink (covers).
 */
export function overprintSpot(rgb: Float32Array, value: Float32Array, ink: RGB, solidity: number, n = value.length): void {
  for (let i = 0; i < n; i++) {
    const k = 1 - value[i];
    if (k <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const base = rgb[i * 4 + c];
      const inkc = c === 0 ? ink.r : c === 1 ? ink.g : ink.b;
      rgb[i * 4 + c] = base * (1 - k) + k * (solidity * inkc + (1 - solidity) * base * inkc);
    }
  }
}
