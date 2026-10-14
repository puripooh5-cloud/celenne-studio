/**
 * Type on a path: geometry helpers. The path is a Bézier sub-path in text space; glyphs are
 * placed along its flattened polyline, each rotated to the local tangent.
 *
 * The model follows Photoshop: the text lies between a start and an end marker (distances along
 * the path). Left-aligned text begins at the start marker, right-aligned text ends at the end
 * marker, centred text is centred between them, and glyphs that do not fit between the markers
 * are hidden. Flip puts the text on the other side of the path, running from the end marker
 * back towards the start marker. On a closed path the markers may wrap around.
 */
import type { PathKnot, SubPath } from '../vector/types';
import { flattenSubPath } from '../vector/rasterize';

export interface TextPath {
  /** The path in text space. */
  subpath: SubPath;
  /** Start marker: distance along the path (text-space px). */
  start: number;
  /** End marker (text-space px); the end of the path when absent. */
  end?: number;
  /** Text on the other side of the path, running in the opposite direction. */
  flip: boolean;
}

export interface FlatPath {
  xs: Float64Array;
  ys: Float64Array;
  /** Cumulative length at each vertex. */
  cum: Float64Array;
  length: number;
  closed: boolean;
}

export function flattenTextPath(sp: SubPath, flip = false): FlatPath | null {
  const poly = flattenSubPath(sp, 1, 0.1);
  const n = poly.length / 2;
  if (n < 2) return null;
  const xs = new Float64Array(n), ys = new Float64Array(n), cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = flip ? n - 1 - i : i;
    xs[i] = poly[j * 2];
    ys[i] = poly[j * 2 + 1];
    if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  const length = cum[n - 1];
  return length > 0 ? { xs, ys, cum, length, closed: sp.closed } : null;
}

/** Point and tangent angle at distance `d`; null past the ends of an open path. */
export function pointAtDistance(f: FlatPath, d: number): { x: number; y: number; angle: number } | null {
  if (f.closed) d = ((d % f.length) + f.length) % f.length;
  else if (d < -1e-9 || d > f.length + 1e-9) return null;
  d = Math.max(0, Math.min(f.length, d));
  // Binary search for the segment.
  let lo = 0, hi = f.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (f.cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  // Skip zero-length segments for a stable tangent.
  let a = lo, b = hi;
  while (b < f.cum.length - 1 && f.cum[b] - f.cum[a] < 1e-9) b++;
  while (a > 0 && f.cum[b] - f.cum[a] < 1e-9) a--;
  const seg = f.cum[b] - f.cum[a];
  const t = seg > 0 ? Math.max(0, Math.min(1, (d - f.cum[a]) / seg)) : 0;
  const x = f.xs[a] + (f.xs[b] - f.xs[a]) * t, y = f.ys[a] + (f.ys[b] - f.ys[a]) * t;
  return { x, y, angle: Math.atan2(f.ys[b] - f.ys[a], f.xs[b] - f.xs[a]) };
}

/** Distance along the path of the point nearest to (x, y), and how far away it is. */
export function nearestDistance(f: FlatPath, x: number, y: number): { d: number; dist: number } {
  let best = { d: 0, dist: Infinity };
  for (let i = 0; i + 1 < f.xs.length; i++) {
    const ax = f.xs[i], ay = f.ys[i], bx = f.xs[i + 1], by = f.ys[i + 1];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    const px = ax + dx * t, py = ay + dy * t;
    const dist = Math.hypot(x - px, y - py);
    if (dist < best.dist) best = { d: f.cum[i] + (f.cum[i + 1] - f.cum[i]) * t, dist };
  }
  return best;
}

/** End marker, defaulting to the end of the path (or once around a closed path). */
export function endMarker(tp: TextPath, length: number): number {
  if (tp.end !== undefined && Number.isFinite(tp.end)) return tp.end;
  return length;
}

/**
 * The text span [a, b] on the (possibly flipped) flattened path: text flows from `a` to `b`.
 * On a closed path, `b` may exceed the length (wrap-around).
 */
export function spanOnFlat(tp: TextPath, f: FlatPath): { a: number; b: number } {
  const s = Math.max(0, Math.min(f.length, tp.start));
  let e = Math.max(0, Math.min(f.length, endMarker(tp, f.length)));
  if (f.closed && e <= s) e += f.length;
  if (!f.closed && e < s) e = s;
  if (!tp.flip) return { a: s, b: e };
  // Flipped: runs from the end marker back to the start marker, on the reversed path.
  // (A negative `a` on a closed path wraps around.)
  return { a: f.length - e, b: f.length - s };
}

/** Kept for callers that only need the anchor: where left-aligned text begins. */
export function startOnFlat(tp: TextPath, f: FlatPath): number {
  return spanOnFlat(tp, f).a;
}

// ---------------------------------------------------------------------------------------------
// Curve parameters (Photoshop stores marker positions as Bézier parameters: segment index + t)
// ---------------------------------------------------------------------------------------------
function segPoint(a: PathKnot, b: PathKnot, t: number): [number, number] {
  const mt = 1 - t;
  const k0 = mt * mt * mt, k1 = 3 * mt * mt * t, k2 = 3 * mt * t * t, k3 = t * t * t;
  return [k0 * a.x + k1 * a.outX + k2 * b.inX + k3 * b.x, k0 * a.y + k1 * a.outY + k2 * b.inY + k3 * b.y];
}

function segLength(a: PathKnot, b: PathKnot, t1 = 1, steps = 96): number {
  let len = 0;
  let [px, py] = segPoint(a, b, 0);
  const n = Math.max(1, Math.ceil(steps * t1));
  for (let i = 1; i <= n; i++) {
    const [x, y] = segPoint(a, b, (t1 * i) / n);
    len += Math.hypot(x - px, y - py);
    px = x; py = y;
  }
  return len;
}

function segmentCount(sp: SubPath): number {
  return sp.closed ? sp.knots.length : Math.max(0, sp.knots.length - 1);
}

/** Arc length at curve parameter `u` (integer part = segment index, fraction = t). */
export function distanceAtParam(sp: SubPath, u: number): number {
  const n = segmentCount(sp);
  if (!n) return 0;
  const uu = Math.max(0, Math.min(n, u));
  let d = 0;
  const whole = Math.floor(uu);
  for (let i = 0; i < Math.min(whole, n); i++) d += segLength(sp.knots[i], sp.knots[(i + 1) % sp.knots.length]);
  const frac = uu - whole;
  if (frac > 0 && whole < n) d += segLength(sp.knots[whole], sp.knots[(whole + 1) % sp.knots.length], frac);
  return d;
}

/** Curve parameter at arc length `d` (inverse of distanceAtParam). */
export function paramAtDistance(sp: SubPath, d: number): number {
  const n = segmentCount(sp);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = sp.knots[i], b = sp.knots[(i + 1) % sp.knots.length];
    const L = segLength(a, b);
    if (acc + L >= d || i === n - 1) {
      // Bisection on t within this segment.
      let lo = 0, hi = 1;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        if (acc + segLength(a, b, mid) < d) lo = mid;
        else hi = mid;
      }
      return i + (lo + hi) / 2;
    }
    acc += L;
  }
  return n;
}

/**
 * Photoshop's text-on-path geometry (from the text engine's TextFrameSet): `controlPoints` is a
 * flat list of cubic segments, 8 numbers each (start, control 1, control 2, end), in text space;
 * `textRange` holds the start / end markers as curve parameters; `reversed` is Flip.
 * Returns null when the data does not describe a continuous path.
 */
export function textPathFromPhotoshop(controlPoints: unknown, textRange: unknown, reversed: unknown): TextPath | null {
  if (!Array.isArray(controlPoints) || controlPoints.length < 8 || controlPoints.length % 8 !== 0 || controlPoints.length > 8 * 10000) return null;
  const p = controlPoints.map(Number);
  if (!p.every(Number.isFinite)) return null;
  const segs = p.length / 8;
  const tol = 0.01;
  for (let s = 1; s < segs; s++) {
    if (Math.abs(p[s * 8] - p[s * 8 - 2]) > tol || Math.abs(p[s * 8 + 1] - p[s * 8 - 1]) > tol) return null; // not continuous
  }
  const first = [p[0], p[1]], last = [p[p.length - 2], p[p.length - 1]];
  const closed = segs > 1 && Math.abs(first[0] - last[0]) <= tol && Math.abs(first[1] - last[1]) <= tol;
  const knots: PathKnot[] = [];
  for (let s = 0; s < segs; s++) {
    const o = s * 8;
    if (s === 0) knots.push({ x: p[o], y: p[o + 1], inX: p[o], inY: p[o + 1], outX: p[o + 2], outY: p[o + 3], smooth: false });
    else knots[knots.length - 1].outX = p[o + 2], knots[knots.length - 1].outY = p[o + 3];
    if (s === segs - 1 && closed) {
      // The last segment returns to the first knot: its incoming handle belongs to knot 0.
      knots[0].inX = p[o + 4];
      knots[0].inY = p[o + 5];
    } else knots.push({ x: p[o + 6], y: p[o + 7], inX: p[o + 4], inY: p[o + 5], outX: p[o + 6], outY: p[o + 7], smooth: false });
  }
  for (const k of knots) {
    // Collinear handles → smooth knot (keeps them together when edited).
    const ax = k.x - k.inX, ay = k.y - k.inY, bx = k.outX - k.x, by = k.outY - k.y;
    k.smooth = Math.hypot(ax, ay) > 1e-6 && Math.hypot(bx, by) > 1e-6 && Math.abs(ax * by - ay * bx) < 1e-3 * Math.hypot(ax, ay) * Math.hypot(bx, by);
  }
  const subpath: SubPath = { knots, closed, op: 'combine' };
  const range = Array.isArray(textRange) ? textRange.map(Number) : [];
  const valid = (v: number) => Number.isFinite(v) && v >= 0 && v <= segs + 1e-6;
  const start = valid(range[0]) ? distanceAtParam(subpath, range[0]) : 0;
  const end = valid(range[1]) && range[1] !== range[0] ? distanceAtParam(subpath, range[1]) : undefined;
  return { subpath, start, end, flip: reversed === true };
}
