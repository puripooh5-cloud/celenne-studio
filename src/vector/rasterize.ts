/**
 * Anti-aliased polygon / Bézier path rasterizer producing float coverage (0..1).
 *
 * Scanline algorithm with 4 vertical sub-scanlines per pixel row and exact horizontal span
 * coverage. Supports non-zero and even-odd fill rules and Photoshop-style path operations
 * (combine / subtract / intersect / exclude) between sub-paths. No canvas dependency, so it
 * runs in workers and in headless tests.
 */
import type { Rect } from '../image-engine/rect';
import type { PathOperation, SubPath, VectorPath } from './types';

export type Polygon = number[]; // flat [x0, y0, x1, y1, ...]

const SUB = 4;

/** Flattens a sub-path into a polygon (document px → scaled coords). */
export function flattenSubPath(sp: SubPath, scale = 1, tolerance = 0.25): Polygon {
  const k = sp.knots;
  const out: Polygon = [];
  if (k.length === 0) return out;
  out.push(k[0].x * scale, k[0].y * scale);
  const n = sp.closed ? k.length : k.length - 1;
  for (let i = 0; i < n; i++) {
    const a = k[i];
    const b = k[(i + 1) % k.length];
    const x0 = a.x * scale, y0 = a.y * scale;
    const x1 = a.outX * scale, y1 = a.outY * scale;
    const x2 = b.inX * scale, y2 = b.inY * scale;
    const x3 = b.x * scale, y3 = b.y * scale;
    const straight = x1 === x0 && y1 === y0 && x2 === x3 && y2 === y3;
    if (straight) {
      out.push(x3, y3);
      continue;
    }
    // Segment count from control polygon length.
    const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    const steps = Math.max(2, Math.min(256, Math.ceil(Math.sqrt(len / tolerance) * 1.2)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, mt = 1 - t;
      const a0 = mt * mt * mt, a1 = 3 * mt * mt * t, a2 = 3 * mt * t * t, a3 = t * t * t;
      out.push(a0 * x0 + a1 * x1 + a2 * x2 + a3 * x3, a0 * y0 + a1 * y1 + a2 * y2 + a3 * y3);
    }
  }
  return out;
}

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dir: number;
}

function buildEdges(polys: Polygon[], ox: number, oy: number): Edge[] {
  const edges: Edge[] = [];
  for (const p of polys) {
    const n = p.length / 2;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const ax = p[i * 2] - ox, ay = p[i * 2 + 1] - oy;
      const j = (i + 1) % n;
      const bx = p[j * 2] - ox, by = p[j * 2 + 1] - oy;
      if (ay === by) continue;
      if (ay < by) edges.push({ x0: ax, y0: ay, x1: bx, y1: by, dir: 1 });
      else edges.push({ x0: bx, y0: by, x1: ax, y1: ay, dir: -1 });
    }
  }
  edges.sort((a, b) => a.y0 - b.y0);
  return edges;
}

/** Adds coverage for the horizontal span [xa, xb) on a row buffer with fractional ends. */
function addSpan(row: Float32Array, w: number, xa: number, xb: number, weight: number) {
  if (xb <= 0 || xa >= w || xb <= xa) return;
  if (xa < 0) xa = 0;
  if (xb > w) xb = w;
  const ia = Math.floor(xa), ib = Math.floor(xb);
  if (ia === ib) {
    row[ia] += (xb - xa) * weight;
    return;
  }
  row[ia] += (ia + 1 - xa) * weight;
  for (let i = ia + 1; i < ib; i++) row[i] += weight;
  if (ib < w) row[ib] += (xb - ib) * weight;
}

/**
 * Rasterizes closed polygons into `rect` (coordinates in the same space as the polygons).
 * Returns coverage for rect.w × rect.h.
 */
export function rasterizePolygons(polys: Polygon[], r: Rect, fillRule: 'nonzero' | 'evenodd' = 'nonzero'): Float32Array {
  const w = r.w, h = r.h;
  const out = new Float32Array(w * h);
  if (w <= 0 || h <= 0) return out;
  const edges = buildEdges(polys, r.x, r.y);
  if (!edges.length) return out;
  const active: Edge[] = [];
  let next = 0;
  const xs: number[] = [];
  const dirs: number[] = [];
  const order: number[] = [];
  const weight = 1 / SUB;
  for (let y = 0; y < h; y++) {
    const row = out.subarray(y * w, y * w + w);
    for (let s = 0; s < SUB; s++) {
      const sy = y + (s + 0.5) / SUB;
      while (next < edges.length && edges[next].y0 <= sy) active.push(edges[next++]);
      // Drop finished edges.
      for (let i = active.length - 1; i >= 0; i--) if (active[i].y1 <= sy) active.splice(i, 1);
      if (!active.length) continue;
      xs.length = 0;
      dirs.length = 0;
      for (const e of active) {
        if (e.y0 > sy) continue;
        const t = (sy - e.y0) / (e.y1 - e.y0);
        xs.push(e.x0 + (e.x1 - e.x0) * t);
        dirs.push(e.dir);
      }
      order.length = xs.length;
      for (let i = 0; i < xs.length; i++) order[i] = i;
      order.sort((a, b) => xs[a] - xs[b]);
      let wind = 0;
      for (let i = 0; i < order.length - 1; i++) {
        const idx = order[i];
        wind = fillRule === 'evenodd' ? wind ^ 1 : wind + dirs[idx];
        const inside = fillRule === 'evenodd' ? wind !== 0 : wind !== 0;
        if (inside) addSpan(row, w, xs[idx], xs[order[i + 1]], weight);
      }
    }
    for (let i = 0; i < w; i++) if (row[i] > 1) row[i] = 1;
  }
  return out;
}

function combine(acc: Float32Array, c: Float32Array, op: PathOperation) {
  for (let i = 0; i < acc.length; i++) {
    const a = acc[i], b = c[i];
    switch (op) {
      case 'combine': acc[i] = a + b - a * b; break;
      case 'subtract': acc[i] = a * (1 - b); break;
      case 'intersect': acc[i] = a * b; break;
      case 'exclude': acc[i] = a + b - 2 * a * b; break;
    }
  }
}

/**
 * Rasterizes a vector path into coverage for `r`, where `r` is expressed in scaled coordinates
 * (document px × scale). Open sub-paths are closed implicitly (like a fill).
 */
export function rasterizePath(path: VectorPath, r: Rect, scale = 1): Float32Array {
  const subs = path.subpaths.filter((s) => s.knots.length >= 2);
  if (!subs.length) return new Float32Array(Math.max(0, r.w * r.h));
  const simple = subs.every((s) => s.op === 'combine');
  if (simple) {
    // One pass with the fill rule across all sub-paths (correct holes for even-odd/non-zero paths).
    return rasterizePolygons(subs.map((s) => flattenSubPath(s, scale)), r, path.fillRule);
  }
  let acc: Float32Array | null = null;
  for (const s of subs) {
    const c = rasterizePolygons([flattenSubPath(s, scale)], r, path.fillRule);
    if (!acc) {
      acc = s.op === 'subtract' ? new Float32Array(c.length) : c;
      if (s.op === 'subtract') combine(acc, c, 'subtract');
      continue;
    }
    combine(acc, c, s.op);
  }
  return acc!;
}

/** Bounding box of a path in document px. */
export function pathBounds(path: VectorPath): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of path.subpaths)
    for (const k of s.knots) {
      for (const [x, y] of [[k.x, k.y], [k.inX, k.inY], [k.outX, k.outY]]) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  if (x1 < x0) return null;
  const l = Math.floor(x0), t = Math.floor(y0);
  return { x: l, y: t, w: Math.ceil(x1) - l + 1, h: Math.ceil(y1) - t + 1 };
}

/** Rasterizes a lasso polygon (document px) into coverage for `r`. */
export function rasterizeLasso(points: { x: number; y: number }[], r: Rect, antiAlias = true): Float32Array {
  const poly: Polygon = [];
  for (const p of points) poly.push(p.x, p.y);
  const c = rasterizePolygons([poly], r, 'nonzero');
  if (!antiAlias) for (let i = 0; i < c.length; i++) c[i] = c[i] >= 0.5 ? 1 : 0;
  return c;
}
