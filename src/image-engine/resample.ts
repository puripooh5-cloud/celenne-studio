/**
 * Geometric resampling: perspective/affine warps and resizing.
 * Interpolation happens on premultiplied values (no dark halos at edges). When the transform
 * minifies, sampling uses the raster's mip pyramid so downscaling does not alias.
 */
import type { Homography } from './matrix';
import { applyH } from './matrix';
import type { Rect } from './rect';
import type { TiledRaster } from './tiledRaster';

export type Interpolation = 'nearest' | 'bilinear' | 'bicubic';

function cubic(t: number): [number, number, number, number] {
  // Catmull-Rom (a = -0.5)
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}

/** Samples a premultiplied RGBA float image at (u, v) (pixel-center coordinates). */
function sample(src: Float32Array, w: number, h: number, u: number, v: number, interp: Interpolation, out: Float32Array, o: number): void {
  if (interp === 'nearest') {
    const x = Math.floor(u + 0.5), y = Math.floor(v + 0.5);
    if (x < 0 || y < 0 || x >= w || y >= h) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; return; }
    const i = (y * w + x) * 4;
    out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; out[o + 3] = src[i + 3];
    return;
  }
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const fx = u - x0, fy = v - y0;
  const px = (x: number, y: number, c: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[(y * w + x) * 4 + c]);
  if (interp === 'bilinear') {
    for (let c = 0; c < 4; c++) {
      const a = px(x0, y0, c), b = px(x0 + 1, y0, c), cc = px(x0, y0 + 1, c), d = px(x0 + 1, y0 + 1, c);
      out[o + c] = a + (b - a) * fx + (cc - a) * fy + (a - b - cc + d) * fx * fy;
    }
    return;
  }
  const wx = cubic(fx), wy = cubic(fy);
  for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let j = 0; j < 4; j++) {
      let row = 0;
      for (let i = 0; i < 4; i++) row += px(x0 - 1 + i, y0 - 1 + j, c) * wx[i];
      s += row * wy[j];
    }
    out[o + c] = s;
  }
  // Cubic overshoot clamp (premultiplied invariant: color <= alpha).
  const a = Math.max(0, Math.min(1, out[o + 3]));
  out[o + 3] = a;
  for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(a, out[o + c]));
}

/** Approximate linear scale of a homography at a point (for mip level selection). */
function localScale(h: Homography, x: number, y: number): number {
  const p = applyH(h, x, y), px = applyH(h, x + 1, y), py = applyH(h, x, y + 1);
  const ax = px.x - p.x, ay = px.y - p.y, bx = py.x - p.x, by = py.y - p.y;
  return Math.sqrt(Math.abs(ax * by - ay * bx));
}

/**
 * Warps a raster into `dst` (document px) using `inv` (document → source-local mapping).
 * `srcBounds` limits sampling to the source content. Returns straight RGBA floats.
 */
export function warpRaster(src: TiledRaster, srcBounds: Rect, inv: Homography, dst: Rect, interp: Interpolation = 'bicubic', shouldCancel?: () => boolean): Float32Array {
  const out = new Float32Array(dst.w * dst.h * 4);
  if (dst.w <= 0 || dst.h <= 0 || srcBounds.w <= 0 || srcBounds.h <= 0) return out;
  // Source pixels per destination pixel.
  const cx = dst.x + dst.w / 2, cy = dst.y + dst.h / 2;
  const scale = localScale(inv, cx, cy);
  const level = scale > 1.5 ? Math.min(8, Math.floor(Math.log2(scale))) : 0;
  const ls = 1 << level;
  // Source region needed (in source-local px), mapped from destination corners.
  const corners = [applyH(inv, dst.x, dst.y), applyH(inv, dst.x + dst.w, dst.y), applyH(inv, dst.x + dst.w, dst.y + dst.h), applyH(inv, dst.x, dst.y + dst.h)];
  let x0 = Math.floor(Math.min(...corners.map((c) => c.x))) - 3, y0 = Math.floor(Math.min(...corners.map((c) => c.y))) - 3;
  let x1 = Math.ceil(Math.max(...corners.map((c) => c.x))) + 3, y1 = Math.ceil(Math.max(...corners.map((c) => c.y))) + 3;
  x0 = Math.max(x0, srcBounds.x - 2); y0 = Math.max(y0, srcBounds.y - 2);
  x1 = Math.min(x1, srcBounds.x + srcBounds.w + 2); y1 = Math.min(y1, srcBounds.y + srcBounds.h + 2);
  if (x1 <= x0 || y1 <= y0) return out;
  const lr = { x: Math.floor(x0 / ls), y: Math.floor(y0 / ls), w: Math.ceil(x1 / ls) - Math.floor(x0 / ls), h: Math.ceil(y1 / ls) - Math.floor(y0 / ls) };
  // Guard against pathological (near-singular) transforms.
  if (lr.w * lr.h > 400e6) throw new Error('Transform is too extreme to render');
  const buf = src.readFloat(lr, level);
  const n = lr.w * lr.h;
  for (let i = 0; i < n; i++) {
    const a = buf[i * 4 + 3];
    buf[i * 4] *= a; buf[i * 4 + 1] *= a; buf[i * 4 + 2] *= a;
  }
  for (let y = 0; y < dst.h; y++) {
    if ((y & 63) === 0 && shouldCancel?.()) throw new Error('Cancelled');
    for (let x = 0; x < dst.w; x++) {
      const p = applyH(inv, dst.x + x + 0.5, dst.y + y + 0.5);
      const u = p.x / ls - lr.x - 0.5, v = p.y / ls - lr.y - 0.5;
      const o = (y * dst.w + x) * 4;
      sample(buf, lr.w, lr.h, u, v, interp, out, o);
      const a = out[o + 3];
      if (a > 1e-6) { const k = 1 / a; out[o] *= k; out[o + 1] *= k; out[o + 2] *= k; } else out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    }
  }
  return out;
}

/** Resizes a straight RGBA float image (area averaging for downscale, bicubic for upscale). */
export function resizeImage(src: Float32Array, sw: number, sh: number, dw: number, dh: number, interp: Interpolation = 'bicubic', ch = 4): Float32Array {
  const out = new Float32Array(dw * dh * ch);
  const premul = ch === 4;
  const s = src.slice();
  if (premul) for (let i = 0; i < sw * sh; i++) { const a = s[i * 4 + 3]; s[i * 4] *= a; s[i * 4 + 1] *= a; s[i * 4 + 2] *= a; }
  const sx = sw / dw, sy = sh / dh;
  if ((sx > 1 || sy > 1) && interp !== 'nearest') {
    // Box filter over the source footprint (exact area average).
    for (let y = 0; y < dh; y++) {
      const fy0 = y * sy, fy1 = (y + 1) * sy;
      for (let x = 0; x < dw; x++) {
        const fx0 = x * sx, fx1 = (x + 1) * sx;
        const acc = new Float64Array(ch);
        let wsum = 0;
        for (let yy = Math.floor(fy0); yy < Math.ceil(fy1); yy++) {
          const wy = Math.min(fy1, yy + 1) - Math.max(fy0, yy);
          for (let xx = Math.floor(fx0); xx < Math.ceil(fx1); xx++) {
            const wx = Math.min(fx1, xx + 1) - Math.max(fx0, xx);
            const w = wx * wy;
            const i = (Math.min(sh - 1, yy) * sw + Math.min(sw - 1, xx)) * ch;
            for (let c = 0; c < ch; c++) acc[c] += s[i + c] * w;
            wsum += w;
          }
        }
        for (let c = 0; c < ch; c++) out[(y * dw + x) * ch + c] = acc[c] / wsum;
      }
    }
  } else {
    const tmp = new Float32Array(4);
    for (let y = 0; y < dh; y++)
      for (let x = 0; x < dw; x++) {
        const u = (x + 0.5) * sx - 0.5, v = (y + 0.5) * sy - 0.5;
        if (ch === 4) sample(s, sw, sh, Math.max(0, Math.min(sw - 1, u)), Math.max(0, Math.min(sh - 1, v)), interp, out, (y * dw + x) * 4);
        else {
          const tmpSrc = s;
          const x0 = Math.max(0, Math.min(sw - 1, Math.floor(u))), y0 = Math.max(0, Math.min(sh - 1, Math.floor(v)));
          const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
          const fx = Math.max(0, Math.min(1, u - x0)), fy = Math.max(0, Math.min(1, v - y0));
          const a = tmpSrc[y0 * sw + x0], b = tmpSrc[y0 * sw + x1], c = tmpSrc[y1 * sw + x0], d = tmpSrc[y1 * sw + x1];
          out[y * dw + x] = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
          void tmp;
        }
      }
  }
  if (premul) for (let i = 0; i < dw * dh; i++) { const a = out[i * 4 + 3]; if (a > 1e-6) { out[i * 4] /= a; out[i * 4 + 1] /= a; out[i * 4 + 2] /= a; } }
  return out;
}
