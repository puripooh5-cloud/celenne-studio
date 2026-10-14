/**
 * Liquify engine.
 *
 * The distortion is a backward displacement field D defined on a proxy grid covering the edit
 * region: output(p) = source(p + D(p)). Every brush tool computes, per affected grid point, the
 * point q the output should now come from and composes the fields: D'(p) = D(q) + (q − p).
 * The field is edited at proxy resolution for interactivity; applying it upsamples D bilinearly to
 * full resolution and resamples the original pixels once (no accumulated resampling blur).
 * A freeze mask (0..1) protects areas from every tool except Thaw.
 */

export type LiquifyTool = 'forwardWarp' | 'reconstruct' | 'smooth' | 'twirlCW' | 'twirlCCW' | 'pucker' | 'bloat' | 'pushLeft' | 'freeze' | 'thaw';

export const LIQUIFY_TOOLS: { id: LiquifyTool; label: string; key: string }[] = [
  { id: 'forwardWarp', label: 'Forward Warp', key: 'W' },
  { id: 'reconstruct', label: 'Reconstruct', key: 'R' },
  { id: 'smooth', label: 'Smooth', key: 'E' },
  { id: 'twirlCW', label: 'Twirl Clockwise', key: 'C' },
  { id: 'twirlCCW', label: 'Twirl Counterclockwise', key: 'Shift+C' },
  { id: 'pucker', label: 'Pucker', key: 'S' },
  { id: 'bloat', label: 'Bloat', key: 'B' },
  { id: 'pushLeft', label: 'Push Left', key: 'O' },
  { id: 'freeze', label: 'Freeze Mask', key: 'F' },
  { id: 'thaw', label: 'Thaw Mask', key: 'D' },
];

export interface LiquifyBrush {
  /** Diameter in proxy pixels. */
  size: number;
  /** 0..1 — strength of each application. */
  pressure: number;
  /** 0..1 — how much the edge of the brush is feathered (1 = soft falloff over whole radius). */
  density: number;
  /** 0..1 — speed of stationary tools (twirl / pucker / bloat / reconstruct) per tick. */
  rate: number;
  /** 0..1 — random jitter added to forward-warp displacement. */
  turbulence: number;
}

export const DEFAULT_LIQUIFY_BRUSH: LiquifyBrush = { size: 100, pressure: 0.5, density: 0.5, rate: 0.5, turbulence: 0 };

export class LiquifyMesh {
  readonly dx: Float32Array;
  readonly dy: Float32Array;
  readonly freeze: Float32Array;
  private seed = 1;

  constructor(readonly w: number, readonly h: number) {
    this.dx = new Float32Array(w * h);
    this.dy = new Float32Array(w * h);
    this.freeze = new Float32Array(w * h);
  }

  snapshot(): { dx: Float32Array; dy: Float32Array; freeze: Float32Array } {
    return { dx: this.dx.slice(), dy: this.dy.slice(), freeze: this.freeze.slice() };
  }

  restore(s: { dx: Float32Array; dy: Float32Array; freeze: Float32Array }): void {
    this.dx.set(s.dx);
    this.dy.set(s.dy);
    this.freeze.set(s.freeze);
  }

  isIdentity(): boolean {
    for (let i = 0; i < this.dx.length; i++) if (this.dx[i] !== 0 || this.dy[i] !== 0) return false;
    return true;
  }

  maxDisplacement(): number {
    let m = 0;
    for (let i = 0; i < this.dx.length; i++) m = Math.max(m, Math.abs(this.dx[i]), Math.abs(this.dy[i]));
    return m;
  }

  /** Bilinear sample of the displacement field (clamped to the grid). */
  sample(x: number, y: number, out: [number, number]): [number, number] {
    const { w, h } = this;
    x = Math.max(0, Math.min(w - 1, x));
    y = Math.max(0, Math.min(h - 1, y));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const i00 = y0 * w + x0, i10 = y0 * w + x1, i01 = y1 * w + x0, i11 = y1 * w + x1;
    const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
    out[0] = this.dx[i00] * a + this.dx[i10] * b + this.dx[i01] * c + this.dx[i11] * d;
    out[1] = this.dy[i00] * a + this.dy[i10] * b + this.dy[i01] * c + this.dy[i11] * d;
    return out;
  }

  private falloff(dist: number, radius: number, density: number): number {
    if (dist >= radius) return 0;
    const t = dist / radius;
    // density 0 = hard brush, 1 = smooth over the full radius.
    const hard = Math.max(0.0001, 1 - density);
    if (t <= hard) return 1;
    const u = (t - hard) / (1 - hard);
    return 0.5 * (1 + Math.cos(Math.PI * u));
  }

  private rand(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff - 0.5;
  }

  /**
   * Applies one brush step at (cx, cy). `prev` is the previous brush position (for directional
   * tools); stationary tools use `rate` per call. Returns the dirty rect on the grid.
   */
  apply(tool: LiquifyTool, cx: number, cy: number, prev: { x: number; y: number } | null, b: LiquifyBrush): { x: number; y: number; w: number; h: number } | null {
    const r = Math.max(1, b.size / 2);
    const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(this.w - 1, Math.ceil(cx + r)), y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    if (x1 < x0 || y1 < y0) return null;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const mdx = prev ? cx - prev.x : 0, mdy = prev ? cy - prev.y : 0;

    if (tool === 'freeze' || tool === 'thaw') {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const f = this.falloff(Math.hypot(x - cx, y - cy), r, b.density) * b.pressure;
          if (f <= 0) continue;
          const i = y * this.w + x;
          this.freeze[i] = tool === 'freeze' ? Math.min(1, this.freeze[i] + f) : Math.max(0, this.freeze[i] - f);
        }
      return { x: x0, y: y0, w: bw, h: bh };
    }
    if ((tool === 'forwardWarp' || tool === 'pushLeft') && mdx === 0 && mdy === 0) return null;

    // Read from a copy so each point composes against the field before this dab.
    const ndx = new Float32Array(bw * bh), ndy = new Float32Array(bw * bh);
    const tmp: [number, number] = [0, 0];
    const rate = b.rate * 0.12;
    let avgX = 0, avgY = 0;
    if (tool === 'smooth') {
      // Local average of the field under the brush (weighted).
      let sw = 0;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const f = this.falloff(Math.hypot(x - cx, y - cy), r, 1);
          const i = y * this.w + x;
          avgX += this.dx[i] * f; avgY += this.dy[i] * f; sw += f;
        }
      if (sw > 0) { avgX /= sw; avgY /= sw; }
    }
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * this.w + x;
        const j = (y - y0) * bw + (x - x0);
        let f = this.falloff(Math.hypot(x - cx, y - cy), r, b.density) * b.pressure * (1 - this.freeze[i]);
        ndx[j] = this.dx[i];
        ndy[j] = this.dy[i];
        if (f <= 0) continue;
        let qx = x, qy = y;
        switch (tool) {
          case 'forwardWarp': {
            const t = b.turbulence;
            qx = x - mdx * f * (1 + t * this.rand() * 2);
            qy = y - mdy * f * (1 + t * this.rand() * 2);
            break;
          }
          case 'pushLeft': {
            // Content is pushed to the left of the stroke direction.
            qx = x - mdy * f;
            qy = y + mdx * f;
            break;
          }
          case 'twirlCW':
          case 'twirlCCW': {
            const ang = (tool === 'twirlCW' ? -1 : 1) * f * rate * 1.5;
            const ox = x - cx, oy = y - cy;
            const cs = Math.cos(ang), sn = Math.sin(ang);
            qx = cx + ox * cs - oy * sn;
            qy = cy + ox * sn + oy * cs;
            break;
          }
          case 'pucker':
          case 'bloat': {
            const k = (tool === 'pucker' ? 1 : -1) * f * rate;
            qx = x + (x - cx) * k;
            qy = y + (y - cy) * k;
            break;
          }
          case 'reconstruct': {
            f *= rate * 2;
            ndx[j] = this.dx[i] * (1 - Math.min(1, f));
            ndy[j] = this.dy[i] * (1 - Math.min(1, f));
            continue;
          }
          case 'smooth': {
            f = Math.min(1, f * rate * 3);
            ndx[j] = this.dx[i] + (avgX - this.dx[i]) * f;
            ndy[j] = this.dy[i] + (avgY - this.dy[i]) * f;
            continue;
          }
        }
        this.sample(qx, qy, tmp);
        ndx[j] = tmp[0] + (qx - x);
        ndy[j] = tmp[1] + (qy - y);
      }
    for (let y = 0; y < bh; y++) {
      this.dx.set(ndx.subarray(y * bw, (y + 1) * bw), (y + y0) * this.w + x0);
      this.dy.set(ndy.subarray(y * bw, (y + 1) * bw), (y + y0) * this.w + x0);
    }
    return { x: x0, y: y0, w: bw, h: bh };
  }

  /** Reconstructs the whole field by `amount` (0..1), respecting frozen areas. */
  reconstructAll(amount: number): void {
    for (let i = 0; i < this.dx.length; i++) {
      const k = 1 - amount * (1 - this.freeze[i]);
      this.dx[i] *= k;
      this.dy[i] *= k;
    }
  }

  resetField(): void {
    this.dx.fill(0);
    this.dy.fill(0);
  }

  invertFreeze(): void {
    for (let i = 0; i < this.freeze.length; i++) this.freeze[i] = 1 - this.freeze[i];
  }
}

/**
 * Warps a straight-alpha RGBA float image with a displacement field.
 * `scale` = image px per grid px; the image and the grid share the same origin.
 */
export function warpWithField(src: Float32Array, w: number, h: number, mesh: LiquifyMesh, scale: number, region = { x: 0, y: 0, w, h }): Float32Array {
  const out = new Float32Array(region.w * region.h * 4);
  const tmp: [number, number] = [0, 0];
  const inv = 1 / scale;
  for (let y = 0; y < region.h; y++) {
    const py = y + region.y;
    for (let x = 0; x < region.w; x++) {
      const px = x + region.x;
      mesh.sample((px + 0.5) * inv - 0.5, (py + 0.5) * inv - 0.5, tmp);
      const sx = px + tmp[0] * scale, sy = py + tmp[1] * scale;
      sampleBilinearPremul(src, w, h, sx, sy, out, (y * region.w + x) * 4);
    }
  }
  return out;
}

/** Bilinear sample in premultiplied space, written back as straight alpha. Outside = transparent. */
export function sampleBilinearPremul(src: Float32Array, w: number, h: number, x: number, y: number, out: Float32Array, o: number): void {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let r = 0, g = 0, b = 0, a = 0;
  for (let k = 0; k < 4; k++) {
    const xx = x0 + (k & 1), yy = y0 + (k >> 1);
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const wt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
    if (wt === 0) continue;
    const i = (yy * w + xx) * 4;
    const al = src[i + 3] * wt;
    r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al;
  }
  if (a > 1e-7) {
    out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; out[o + 3] = Math.min(1, a);
  } else {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
  }
}
