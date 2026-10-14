/**
 * Selection algorithms. Large-document friendly: sampling goes through LazyImage (tiles are
 * fetched/composited on demand) and results are written into sparse TiledRasters.
 */
import { TiledRaster, TILE_SIZE, tileKey } from '../image-engine/tiledRaster';
import type { Rect } from '../image-engine/rect';
import { expand, intersect, isEmpty } from '../image-engine/rect';
import { dilateMask, erodeMask, gaussianBlur, boxBlur } from '../image-engine/blur';
import type { SelectionOp } from './selection';
import { Selection } from './selection';
import { rgbToHsl } from '../color/convert';

const TS = TILE_SIZE;

/** On-demand tiled RGBA float image (straight alpha). */
export class LazyImage {
  private cache = new Map<number, Float32Array>();
  constructor(
    readonly bounds: Rect,
    private fetch: (r: Rect) => Float32Array,
    private maxTiles = 256,
  ) {}
  private tile(tx: number, ty: number): Float32Array {
    const k = tileKey(tx, ty);
    let t = this.cache.get(k);
    if (!t) {
      t = this.fetch({ x: tx * TS, y: ty * TS, w: TS, h: TS });
      if (this.cache.size > this.maxTiles) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(k, t);
    }
    return t;
  }
  get(x: number, y: number, out: Float32Array): boolean {
    const b = this.bounds;
    if (x < b.x || y < b.y || x >= b.x + b.w || y >= b.y + b.h) return false;
    const tx = Math.floor(x / TS), ty = Math.floor(y / TS);
    const t = this.tile(tx, ty);
    const i = ((y - ty * TS) * TS + (x - tx * TS)) * 4;
    out[0] = t[i]; out[1] = t[i + 1]; out[2] = t[i + 2]; out[3] = t[i + 3];
    return true;
  }
  region(r: Rect): Float32Array {
    const out = new Float32Array(r.w * r.h * 4);
    const px = new Float32Array(4);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (this.get(r.x + x, r.y + y, px)) out.set(px, (y * r.w + x) * 4);
    return out;
  }
}

function colorDistance(a: Float32Array, b: Float32Array): number {
  // Photoshop-like tolerance: max channel difference (in 0..255 levels), alpha included.
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3])) * 255;
}

/** Magic wand / paint bucket region: returns coverage raster (document space). */
export function floodRegion(img: LazyImage, sx: number, sy: number, tolerance: number, contiguous: boolean, antiAlias: boolean): TiledRaster {
  const out = new TiledRaster(1, 8, 0);
  const seed = new Float32Array(4);
  if (!img.get(Math.floor(sx), Math.floor(sy), seed)) return out;
  const px = new Float32Array(4);
  const b = img.bounds;
  const tol = tolerance + 0.5;
  const match = (x: number, y: number) => img.get(x, y, px) && colorDistance(px, seed) <= tol;
  // Write helper with a per-tile cache of writable tiles.
  const setPx = (x: number, y: number, v: number) => {
    const tx = Math.floor(x / TS), ty = Math.floor(y / TS);
    const t = out.writableTile(tx, ty);
    t.data[(y - ty * TS) * TS + (x - tx * TS)] = v;
  };
  const visited = new TiledRaster(1, 8, 0);
  const isVisited = (x: number, y: number) => {
    const t = visited.getTile(Math.floor(x / TS), Math.floor(y / TS));
    return !!t && t.data[(y - Math.floor(y / TS) * TS) * TS + (x - Math.floor(x / TS) * TS)] > 0;
  };
  const markVisited = (x: number, y: number) => {
    const tx = Math.floor(x / TS), ty = Math.floor(y / TS);
    visited.writableTile(tx, ty).data[(y - ty * TS) * TS + (x - tx * TS)] = 1;
  };
  if (contiguous) {
    const stack: number[] = [Math.floor(sx), Math.floor(sy)];
    while (stack.length) {
      const y = stack.pop()!, x0 = stack.pop()!;
      if (isVisited(x0, y) || !match(x0, y)) continue;
      let l = x0, r = x0;
      while (l - 1 >= b.x && !isVisited(l - 1, y) && match(l - 1, y)) l--;
      while (r + 1 < b.x + b.w && !isVisited(r + 1, y) && match(r + 1, y)) r++;
      for (let x = l; x <= r; x++) {
        markVisited(x, y);
        setPx(x, y, 255);
        if (y - 1 >= b.y && !isVisited(x, y - 1) && match(x, y - 1)) stack.push(x, y - 1);
        if (y + 1 < b.y + b.h && !isVisited(x, y + 1) && match(x, y + 1)) stack.push(x, y + 1);
      }
    }
  } else {
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (match(x, y)) setPx(x, y, 255);
  }
  if (antiAlias) antialiasEdges(out);
  out.touch();
  return out;
}

/** Softens hard binary edges by one pixel (anti-aliased selections). */
export function antialiasEdges(m: TiledRaster): void {
  const b = m.contentBounds();
  if (!b) return;
  const r = expand(b, 1);
  const v = m.readFloat(r);
  const out = v.slice();
  for (let y = 1; y < r.h - 1; y++)
    for (let x = 1; x < r.w - 1; x++) {
      const i = y * r.w + x;
      const c = v[i];
      const edge = v[i - 1] !== c || v[i + 1] !== c || v[i - r.w] !== c || v[i + r.w] !== c;
      if (edge) out[i] = (c * 4 + v[i - 1] + v[i + 1] + v[i - r.w] + v[i + r.w]) / 8;
    }
  m.writeFloat(r, out);
}

/** Combines a coverage raster into a selection. */
export function combineRaster(sel: Selection, other: TiledRaster, op: SelectionOp, canvas: Rect): void {
  const m = sel.mask;
  if (op === 'replace') {
    // Shares tiles copy-on-write; later edits to the selection never touch `other`.
    m.restore(other.snapshot());
    return;
  }
  const b = other.tileBounds();
  const selB = sel.bounds(canvas);
  const region = op === 'intersect' ? selB : b;
  if (!region) {
    if (op === 'intersect') sel.clear();
    return;
  }
  const r = intersect(expand(region, 0), op === 'intersect' ? canvas : expand(canvas, 0));
  if (isEmpty(r)) {
    if (op === 'intersect') sel.clear();
    return;
  }
  const cov = other.readFloat(r);
  sel.combine(r, cov, op);
}

// ---------------------------------------------------------------------------------------------
// Modify
// ---------------------------------------------------------------------------------------------
function withDense(sel: Selection, canvas: Rect, pad: number, fn: (v: Float32Array, r: Rect) => Float32Array): void {
  const b = sel.bounds(canvas);
  if (!b) return;
  const r = intersect(expand(b, pad), canvas);
  const v = sel.read(r);
  const out = fn(v, r);
  sel.setRegion(r, out);
}

export function feather(sel: Selection, canvas: Rect, radius: number): void {
  if (radius <= 0) return;
  withDense(sel, canvas, Math.ceil(radius * 3), (v, r) => {
    gaussianBlur(v, r.w, r.h, 1, radius);
    return v;
  });
}

export function expandSelection(sel: Selection, canvas: Rect, px: number): void {
  withDense(sel, canvas, Math.ceil(px) + 2, (v, r) => dilateMask(v, r.w, r.h, px));
}

export function contractSelection(sel: Selection, canvas: Rect, px: number): void {
  // Canvas edges count as unselected when contracting from a full selection.
  withDense(sel, canvas, 1, (v, r) => erodeMask(v, r.w, r.h, px));
}

export function smoothSelection(sel: Selection, canvas: Rect, radius: number): void {
  withDense(sel, canvas, radius + 2, (v, r) => {
    boxBlur(v, r.w, r.h, 1, radius);
    for (let i = 0; i < v.length; i++) v[i] = v[i] >= 0.5 ? 1 : 0;
    boxBlur(v, r.w, r.h, 1, 0.75);
    return v;
  });
}

export function borderSelection(sel: Selection, canvas: Rect, width: number): void {
  withDense(sel, canvas, Math.ceil(width) + 2, (v, r) => {
    const outer = dilateMask(v, r.w, r.h, width / 2), inner = erodeMask(v, r.w, r.h, width / 2);
    const out = outer.map((o, i) => Math.max(0, o - inner[i]));
    boxBlur(out, r.w, r.h, 1, 1);
    return out;
  });
}

/** Grow (contiguous) / Similar (global) using colors inside the current selection. */
export function growSimilar(sel: Selection, img: LazyImage, canvas: Rect, tolerance: number, contiguous: boolean): void {
  const b = sel.bounds(canvas);
  if (!b) return;
  // Sample color range of selected pixels (subsampled).
  const cov = sel.read(b);
  const px = new Float32Array(4);
  const lo = [1, 1, 1], hi = [0, 0, 0];
  const step = Math.max(1, Math.floor(Math.sqrt((b.w * b.h) / 20000)));
  for (let y = 0; y < b.h; y += step)
    for (let x = 0; x < b.w; x += step) {
      if (cov[y * b.w + x] < 0.5 || !img.get(b.x + x, b.y + y, px)) continue;
      for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], px[c]); hi[c] = Math.max(hi[c], px[c]); }
    }
  const tol = tolerance / 255;
  const inRange = (x: number, y: number) => img.get(x, y, px) && px[0] >= lo[0] - tol && px[0] <= hi[0] + tol && px[1] >= lo[1] - tol && px[1] <= hi[1] + tol && px[2] >= lo[2] - tol && px[2] <= hi[2] + tol;
  const result = new TiledRaster(1, 8, 0);
  const set = (x: number, y: number) => { const tx = Math.floor(x / TS), ty = Math.floor(y / TS); result.writableTile(tx, ty).data[(y - ty * TS) * TS + (x - tx * TS)] = 255; };
  if (contiguous) {
    const seen = new Uint8Array(canvas.w * canvas.h);
    const stack: number[] = [];
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (cov[y * b.w + x] >= 0.5) stack.push(b.x + x, b.y + y);
    while (stack.length) {
      const y = stack.pop()!, x = stack.pop()!;
      if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h) continue;
      const i = y * canvas.w + x;
      if (seen[i]) continue;
      seen[i] = 1;
      if (!inRange(x, y)) continue;
      set(x, y);
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
  } else {
    for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) if (inRange(x, y)) set(x, y);
  }
  combineRaster(sel, result, 'add', canvas);
}

export type ColorRangeMode = 'sampled' | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas' | 'highlights' | 'midtones' | 'shadows' | 'skinTones';

/** Color Range selection over the canvas (fuzziness 0..200). */
export function colorRange(img: LazyImage, canvas: Rect, mode: ColorRangeMode, samples: [number, number, number][], fuzziness: number, invert: boolean): TiledRaster {
  const out = new TiledRaster(1, 8, 0);
  const f = Math.max(1, fuzziness) / 255;
  const px = new Float32Array(4);
  const hueCenter: Record<string, number> = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };
  const buf = new Float32Array(TS * TS);
  for (let ty = 0; ty * TS < canvas.h; ty++)
    for (let tx = 0; tx * TS < canvas.w; tx++) {
      const r = intersect({ x: tx * TS, y: ty * TS, w: TS, h: TS }, canvas);
      buf.fill(0);
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          if (!img.get(r.x + x, r.y + y, px)) continue;
          let v = 0;
          const L = 0.3 * px[0] + 0.59 * px[1] + 0.11 * px[2];
          if (mode === 'sampled') {
            for (const s of samples) {
              const d = Math.max(Math.abs(px[0] - s[0]), Math.abs(px[1] - s[1]), Math.abs(px[2] - s[2]));
              v = Math.max(v, Math.max(0, 1 - d / f));
            }
          } else if (mode === 'highlights') v = Math.max(0, Math.min(1, (L - 0.6) / 0.2));
          else if (mode === 'shadows') v = Math.max(0, Math.min(1, (0.4 - L) / 0.2));
          else if (mode === 'midtones') v = Math.max(0, 1 - Math.abs(L - 0.5) / 0.25);
          else if (mode === 'skinTones') {
            const hsl = rgbToHsl({ r: px[0], g: px[1], b: px[2] });
            const dh = Math.min(Math.abs(hsl.h - 25), 360 - Math.abs(hsl.h - 25));
            v = hsl.s > 0.15 && hsl.l > 0.2 && hsl.l < 0.9 ? Math.max(0, 1 - dh / 25) : 0;
          } else {
            const hsl = rgbToHsl({ r: px[0], g: px[1], b: px[2] });
            const dh = Math.min(Math.abs(hsl.h - hueCenter[mode]), 360 - Math.abs(hsl.h - hueCenter[mode]));
            v = hsl.s > 0.1 ? Math.max(0, 1 - dh / 30) * Math.min(1, hsl.s * 3) : 0;
          }
          buf[y * r.w + x] = invert ? 1 - v : v;
        }
      out.writeFloat(r, buf.subarray(0, r.w * r.h));
    }
  out.compact();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Contours (marching squares) — marching ants and selection → path
// ---------------------------------------------------------------------------------------------
/**
 * Traces iso-contours at 0.5 of a coverage grid. Returns polylines in grid coordinates
 * (multiply by the level scale and add the origin to get document coordinates).
 */
export function traceContours(v: Float32Array, w: number, h: number): number[][] {
  // Pad with zeros so all contours close.
  const W = w + 2, H = h + 2;
  const g = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[(y + 1) * W + x + 1] = v[y * w + x] >= 0.5 ? 1 : 0;
  // Edge segments between cell corners, keyed for chaining.
  const segs = new Map<number, number>();
  const key = (x: number, y: number) => y * (W * 2 + 2) + x;
  const addSeg = (ax: number, ay: number, bx: number, by: number) => segs.set(key(ax, ay), key(bx, by));
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const tl = g[y * W + x], tr = g[y * W + x + 1], br = g[(y + 1) * W + x + 1], bl = g[(y + 1) * W + x];
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;
      // Midpoints on a doubled grid: top (2x+1, 2y), right (2x+2, 2y+1), bottom (2x+1, 2y+2), left (2x, 2y+1).
      const T: [number, number] = [2 * x + 1, 2 * y], R: [number, number] = [2 * x + 2, 2 * y + 1], B: [number, number] = [2 * x + 1, 2 * y + 2], L: [number, number] = [2 * x, 2 * y + 1];
      const s = (a: [number, number], b: [number, number]) => addSeg(a[0], a[1], b[0], b[1]);
      switch (code) {
        case 1: s(L, B); break;
        case 2: s(B, R); break;
        case 3: s(L, R); break;
        case 4: s(R, T); break;
        case 5: s(L, T); s(R, B); break;
        case 6: s(B, T); break;
        case 7: s(L, T); break;
        case 8: s(T, L); break;
        case 9: s(T, B); break;
        case 10: s(T, R); s(B, L); break;
        case 11: s(T, R); break;
        case 12: s(R, L); break;
        case 13: s(R, B); break;
        case 14: s(B, L); break;
      }
    }
  }
  const polys: number[][] = [];
  const stride = W * 2 + 2;
  while (segs.size) {
    const startKey = segs.keys().next().value!;
    const poly: number[] = [];
    let k = startKey;
    let guard = 0;
    while (segs.has(k) && guard++ < 10_000_000) {
      const nx = segs.get(k)!;
      segs.delete(k);
      const x = k % stride, y = Math.floor(k / stride);
      poly.push(x / 2 - 1, y / 2 - 1);
      k = nx;
      if (k === startKey) break;
    }
    if (poly.length >= 6) polys.push(poly);
  }
  return polys;
}

/** Douglas–Peucker simplification of a closed polyline. */
export function simplify(poly: number[], tol: number): number[] {
  const n = poly.length / 2;
  if (n < 4) return poly;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0, idx = -1;
    const ax = poly[a * 2], ay = poly[a * 2 + 1], bx = poly[b * 2], by = poly[b * 2 + 1];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((poly[i * 2] - ax) * dy - (poly[i * 2 + 1] - ay) * dx) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(poly[i * 2], poly[i * 2 + 1]);
  return out;
}
