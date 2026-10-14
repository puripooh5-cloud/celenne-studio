/**
 * Blur and morphology primitives over interleaved float buffers.
 * All functions operate in place unless documented otherwise.
 */

/** Separable Gaussian blur (exact kernel for σ ≤ 3, 3-pass box approximation above — visually equivalent there). */
export function gaussianBlur(buf: Float32Array, w: number, h: number, ch: number, sigma: number, shouldCancel?: () => boolean): void {
  if (sigma <= 0.05 || w <= 0 || h <= 0) return;
  if (sigma <= 3) {
    const kernel = gaussianKernel(sigma);
    convolveSeparable(buf, w, h, ch, kernel, shouldCancel);
    return;
  }
  const boxes = boxesForGauss(sigma, 3);
  for (const b of boxes) {
    boxBlur(buf, w, h, ch, (b - 1) / 2, shouldCancel);
    if (shouldCancel?.()) return;
  }
}

export function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

export function boxesForGauss(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

/** 1D convolution along rows then columns (clamped edges). */
export function convolveSeparable(buf: Float32Array, w: number, h: number, ch: number, k: Float32Array, shouldCancel?: () => boolean): void {
  const r = (k.length - 1) >> 1;
  const rowLen = w * ch;
  // Horizontal: a padded copy of each row (edge-clamped) keeps the inner loop branch-free.
  const padded = new Float32Array((w + 2 * r) * ch);
  for (let y = 0; y < h; y++) {
    const row = y * rowLen;
    padded.set(buf.subarray(row, row + rowLen), r * ch);
    for (let i = 0; i < r; i++)
      for (let c = 0; c < ch; c++) {
        padded[i * ch + c] = buf[row + c];
        padded[(w + r + i) * ch + c] = buf[row + (w - 1) * ch + c];
      }
    for (let x = 0; x < w; x++) {
      const base = x * ch;
      for (let c = 0; c < ch; c++) {
        let s = 0;
        for (let i = 0, o = base + c; i < k.length; i++, o += ch) s += padded[o] * k[i];
        buf[row + base + c] = s;
      }
    }
    if ((y & 63) === 0 && shouldCancel?.()) return;
  }
  // Vertical: accumulate whole rows (contiguous memory) instead of gathering strided columns.
  const src = buf.slice();
  const acc = new Float32Array(rowLen);
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    for (let i = -r; i <= r; i++) {
      const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
      const kv = k[i + r];
      const off = yy * rowLen;
      for (let j = 0; j < rowLen; j++) acc[j] += src[off + j] * kv;
    }
    buf.set(acc, y * rowLen);
    if ((y & 63) === 0 && shouldCancel?.()) return;
  }
}

/** Box blur with radius r (window 2r+1), separable, O(1) per pixel via running sums. */
export function boxBlur(buf: Float32Array, w: number, h: number, ch: number, r: number, shouldCancel?: () => boolean): void {
  if (r < 0.5) return;
  const ri = Math.round(r);
  const norm = 1 / (ri * 2 + 1);
  const line = new Float32Array(Math.max(w, h) * ch);
  const acc = new Float64Array(ch);
  for (let y = 0; y < h; y++) {
    const row = y * w * ch;
    line.set(buf.subarray(row, row + w * ch));
    for (let c = 0; c < ch; c++) {
      let s = 0;
      for (let i = -ri; i <= ri; i++) s += line[Math.min(w - 1, Math.max(0, i)) * ch + c];
      acc[c] = s;
    }
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        buf[row + x * ch + c] = acc[c] * norm;
        const add = Math.min(w - 1, x + ri + 1), sub = Math.max(0, x - ri);
        acc[c] += line[add * ch + c] - line[sub * ch + c];
      }
    }
    if ((y & 127) === 0 && shouldCancel?.()) return;
  }
  // Vertical: running sums over whole rows (contiguous) instead of strided column walks.
  const rowLen = w * ch;
  const src = buf.slice();
  const sum = new Float64Array(rowLen);
  for (let i = -ri; i <= ri; i++) {
    const off = Math.min(h - 1, Math.max(0, i)) * rowLen;
    for (let j = 0; j < rowLen; j++) sum[j] += src[off + j];
  }
  for (let y = 0; y < h; y++) {
    const row = y * rowLen;
    const addOff = Math.min(h - 1, y + ri + 1) * rowLen, subOff = Math.max(0, y - ri) * rowLen;
    for (let j = 0; j < rowLen; j++) {
      buf[row + j] = sum[j] * norm;
      sum[j] += src[addOff + j] - src[subOff + j];
    }
    if ((y & 127) === 0 && shouldCancel?.()) return;
  }
}

// ---------------------------------------------------------------------------------------------
// Euclidean distance transform (Felzenszwalb & Huttenlocher)
// ---------------------------------------------------------------------------------------------
const INF = 1e20;

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Distance (px) from every pixel to the nearest pixel where `inside(i)` is true. */
export function distanceTransform(w: number, h: number, inside: (i: number) => boolean): Float32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = inside(i) ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

/** Grows a coverage mask by `r` px (anti-aliased). */
export function dilateMask(mask: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return mask.slice();
  const d = distanceTransform(w, h, (i) => mask[i] >= 0.5);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(mask[i], clamp01(r + 0.5 - d[i]));
  return out;
}

/** Shrinks a coverage mask by `r` px (anti-aliased). */
export function erodeMask(mask: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return mask.slice();
  const d = distanceTransform(w, h, (i) => mask[i] < 0.5);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(mask[i], clamp01(d[i] - r + 0.5));
  return out;
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Square minimum/maximum filter (van Herk / Gil-Werman), per channel. */
export function minMaxFilter(buf: Float32Array, w: number, h: number, ch: number, r: number, max: boolean): void {
  if (r < 1) return;
  const size = r * 2 + 1;
  const op = max ? Math.max : Math.min;
  const pass = (len: number, get: (i: number) => number, set: (i: number, v: number) => void) => {
    const g = new Float32Array(len + size), hh = new Float32Array(len + size);
    const at = (i: number) => get(Math.min(len - 1, Math.max(0, i - r)));
    const total = len + size - 1;
    for (let i = 0; i < total; i++) g[i] = i % size === 0 ? at(i) : op(g[i - 1], at(i));
    for (let i = total - 1; i >= 0; i--) hh[i] = i === total - 1 || (i + 1) % size === 0 ? at(i) : op(hh[i + 1], at(i));
    for (let i = 0; i < len; i++) set(i, op(hh[i], g[i + size - 1]));
  };
  for (let c = 0; c < ch; c++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const tmp = new Float32Array(w);
      pass(w, (i) => buf[(row + i) * ch + c], (i, v) => (tmp[i] = v));
      for (let x = 0; x < w; x++) buf[(row + x) * ch + c] = tmp[x];
    }
    for (let x = 0; x < w; x++) {
      const tmp = new Float32Array(h);
      pass(h, (i) => buf[(i * w + x) * ch + c], (i, v) => (tmp[i] = v));
      for (let y = 0; y < h; y++) buf[(y * w + x) * ch + c] = tmp[y];
    }
  }
}

export function premultiply(buf: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) {
    const a = buf[i * 4 + 3];
    buf[i * 4] *= a; buf[i * 4 + 1] *= a; buf[i * 4 + 2] *= a;
  }
}

export function unpremultiply(buf: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) {
    const a = buf[i * 4 + 3];
    if (a > 1e-7) {
      const k = 1 / a;
      buf[i * 4] *= k; buf[i * 4 + 1] *= k; buf[i * 4 + 2] *= k;
    } else {
      buf[i * 4] = buf[i * 4 + 1] = buf[i * 4 + 2] = 0;
    }
  }
}

/**
 * Separable tent blur of a coverage mask (zero outside), radius r: weights (r − |k|) for
 * |k| < r — two running-sum box passes of width r with opposite rounding, so it stays O(n) for
 * any size. Photoshop's drop / inner shadows and "softer" glows blur exactly like this (measured,
 * within 0.5/255 for sizes 1–60; a size of 1 acts as 2).
 */
export function tentBlurMask(mask: Float32Array, w: number, h: number, r: number): Float32Array {
  const rr = Math.round(r);
  if (rr < 1) return mask.slice();
  const R = Math.max(2, rr);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const line = new Float32Array(Math.max(w, h) + 2 * R + 2);
  const pass = (src: Float32Array, dst: Float32Array, len: number, count: number, stride: number, step: number, left: number) => {
    for (let c = 0; c < count; c++) {
      const base = c * stride;
      // Padded copy (zeros outside), then a running sum of width R starting `left` before x.
      line.fill(0);
      for (let i = 0; i < len; i++) line[i + R] = src[base + i * step];
      let s = 0;
      for (let k = 0; k < R; k++) s += line[R - left + k];
      for (let i = 0; i < len; i++) {
        dst[base + i * step] = s / R;
        s += line[i + R - left + R] - line[i + R - left];
      }
    }
  };
  const lo = Math.floor((R - 1) / 2), hi = Math.ceil((R - 1) / 2);
  // Horizontal (rows), then vertical (columns); each axis gets both box passes.
  pass(mask, tmp, w, h, w, 1, lo);
  pass(tmp, out, w, h, w, 1, hi);
  pass(out, tmp, h, w, 1, w, lo);
  pass(tmp, out, h, w, 1, w, hi);
  return out;
}

/** 1D squared-distance transform that also records, for each q, the index of its nearest seed. */
function edt1dArg(f: Float64Array, n: number, d: Float64Array, arg: Int32Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
    arg[q] = v[k];
  }
}

/** For every pixel, the index of the nearest pixel where `seed(i)` holds (Euclidean; −1 if none). */
export function nearestSeed(w: number, h: number, seed: (i: number) => boolean): Int32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n), arg = new Int32Array(n);
  const colD = new Float64Array(w * h), colY = new Int32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = seed(y * w + x) ? 0 : INF;
    edt1dArg(f, h, d, arg, v, z);
    for (let y = 0; y < h; y++) { colD[y * w + x] = d[y]; colY[y * w + x] = arg[y]; }
  }
  const out = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = colD[y * w + x];
    edt1dArg(f, w, d, arg, v, z);
    for (let x = 0; x < w; x++) {
      const xc = arg[x];
      out[y * w + x] = d[x] >= INF / 2 ? -1 : colY[y * w + xc] * w + xc;
    }
  }
  return out;
}

/**
 * Signed distance (px) from each pixel centre to the edge of an anti-aliased coverage mask:
 * positive outside, negative inside. A pixel with coverage a has the edge (a − 0.5) beyond its
 * centre, so straight and curved anti-aliased edges keep their sub-pixel position (what
 * Photoshop's strokes and spreads follow).
 */
export function edgeDistance(mask: Float32Array, w: number, h: number): Float32Array {
  const toIn = nearestSeed(w, h, (i) => mask[i] >= 0.5);
  const toOut = nearestSeed(w, h, (i) => mask[i] < 0.5);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = mask[i], x = i % w, y = (i - x) / w;
    const dist = (j: number) => { const jx = j % w, jy = (j - jx) / w; return Math.hypot(jx - x, jy - y); };
    if (a < 0.5) {
      let d = a > 0 ? 0.5 - a : INF;
      const q = toIn[i];
      if (q >= 0) d = Math.min(d, dist(q) - (mask[q] - 0.5));
      out[i] = q < 0 && a <= 0 ? 1e9 : d;
    } else {
      let d = a < 1 ? a - 0.5 : INF;
      const q = toOut[i];
      if (q >= 0) d = Math.min(d, dist(q) - (0.5 - mask[q]));
      out[i] = -(q < 0 && a >= 1 ? 1e9 : d);
    }
  }
  return out;
}
