/**
 * 2D affine matrices (canvas convention) and 3×3 homographies for perspective/distort.
 *   Affine [a, b, c, d, e, f]:  x' = a·x + c·y + e,  y' = b·x + d·y + f
 */
export type Affine = [number, number, number, number, number, number];
/** Row-major 3×3 homography. */
export type Homography = [number, number, number, number, number, number, number, number, number];
export interface Point {
  x: number;
  y: number;
}
/** Quad corners: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function identity(): Affine {
  return [1, 0, 0, 1, 0, 0];
}

/** Returns m1 · m2 (apply m2 first, then m1). */
export function multiply(m1: Affine, m2: Affine): Affine {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function invert(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return identity();
  const id = 1 / det;
  return [
    m[3] * id,
    -m[1] * id,
    -m[2] * id,
    m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id,
  ];
}

export function apply(m: Affine, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function translation(tx: number, ty: number): Affine {
  return [1, 0, 0, 1, tx, ty];
}

export function scaling(sx: number, sy: number): Affine {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotation(rad: number): Affine {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

export function isIdentity(m: Affine, eps = 1e-9): boolean {
  return Math.abs(m[0] - 1) < eps && Math.abs(m[1]) < eps && Math.abs(m[2]) < eps && Math.abs(m[3] - 1) < eps && Math.abs(m[4]) < eps && Math.abs(m[5]) < eps;
}

export function isTranslationOnly(m: Affine, eps = 1e-9): boolean {
  return Math.abs(m[0] - 1) < eps && Math.abs(m[1]) < eps && Math.abs(m[2]) < eps && Math.abs(m[3] - 1) < eps;
}

export interface Decomposed {
  tx: number;
  ty: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
}

/** Decomposes into translate · rotate · skewX · scale. */
export function decompose(m: Affine): Decomposed {
  const [a, b, c, d, e, f] = m;
  const scaleX = Math.hypot(a, b);
  const rot = Math.atan2(b, a);
  const det = a * d - b * c;
  const scaleY = scaleX === 0 ? 0 : det / scaleX;
  const skew = scaleX === 0 ? 0 : Math.atan2(a * c + b * d, scaleX * scaleX);
  return { tx: e, ty: f, rotation: rot, scaleX, scaleY, skewX: skew };
}

export function compose(p: Decomposed): Affine {
  let m = translation(p.tx, p.ty);
  m = multiply(m, rotation(p.rotation));
  m = multiply(m, [1, 0, Math.tan(p.skewX), 1, 0, 0]);
  m = multiply(m, scaling(p.scaleX, p.scaleY));
  return m;
}

export function affineToHomography(m: Affine): Homography {
  return [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];
}

export function applyH(h: Homography, x: number, y: number): Point {
  const w = h[6] * x + h[7] * y + h[8];
  const iw = Math.abs(w) < 1e-12 ? 1e12 : 1 / w;
  return { x: (h[0] * x + h[1] * y + h[2]) * iw, y: (h[3] * x + h[4] * y + h[5]) * iw };
}

export function invertH(h: Homography): Homography {
  const [a, b, c, d, e, f, g, hh, i] = h;
  const A = e * i - f * hh, B = -(d * i - f * g), C = d * hh - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const id = 1 / det;
  return [
    A * id, -(b * i - c * hh) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, -(a * f - c * d) * id,
    C * id, -(a * hh - b * g) * id, (a * e - b * d) * id,
  ];
}

export function multiplyH(p: Homography, q: Homography): Homography {
  const r = new Array(9).fill(0) as Homography;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += p[i * 3 + k] * q[k * 3 + j];
  return r;
}

/** Homography mapping the unit square (0,0)-(1,1) to the quad (TL, TR, BR, BL). */
export function squareToQuad(q: Quad): Homography {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}

/** Homography mapping source rectangle (0,0,w,h) onto the quad. */
export function rectToQuad(w: number, h: number, q: Quad): Homography {
  return multiplyH(squareToQuad(q), [1 / w, 0, 0, 0, 1 / h, 0, 0, 0, 1]);
}

export function quadFromRect(x: number, y: number, w: number, h: number): Quad {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

export function transformQuad(q: Quad, m: Affine): Quad {
  return q.map((p) => apply(m, p.x, p.y)) as Quad;
}

export function quadBounds(q: Quad): { x: number; y: number; w: number; h: number } {
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/** True when the quad is a parallelogram (so an affine transform suffices). */
export function isAffineQuad(q: Quad, eps = 1e-6): boolean {
  return Math.abs(q[0].x + q[2].x - q[1].x - q[3].x) < eps && Math.abs(q[0].y + q[2].y - q[1].y - q[3].y) < eps;
}

export function affineFromQuad(w: number, h: number, q: Quad): Affine {
  return [(q[1].x - q[0].x) / w, (q[1].y - q[0].y) / w, (q[3].x - q[0].x) / h, (q[3].y - q[0].y) / h, q[0].x, q[0].y];
}
