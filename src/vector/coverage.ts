/**
 * Exact-area coverage rasterizer for glyph outlines (signed-area accumulation, as in font-rs and
 * stb_truetype): every line segment adds the area it encloses to the pixels it crosses, and a
 * running sum along each row turns that into coverage. Coverage is exact for each pixel (no
 * sub-scanlines), which matters for small text. Fill rule: non-zero, with the winding magnitude
 * clamped to 1.
 */
export class CoverageRaster {
  private readonly a: Float32Array;
  private readonly stride: number;
  private cx = 0;
  private cy = 0;
  private sx = 0;
  private sy = 0;

  /** Raster covering document pixels [x0, x0 + w) × [y0, y0 + h). */
  constructor(readonly x0: number, readonly y0: number, readonly w: number, readonly h: number, readonly tolerance = 0.15) {
    this.stride = w + 3;
    this.a = new Float32Array(this.stride * h);
  }

  moveTo(x: number, y: number) { this.closePath(); this.cx = this.sx = x - this.x0; this.cy = this.sy = y - this.y0; }
  lineTo(x: number, y: number) { const nx = x - this.x0, ny = y - this.y0; this.line(this.cx, this.cy, nx, ny); this.cx = nx; this.cy = ny; }
  closePath() { if (this.cx !== this.sx || this.cy !== this.sy) this.line(this.cx, this.cy, this.sx, this.sy); this.cx = this.sx; this.cy = this.sy; }

  quadTo(cx: number, cy: number, x: number, y: number) {
    const x0 = this.cx, y0 = this.cy, x1 = cx - this.x0, y1 = cy - this.y0, x2 = x - this.x0, y2 = y - this.y0;
    const dd = Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2);
    const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(dd / (4 * this.tolerance)))));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      this.lineToLocal(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
    }
  }

  cubicTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
    const x0 = this.cx, y0 = this.cy, x1 = c1x - this.x0, y1 = c1y - this.y0, x2 = c2x - this.x0, y2 = c2y - this.y0, x3 = x - this.x0, y3 = y - this.y0;
    const dd = Math.max(Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3));
    const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt((3 * dd) / (4 * this.tolerance)))));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      this.lineToLocal(a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3);
    }
  }

  private lineToLocal(x: number, y: number) { this.line(this.cx, this.cy, x, y); this.cx = x; this.cy = y; }

  /** Adds one edge (raster-local coordinates). */
  private line(px0: number, py0: number, px1: number, py1: number) {
    if (Math.abs(py0 - py1) < 1e-9) return;
    let dir = 1;
    if (py0 > py1) { dir = -1; [px0, px1] = [px1, px0]; [py0, py1] = [py1, py0]; }
    if (py1 <= 0 || py0 >= this.h) return;
    const dxdy = (px1 - px0) / (py1 - py0);
    const W = this.w;
    // Columns left of the raster collapse onto column 0, right of it onto the padding (the
    // running sum is per row, so both stay correct).
    const clampX = (v: number) => (v < 0 ? 0 : v > W + 1 ? W + 1 : v);
    let x = px0;
    if (py0 < 0) x -= py0 * dxdy;
    const yStart = Math.max(0, Math.floor(py0));
    const yEnd = Math.min(this.h, Math.ceil(py1));
    const a = this.a, stride = this.stride;
    for (let y = yStart; y < yEnd; y++) {
      const dy = Math.min(y + 1, py1) - Math.max(y, py0);
      const xnext = x + dxdy * dy;
      const d = dy * dir;
      const xa = clampX(Math.min(x, xnext)), xb = clampX(Math.max(x, xnext));
      const row = y * stride;
      const x0f = Math.floor(xa), x0i = x0f, x1c = Math.ceil(xb), x1i = x1c;
      if (x1i <= x0i + 1) {
        const xmf = 0.5 * (clampX(x) + clampX(xnext)) - x0f;
        a[row + x0i] += d - d * xmf;
        a[row + x0i + 1] += d * xmf;
      } else {
        const s = 1 / (xb - xa);
        const fx0 = xa - x0f;
        const a0 = 0.5 * s * (1 - fx0) * (1 - fx0);
        const fx1 = xb - x1c + 1;
        const am = 0.5 * s * fx1 * fx1;
        a[row + x0i] += d * a0;
        if (x1i === x0i + 2) a[row + x0i + 1] += d * (1 - a0 - am);
        else {
          const a1 = s * (1.5 - fx0);
          a[row + x0i + 1] += d * (a1 - a0);
          for (let xi = x0i + 2; xi < x1i - 1; xi++) a[row + xi] += d * s;
          const a2 = a1 + (x1i - x0i - 3) * s;
          a[row + x1i - 1] += d * (1 - a2 - am);
        }
        a[row + x1i] += d * am;
      }
      x = xnext;
    }
  }

  /** Coverage 0..1 per pixel, row-major w × h. */
  coverage(): Float32Array {
    this.closePath();
    const out = new Float32Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) {
      let acc = 0;
      const row = y * this.stride;
      for (let x = 0; x < this.w; x++) {
        acc += this.a[row + x];
        const v = Math.abs(acc);
        out[y * this.w + x] = v > 1 ? 1 : v;
      }
    }
    return out;
  }
}
