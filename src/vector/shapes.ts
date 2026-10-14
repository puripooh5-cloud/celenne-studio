/** Parametric shape → Bézier path generators and path editing utilities. */
import type { PathKnot, ShapeOrigin, SubPath, VectorPath } from './types';
import { knot } from './types';

const K = 0.5522847498307936; // 4/3·(√2−1): cubic approximation of a quarter circle

function sub(knots: PathKnot[], closed = true): SubPath {
  return { knots, closed, op: 'combine' };
}

export function rectPath(x: number, y: number, w: number, h: number, radii: [number, number, number, number] = [0, 0, 0, 0]): VectorPath {
  const max = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(max, r)));
  if (!tl && !tr && !br && !bl) return { fillRule: 'nonzero', subpaths: [sub([knot(x, y), knot(x + w, y), knot(x + w, y + h), knot(x, y + h)])] };
  const ks: PathKnot[] = [];
  const corner = (cx: number, cy: number, r: number, a0: number) => {
    // Arc from angle a0 to a0 + 90° around (cx, cy).
    if (r <= 0) { ks.push(knot(cx, cy)); return; }
    const p0 = { x: cx + Math.cos(a0) * r, y: cy + Math.sin(a0) * r };
    const p1 = { x: cx + Math.cos(a0 + Math.PI / 2) * r, y: cy + Math.sin(a0 + Math.PI / 2) * r };
    const t0 = { x: -Math.sin(a0), y: Math.cos(a0) }, t1 = { x: -Math.sin(a0 + Math.PI / 2), y: Math.cos(a0 + Math.PI / 2) };
    ks.push({ x: p0.x, y: p0.y, inX: p0.x, inY: p0.y, outX: p0.x + t0.x * r * K, outY: p0.y + t0.y * r * K, smooth: false });
    ks.push({ x: p1.x, y: p1.y, inX: p1.x - t1.x * r * K, inY: p1.y - t1.y * r * K, outX: p1.x, outY: p1.y, smooth: false });
  };
  corner(x + w - tr, y + tr, tr, -Math.PI / 2);
  corner(x + w - br, y + h - br, br, 0);
  corner(x + bl, y + h - bl, bl, Math.PI / 2);
  corner(x + tl, y + tl, tl, Math.PI);
  return { fillRule: 'nonzero', subpaths: [sub(ks.filter((k, i) => i === 0 || Math.hypot(k.x - ks[i - 1].x, k.y - ks[i - 1].y) > 1e-6))] };
}

export function ellipsePath(x: number, y: number, w: number, h: number): VectorPath {
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  const k = (px: number, py: number, dx: number, dy: number): PathKnot => ({ x: px, y: py, inX: px - dx, inY: py - dy, outX: px + dx, outY: py + dy, smooth: true });
  return {
    fillRule: 'nonzero',
    subpaths: [sub([k(cx, y, rx * K, 0), k(x + w, cy, 0, ry * K), k(cx, y + h, -rx * K, 0), k(x, cy, 0, -ry * K)])],
  };
}

export function polygonPath(cx: number, cy: number, r: number, sides: number, starRatio: number | null, rotation = -Math.PI / 2): VectorPath {
  const n = Math.max(3, Math.min(100, Math.round(sides)));
  const ks: PathKnot[] = [];
  const count = starRatio ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    const a = rotation + (i / count) * Math.PI * 2;
    const rr = starRatio && i % 2 ? r * starRatio : r;
    ks.push(knot(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
  }
  return { fillRule: 'nonzero', subpaths: [sub(ks)] };
}

export function linePath(x0: number, y0: number, x1: number, y1: number, weight: number): VectorPath {
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const nx = (-(y1 - y0) / len) * (weight / 2), ny = ((x1 - x0) / len) * (weight / 2);
  return { fillRule: 'nonzero', subpaths: [sub([knot(x0 + nx, y0 + ny), knot(x1 + nx, y1 + ny), knot(x1 - nx, y1 - ny), knot(x0 - nx, y0 - ny)])] };
}

/** Custom shape presets in a 100×100 unit box. */
const CUSTOM: Record<string, number[][]> = {
  arrow: [[0, 35], [60, 35], [60, 10], [100, 50], [60, 90], [60, 65], [0, 65]],
  star: [], // generated
  check: [[5, 55], [20, 40], [40, 60], [80, 15], [95, 30], [40, 90]],
  cross: [[35, 0], [65, 0], [65, 35], [100, 35], [100, 65], [65, 65], [65, 100], [35, 100], [35, 65], [0, 65], [0, 35], [35, 35]],
  speech: [[10, 10], [90, 10], [90, 65], [45, 65], [25, 90], [28, 65], [10, 65]],
  chevron: [[0, 0], [55, 0], [100, 50], [55, 100], [0, 100], [45, 50]],
};

export const CUSTOM_SHAPES = ['arrow', 'star', 'heart', 'check', 'cross', 'speech', 'chevron'];

export function customShapePath(name: string, x: number, y: number, w: number, h: number): VectorPath {
  if (name === 'star') return polygonPath(x + w / 2, y + h / 2, Math.min(w, h) / 2, 5, 0.45);
  if (name === 'heart') {
    const P = (px: number, py: number) => ({ x: x + (px / 100) * w, y: y + (py / 100) * h });
    const mk = (a: { x: number; y: number }, i: { x: number; y: number }, o: { x: number; y: number }): PathKnot => ({ x: a.x, y: a.y, inX: i.x, inY: i.y, outX: o.x, outY: o.y, smooth: false });
    return {
      fillRule: 'nonzero',
      subpaths: [sub([mk(P(50, 25), P(40, 0), P(60, 0)), mk(P(100, 30), P(100, 10), P(100, 55)), mk(P(50, 100), P(80, 75), P(20, 75)), mk(P(0, 30), P(0, 55), P(0, 10))])],
    };
  }
  const pts = CUSTOM[name] ?? CUSTOM.arrow;
  return { fillRule: 'nonzero', subpaths: [sub(pts.map(([px, py]) => knot(x + (px / 100) * w, y + (py / 100) * h)))] };
}

export function pathFromOrigin(o: ShapeOrigin): VectorPath {
  switch (o.kind) {
    case 'rectangle': return rectPath(o.x, o.y, o.w, o.h);
    case 'roundedRectangle': return rectPath(o.x, o.y, o.w, o.h, o.radii ?? [10, 10, 10, 10]);
    case 'ellipse': return ellipsePath(o.x, o.y, o.w, o.h);
    case 'polygon': return polygonPath(o.x + o.w / 2, o.y + o.h / 2, Math.min(o.w, o.h) / 2, o.sides ?? 5, null);
    case 'star': return polygonPath(o.x + o.w / 2, o.y + o.h / 2, Math.min(o.w, o.h) / 2, o.sides ?? 5, o.starRatio ?? 0.5);
    case 'line': return linePath(o.x, o.y, o.x + o.w, o.y + o.h, o.lineWidth ?? 3);
    default: return rectPath(o.x, o.y, o.w, o.h);
  }
}

// ---------------------------------------------------------------------------------------------
// Editing helpers
// ---------------------------------------------------------------------------------------------
export function bezierPoint(a: PathKnot, b: PathKnot, t: number): { x: number; y: number } {
  const mt = 1 - t;
  const c0 = mt * mt * mt, c1 = 3 * mt * mt * t, c2 = 3 * mt * t * t, c3 = t * t * t;
  return { x: c0 * a.x + c1 * a.outX + c2 * b.inX + c3 * b.x, y: c0 * a.y + c1 * a.outY + c2 * b.inY + c3 * b.y };
}

/** Splits segment a→b at t (de Casteljau); returns the new knot and updates handles of a and b. */
export function splitSegment(a: PathKnot, b: PathKnot, t: number): PathKnot {
  const lerp = (p: { x: number; y: number }, q: { x: number; y: number }) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const p0 = { x: a.x, y: a.y }, p1 = { x: a.outX, y: a.outY }, p2 = { x: b.inX, y: b.inY }, p3 = { x: b.x, y: b.y };
  const q0 = lerp(p0, p1), q1 = lerp(p1, p2), q2 = lerp(p2, p3);
  const r0 = lerp(q0, q1), r1 = lerp(q1, q2);
  const m = lerp(r0, r1);
  a.outX = q0.x; a.outY = q0.y;
  b.inX = q2.x; b.inY = q2.y;
  return { x: m.x, y: m.y, inX: r0.x, inY: r0.y, outX: r1.x, outY: r1.y, smooth: true };
}

/** Nearest segment to a point: returns sub-path index, segment start index and t. */
export function nearestSegment(path: VectorPath, x: number, y: number): { sp: number; i: number; t: number; d: number } | null {
  let best: { sp: number; i: number; t: number; d: number } | null = null;
  path.subpaths.forEach((s, spi) => {
    const n = s.closed ? s.knots.length : s.knots.length - 1;
    for (let i = 0; i < n; i++) {
      const a = s.knots[i], b = s.knots[(i + 1) % s.knots.length];
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        const p = bezierPoint(a, b, t);
        const d = Math.hypot(p.x - x, p.y - y);
        if (!best || d < best.d) best = { sp: spi, i, t, d };
      }
    }
  });
  return best;
}

/** Fits a smooth Bézier sub-path through points (Catmull-Rom → cubic). */
export function fitSmooth(points: { x: number; y: number }[], closed: boolean, tension = 1 / 6): SubPath {
  const n = points.length;
  const knots: PathKnot[] = points.map((p, i) => {
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const tx = (next.x - prev.x) * tension, ty = (next.y - prev.y) * tension;
    return { x: p.x, y: p.y, inX: p.x - tx, inY: p.y - ty, outX: p.x + tx, outY: p.y + ty, smooth: true };
  });
  return { knots, closed, op: 'combine' };
}
