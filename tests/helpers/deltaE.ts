/** Colour differences for tests: 16-bit ProPhoto RGB (gamma 1.8, D50) → CIELAB → ΔE2000. */
const M = [[0.7976749, 0.1351917, 0.0313534], [0.2880402, 0.7118741, 0.0000857], [0, 0, 0.82521]];
const W50 = [0.9642, 1, 0.8249];
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);

export function proPhoto16ToLab(rgb: number[]): [number, number, number] {
  const l = rgb.map((v) => Math.pow(Math.max(0, v / 65535), 1.8));
  const X = [0, 1, 2].map((i) => M[i][0] * l[0] + M[i][1] * l[1] + M[i][2] * l[2]);
  const fx = f(X[0] / W50[0]), fy = f(X[1] / W50[1]), fz = f(X[2] / W50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE2000([L1, a1, b1]: number[], [L2, a2, b2]: number[]): number {
  const d = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G), C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1 = (Math.atan2(b1, a1p) / d + 360) % 360, h2 = (Math.atan2(b2, a2p) / d + 360) % 360;
  const dL = L2 - L1, dC = C2p - C1p;
  let dh = h2 - h1;
  if (C1p * C2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh * d) / 2);
  const Lb = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hb = (h1 + h2) / 2;
  if (C1p * C2p !== 0 && Math.abs(h1 - h2) > 180) hb += 180;
  const T = 1 - 0.17 * Math.cos((hb - 30) * d) + 0.24 * Math.cos(2 * hb * d) + 0.32 * Math.cos((3 * hb + 6) * d) - 0.2 * Math.cos((4 * hb - 63) * d);
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2), SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * d);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}
