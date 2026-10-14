/**
 * Blend modes and compositing kernels.
 *
 * Backdrop buffers are premultiplied RGBA floats; sources are straight (unpremultiplied) RGBA
 * floats, which is how layer pixels are stored. The general compositing equation
 * (W3C Compositing & Blending Level 1, which matches Photoshop's model):
 *
 *   αo = αs + αb·(1 − αs)
 *   co = αs·(1 − αb)·Cs + αs·αb·B(Cb, Cs) + (1 − αs)·cb        (cb = αb·Cb, premultiplied)
 */
export type BlendMode =
  | 'passThrough'
  | 'normal'
  | 'dissolve'
  | 'darken'
  | 'multiply'
  | 'colorBurn'
  | 'linearBurn'
  | 'darkerColor'
  | 'lighten'
  | 'screen'
  | 'colorDodge'
  | 'linearDodge'
  | 'lighterColor'
  | 'overlay'
  | 'softLight'
  | 'hardLight'
  | 'vividLight'
  | 'linearLight'
  | 'pinLight'
  | 'hardMix'
  | 'difference'
  | 'exclusion'
  | 'subtract'
  | 'divide'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export interface BlendModeInfo {
  id: BlendMode;
  label: string;
  group: number;
}

/** Ordered and grouped like a professional blend-mode menu. */
export const BLEND_MODES: BlendModeInfo[] = [
  { id: 'passThrough', label: 'Pass Through', group: 0 },
  { id: 'normal', label: 'Normal', group: 0 },
  { id: 'dissolve', label: 'Dissolve', group: 0 },
  { id: 'darken', label: 'Darken', group: 1 },
  { id: 'multiply', label: 'Multiply', group: 1 },
  { id: 'colorBurn', label: 'Color Burn', group: 1 },
  { id: 'linearBurn', label: 'Linear Burn', group: 1 },
  { id: 'darkerColor', label: 'Darker Color', group: 1 },
  { id: 'lighten', label: 'Lighten', group: 2 },
  { id: 'screen', label: 'Screen', group: 2 },
  { id: 'colorDodge', label: 'Color Dodge', group: 2 },
  { id: 'linearDodge', label: 'Linear Dodge (Add)', group: 2 },
  { id: 'lighterColor', label: 'Lighter Color', group: 2 },
  { id: 'overlay', label: 'Overlay', group: 3 },
  { id: 'softLight', label: 'Soft Light', group: 3 },
  { id: 'hardLight', label: 'Hard Light', group: 3 },
  { id: 'vividLight', label: 'Vivid Light', group: 3 },
  { id: 'linearLight', label: 'Linear Light', group: 3 },
  { id: 'pinLight', label: 'Pin Light', group: 3 },
  { id: 'hardMix', label: 'Hard Mix', group: 3 },
  { id: 'difference', label: 'Difference', group: 4 },
  { id: 'exclusion', label: 'Exclusion', group: 4 },
  { id: 'subtract', label: 'Subtract', group: 4 },
  { id: 'divide', label: 'Divide', group: 4 },
  { id: 'hue', label: 'Hue', group: 5 },
  { id: 'saturation', label: 'Saturation', group: 5 },
  { id: 'color', label: 'Color', group: 5 },
  { id: 'luminosity', label: 'Luminosity', group: 5 },
];

export const LAYER_BLEND_MODES = BLEND_MODES.filter((m) => m.id !== 'passThrough');

// ---------------------------------------------------------------------------------------------
// Separable blend functions B(Cb, Cs)
// ---------------------------------------------------------------------------------------------
const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const screen = (b: number, s: number) => b + s - b * s;
const colorDodge = (b: number, s: number) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const colorBurn = (b: number, s: number) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const hardLight = (b: number, s: number) => (s <= 0.5 ? b * 2 * s : screen(b, 2 * s - 1));
const softLight = (b: number, s: number) => {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
};

export type SeparableFn = (b: number, s: number) => number;

export const SEPARABLE: Partial<Record<BlendMode, SeparableFn>> = {
  normal: (_b, s) => s,
  dissolve: (_b, s) => s,
  multiply: (b, s) => b * s,
  screen,
  overlay: (b, s) => hardLight(s, b),
  darken: (b, s) => (b < s ? b : s),
  lighten: (b, s) => (b > s ? b : s),
  colorDodge,
  colorBurn,
  hardLight,
  softLight,
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  linearBurn: (b, s) => clamp(b + s - 1),
  linearDodge: (b, s) => clamp(b + s),
  vividLight: (b, s) => (s <= 0.5 ? colorBurn(b, 2 * s) : colorDodge(b, 2 * (s - 0.5))),
  linearLight: (b, s) => clamp(b + 2 * s - 1),
  pinLight: (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
  hardMix: (b, s) => (b + s >= 1 ? 1 : 0),
  subtract: (b, s) => clamp(b - s),
  divide: (b, s) => (s <= 0 ? (b <= 0 ? 0 : 1) : clamp(b / s)),
};

// ---------------------------------------------------------------------------------------------
// Non-separable helpers (W3C definitions)
// ---------------------------------------------------------------------------------------------
const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

function clipColor(c: number[]): void {
  const l = lum(c[0], c[1], c[2]);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  if (n < 0) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * l) / (l - n || 1e-9);
  if (x > 1) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * (1 - l)) / (x - l || 1e-9);
}

function setLum(c: number[], l: number): void {
  const d = l - lum(c[0], c[1], c[2]);
  c[0] += d; c[1] += d; c[2] += d;
  clipColor(c);
}

const sat = (c: number[]) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

function setSat(c: number[], s: number): void {
  let maxI = 0, minI = 0;
  for (let i = 1; i < 3; i++) {
    if (c[i] > c[maxI]) maxI = i;
    if (c[i] < c[minI]) minI = i;
  }
  if (maxI === minI) { c[0] = c[1] = c[2] = 0; return; }
  const midI = 3 - maxI - minI;
  const range = c[maxI] - c[minI];
  c[midI] = ((c[midI] - c[minI]) * s) / range;
  c[maxI] = s;
  c[minI] = 0;
}

const tmpA = [0, 0, 0];
const tmpB = [0, 0, 0];

/** Non-separable blend. Writes the result into `out`. */
export function blendNonSeparable(mode: BlendMode, br: number, bg: number, bb: number, sr: number, sg: number, sb: number, out: number[]): void {
  switch (mode) {
    case 'hue':
      tmpA[0] = sr; tmpA[1] = sg; tmpA[2] = sb;
      tmpB[0] = br; tmpB[1] = bg; tmpB[2] = bb;
      setSat(tmpA, sat(tmpB));
      setLum(tmpA, lum(br, bg, bb));
      out[0] = tmpA[0]; out[1] = tmpA[1]; out[2] = tmpA[2];
      return;
    case 'saturation':
      tmpA[0] = br; tmpA[1] = bg; tmpA[2] = bb;
      tmpB[0] = sr; tmpB[1] = sg; tmpB[2] = sb;
      setSat(tmpA, sat(tmpB));
      setLum(tmpA, lum(br, bg, bb));
      out[0] = tmpA[0]; out[1] = tmpA[1]; out[2] = tmpA[2];
      return;
    case 'color':
      tmpA[0] = sr; tmpA[1] = sg; tmpA[2] = sb;
      setLum(tmpA, lum(br, bg, bb));
      out[0] = tmpA[0]; out[1] = tmpA[1]; out[2] = tmpA[2];
      return;
    case 'luminosity':
      tmpA[0] = br; tmpA[1] = bg; tmpA[2] = bb;
      setLum(tmpA, lum(sr, sg, sb));
      out[0] = tmpA[0]; out[1] = tmpA[1]; out[2] = tmpA[2];
      return;
    case 'darkerColor':
      if (lum(sr, sg, sb) < lum(br, bg, bb)) { out[0] = sr; out[1] = sg; out[2] = sb; } else { out[0] = br; out[1] = bg; out[2] = bb; }
      return;
    case 'lighterColor':
      if (lum(sr, sg, sb) > lum(br, bg, bb)) { out[0] = sr; out[1] = sg; out[2] = sb; } else { out[0] = br; out[1] = bg; out[2] = bb; }
      return;
    default:
      out[0] = sr; out[1] = sg; out[2] = sb;
  }
}

/** Deterministic per-pixel hash in [0,1) used by Dissolve (stable across renders and tiles). */
export function dissolveNoise(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const outRGB = [0, 0, 0];

/**
 * Fill opacity in Photoshop's "special eight" modes is not a fade (measured against Photoshop
 * 26.5): for seven of them it moves the layer's colours toward the mode's neutral colour before
 * blending (white for the burns, black for the dodges and Difference, mid-gray for Vivid / Linear
 * Light), and Hard Mix becomes clamp((b − f·(1 − s)) / (1 − f)). Opacity still fades the result.
 */
export const FILL_NEUTRAL: Partial<Record<BlendMode, number>> = { colorBurn: 1, linearBurn: 1, colorDodge: 0, linearDodge: 0, vividLight: 0.5, linearLight: 0.5, difference: 0, hardMix: -1 };
export const fillIsSpecial = (mode: BlendMode, fill: number) => fill < 1 && FILL_NEUTRAL[mode] !== undefined;

/** Straight RGBA source with fill applied the special-mode way (Hard Mix: unchanged, see `fill`). */
export function specialFillSource(mode: BlendMode, src: Float32Array, n: number, fill: number): Float32Array {
  const k = FILL_NEUTRAL[mode]!;
  if (k < 0) return src;
  const out = new Float32Array(src.length);
  const nk = k * (1 - fill);
  for (let i = 0; i < n * 4; i += 4) {
    out[i] = src[i] * fill + nk; out[i + 1] = src[i + 1] * fill + nk; out[i + 2] = src[i + 2] * fill + nk; out[i + 3] = src[i + 3];
  }
  return out;
}
const hardMixFill = (b: number, s: number, f: number) => (f >= 1 ? (b + s >= 1 ? 1 : 0) : clamp((b - f * (1 - s)) / (1 - f)));

export interface SpanOptions {
  /** 32-bit (HDR) document: Linear Dodge and Divide are not clamped at 1, as in Photoshop. */
  hdr?: boolean;
  /** Hard Mix with fill opacity below 100 % (Photoshop's special-mode fill). */
  hardMixFill?: number;
  /** Global multiplier (layer opacity × fill opacity). */
  opacity: number;
  /** Optional single-channel coverage (mask, selection, clip base alpha). */
  mask?: Float32Array;
  maskOffset?: number;
  /** Document-space origin and stride of the span; needed by Dissolve. */
  x0?: number;
  y0?: number;
  width?: number;
}

/**
 * Composites `n` straight-alpha source pixels onto a premultiplied backdrop in place.
 */
export function compositeSpan(mode: BlendMode, dst: Float32Array, dOff: number, src: Float32Array, sOff: number, n: number, o: SpanOptions): void {
  const opacity = o.opacity;
  if (opacity <= 0) return;
  const mask = o.mask;
  const mOff = o.maskOffset ?? 0;
  const fn = SEPARABLE[mode];
  const isNormal = mode === 'normal' || mode === 'passThrough';
  const isDissolve = mode === 'dissolve';
  const width = o.width ?? n;
  for (let i = 0; i < n; i++) {
    const s = sOff + i * 4;
    let as = src[s + 3] * opacity;
    if (mask) as *= mask[mOff + i];
    if (as <= 0) continue;
    if (isDissolve) {
      const px = (o.x0 ?? 0) + (i % width);
      const py = (o.y0 ?? 0) + Math.floor(i / width);
      if (dissolveNoise(px, py) >= as) continue;
      as = 1;
    }
    const d = dOff + i * 4;
    const ab = dst[d + 3];
    const sr = src[s], sg = src[s + 1], sb = src[s + 2];
    if (isNormal || isDissolve || ab <= 0) {
      const k = 1 - as;
      dst[d] = sr * as + dst[d] * k;
      dst[d + 1] = sg * as + dst[d + 1] * k;
      dst[d + 2] = sb * as + dst[d + 2] * k;
      dst[d + 3] = as + ab * k;
      continue;
    }
    const inv = 1 / ab;
    const br = dst[d] * inv, bg = dst[d + 1] * inv, bb = dst[d + 2] * inv;
    let rr: number, rg: number, rb: number;
    if (o.hardMixFill !== undefined && mode === 'hardMix') {
      const f = o.hardMixFill;
      rr = hardMixFill(br, sr, f); rg = hardMixFill(bg, sg, f); rb = hardMixFill(bb, sb, f);
    } else if (o.hdr && mode === 'linearDodge') {
      rr = br + sr; rg = bg + sg; rb = bb + sb;
    } else if (o.hdr && mode === 'divide') {
      rr = sr > 0 ? br / sr : br > 0 ? 1 : 0; rg = sg > 0 ? bg / sg : bg > 0 ? 1 : 0; rb = sb > 0 ? bb / sb : bb > 0 ? 1 : 0;
    } else if (fn) {
      rr = fn(br, sr); rg = fn(bg, sg); rb = fn(bb, sb);
    } else {
      blendNonSeparable(mode, br, bg, bb, sr, sg, sb, outRGB);
      rr = outRGB[0]; rg = outRGB[1]; rb = outRGB[2];
    }
    const k1 = as * (1 - ab);
    const k2 = as * ab;
    const k3 = 1 - as;
    dst[d] = k1 * sr + k2 * rr + k3 * dst[d];
    dst[d + 1] = k1 * sg + k2 * rg + k3 * dst[d + 1];
    dst[d + 2] = k1 * sb + k2 * rb + k3 * dst[d + 2];
    dst[d + 3] = as + ab * k3;
  }
}

/**
 * Composites a premultiplied source span (e.g. an isolated group result) onto a premultiplied backdrop.
 */
export function compositePremultipliedSpan(mode: BlendMode, dst: Float32Array, dOff: number, src: Float32Array, sOff: number, n: number, o: SpanOptions): void {
  const opacity = o.opacity;
  const mask = o.mask;
  const mOff = o.maskOffset ?? 0;
  const tmp = scratchStraight(n);
  for (let i = 0; i < n; i++) {
    const s = sOff + i * 4;
    const a = src[s + 3];
    const t = i * 4;
    if (a <= 0) { tmp[t + 3] = 0; continue; }
    const inv = 1 / a;
    tmp[t] = src[s] * inv; tmp[t + 1] = src[s + 1] * inv; tmp[t + 2] = src[s + 2] * inv; tmp[t + 3] = a;
  }
  compositeSpan(mode, dst, dOff, tmp, 0, n, { opacity, mask, maskOffset: mOff, x0: o.x0, y0: o.y0, width: o.width });
}

let scratch = new Float32Array(0);
function scratchStraight(n: number): Float32Array {
  if (scratch.length < n * 4) scratch = new Float32Array(n * 4);
  return scratch;
}

/**
 * Applies adjusted colors (straight RGB, alpha ignored) onto a premultiplied backdrop.
 * Alpha is preserved: adjustment layers never add coverage.
 */
export function applyAdjustedSpan(mode: BlendMode, dst: Float32Array, adjusted: Float32Array, n: number, opacity: number, mask?: Float32Array): void {
  const fn = SEPARABLE[mode];
  const isNormal = mode === 'normal' || mode === 'passThrough' || mode === 'dissolve';
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    const ab = dst[d + 3];
    if (ab <= 0) continue;
    let k = opacity;
    if (mask) k *= mask[i];
    if (k <= 0) continue;
    const inv = 1 / ab;
    const br = dst[d] * inv, bg = dst[d + 1] * inv, bb = dst[d + 2] * inv;
    let rr = adjusted[d], rg = adjusted[d + 1], rb = adjusted[d + 2];
    if (!isNormal) {
      if (fn) { rr = fn(br, rr); rg = fn(bg, rg); rb = fn(bb, rb); }
      else { blendNonSeparable(mode, br, bg, bb, rr, rg, rb, outRGB); rr = outRGB[0]; rg = outRGB[1]; rb = outRGB[2]; }
    }
    dst[d] = (br + (rr - br) * k) * ab;
    dst[d + 1] = (bg + (rg - bg) * k) * ab;
    dst[d + 2] = (bb + (rb - bb) * k) * ab;
  }
}

/**
 * "Source-atop" compositing used inside clipping groups: the backdrop (base layer + clipped
 * layers so far) keeps its alpha; the source only shows where the base has coverage.
 */
export function compositeAtopSpan(mode: BlendMode, dst: Float32Array, dOff: number, src: Float32Array, sOff: number, n: number, o: SpanOptions): void {
  const opacity = o.opacity;
  if (opacity <= 0) return;
  const mask = o.mask;
  const mOff = o.maskOffset ?? 0;
  const fn = SEPARABLE[mode];
  const isNormal = mode === 'normal' || mode === 'passThrough' || mode === 'dissolve';
  for (let i = 0; i < n; i++) {
    const s = sOff + i * 4;
    let as = src[s + 3] * opacity;
    if (mask) as *= mask[mOff + i];
    if (as <= 0) continue;
    const d = dOff + i * 4;
    const ab = dst[d + 3];
    if (ab <= 0) continue;
    const inv = 1 / ab;
    const br = dst[d] * inv, bg = dst[d + 1] * inv, bb = dst[d + 2] * inv;
    const sr = src[s], sg = src[s + 1], sb = src[s + 2];
    let rr = sr, rg = sg, rb = sb;
    if (!isNormal) {
      if (o.hardMixFill !== undefined && mode === 'hardMix') { const f = o.hardMixFill; rr = hardMixFill(br, sr, f); rg = hardMixFill(bg, sg, f); rb = hardMixFill(bb, sb, f); }
      else if (o.hdr && mode === 'linearDodge') { rr = br + sr; rg = bg + sg; rb = bb + sb; }
      else if (fn) { rr = fn(br, sr); rg = fn(bg, sg); rb = fn(bb, sb); }
      else { blendNonSeparable(mode, br, bg, bb, sr, sg, sb, outRGB); rr = outRGB[0]; rg = outRGB[1]; rb = outRGB[2]; }
    }
    const k = 1 - as;
    dst[d] = as * ab * rr + k * dst[d];
    dst[d + 1] = as * ab * rg + k * dst[d + 1];
    dst[d + 2] = as * ab * rb + k * dst[d + 2];
  }
}

/** Straight-alpha single pixel blend used by painting tools (brush blend modes). */
export function blendStraightPixel(mode: BlendMode, dst: Float32Array, d: number, sr: number, sg: number, sb: number, as: number, lockAlpha: boolean): void {
  if (as <= 0) return;
  const ab = dst[d + 3];
  const br = dst[d], bg = dst[d + 1], bb = dst[d + 2];
  let rr = sr, rg = sg, rb = sb;
  if (mode !== 'normal' && ab > 0) {
    const fn = SEPARABLE[mode];
    if (fn) { rr = fn(br, sr); rg = fn(bg, sg); rb = fn(bb, sb); }
    else { blendNonSeparable(mode, br, bg, bb, sr, sg, sb, outRGB); rr = outRGB[0]; rg = outRGB[1]; rb = outRGB[2]; }
  }
  if (lockAlpha) {
    if (ab <= 0) return;
    dst[d] = br + (rr - br) * as;
    dst[d + 1] = bg + (rg - bg) * as;
    dst[d + 2] = bb + (rb - bb) * as;
    return;
  }
  // Premultiplied source-over on a straight pixel, with B() mixing where the backdrop exists.
  const ao = as + ab * (1 - as);
  if (ao <= 0) { dst[d + 3] = 0; return; }
  const k1 = as * (1 - ab), k2 = as * ab, k3 = (1 - as) * ab;
  dst[d] = (k1 * sr + k2 * rr + k3 * br) / ao;
  dst[d + 1] = (k1 * sg + k2 * rg + k3 * bg) / ao;
  dst[d + 2] = (k1 * sb + k2 * rb + k3 * bb) / ao;
  dst[d + 3] = ao;
}
