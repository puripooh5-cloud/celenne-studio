/**
 * Mesh warps: the Edit ▸ Transform ▸ Warp envelope (a bicubic Bézier patch with a 4×4 control
 * grid) and the Warp Text / warp preset styles (Arc, Bulge, Flag, …).
 *
 * A warp is a forward map from the unit square (u, v ∈ [0, 1] over the base rectangle) to
 * document space. Rasters are resampled by subdividing the unit square into a fine grid and
 * inverse-mapping each destination triangle affinely back into the source (so any forward map
 * can be rendered, including folded envelopes).
 *
 * The preset formulas are Celenne's own approximations of the Photoshop styles (same names and
 * parameters: bend, horizontal and vertical distortion, orientation), not Photoshop's exact
 * curves.
 */
import type { Point } from './matrix';
import type { Rect } from './rect';
import { roundOut } from './rect';
import { TiledRaster } from './tiledRaster';

export type WarpStyle =
  | 'none' | 'arc' | 'arcLower' | 'arcUpper' | 'arch' | 'bulge' | 'shellLower' | 'shellUpper' | 'flag' | 'wave'
  | 'fish' | 'rise' | 'fisheye' | 'inflate' | 'squeeze' | 'twist' | 'cylinder' | 'custom';

export const WARP_STYLES: { id: Exclude<WarpStyle, 'custom'>; label: string }[] = [
  { id: 'none', label: 'None' }, { id: 'arc', label: 'Arc' }, { id: 'arcLower', label: 'Arc Lower' }, { id: 'arcUpper', label: 'Arc Upper' },
  { id: 'arch', label: 'Arch' }, { id: 'bulge', label: 'Bulge' }, { id: 'shellLower', label: 'Shell Lower' }, { id: 'shellUpper', label: 'Shell Upper' },
  { id: 'flag', label: 'Flag' }, { id: 'wave', label: 'Wave' }, { id: 'fish', label: 'Fish' }, { id: 'rise', label: 'Rise' },
  { id: 'fisheye', label: 'Fisheye' }, { id: 'inflate', label: 'Inflate' }, { id: 'squeeze', label: 'Squeeze' }, { id: 'twist', label: 'Twist' },
  { id: 'cylinder', label: 'Cylinder' },
];

/** Preset parameters (percentages −100..100, as in Photoshop's Warp Text dialog). */
export interface WarpPreset {
  style: WarpStyle;
  bend: number;
  horizontalDistortion: number;
  verticalDistortion: number;
  orientation: 'horizontal' | 'vertical';
}

export function defaultWarpPreset(style: WarpStyle = 'arc'): WarpPreset {
  return { style, bend: style === 'none' ? 0 : 50, horizontalDistortion: 0, verticalDistortion: 0, orientation: 'horizontal' };
}

/**
 * Evaluates a preset in centred coordinates: x ∈ [−0.5, 0.5] across the width, yn ∈ [−0.5, 0.5]
 * down the height, `a` = height / width. Geometry is computed in width units (y = yn·a) so the
 * shapes keep the box's proportions; returns [X, Yn] in the same normalized convention.
 */
function presetCentered(style: WarpStyle, b: number, x: number, yn: number, a: number): [number, number] {
  const u = x + 0.5, v = yn + 0.5;
  const y = yn * a;
  const par = 1 - 4 * x * x; // 1 at the centre column, 0 at the sides
  let X = x, Y = y;
  switch (style) {
    case 'arc': {
      if (Math.abs(b) < 1e-4) break;
      const s = Math.sign(b);
      // The middle row keeps its length and spans |b|·180°; tall boxes get a larger radius (and a
      // gentler angle) so the inner edge never collapses through the centre.
      const rMid = Math.max(1 / (Math.abs(b) * Math.PI), a / 2 + 0.15);
      const th = 1 / rMid;
      const yy = s > 0 ? y : -y;
      const rho = rMid - yy;
      const ang = x * th;
      X = rho * Math.sin(ang);
      const YY = rMid - rho * Math.cos(ang);
      Y = s > 0 ? YY : -YY;
      break;
    }
    case 'arcLower': Y = y + b * a * 0.6 * par * v; break;
    case 'arcUpper': Y = y - b * a * 0.6 * par * (1 - v); break;
    case 'arch': Y = y - b * a * 0.6 * par; break;
    case 'bulge': Y = y * (1 + b * par); break;
    case 'shellLower': Y = y - b * a * 2.4 * x * x * v; break;
    case 'shellUpper': Y = y + b * a * 2.4 * x * x * (1 - v); break;
    case 'flag': Y = y - b * a * 0.5 * Math.sin(2 * Math.PI * u); break;
    case 'wave': Y = y - b * a * 0.5 * Math.sin(2 * Math.PI * u + Math.PI * v * 0.5); break;
    case 'fish': Y = y * (1 + b * 0.8 * Math.sin(Math.PI * u) * (1 - u * 0.6)); break;
    case 'rise': Y = y - b * a * 0.8 * Math.sin(Math.PI * x); break;
    case 'fisheye': {
      const k = 1 + b * 0.6 * Math.max(0, 1 - 2 * (x * x + yn * yn));
      X = x * k; Y = y * k;
      break;
    }
    case 'inflate': X = x * (1 + b * 0.5 * (1 - 4 * yn * yn)); Y = y * (1 + b * 0.5 * par); break;
    case 'squeeze': X = x * (1 - b * 0.5 * (1 - 4 * yn * yn)); Y = y * (1 + b * 0.3 * par); break;
    case 'twist': {
      // Swirl about the centre, measured in width units, fading smoothly to the box's half-width.
      const r = Math.min(1, Math.sqrt(x * x + y * y) / 0.5);
      const f = 1 - r * r * (3 - 2 * r);
      const t = b * Math.PI * 0.6 * f;
      const c = Math.cos(t), sn = Math.sin(t);
      X = x * c - y * sn; Y = x * sn + y * c;
      break;
    }
    case 'cylinder': {
      if (Math.abs(b) < 1e-4) break;
      const k = 0.5 + Math.abs(b) * 0.5;
      X = Math.sin(x * Math.PI * k) / (2 * Math.sin((Math.PI * k) / 2));
      Y = y + b * a * 0.35 * (1 - par);
      break;
    }
  }
  return [X, Y / a];
}

/** Forward map of a preset over the unit square; `aspect` is the box's height / width. */
export function presetMap(p: WarpPreset, aspect = 1): (u: number, v: number) => Point {
  const b = Math.max(-1, Math.min(1, p.bend / 100));
  const hd = Math.max(-1, Math.min(1, p.horizontalDistortion / 100));
  const vd = Math.max(-1, Math.min(1, p.verticalDistortion / 100));
  const vertical = p.orientation === 'vertical';
  const as = Math.max(1e-3, aspect);
  const a = vertical ? 1 / as : as; // aspect of the (possibly rotated) working frame
  return (u, v) => {
    let x = u - 0.5, y = v - 0.5;
    if (vertical) [x, y] = [y, -x];
    let [X, Y] = p.style === 'none' ? [x, y] : presetCentered(p.style, b, x, y, a);
    if (vertical) [X, Y] = [-Y, X];
    // Distortions: a perspective-like taper across the other axis.
    if (hd) Y *= 1 + hd * X * 1.2;
    if (vd) X *= 1 + vd * Y * 1.2;
    return { x: X + 0.5, y: Y + 0.5 };
  };
}

// ---------------------------------------------------------------------------------------------
// Bézier envelope (4×4 control points, row-major: index = row * 4 + col)
// ---------------------------------------------------------------------------------------------
export type WarpGrid = Point[];

function bern(t: number): [number, number, number, number] {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

export function evalGrid(g: WarpGrid, u: number, v: number): Point {
  const bu = bern(u), bv = bern(v);
  let x = 0, y = 0;
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 4; i++) {
      const w = bu[i] * bv[j];
      const p = g[j * 4 + i];
      x += p.x * w; y += p.y * w;
    }
  return { x, y };
}

/** The identity envelope over a rectangle. */
export function rectGrid(r: Rect): WarpGrid {
  const g: WarpGrid = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) g.push({ x: r.x + (r.w * i) / 3, y: r.y + (r.h * j) / 3 });
  return g;
}

// Inverse of the Bernstein matrix sampled at t = 0, 1/3, 2/3, 1 (interpolating control points).
const BINV = (() => {
  const m = [0, 1 / 3, 2 / 3, 1].map(bern);
  // Gauss-Jordan on the 4×4 matrix.
  const a = m.map((r, i) => [...r, ...[0, 1, 2, 3].map((k) => (k === i ? 1 : 0))]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let k = 0; k < 8; k++) a[c][k] /= d;
    for (let r = 0; r < 4; r++) if (r !== c) { const f = a[r][c]; for (let k = 0; k < 8; k++) a[r][k] -= f * a[c][k]; }
  }
  return a.map((r) => r.slice(4));
})();

/** Fits an envelope through a forward map sampled on the 4×4 grid t = 0, 1/3, 2/3, 1. */
export function fitGrid(map: (u: number, v: number) => Point): WarpGrid {
  const S: Point[][] = [];
  for (let j = 0; j < 4; j++) { S.push([]); for (let i = 0; i < 4; i++) S[j].push(map(i / 3, j / 3)); }
  // P = B⁻¹ · S · B⁻ᵀ
  const T: Point[][] = S.map((row) => [0, 1, 2, 3].map((i) => row.reduce((acc, p, k) => ({ x: acc.x + BINV[i][k] * p.x, y: acc.y + BINV[i][k] * p.y }), { x: 0, y: 0 })));
  const g: WarpGrid = [];
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 4; i++) {
      let x = 0, y = 0;
      for (let k = 0; k < 4; k++) { x += BINV[j][k] * T[k][i].x; y += BINV[j][k] * T[k][i].y; }
      g.push({ x, y });
    }
  return g;
}

/** Envelope for a preset placed over a document rectangle. */
export function presetGrid(p: WarpPreset, r: Rect): WarpGrid {
  const m = presetMap(p, r.h / Math.max(1e-9, r.w));
  return fitGrid((u, v) => { const q = m(u, v); return { x: r.x + q.x * r.w, y: r.y + q.y * r.h }; });
}

export function isIdentityGrid(g: WarpGrid, r: Rect): boolean {
  const id = rectGrid(r);
  return g.every((p, i) => Math.abs(p.x - id[i].x) < 1e-6 && Math.abs(p.y - id[i].y) < 1e-6);
}

// ---------------------------------------------------------------------------------------------
// Raster resampling through a forward map
// ---------------------------------------------------------------------------------------------
export interface MeshSource {
  raster: TiledRaster;
  /** Raster offset in document space. */
  ox: number;
  oy: number;
  /** Source content bounds (raster-local, level 0). */
  bounds: Rect;
}

const N = 32; // subdivisions per axis

/** Samples the forward map on an (N+1)² grid (document space, level 0). */
export function sampleMesh(fwd: (u: number, v: number) => Point): Float64Array {
  const g = new Float64Array((N + 1) * (N + 1) * 2);
  for (let j = 0; j <= N; j++)
    for (let i = 0; i <= N; i++) {
      const p = fwd(i / N, j / N);
      g[(j * (N + 1) + i) * 2] = p.x;
      g[(j * (N + 1) + i) * 2 + 1] = p.y;
    }
  return g;
}

export function meshBounds(mesh: Float64Array): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < mesh.length; i += 2) {
    x0 = Math.min(x0, mesh[i]); x1 = Math.max(x1, mesh[i]);
    y0 = Math.min(y0, mesh[i + 1]); y1 = Math.max(y1, mesh[i + 1]);
  }
  return roundOut(x0, y0, x1, y1);
}

/**
 * Renders the source warped by `mesh` (the forward map of `base`, a document rectangle, sampled
 * with sampleMesh) into `dst` (pixels at display `level`). Returns straight RGBA floats.
 * Pixels of the source outside `base` are not drawn.
 */
export function meshWarpRegion(src: MeshSource, base: Rect, mesh: Float64Array, dst: Rect, level = 0, bilinear = true): Float32Array {
  const out = new Float32Array(dst.w * dst.h * 4);
  if (dst.w <= 0 || dst.h <= 0 || base.w <= 0 || base.h <= 0) return out;
  const ls = 1 << level;
  const W = N + 1;
  // Cells overlapping dst, and the source region they need.
  const cells: number[] = [];
  let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
  let srcArea = 0, dstArea = 0;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const k = [(j * W + i) * 2, (j * W + i + 1) * 2, ((j + 1) * W + i + 1) * 2, ((j + 1) * W + i) * 2];
      let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;
      for (const q of k) { const x = mesh[q] / ls, y = mesh[q + 1] / ls; cx0 = Math.min(cx0, x); cx1 = Math.max(cx1, x); cy0 = Math.min(cy0, y); cy1 = Math.max(cy1, y); }
      if (cx1 < dst.x - 1 || cy1 < dst.y - 1 || cx0 > dst.x + dst.w + 1 || cy0 > dst.y + dst.h + 1) continue;
      cells.push(j * N + i);
      const u0 = base.x + (base.w * i) / N, v0 = base.y + (base.h * j) / N;
      sx0 = Math.min(sx0, u0); sy0 = Math.min(sy0, v0);
      sx1 = Math.max(sx1, u0 + base.w / N); sy1 = Math.max(sy1, v0 + base.h / N);
      srcArea += (base.w / N) * (base.h / N);
      dstArea += Math.max(1e-6, (cx1 - cx0) * (cy1 - cy0));
    }
  if (!cells.length) return out;
  // Mip level for strongly minifying warps.
  const ratio = Math.sqrt(srcArea / (dstArea * ls * ls));
  const srcLevel = Math.min(8, level + (ratio > 1.5 ? Math.floor(Math.log2(ratio)) : 0));
  const ss = 1 << srcLevel;
  // Source-local rectangle at srcLevel.
  const b = src.bounds;
  const lx0 = Math.max(b.x, Math.floor(sx0 - src.ox) - 2), ly0 = Math.max(b.y, Math.floor(sy0 - src.oy) - 2);
  const lx1 = Math.min(b.x + b.w, Math.ceil(sx1 - src.ox) + 2), ly1 = Math.min(b.y + b.h, Math.ceil(sy1 - src.oy) + 2);
  if (lx1 <= lx0 || ly1 <= ly0) return out;
  const lr = { x: Math.floor(lx0 / ss), y: Math.floor(ly0 / ss), w: Math.ceil(lx1 / ss) - Math.floor(lx0 / ss), h: Math.ceil(ly1 / ss) - Math.floor(ly0 / ss) };
  if (lr.w * lr.h > 400e6) throw new Error('Warp is too large to render');
  const buf = src.raster.readFloat(lr, srcLevel);
  for (let i = 0; i < lr.w * lr.h; i++) { const a = buf[i * 4 + 3]; buf[i * 4] *= a; buf[i * 4 + 1] *= a; buf[i * 4 + 2] *= a; }
  // Base-rectangle limits in buffer coordinates (pixels outside `base` are not part of the warp).
  const bx0 = (base.x - src.ox) / ss - lr.x, by0 = (base.y - src.oy) / ss - lr.y;
  const bx1 = bx0 + base.w / ss, by1 = by0 + base.h / ss;
  // Where the envelope folds over itself the most opaque sample wins (so a transparent margin
  // never hides content folded over it).
  const written = new Uint8Array(dst.w * dst.h);
  const tmp = new Float32Array(4);
  const tri = (ax: number, ay: number, au: number, av: number, bx: number, by: number, bu: number, bv: number, cx: number, cy: number, cu: number, cv: number) => {
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) return;
    const minX = Math.max(dst.x, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(dst.x + dst.w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(dst.y, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(dst.y + dst.h - 1, Math.ceil(Math.max(ay, by, cy)));
    const eps = -1e-7;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const oi = (y - dst.y) * dst.w + (x - dst.x);
        const px = x + 0.5;
        const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        if (w0 < eps) continue;
        const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        if (w1 < eps) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < eps) continue;
        const o = oi * 4;
        if (written[oi] && out[o + 3] >= 0.999) continue;
        const su = w0 * au + w1 * bu + w2 * cu, sv = w0 * av + w1 * bv + w2 * cv;
        if (su < bx0 || sv < by0 || su > bx1 || sv > by1) { written[oi] = 1; continue; }
        // Sample in buffer coordinates (pixel-centre convention).
        if (!bilinear) {
          const ix = Math.floor(su), iy = Math.floor(sv);
          if (ix < 0 || iy < 0 || ix >= lr.w || iy >= lr.h) { tmp.fill(0); }
          else { const i = (iy * lr.w + ix) * 4; tmp[0] = buf[i]; tmp[1] = buf[i + 1]; tmp[2] = buf[i + 2]; tmp[3] = buf[i + 3]; }
        } else {
          const fu = su - 0.5, fv = sv - 0.5;
          const x0 = Math.floor(fu), y0 = Math.floor(fv), fx = fu - x0, fy = fv - y0;
          for (let c = 0; c < 4; c++) {
            const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= lr.w || yy >= lr.h ? 0 : buf[(yy * lr.w + xx) * 4 + c]);
            const p00 = at(x0, y0), p10 = at(x0 + 1, y0), p01 = at(x0, y0 + 1), p11 = at(x0 + 1, y0 + 1);
            tmp[c] = p00 + (p10 - p00) * fx + (p01 - p00) * fy + (p00 - p10 - p01 + p11) * fx * fy;
          }
        }
        if (!written[oi] || tmp[3] > out[o + 3]) { out[o] = tmp[0]; out[o + 1] = tmp[1]; out[o + 2] = tmp[2]; out[o + 3] = tmp[3]; }
        written[oi] = 1;
      }
    }
  };
  for (const c of cells) {
    const j = Math.floor(c / N), i = c % N;
    const q = [(j * W + i) * 2, (j * W + i + 1) * 2, ((j + 1) * W + i + 1) * 2, ((j + 1) * W + i) * 2];
    const d = q.map((k) => [mesh[k] / ls, mesh[k + 1] / ls]);
    const su = [i, i + 1, i + 1, i].map((ii) => (base.x + (base.w * ii) / N - src.ox) / ss - lr.x);
    const sv = [j, j, j + 1, j + 1].map((jj) => (base.y + (base.h * jj) / N - src.oy) / ss - lr.y);
    tri(d[0][0], d[0][1], su[0], sv[0], d[1][0], d[1][1], su[1], sv[1], d[2][0], d[2][1], su[2], sv[2]);
    tri(d[0][0], d[0][1], su[0], sv[0], d[2][0], d[2][1], su[2], sv[2], d[3][0], d[3][1], su[3], sv[3]);
  }
  for (let i = 0; i < dst.w * dst.h; i++) {
    const a = out[i * 4 + 3];
    if (a > 1e-6) { const k = 1 / Math.min(1, a); out[i * 4] = Math.min(1, out[i * 4] * k); out[i * 4 + 1] = Math.min(1, out[i * 4 + 1] * k); out[i * 4 + 2] = Math.min(1, out[i * 4 + 2] * k); out[i * 4 + 3] = Math.min(1, a); }
    else out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = out[i * 4 + 3] = 0;
  }
  return out;
}

/** Warps a whole layer raster (commit). Single-channel rasters (masks) keep their fill outside. */
export function meshWarpLayerRaster(raster: TiledRaster, ox: number, oy: number, base: Rect, mesh: Float64Array, bounds?: Rect | null): { raster: TiledRaster; x: number; y: number } {
  const out = new TiledRaster(raster.channels, raster.depth, raster.fill);
  const cb = bounds !== undefined ? bounds : raster.channels === 4 ? rasterContent(raster) : raster.tileBounds();
  // CMYK: the K plate is warped with plate 0's content bounds.
  if (raster.companion) out.companion = cb ? meshWarpLayerRaster(raster.companion, ox, oy, base, mesh, cb).raster : new TiledRaster(4, raster.depth, raster.fill);
  if (!cb) return { raster: out, x: 0, y: 0 };
  const nb = meshBounds(mesh);
  if (nb.w <= 0 || nb.h <= 0) return { raster: out, x: 0, y: 0 };
  if (raster.channels === 4) {
    const src: MeshSource = { raster, ox, oy, bounds: cb };
    const TS = 1024;
    for (let y = nb.y; y < nb.y + nb.h; y += TS)
      for (let x = nb.x; x < nb.x + nb.w; x += TS) {
        const r = { x, y, w: Math.min(TS, nb.x + nb.w - x), h: Math.min(TS, nb.y + nb.h - y) };
        out.writeFloat({ x: r.x - nb.x, y: r.y - nb.y, w: r.w, h: r.h }, meshWarpRegion(src, base, mesh, r));
      }
    out.compact();
    return { raster: out, x: nb.x, y: nb.y };
  }
  const tmp = new TiledRaster(4, 32, 0);
  const vals = raster.readFloat(cb);
  const rgba = new Float32Array(cb.w * cb.h * 4);
  for (let i = 0; i < vals.length; i++) { rgba[i * 4] = vals[i]; rgba[i * 4 + 3] = 1; }
  tmp.writeFloat(cb, rgba);
  const px = meshWarpRegion({ raster: tmp, ox, oy, bounds: cb }, base, mesh, nb);
  const m = new Float32Array(nb.w * nb.h);
  const f = raster.fill;
  for (let i = 0; i < m.length; i++) m[i] = f + (px[i * 4] - f) * px[i * 4 + 3];
  out.writeFloat({ x: 0, y: 0, w: nb.w, h: nb.h }, m);
  out.compact();
  return { raster: out, x: nb.x, y: nb.y };
}

/** Finds (u, v) whose envelope point is (x, y) (Newton iterations from the linear guess). */
export function inverseGrid(g: WarpGrid, base: Rect, x: number, y: number): { u: number; v: number } {
  let u = (x - base.x) / base.w, v = (y - base.y) / base.h;
  for (let it = 0; it < 16; it++) {
    const p = evalGrid(g, u, v);
    const e = 1e-4;
    const pu = evalGrid(g, u + e, v), pv = evalGrid(g, u, v + e);
    const a = (pu.x - p.x) / e, b = (pv.x - p.x) / e, c = (pu.y - p.y) / e, d = (pv.y - p.y) / e;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) break;
    const rx = x - p.x, ry = y - p.y;
    u += (d * rx - b * ry) / det;
    v += (-c * rx + a * ry) / det;
    if (rx * rx + ry * ry < 1e-6) break;
  }
  return { u, v };
}

/** Moves the envelope so the surface point at (u, v) moves by (dx, dy), changing the control points minimally. */
export function dragSurface(g: WarpGrid, u: number, v: number, dx: number, dy: number): WarpGrid {
  const bu = bern(Math.max(0, Math.min(1, u))), bv = bern(Math.max(0, Math.min(1, v)));
  let s = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) s += (bu[i] * bv[j]) ** 2;
  if (s < 1e-12) return g;
  return g.map((p, k) => {
    const w = (bu[k % 4] * bv[Math.floor(k / 4)]) / s;
    return { x: p.x + dx * w, y: p.y + dy * w };
  });
}

function rasterContent(r: TiledRaster): Rect | null {
  // Allocated tile bounds (a superset of the content; the warp only samples inside `base`).
  const tb = r.tileBounds();
  return tb && tb.w > 0 && tb.h > 0 ? tb : null;
}
