/** Integer-aligned rectangle helpers. Rects are half-open: [x, x + w) × [y, y + h). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const EMPTY_RECT: Rect = Object.freeze({ x: 0, y: 0, w: 0, h: 0 });

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

export function rectFromLTRB(l: number, t: number, r: number, b: number): Rect {
  return { x: l, y: t, w: Math.max(0, r - l), h: Math.max(0, b - t) };
}

export function isEmpty(r: Rect | null | undefined): boolean {
  return !r || r.w <= 0 || r.h <= 0;
}

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  return r > x && bt > y ? { x, y, w: r - x, h: bt - y } : { x, y, w: 0, h: 0 };
}

export function union(a: Rect | null | undefined, b: Rect | null | undefined): Rect | null {
  if (isEmpty(a)) return isEmpty(b) ? null : { ...b! };
  if (isEmpty(b)) return { ...a! };
  const x = Math.min(a!.x, b!.x);
  const y = Math.min(a!.y, b!.y);
  return {
    x,
    y,
    w: Math.max(a!.x + a!.w, b!.x + b!.w) - x,
    h: Math.max(a!.y + a!.h, b!.y + b!.h) - y,
  };
}

export function expand(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

export function translate(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}

export function containsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

export function rectsEqual(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Smallest integer rect covering a floating-point box. */
export function roundOut(x0: number, y0: number, x1: number, y1: number): Rect {
  const l = Math.floor(Math.min(x0, x1));
  const t = Math.floor(Math.min(y0, y1));
  const r = Math.ceil(Math.max(x0, x1));
  const b = Math.ceil(Math.max(y0, y1));
  return { x: l, y: t, w: r - l, h: b - t };
}

export function area(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

export function scaleRect(r: Rect, s: number): Rect {
  return roundOut(r.x * s, r.y * s, (r.x + r.w) * s, (r.y + r.h) * s);
}
