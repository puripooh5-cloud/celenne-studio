/**
 * Built-in CMYK output profile: "Celenne Coated CMYK" — a synthetic ICC v2 printer profile
 * approximating coated offset printing (FOGRA39-like), used when no CMYK profile is configured.
 *
 * Forward model (CMYK → Lab): Yule–Nielsen modified spectral-free Neugebauer with Demichel
 * weights over the 16 ink overprints (approximate coated-stock colorimetry), n = 2, plus a
 * mechanical dot gain of 12 % at 50 %. Colours are media-relative (paper = L* 100).
 * Inverse (Lab → CMYK): Gauss–Newton inversion with medium GCR black generation and a 300 %
 * total area coverage limit; out-of-gamut colours land on the nearest reproducible colour.
 *
 * The tables are written as lut16 (mft2) A2B0/A2B1/A2B2 and B2A0/B2A1/B2A2 tags, so LittleCMS
 * treats the profile like any vendor CMYK profile. It is an approximation: users who print
 * should load their printer's or press's profile (Preferences ▸ Color).
 */

type Lab = [number, number, number];
type XYZ = [number, number, number];

const D50: XYZ = [0.9642, 1, 0.8249];

function labToXyz([L, a, b]: Lab): XYZ {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const f = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29));
  return [f(fx) * D50[0], f(fy) * D50[1], f(fz) * D50[2]];
}

export function xyzToLab([X, Y, Z]: XYZ): Lab {
  const f = (t: number) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  const fx = f(X / D50[0]), fy = f(Y / D50[1]), fz = f(Z / D50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Neugebauer primaries (absolute Lab, D50): index bits C=1, M=2, Y=4, K=8.
const PRIMARY_LAB: Lab[] = [
  [95, 0, -2], // paper
  [55, -37, -50], // C
  [48, 74, -3], // M
  [24, 22, -46], // CM (blue)
  [89, -5, 93], // Y
  [50, -65, 27], // CY (green)
  [47, 68, 48], // MY (red)
  [23, 0, 0], // CMY
  [16, 0, 0], // K
  [12, -9, -14], // CK
  [11, 14, 1], // MK
  [7, 3, -6], // CMK
  [15, -1, 9], // YK
  [9, -9, 3], // CYK
  [8, 7, 4], // MYK
  [5, 0, 0], // CMYK
];
const N = 2; // Yule–Nielsen factor
const PAPER = labToXyz(PRIMARY_LAB[0]);
// Primaries in media-relative XYZ (paper → D50 white), raised to 1/n.
const PRIM = PRIMARY_LAB.map((lab) => labToXyz(lab).map((v, i) => Math.pow((v * D50[i]) / PAPER[i], 1 / N)) as XYZ);

const dotGain = (v: number) => v + 0.48 * v * (1 - v);

/** Media-relative Lab of a CMYK ink combination (0..1 each). */
export function cmykToLabModel(c: number, m: number, y: number, k: number): Lab {
  const a = [dotGain(c), dotGain(m), dotGain(y), dotGain(k)];
  let X = 0, Y = 0, Z = 0;
  for (let s = 0; s < 16; s++) {
    let w = 1;
    for (let i = 0; i < 4; i++) w *= s & (1 << i) ? a[i] : 1 - a[i];
    if (w === 0) continue;
    X += w * PRIM[s][0]; Y += w * PRIM[s][1]; Z += w * PRIM[s][2];
  }
  return xyzToLab([Math.pow(X, N), Math.pow(Y, N), Math.pow(Z, N)]);
}

const dE2 = (p: Lab, q: Lab) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Solves C, M, Y for a fixed K (damped Gauss–Newton, box-constrained). */
function solveCmy(target: Lab, k: number, start: [number, number, number]): [number, number, number] {
  const x = [...start] as [number, number, number];
  let cur = cmykToLabModel(x[0], x[1], x[2], k);
  let err = dE2(cur, target);
  let lambda = 1e-3;
  for (let it = 0; it < 40 && err > 1e-4; it++) {
    const h = 1e-4;
    const J: number[][] = [[], [], []]; // J[row = Lab component][col = ink]
    for (let j = 0; j < 3; j++) {
      const xp = [...x] as [number, number, number];
      xp[j] = x[j] + h > 1 ? x[j] - h : x[j] + h;
      const sgn = xp[j] > x[j] ? 1 : -1;
      const lp = cmykToLabModel(xp[0], xp[1], xp[2], k);
      for (let r = 0; r < 3; r++) J[r][j] = ((lp[r] - cur[r]) / h) * sgn;
    }
    const res = [target[0] - cur[0], target[1] - cur[1], target[2] - cur[2]];
    // (JᵀJ + λI) δ = Jᵀ r
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], g = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) for (let r = 0; r < 3; r++) A[i][j] += J[r][i] * J[r][j];
      for (let r = 0; r < 3; r++) g[i] += J[r][i] * res[r];
    }
    const tr = A[0][0] + A[1][1] + A[2][2];
    for (let i = 0; i < 3; i++) A[i][i] += lambda * (tr / 3 + 1e-6);
    const d = solve3(A, g);
    if (!d) break;
    const nx: [number, number, number] = [clamp01(x[0] + d[0]), clamp01(x[1] + d[1]), clamp01(x[2] + d[2])];
    const nl = cmykToLabModel(nx[0], nx[1], nx[2], k);
    const ne = dE2(nl, target);
    if (ne < err) { x[0] = nx[0]; x[1] = nx[1]; x[2] = nx[2]; cur = nl; err = ne; lambda = Math.max(1e-6, lambda * 0.3); }
    else { lambda *= 10; if (lambda > 1e6) break; }
  }
  return x;
}

function solve3(A: number[][], b: number[]): number[] | null {
  const [a, bb, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-18) return null;
  return [
    (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det,
  ];
}

/** Medium GCR: black replaces part of the grey component once it exceeds 25 %. */
function blackFor(grey: number): number {
  if (grey <= 0.25) return 0;
  return Math.min(1, Math.pow((grey - 0.25) / 0.75, 1.1) * 1.02);
}

const TAC = 3.0;

/** Media-relative Lab → CMYK (0..1) with GCR and the total ink limit. */
export function labToCmykModel(target: Lab): [number, number, number, number] {
  // CMY-only first, from a neutral guess.
  const g0 = clamp01(1 - target[0] / 100);
  const cmy = solveCmy(target, 0, [g0, g0, g0]);
  let k = blackFor(Math.min(cmy[0], cmy[1], cmy[2]));
  let x = k > 0 ? solveCmy(target, k, [Math.max(0, cmy[0] - k), Math.max(0, cmy[1] - k), Math.max(0, cmy[2] - k)]) : cmy;
  // Total area coverage: shift towards black until within the limit.
  for (let it = 0; it < 12 && x[0] + x[1] + x[2] + k > TAC; it++) {
    k = Math.min(1, k + 0.05);
    x = solveCmy(target, k, x);
    const over = x[0] + x[1] + x[2] + k - TAC;
    if (over > 0 && k >= 1) { const s = (TAC - k) / (x[0] + x[1] + x[2]); x = [x[0] * s, x[1] * s, x[2] * s]; break; }
  }
  return [x[0], x[1], x[2], k];
}

// ---------------------------------------------------------------------------------------------
// ICC encoding
// ---------------------------------------------------------------------------------------------
class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 255); }
  u16(v: number) { this.u8(v >> 8); this.u8(v); }
  u32(v: number) { this.u8(v >>> 24); this.u8(v >>> 16); this.u8(v >>> 8); this.u8(v); }
  s15(v: number) { this.u32(Math.round(v * 65536) | 0); }
  sig(s: string) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
}

/** lut16Type with identity matrix and 2-entry linear input/output tables. */
function lut16(inCh: number, outCh: number, grid: number, clut: Uint16Array): number[] {
  const w = new W();
  w.sig('mft2'); w.u32(0);
  w.u8(inCh); w.u8(outCh); w.u8(grid); w.u8(0);
  for (let i = 0; i < 9; i++) w.s15(i % 4 === 0 ? 1 : 0);
  w.u16(2); w.u16(2);
  for (let c = 0; c < inCh; c++) { w.u16(0); w.u16(65535); }
  for (const v of clut) w.u16(v);
  for (let c = 0; c < outCh; c++) { w.u16(0); w.u16(65535); }
  return w.b;
}

const encL = (L: number) => Math.round(Math.max(0, Math.min(65535, (L / 100) * 65280)));
const encAB = (a: number) => Math.round(Math.max(0, Math.min(65535, (a + 128) * 256)));

function tagDesc(text: string): number[] {
  const w = new W();
  w.sig('desc'); w.u32(0); w.u32(text.length + 1);
  for (const c of text) w.u8(c.charCodeAt(0));
  w.u8(0); w.u32(0); w.u32(0); w.u16(0); w.u8(0);
  for (let i = 0; i < 67; i++) w.u8(0);
  return w.b;
}
function tagText(text: string): number[] {
  const w = new W();
  w.sig('text'); w.u32(0);
  for (const c of text) w.u8(c.charCodeAt(0));
  w.u8(0);
  return w.b;
}
function tagXYZ(v: XYZ): number[] {
  const w = new W();
  w.sig('XYZ '); w.u32(0); w.s15(v[0]); w.s15(v[1]); w.s15(v[2]);
  return w.b;
}

export const CELENNE_CMYK_NAME = 'Celenne Coated CMYK (approximate)';

let cached: Uint8Array | null = null;

/** Builds the profile (≈ 0.3 s the first time; cached). */
export function celenneCmykProfile(): Uint8Array {
  if (cached) return cached;
  // A2B: CMYK → Lab, 11-point grid (first input channel varies slowest).
  const GA = 11;
  const a2b = new Uint16Array(GA ** 4 * 3);
  let o = 0;
  for (let c = 0; c < GA; c++) for (let m = 0; m < GA; m++) for (let y = 0; y < GA; y++) for (let k = 0; k < GA; k++) {
    const lab = cmykToLabModel(c / (GA - 1), m / (GA - 1), y / (GA - 1), k / (GA - 1));
    a2b[o++] = encL(lab[0]); a2b[o++] = encAB(lab[1]); a2b[o++] = encAB(lab[2]);
  }
  // B2A: Lab → CMYK, 17-point grid over the v2 16-bit Lab encoding.
  const GB = 17;
  const b2a = new Uint16Array(GB ** 3 * 4);
  o = 0;
  for (let i = 0; i < GB; i++) for (let j = 0; j < GB; j++) for (let l = 0; l < GB; l++) {
    const u = (v: number) => (v / (GB - 1)) * 65535;
    const L = Math.min(100, (u(i) / 65280) * 100), a = u(j) / 256 - 128, b = u(l) / 256 - 128;
    const cmyk = labToCmykModel([L, a, b]);
    for (const v of cmyk) b2a[o++] = Math.round(clamp01(v) * 65535);
  }
  const A = lut16(4, 3, GA, a2b), B = lut16(3, 4, GB, b2a);
  const tags: [string, number[]][] = [
    ['desc', tagDesc(CELENNE_CMYK_NAME)],
    ['cprt', tagText('Generated by Celenne Studio. No copyright, use freely.')],
    ['wtpt', tagXYZ(PAPER)],
    ['A2B0', A], ['A2B1', A], ['A2B2', A],
    ['B2A0', B], ['B2A1', B], ['B2A2', B],
  ];
  // Header + tag table (shared data for identical tags).
  const headerSize = 128, tableSize = 4 + tags.length * 12;
  let offset = headerSize + tableSize;
  const placed: { sig: string; off: number; data: number[] }[] = [];
  const seen = new Map<number[], number>();
  for (const [sig, data] of tags) {
    if (seen.has(data)) { placed.push({ sig, off: seen.get(data)!, data }); continue; }
    while (offset % 4) offset++;
    placed.push({ sig, off: offset, data });
    seen.set(data, offset);
    offset += data.length;
  }
  while (offset % 4) offset++;
  const out = new Uint8Array(offset);
  const dv = new DataView(out.buffer);
  const str = (s: string, at: number) => out.set([...s].map((ch) => ch.charCodeAt(0)), at);
  dv.setUint32(0, offset);
  str('lcms', 4);
  out[8] = 2; out[9] = 0x10;
  str('prtr', 12); str('CMYK', 16); str('Lab ', 20);
  dv.setUint16(24, 2026); dv.setUint16(26, 1); dv.setUint16(28, 1);
  str('acsp', 36); str('MSFT', 40);
  dv.setInt32(68, Math.round(D50[0] * 65536)); dv.setInt32(72, 65536); dv.setInt32(76, Math.round(D50[2] * 65536));
  str('LUMN', 80);
  dv.setUint32(128, tags.length);
  placed.forEach((p, i) => {
    str(p.sig, 132 + i * 12);
    dv.setUint32(136 + i * 12, p.off);
    dv.setUint32(140 + i * 12, p.data.length);
  });
  for (const p of placed) out.set(p.data, p.off);
  cached = out;
  return out;
}
