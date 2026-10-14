/**
 * Indexed Color and Bitmap modes: palette generation, colour quantization with dithering, and
 * 1-bit conversion (threshold, pattern, diffusion, halftone screen).
 *
 * Pixels stay stored as 8-bit RGBA; in these modes every pixel is kept to a palette colour (or
 * pure black / white), so the document *is* an indexed / 1-bit image and is written to PSD as
 * such.
 */

export type PaletteMethod = 'exact' | 'uniform' | 'web' | 'adaptive' | 'perceptual' | 'grayscale' | 'blackWhite' | 'custom';
export type IndexedDither = 'none' | 'diffusion' | 'pattern' | 'noise';
export type ForcedColors = 'none' | 'blackWhite' | 'primaries' | 'web';

export interface IndexedOptions {
  palette: PaletteMethod;
  /** Number of colours (2..256) for uniform / adaptive / perceptual. */
  colors: number;
  forced: ForcedColors;
  /** Keep transparency (one palette slot); otherwise transparent areas are matted. */
  transparency: boolean;
  matte: [number, number, number];
  dither: IndexedDither;
  /** Dither amount 0..1. */
  amount: number;
  /** For 'custom': the palette to use. */
  custom?: number[];
}

export const DEFAULT_INDEXED: IndexedOptions = { palette: 'perceptual', colors: 256, forced: 'blackWhite', transparency: true, matte: [255, 255, 255], dither: 'diffusion', amount: 0.75 };

/** Unique opaque colours (flat RGB), or null when there are more than `max`. */
export function exactColors(rgba: Uint8ClampedArray, max = 256): number[] | null {
  const seen = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    seen.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
    if (seen.size > max) return null;
  }
  return [...seen].sort((a, b) => a - b).flatMap((c) => [c >> 16, (c >> 8) & 255, c & 255]);
}

function webPalette(): number[] {
  const out: number[] = [];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) out.push(r * 51, g * 51, b * 51);
  return out;
}

function uniformPalette(n: number): number[] {
  // Largest levels³ ≤ n (at least 2 levels).
  const levels = Math.max(2, Math.floor(Math.cbrt(n) + 1e-9));
  const out: number[] = [];
  for (let r = 0; r < levels; r++) for (let g = 0; g < levels; g++) for (let b = 0; b < levels; b++) out.push(Math.round((r * 255) / (levels - 1)), Math.round((g * 255) / (levels - 1)), Math.round((b * 255) / (levels - 1)));
  return out;
}

/** Median cut over a 5-bit histogram; `weights` scales channel ranges (perceptual = luma weights). */
function medianCut(rgba: Uint8ClampedArray, n: number, weights: [number, number, number]): number[] {
  const hist = new Uint32Array(32768);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    hist[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)]++;
  }
  const colors: number[] = [];
  for (let k = 0; k < 32768; k++) if (hist[k]) colors.push(k);
  if (!colors.length) return [0, 0, 0];
  type Box = { items: number[]; score: number; axis: number };
  const ch = (k: number, a: number) => (a === 0 ? k >> 10 : a === 1 ? (k >> 5) & 31 : k & 31);
  const makeBox = (items: number[]): Box => {
    let best = 0, axis = 0;
    for (let a = 0; a < 3; a++) {
      let lo = 31, hi = 0;
      for (const k of items) { const v = ch(k, a); if (v < lo) lo = v; if (v > hi) hi = v; }
      const r = (hi - lo) * weights[a];
      if (r > best) { best = r; axis = a; }
    }
    let count = 0;
    for (const k of items) count += hist[k];
    return { items, axis, score: items.length > 1 ? best * Math.sqrt(count) : -1 };
  };
  const boxes: Box[] = [makeBox(colors)];
  while (boxes.length < n) {
    let bi = -1, bs = 0;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].score > bs) { bs = boxes[i].score; bi = i; }
    if (bi < 0) break;
    const b = boxes[bi];
    const sorted = b.items.slice().sort((x, y) => ch(x, b.axis) - ch(y, b.axis));
    let total = 0;
    for (const k of sorted) total += hist[k];
    let acc = 0, cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += hist[sorted[i]];
      if (acc >= total / 2) { cut = i + 1; break; }
      cut = i + 1;
    }
    boxes.splice(bi, 1, makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut)));
  }
  // Box colour: count-weighted mean of the exact pixels (second pass for precision).
  const boxOf = new Int32Array(32768).fill(-1);
  boxes.forEach((b, i) => { for (const k of b.items) boxOf[k] = i; });
  const sum = new Float64Array(boxes.length * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const bi = boxOf[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)];
    sum[bi * 4] += rgba[i]; sum[bi * 4 + 1] += rgba[i + 1]; sum[bi * 4 + 2] += rgba[i + 2]; sum[bi * 4 + 3]++;
  }
  const out: number[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const c = sum[i * 4 + 3] || 1;
    out.push(Math.round(sum[i * 4] / c), Math.round(sum[i * 4 + 1] / c), Math.round(sum[i * 4 + 2] / c));
  }
  return out;
}

function forcedColors(f: ForcedColors): number[] {
  if (f === 'blackWhite') return [0, 0, 0, 255, 255, 255];
  if (f === 'primaries') return [0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0];
  if (f === 'web') return webPalette();
  return [];
}

/** Builds the palette (flat RGB, ≤ 256 colours; one slot is reserved for transparency when asked). */
export function buildPalette(rgba: Uint8ClampedArray, o: IndexedOptions): number[] {
  const slots = Math.max(2, Math.min(256, Math.round(o.colors))) - (o.transparency ? 1 : 0);
  let base: number[];
  switch (o.palette) {
    case 'exact': base = exactColors(rgba, 256 - (o.transparency ? 1 : 0)) ?? medianCut(rgba, slots, [1, 1, 1]); break;
    case 'web': base = webPalette(); break;
    case 'uniform': base = uniformPalette(slots); break;
    case 'grayscale': base = Array.from({ length: slots }, (_, i) => Math.round((i * 255) / (slots - 1))).flatMap((v) => [v, v, v]); break;
    case 'blackWhite': base = [0, 0, 0, 255, 255, 255]; break;
    case 'custom': base = (o.custom ?? [0, 0, 0, 255, 255, 255]).slice(0, 768); break;
    case 'adaptive': base = medianCut(rgba, slots, [1, 1, 1]); break;
    default: base = medianCut(rgba, slots, [0.299 * 3, 0.587 * 3, 0.114 * 3]);
  }
  // Forced colours replace the least important (last) entries, without duplicates.
  const forced = o.palette === 'exact' || o.palette === 'custom' || o.palette === 'web' ? [] : forcedColors(o.forced);
  const key = (p: number[], i: number) => (p[i] << 16) | (p[i + 1] << 8) | p[i + 2];
  const have = new Set<number>();
  for (let i = 0; i < base.length; i += 3) have.add(key(base, i));
  const extra: number[] = [];
  for (let i = 0; i < forced.length; i += 3) if (!have.has(key(forced, i))) extra.push(forced[i], forced[i + 1], forced[i + 2]);
  const room = Math.max(0, slots * 3 - extra.length);
  const out = [...base.slice(0, Math.min(base.length, room)), ...extra].slice(0, slots * 3);
  return out.length >= 3 ? out : [0, 0, 0];
}

/** Nearest palette entry with a 6-bit-per-channel cache. */
export class NearestPalette {
  private cache = new Int16Array(1 << 18).fill(-1);
  readonly n: number;
  constructor(readonly pal: number[]) {
    this.n = Math.floor(pal.length / 3);
  }
  exact(r: number, g: number, b: number): number {
    let best = 0, bd = Infinity;
    const p = this.pal;
    for (let i = 0; i < this.n; i++) {
      const dr = p[i * 3] - r, dg = p[i * 3 + 1] - g, db = p[i * 3 + 2] - b;
      // Luma-weighted distance.
      const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
      if (d < bd) { bd = d; best = i; if (!d) break; }
    }
    return best;
  }
  index(r: number, g: number, b: number): number {
    const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let v = this.cache[k];
    if (v < 0) {
      v = this.exact(r, g, b);
      // Only cache when the entry is unambiguous for the whole 4×4×4 cell.
      if (this.exact(r | 3, g | 3, b | 3) === v && this.exact(r & ~3, g & ~3, b & ~3) === v) this.cache[k] = v;
    }
    return v;
  }
}

const BAYER8 = (() => {
  const m = [[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22], [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25], [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]];
  return m.map((r) => r.map((v) => (v + 0.5) / 64 - 0.5));
})();

/**
 * Maps pixels to the palette in place. Transparent pixels (alpha < 128) become fully
 * transparent when `transparency` is set; otherwise everything is matted and opaque.
 */
export function quantize(rgba: Uint8ClampedArray, w: number, h: number, pal: number[], o: Pick<IndexedOptions, 'dither' | 'amount' | 'transparency' | 'matte'>): void {
  const np = new NearestPalette(pal);
  const n = w * h;
  // Matte partially transparent pixels.
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    if (a === 255) continue;
    if (o.transparency && a < 128) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = rgba[i * 4 + 3] = 0; continue; }
    const k = a / 255;
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(rgba[i * 4 + c] * k + o.matte[c] * (1 - k));
    rgba[i * 4 + 3] = 255;
  }
  const spread = 255 / Math.max(1, Math.cbrt(np.n) - 1);
  const amt = Math.max(0, Math.min(1, o.amount));
  if (o.dither === 'diffusion') {
    const err = new Float32Array((w + 2) * 2 * 3);
    for (let y = 0; y < h; y++) {
      const cur = (y & 1) * (w + 2) * 3, nxt = ((y + 1) & 1) * (w + 2) * 3;
      err.fill(0, nxt, nxt + (w + 2) * 3);
      const ltr = (y & 1) === 0;
      for (let s = 0; s < w; s++) {
        const x = ltr ? s : w - 1 - s;
        const i = (y * w + x) * 4;
        if (rgba[i + 3] === 0) continue;
        const e = cur + (x + 1) * 3;
        const r = clamp8(rgba[i] + err[e]), g = clamp8(rgba[i + 1] + err[e + 1]), b = clamp8(rgba[i + 2] + err[e + 2]);
        const k = np.index(r, g, b) * 3;
        rgba[i] = pal[k]; rgba[i + 1] = pal[k + 1]; rgba[i + 2] = pal[k + 2];
        const er = (r - pal[k]) * amt, eg = (g - pal[k + 1]) * amt, eb = (b - pal[k + 2]) * amt;
        const dx = ltr ? 3 : -3;
        // Floyd–Steinberg (serpentine).
        for (const [off, wgt] of [[e + dx, 7 / 16], [nxt + (x + 1) * 3 - dx, 3 / 16], [nxt + (x + 1) * 3, 5 / 16], [nxt + (x + 1) * 3 + dx, 1 / 16]] as [number, number][]) {
          err[off] += er * wgt; err[off + 1] += eg * wgt; err[off + 2] += eb * wgt;
        }
      }
    }
    return;
  }
  let seed = 0x9e3779b9;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3] === 0) continue;
      let off = 0;
      if (o.dither === 'pattern') off = BAYER8[y & 7][x & 7] * spread * amt;
      else if (o.dither === 'noise') { seed = (seed * 1664525 + 1013904223) >>> 0; off = (seed / 4294967296 - 0.5) * spread * amt; }
      const k = np.index(clamp8(rgba[i] + off), clamp8(rgba[i + 1] + off), clamp8(rgba[i + 2] + off)) * 3;
      rgba[i] = pal[k]; rgba[i + 1] = pal[k + 1]; rgba[i + 2] = pal[k + 2];
    }
  }
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// ---------------------------------------------------------------------------------------------
// Bitmap (1-bit)
// ---------------------------------------------------------------------------------------------
export type BitmapMethod = 'threshold' | 'pattern' | 'diffusion' | 'halftone';
export type HalftoneShape = 'round' | 'ellipse' | 'line' | 'square' | 'cross' | 'diamond';

export interface BitmapOptions {
  method: BitmapMethod;
  /** Halftone screen: lines per inch, angle in degrees, spot shape. */
  frequency: number;
  angle: number;
  shape: HalftoneShape;
}

export const DEFAULT_BITMAP: BitmapOptions = { method: 'diffusion', frequency: 53, angle: 45, shape: 'round' };

/** Luminance (0..255, over white) → 1-bit, returned as RGBA with 0 / 255 values. */
export function toBitmap(rgba: Uint8ClampedArray, w: number, h: number, o: BitmapOptions, resolution: number): void {
  const n = w * h;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const l = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    g[i] = (l * a + 255 * (1 - a)) / 255;
  }
  const out = new Uint8Array(n); // 1 = white
  if (o.method === 'threshold') for (let i = 0; i < n; i++) out[i] = g[i] >= 0.5 ? 1 : 0;
  else if (o.method === 'pattern') for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = g[y * w + x] > BAYER8[y & 7][x & 7] + 0.5 ? 1 : 0;
  else if (o.method === 'diffusion') {
    for (let y = 0; y < h; y++) {
      const ltr = (y & 1) === 0;
      for (let s = 0; s < w; s++) {
        const x = ltr ? s : w - 1 - s;
        const i = y * w + x;
        const v = g[i];
        const b = v >= 0.5 ? 1 : 0;
        out[i] = b;
        const e = v - b;
        const dx = ltr ? 1 : -1;
        if (x + dx >= 0 && x + dx < w) g[i + dx] += (e * 7) / 16;
        if (y + 1 < h) {
          if (x - dx >= 0 && x - dx < w) g[i + w - dx] += (e * 3) / 16;
          g[i + w] += (e * 5) / 16;
          if (x + dx >= 0 && x + dx < w) g[i + w + dx] += e / 16;
        }
      }
    }
  } else {
    const cell = Math.max(2, resolution / Math.max(1, o.frequency));
    const t = (o.angle * Math.PI) / 180, ct = Math.cos(t), st = Math.sin(t);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x * ct + y * st) / cell, v = (-x * st + y * ct) / cell;
        const px = (u - Math.floor(u)) * 2 - 1, py = (v - Math.floor(v)) * 2 - 1;
        const spot = spotFunction(o.shape, px, py);
        const dark = 1 - g[y * w + x];
        out[y * w + x] = spot > 1 - 2 * dark ? 0 : 1;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const v = out[i] ? 255 : 0;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
}

/** Halftone spot functions over a cell in [-1, 1]², returning -1..1 (higher = inks first). */
function spotFunction(shape: HalftoneShape, x: number, y: number): number {
  const ax = Math.abs(x), ay = Math.abs(y);
  switch (shape) {
    case 'ellipse': return 1 - (x * x * 0.8 + y * y * 1.25);
    case 'line': return 1 - 2 * ay;
    case 'square': return 1 - 2 * Math.max(ax, ay);
    case 'cross': return 1 - 2 * Math.min(ax, ay);
    case 'diamond': return 1 - (ax + ay);
    default: return 1 - (x * x + y * y);
  }
}

/** Snaps pixels to pure black / white (Bitmap-mode editing). Returns true when anything changed. */
export function snapBitmap(rgba: Uint8ClampedArray): boolean {
  let changed = false;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    const l = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 255 * (1 - a);
    const v = l >= 127.5 ? 255 : 0;
    if (rgba[i] !== v || rgba[i + 1] !== v || rgba[i + 2] !== v || rgba[i + 3] !== 255) {
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
      changed = true;
    }
  }
  return changed;
}

/** Snaps pixels to the palette without dithering (Indexed-mode editing). Returns true when anything changed. */
export function snapIndexed(rgba: Uint8ClampedArray, np: NearestPalette, transparency: boolean): boolean {
  let changed = false;
  const p = np.pal;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (transparency && a < 128) {
      if (a || rgba[i] || rgba[i + 1] || rgba[i + 2]) { rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0; changed = true; }
      continue;
    }
    let r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (a < 255) { const k = a / 255; r = Math.round(r * k + 255 * (1 - k)); g = Math.round(g * k + 255 * (1 - k)); b = Math.round(b * k + 255 * (1 - k)); }
    const k = np.index(r, g, b) * 3;
    if (rgba[i] !== p[k] || rgba[i + 1] !== p[k + 1] || rgba[i + 2] !== p[k + 2] || a !== 255) {
      rgba[i] = p[k]; rgba[i + 1] = p[k + 1]; rgba[i + 2] = p[k + 2]; rgba[i + 3] = 255;
      changed = true;
    }
  }
  return changed;
}
