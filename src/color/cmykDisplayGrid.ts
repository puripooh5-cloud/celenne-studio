/**
 * CMYK → display RGB as a 33⁴ grid of exact (float) profile-transform values, evaluated by
 * tetrahedral interpolation over C, M, Y and linear interpolation over K — the scheme LittleCMS
 * uses for CMYK device links. The CPU display path and the GPU display path evaluate this same
 * grid, so GPU- and CPU-rendered tiles of a CMYK document match. Against the exact transform it is
 * within 6/255 (mean 0.04/255) on the built-in profile — LittleCMS's optimised 8-bit transform,
 * used before, was off by up to 14/255 (mean 0.15/255).
 */
export const CMYK_GRID_N = 33;

/** Grid of RGB (0..1) at ink nodes i·255/(N−1), C fastest, then M, Y, K. */
export function buildCmykGrid(exact: (inkPct: Float32Array, n: number) => Float32Array): Float32Array {
  const n = CMYK_GRID_N;
  const count = n ** 4;
  const pct = new Float32Array(count * 4);
  let i = 0;
  const node = (q: number) => (q * 100) / (n - 1);
  for (let k = 0; k < n; k++) for (let y = 0; y < n; y++) for (let m = 0; m < n; m++) for (let c = 0; c < n; c++) {
    pct[i * 4] = node(c); pct[i * 4 + 1] = node(m); pct[i * 4 + 2] = node(y); pct[i * 4 + 3] = node(k);
    i++;
  }
  const rgb = exact(pct, count);
  for (let j = 0; j < rgb.length; j++) rgb[j] = Math.min(1, Math.max(0, rgb[j]));
  return rgb;
}

/** Evaluates the grid for ink bytes (C M Y K per pixel) → RGB8 (3 per pixel). */
export function evalCmykGrid(grid: Float32Array, ink: Uint8Array, count: number): Uint8Array {
  const n = CMYK_GRID_N;
  const out = new Uint8Array(count * 3);
  const s = (n - 1) / 255;
  const at = (c: number, m: number, y: number, k: number) => (((k * n + y) * n + m) * n + c) * 3;
  const v = [0, 0, 0], a = [0, 0, 0];
  const tetra = (c0: number, m0: number, y0: number, k: number, tx: number, ty: number, tz: number, res: number[]) => {
    const p000 = at(c0, m0, y0, k), p111 = at(c0 + 1, m0 + 1, y0 + 1, k);
    let p1: number, p2: number, w0: number, w1: number, w2: number;
    if (tx >= ty) {
      if (ty >= tz) { p1 = at(c0 + 1, m0, y0, k); p2 = at(c0 + 1, m0 + 1, y0, k); w0 = tx; w1 = ty; w2 = tz; }
      else if (tx >= tz) { p1 = at(c0 + 1, m0, y0, k); p2 = at(c0 + 1, m0, y0 + 1, k); w0 = tx; w1 = tz; w2 = ty; }
      else { p1 = at(c0, m0, y0 + 1, k); p2 = at(c0 + 1, m0, y0 + 1, k); w0 = tz; w1 = tx; w2 = ty; }
    } else if (tz >= ty) { p1 = at(c0, m0, y0 + 1, k); p2 = at(c0, m0 + 1, y0 + 1, k); w0 = tz; w1 = ty; w2 = tx; }
    else if (tz >= tx) { p1 = at(c0, m0 + 1, y0, k); p2 = at(c0, m0 + 1, y0 + 1, k); w0 = ty; w1 = tz; w2 = tx; }
    else { p1 = at(c0, m0 + 1, y0, k); p2 = at(c0 + 1, m0 + 1, y0, k); w0 = ty; w1 = tx; w2 = tz; }
    for (let ch = 0; ch < 3; ch++) {
      const g000 = grid[p000 + ch], g1 = grid[p1 + ch], g2 = grid[p2 + ch], g111 = grid[p111 + ch];
      res[ch] = g000 + w0 * (g1 - g000) + w1 * (g2 - g1) + w2 * (g111 - g2);
    }
  };
  for (let i = 0; i < count; i++) {
    const fc = ink[i * 4] * s, fm = ink[i * 4 + 1] * s, fy = ink[i * 4 + 2] * s, fk = ink[i * 4 + 3] * s;
    const c0 = Math.min(n - 2, Math.floor(fc)), m0 = Math.min(n - 2, Math.floor(fm)), y0 = Math.min(n - 2, Math.floor(fy)), k0 = Math.min(n - 2, Math.floor(fk));
    const tx = fc - c0, ty = fm - m0, tz = fy - y0, tk = fk - k0;
    tetra(c0, m0, y0, k0, tx, ty, tz, v);
    tetra(c0, m0, y0, k0 + 1, tx, ty, tz, a);
    for (let ch = 0; ch < 3; ch++) out[i * 3 + ch] = Math.floor((v[ch] + (a[ch] - v[ch]) * tk) * 255 + 0.5);
  }
  return out;
}
