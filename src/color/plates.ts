/**
 * Native CMYK and Lab documents: how colour is stored and converted.
 *
 * Storage (straight RGBA float rasters, so the whole engine keeps working on 4 channels):
 *  - RGB / Gray / Indexed / Bitmap: one plate, R G B A.
 *  - Lab: one plate, L/100, (a+128)/255, (b+128)/255, A — Photoshop's encoding.
 *  - CMYK: two plates. Plate 0 = the layer raster: (1−C, 1−M, 1−Y, A). Plate 1 = its companion
 *    raster: (1−K, 1−K, 1−K, A). Inks are stored inverted (1 = no ink), as Photoshop does, so the
 *    ordinary blend modes act on CMYK exactly as they do in Photoshop's CMYK mode, and each
 *    plate composites independently. Plate 1 always holds a neutral triple.
 *
 * UI colours (foreground, swatches, style colours) are sRGB with optional exact CMYK / Lab
 * values (RGB.exact). Encoding a colour for a document uses the exact values when present and
 * otherwise converts through the document's profile.
 */
import type { CelenneDocument } from '../document/document';
import type { ColorProfileRef } from '../document/types';
import type { RGB } from './types';
import { colorEngine, Intent, ProfileLike } from './cms';

export type Cmyk = [number, number, number, number];
export type LabValue = [number, number, number];

export const isCmykDoc = (d: { canvas: { colorMode: string } }): boolean => d.canvas.colorMode === 'cmyk';
export const isLabDoc = (d: { canvas: { colorMode: string } }): boolean => d.canvas.colorMode === 'lab';
export const plateCount = (d: { canvas: { colorMode: string } }): 1 | 2 => (isCmykDoc(d) ? 2 : 1);

/** The profile describing a document's stored values. */
export function docProfile(doc: CelenneDocument): ColorProfileRef {
  if (isLabDoc(doc)) return { name: 'Lab Color (D50)', builtin: 'labD50' };
  return doc.profile;
}

// ---------------------------------------------------------------------------------------------
// Exact values carried by UI colours
// ---------------------------------------------------------------------------------------------
function exactOf(c: RGB) {
  const e = c.exact;
  return e && e.r === c.r && e.g === c.g && e.b === c.b ? e : undefined;
}

export function exactCmyk(c: RGB): Cmyk | undefined {
  return exactOf(c)?.cmyk;
}
export function exactLab(c: RGB): LabValue | undefined {
  return exactOf(c)?.lab;
}

/** A UI colour for exact CMYK ink values (RGB is its sRGB appearance). */
export function colorFromCmyk(cmyk: Cmyk, profile: ProfileLike): RGB {
  const rgb = cmykToSrgb(cmyk, profile);
  return { ...rgb, exact: { ...rgb, cmyk: [...cmyk] as Cmyk } };
}

/** A UI colour for exact Lab values. */
export function colorFromLab(lab: LabValue): RGB {
  const rgb = labToSrgb(lab);
  return { ...rgb, exact: { ...rgb, lab: [...lab] as LabValue } };
}

// ---------------------------------------------------------------------------------------------
// Single-colour conversions
// ---------------------------------------------------------------------------------------------
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** sRGB → CMYK ink (0..1) through a CMYK profile (device formula when the engine is not ready). */
export function srgbToCmyk(c: RGB, profile: ProfileLike, intent: Intent = 'relative'): Cmyk {
  if (colorEngine.ready) {
    try {
      const o = colorEngine.transform('srgb', profile, intent, true).run(Float32Array.of(c.r, c.g, c.b), 1);
      return [clamp01(o[0] / 100), clamp01(o[1] / 100), clamp01(o[2] / 100), clamp01(o[3] / 100)];
    } catch { /* fall through */ }
  }
  const k = 1 - Math.max(c.r, c.g, c.b);
  if (k >= 1) return [0, 0, 0, 1];
  return [(1 - c.r - k) / (1 - k), (1 - c.g - k) / (1 - k), (1 - c.b - k) / (1 - k), k];
}

export function cmykToSrgb(cmyk: Cmyk, profile: ProfileLike, intent: Intent = 'relative'): RGB {
  if (colorEngine.ready) {
    try {
      const o = colorEngine.transform(profile, 'srgb', intent, true).run(Float32Array.of(cmyk[0] * 100, cmyk[1] * 100, cmyk[2] * 100, cmyk[3] * 100), 1);
      return { r: clamp01(o[0]), g: clamp01(o[1]), b: clamp01(o[2]) };
    } catch { /* fall through */ }
  }
  return { r: (1 - cmyk[0]) * (1 - cmyk[3]), g: (1 - cmyk[1]) * (1 - cmyk[3]), b: (1 - cmyk[2]) * (1 - cmyk[3]) };
}

// Analytic sRGB ↔ CIE Lab (D50, Bradford) — matches LittleCMS closely; used without the engine.
const srgbLin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const linSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
// sRGB (D65) → XYZ (D50) via Bradford.
const M_RGB_XYZ50 = [[0.4360747, 0.3850649, 0.1430804], [0.2225045, 0.7168786, 0.0606169], [0.0139322, 0.0971045, 0.7141733]];
const M_XYZ50_RGB = [[3.1338561, -1.6168667, -0.4906146], [-0.9787684, 1.9161415, 0.033454], [0.0719453, -0.2289914, 1.4052427]];
const W50 = [0.9642, 1, 0.8249];
const fLab = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fInv = (t: number) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27));

export function srgbToLab(c: RGB): LabValue {
  const R = srgbLin(c.r), G = srgbLin(c.g), B = srgbLin(c.b);
  const X = M_RGB_XYZ50[0][0] * R + M_RGB_XYZ50[0][1] * G + M_RGB_XYZ50[0][2] * B;
  const Y = M_RGB_XYZ50[1][0] * R + M_RGB_XYZ50[1][1] * G + M_RGB_XYZ50[1][2] * B;
  const Z = M_RGB_XYZ50[2][0] * R + M_RGB_XYZ50[2][1] * G + M_RGB_XYZ50[2][2] * B;
  const fx = fLab(X / W50[0]), fy = fLab(Y / W50[1]), fz = fLab(Z / W50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToSrgb([L, a, b]: LabValue): RGB {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = fInv(fx) * W50[0], Y = fInv(fy) * W50[1], Z = fInv(fz) * W50[2];
  const R = M_XYZ50_RGB[0][0] * X + M_XYZ50_RGB[0][1] * Y + M_XYZ50_RGB[0][2] * Z;
  const G = M_XYZ50_RGB[1][0] * X + M_XYZ50_RGB[1][1] * Y + M_XYZ50_RGB[1][2] * Z;
  const B2 = M_XYZ50_RGB[2][0] * X + M_XYZ50_RGB[2][1] * Y + M_XYZ50_RGB[2][2] * Z;
  return { r: clamp01(linSrgb(R)), g: clamp01(linSrgb(G)), b: clamp01(linSrgb(B2)) };
}

export const encodeLab = ([L, a, b]: LabValue): [number, number, number] => [clamp01(L / 100), clamp01((a + 128) / 255), clamp01((b + 128) / 255)];
export const decodeLab = (v0: number, v1: number, v2: number): LabValue => [v0 * 100, v1 * 255 - 128, v2 * 255 - 128];

// ---------------------------------------------------------------------------------------------
// Document encoding
// ---------------------------------------------------------------------------------------------
/** CMYK ink for a UI colour in a CMYK document. */
export function cmykFor(doc: CelenneDocument, c: RGB): Cmyk {
  return exactCmyk(c) ?? srgbToCmyk(c, doc.profile);
}

/** Lab for a UI colour. */
export function labFor(c: RGB): LabValue {
  return exactLab(c) ?? srgbToLab(c);
}

/** A UI colour's stored channel values, per plate. */
export function encodeColor(doc: CelenneDocument, c: RGB): [number, number, number][] {
  if (isCmykDoc(doc)) {
    const [C, M, Y, K] = cmykFor(doc, c);
    return [[1 - C, 1 - M, 1 - Y], [1 - K, 1 - K, 1 - K]];
  }
  if (isLabDoc(doc)) return [encodeLab(labFor(c))];
  return [[c.r, c.g, c.b]];
}

/** The same colour as an RGB triple for plate `p` (for code that paints with RGB objects). */
export function plateColor(doc: CelenneDocument, c: RGB, p: number): RGB {
  const v = encodeColor(doc, c)[p] ?? encodeColor(doc, c)[0];
  return { r: v[0], g: v[1], b: v[2] };
}

/** Stored plate values of one pixel → a UI colour with exact values. */
export function decodeColor(doc: CelenneDocument, plates: number[][]): RGB {
  if (isCmykDoc(doc)) {
    const p0 = plates[0], p1 = plates[1] ?? [1, 1, 1];
    return colorFromCmyk([clamp01(1 - p0[0]), clamp01(1 - p0[1]), clamp01(1 - p0[2]), clamp01(1 - p1[0])], doc.profile);
  }
  if (isLabDoc(doc)) return colorFromLab(decodeLab(plates[0][0], plates[0][1], plates[0][2]));
  return { r: plates[0][0], g: plates[0][1], b: plates[0][2] };
}

/** Maps every colour object inside `obj` (deep copy) to its plate-`p` stored values. */
export function mapColorsToPlate<T>(doc: CelenneDocument, obj: T, p: number): T {
  if (plateCount(doc) === 1 && !isLabDoc(doc)) return obj;
  const seen = new Map<object, unknown>();
  const walk = (o: unknown): unknown => {
    if (!o || typeof o !== 'object') return o;
    if (ArrayBuffer.isView(o) || o instanceof Map) return o;
    if (seen.has(o)) return seen.get(o);
    if (Array.isArray(o)) { const a: unknown[] = []; seen.set(o, a); for (const v of o) a.push(walk(v)); return a; }
    const rec = o as Record<string, unknown>;
    if (typeof rec.r === 'number' && typeof rec.g === 'number' && typeof rec.b === 'number' && Object.keys(rec).every((k) => k === 'r' || k === 'g' || k === 'b' || k === 'a' || k === 'exact')) {
      const pc = plateColor(doc, rec as unknown as RGB, p);
      const out = { ...pc, ...(typeof rec.a === 'number' ? { a: rec.a } : {}) };
      seen.set(o, out);
      return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(o, out);
    for (const [k, v] of Object.entries(rec)) out[k] = k === 'parent' || k === 'raster' ? v : walk(v);
    return out;
  };
  return walk(obj) as T;
}

// ---------------------------------------------------------------------------------------------
// Buffer conversions (straight RGBA floats; alpha is carried through unchanged)
// ---------------------------------------------------------------------------------------------
/** Document plates → RGB in `to` (default sRGB). */
export function platesToRgb(doc: CelenneDocument, plates: Float32Array[], n: number, to: ProfileLike = 'srgb', intent: Intent = 'relative'): Float32Array {
  const out = new Float32Array(n * 4);
  if (isCmykDoc(doc)) {
    const p0 = plates[0], p1 = plates[1];
    const inp = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      inp[i * 4] = (1 - p0[i * 4]) * 100; inp[i * 4 + 1] = (1 - p0[i * 4 + 1]) * 100; inp[i * 4 + 2] = (1 - p0[i * 4 + 2]) * 100;
      inp[i * 4 + 3] = p1 ? (1 - p1[i * 4]) * 100 : 0;
    }
    const rgb = cmykBufferToRgb(inp, n, doc.profile, to, intent);
    for (let i = 0; i < n; i++) { out[i * 4] = rgb[i * 3]; out[i * 4 + 1] = rgb[i * 3 + 1]; out[i * 4 + 2] = rgb[i * 3 + 2]; out[i * 4 + 3] = p0[i * 4 + 3]; }
    return out;
  }
  if (isLabDoc(doc)) {
    const p0 = plates[0];
    const inp = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const l = decodeLab(p0[i * 4], p0[i * 4 + 1], p0[i * 4 + 2]); inp[i * 3] = l[0]; inp[i * 3 + 1] = l[1]; inp[i * 3 + 2] = l[2]; }
    let rgb: Float32Array;
    if (colorEngine.ready) rgb = colorEngine.transform({ name: 'Lab', builtin: 'labD50' }, to, intent, true).run(inp, n);
    else { rgb = new Float32Array(n * 3); for (let i = 0; i < n; i++) { const c = labToSrgb([inp[i * 3], inp[i * 3 + 1], inp[i * 3 + 2]]); rgb[i * 3] = c.r; rgb[i * 3 + 1] = c.g; rgb[i * 3 + 2] = c.b; } }
    for (let i = 0; i < n; i++) { out[i * 4] = rgb[i * 3]; out[i * 4 + 1] = rgb[i * 3 + 1]; out[i * 4 + 2] = rgb[i * 3 + 2]; out[i * 4 + 3] = p0[i * 4 + 3]; }
    return out;
  }
  out.set(plates[0].subarray(0, n * 4));
  return out;
}

function cmykBufferToRgb(inkPct: Float32Array, n: number, profile: ProfileLike, to: ProfileLike, intent: Intent): Float32Array {
  if (colorEngine.ready) {
    try { return colorEngine.transform(profile, to, intent, true).run(inkPct, n); } catch { /* fall through */ }
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = 1 - inkPct[i * 4 + 3] / 100;
    out[i * 3] = (1 - inkPct[i * 4] / 100) * k; out[i * 3 + 1] = (1 - inkPct[i * 4 + 1] / 100) * k; out[i * 3 + 2] = (1 - inkPct[i * 4 + 2] / 100) * k;
  }
  return out;
}

/** RGB in `from` (straight RGBA floats) → document plates. */
export function rgbToPlates(doc: CelenneDocument, rgba: Float32Array, n: number, from: ProfileLike = 'srgb', intent: Intent = 'relative'): Float32Array[] {
  if (isCmykDoc(doc)) {
    const inp = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { inp[i * 3] = rgba[i * 4]; inp[i * 3 + 1] = rgba[i * 4 + 1]; inp[i * 3 + 2] = rgba[i * 4 + 2]; }
    let ink: Float32Array;
    if (colorEngine.ready) ink = colorEngine.transform(from, doc.profile, intent, true).run(inp, n);
    else {
      ink = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { const c = srgbToCmyk({ r: inp[i * 3], g: inp[i * 3 + 1], b: inp[i * 3 + 2] }, doc.profile); for (let k = 0; k < 4; k++) ink[i * 4 + k] = c[k] * 100; }
    }
    const p0 = new Float32Array(n * 4), p1 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const a = rgba[i * 4 + 3];
      p0[i * 4] = 1 - ink[i * 4] / 100; p0[i * 4 + 1] = 1 - ink[i * 4 + 1] / 100; p0[i * 4 + 2] = 1 - ink[i * 4 + 2] / 100; p0[i * 4 + 3] = a;
      p1[i * 4] = p1[i * 4 + 1] = p1[i * 4 + 2] = 1 - ink[i * 4 + 3] / 100; p1[i * 4 + 3] = a;
    }
    return [p0, p1];
  }
  if (isLabDoc(doc)) {
    const inp = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { inp[i * 3] = rgba[i * 4]; inp[i * 3 + 1] = rgba[i * 4 + 1]; inp[i * 3 + 2] = rgba[i * 4 + 2]; }
    let lab: Float32Array;
    if (colorEngine.ready) lab = colorEngine.transform(from, { name: 'Lab', builtin: 'labD50' }, intent, true).run(inp, n);
    else { lab = new Float32Array(n * 3); for (let i = 0; i < n; i++) { const l = srgbToLab({ r: inp[i * 3], g: inp[i * 3 + 1], b: inp[i * 3 + 2] }); lab[i * 3] = l[0]; lab[i * 3 + 1] = l[1]; lab[i * 3 + 2] = l[2]; } }
    const p0 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const e = encodeLab([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]);
      p0[i * 4] = e[0]; p0[i * 4 + 1] = e[1]; p0[i * 4 + 2] = e[2]; p0[i * 4 + 3] = rgba[i * 4 + 3];
    }
    return [p0];
  }
  return [rgba.slice(0, n * 4)];
}

/**
 * Reads a raster region as document plates: [plate 0] or, for CMYK, [plate 0, plate 1]. A missing
 * companion reads as "no black ink" with plate 0's alpha.
 */
export function readPlates(doc: CelenneDocument, raster: import('../image-engine/tiledRaster').TiledRaster, r: import('../image-engine/rect').Rect, level = 0): Float32Array[] {
  const p0 = raster.readFloat(r, level);
  if (!isCmykDoc(doc)) return [p0];
  return [p0, companionRead(raster, r, level, p0)];
}

export function companionRead(raster: import('../image-engine/tiledRaster').TiledRaster, r: import('../image-engine/rect').Rect, level: number, p0: Float32Array): Float32Array {
  if (raster.companion) return raster.companion.readFloat(r, level);
  const out = new Float32Array(p0.length);
  for (let i = 0; i < out.length; i += 4) { out[i] = out[i + 1] = out[i + 2] = 1; out[i + 3] = p0[i + 3]; }
  return out;
}

/** The companion raster of a CMYK layer raster, created (empty = no black) when missing. */
export function ensureCompanion(raster: import('../image-engine/tiledRaster').TiledRaster): import('../image-engine/tiledRaster').TiledRaster {
  if (!raster.companion) {
    // Built lazily from plate 0's alpha so existing content gets "no black ink".
    const Ctor = raster.constructor as new (ch: 1 | 4, depth: import('../image-engine/pixels').BitDepth, fill: number) => import('../image-engine/tiledRaster').TiledRaster;
    const k = new Ctor(4, raster.depth, raster.fill);
    for (const [key] of raster.tiles) {
      const tx = (key % 65536) - 32768, ty = Math.floor(key / 65536) - 32768;
      const rect = { x: tx * 256, y: ty * 256, w: 256, h: 256 };
      const src = raster.readFloat(rect);
      for (let i = 0; i < src.length; i += 4) { src[i] = src[i + 1] = src[i + 2] = 1; }
      k.writeFloat(rect, src);
    }
    raster.companion = k;
  }
  return raster.companion;
}

// ---------------------------------------------------------------------------------------------
// Lab documents: an exact RGB view for tools and filters
// ---------------------------------------------------------------------------------------------
const linSrgbU = (v: number): number => (v < 0 ? -linSrgbU(-v) : v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const srgbLinU = (v: number): number => (v < 0 ? -srgbLinU(-v) : v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/** Encoded Lab → sRGB-encoded values without clipping (straight RGBA, in place). */
export function labToRgbUnclamped(buf: Float32Array, n = buf.length / 4): void {
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const [L, a, b] = decodeLab(buf[o], buf[o + 1], buf[o + 2]);
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const X = fInv(fx) * W50[0], Y = fInv(fy) * W50[1], Z = fInv(fz) * W50[2];
    buf[o] = linSrgbU(M_XYZ50_RGB[0][0] * X + M_XYZ50_RGB[0][1] * Y + M_XYZ50_RGB[0][2] * Z);
    buf[o + 1] = linSrgbU(M_XYZ50_RGB[1][0] * X + M_XYZ50_RGB[1][1] * Y + M_XYZ50_RGB[1][2] * Z);
    buf[o + 2] = linSrgbU(M_XYZ50_RGB[2][0] * X + M_XYZ50_RGB[2][1] * Y + M_XYZ50_RGB[2][2] * Z);
  }
}

/** Inverse of labToRgbUnclamped (straight RGBA, in place). */
export function rgbToLabUnclamped(buf: Float32Array, n = buf.length / 4): void {
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const R = srgbLinU(buf[o]), G = srgbLinU(buf[o + 1]), B = srgbLinU(buf[o + 2]);
    const X = M_RGB_XYZ50[0][0] * R + M_RGB_XYZ50[0][1] * G + M_RGB_XYZ50[0][2] * B;
    const Y = M_RGB_XYZ50[1][0] * R + M_RGB_XYZ50[1][1] * G + M_RGB_XYZ50[1][2] * B;
    const Z = M_RGB_XYZ50[2][0] * R + M_RGB_XYZ50[2][1] * G + M_RGB_XYZ50[2][2] * B;
    const fx = f(X / W50[0]), fy = f(Y / W50[1]), fz = f(Z / W50[2]);
    buf[o] = (116 * fy - 16) / 100;
    buf[o + 1] = (500 * (fx - fy) + 128) / 255;
    buf[o + 2] = (200 * (fy - fz) + 128) / 255;
  }
}

/** The RGB value a UI colour has in a Lab document's RGB view (exact Lab kept, unclipped). */
export function labViewColor(c: RGB): RGB {
  const lab = exactLab(c);
  if (!lab) return { r: c.r, g: c.g, b: c.b };
  const b = Float32Array.from([...encodeLab(lab), 1]);
  labToRgbUnclamped(b, 1);
  return { r: b[0], g: b[1], b: b[2] };
}

type RW = Pick<import('../image-engine/tiledRaster').TiledRaster, 'readFloat' | 'writeFloat'>;

/**
 * A read/write RGB view of a Lab raster (exact round trip). Reads and writes convert; every other
 * member is forwarded to the raster itself.
 */
export function labRgbView(r: import('../image-engine/tiledRaster').TiledRaster): import('../image-engine/tiledRaster').TiledRaster {
  const readFloat = (rect: import('../image-engine/rect').Rect, level = 0, out?: Float32Array) => { const v = r.readFloat(rect, level, out); labToRgbUnclamped(v); return v; };
  const writeFloat = (rect: import('../image-engine/rect').Rect, src: Float32Array) => { const c = src.slice(); rgbToLabUnclamped(c); r.writeFloat(rect, c); };
  return new Proxy(r, {
    get(t, k) {
      if (k === 'readFloat') return readFloat;
      if (k === 'writeFloat') return writeFloat;
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/** Colour to write inside an editRaster `mutate` for `plate` (CMYK plate values, Lab RGB view, RGB as is). */
export function editColor(doc: CelenneDocument, c: RGB, plate: number): RGB {
  if (isCmykDoc(doc)) return plateColor(doc, c, plate);
  if (isLabDoc(doc)) return labViewColor(c);
  return c;
}

/** A gradient whose colours are what editRaster's `mutate` writes for `plate`. */
export function editGradient<T>(doc: CelenneDocument, g: T, plate: number): T {
  if (isCmykDoc(doc)) return mapColorsToPlate(doc, g, plate);
  if (!isLabDoc(doc)) return g;
  const seen = new Map<object, unknown>();
  const walk = (o: unknown): unknown => {
    if (!o || typeof o !== 'object' || ArrayBuffer.isView(o)) return o;
    if (seen.has(o)) return seen.get(o);
    if (Array.isArray(o)) { const a: unknown[] = []; seen.set(o, a); for (const v of o) a.push(walk(v)); return a; }
    const rec = o as Record<string, unknown>;
    if (typeof rec.r === 'number' && typeof rec.g === 'number' && typeof rec.b === 'number') {
      const out: Record<string, unknown> = { ...rec, ...labViewColor(rec as unknown as RGB) };
      delete out.exact;
      seen.set(o, out);
      return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(o, out);
    for (const [k, v] of Object.entries(rec)) out[k] = walk(v);
    return out;
  };
  return walk(g) as T;
}

let platePatternsRef: ((doc: CelenneDocument, plate: number) => Map<string, import('../document/types').PatternDef>) | null = null;
/** Registered by rendering/platePatterns (avoids a circular import). */
export function registerPlatePatterns(f: typeof platePatternsRef): void {
  platePatternsRef = f;
}

/** A document pattern as editRaster's `mutate` should write it for `plate` (CMYK plates; RGB otherwise). */
export function editPattern(doc: CelenneDocument, id: string, plate: number): import('../document/types').PatternDef | undefined {
  if (isCmykDoc(doc)) return platePatternsRef?.(doc, plate).get(id) ?? doc.patterns.get(id);
  return doc.patterns.get(id);
}

/** Straight RGBA appearance (sRGB for CMYK / Lab) of a layer raster region, for previews. */
export function rasterAppearance(doc: CelenneDocument, raster: import('../image-engine/tiledRaster').TiledRaster, r: import('../image-engine/rect').Rect, level = 0): Float32Array {
  if (!isCmykDoc(doc) && !isLabDoc(doc)) return raster.readFloat(r, level);
  return platesToRgb(doc, readPlates(doc, raster, r, level), r.w * r.h);
}
