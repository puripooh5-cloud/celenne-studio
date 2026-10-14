/**
 * Stroke operations: how a dab's coverage modifies the target raster.
 * All operations read from `original` (the target as it was when the stroke began, shared
 * copy-on-write) where the stroke must not compound, and from the live target where it must
 * (blur, smudge, dodge...).
 */
import type { Dab } from './engine';
import type { Rect } from '../image-engine/rect';
import { expand, intersect, isEmpty, translate, union } from '../image-engine/rect';
import { TiledRaster } from '../image-engine/tiledRaster';
import type { ResolvedTarget } from '../commands/rasterTarget';
import type { Selection } from '../selection/selection';
import { BlendMode, blendStraightPixel } from '../image-engine/blend';
import { boxBlur } from '../image-engine/blur';
import { rgbToHsl, hslToRgb } from '../color/convert';
import type { RGB } from '../color/types';
import type { PatternDef } from '../document/types';

export interface StrokeContext {
  target: ResolvedTarget;
  original: TiledRaster;
  selection: Selection | null;
  canvas: Rect;
  lockAlpha: boolean;
}

const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

export abstract class StrokeOp {
  dirty: Rect | null = null;
  constructor(protected ctx: StrokeContext) {}

  /** Applies a dab whose coverage `cov` covers document rect `r`. */
  apply(d: Dab, cov: Float32Array, r: Rect): void {
    // Clip to canvas for selection-driven targets; layers may extend beyond the canvas.
    let rr = r;
    if (this.ctx.target.channels === 1 || this.ctx.selection) rr = intersect(r, expand(this.ctx.canvas, 0));
    if (isEmpty(rr)) return;
    const c = rr === r ? cov : subCov(cov, r, rr);
    const sel = this.ctx.selection && !this.ctx.selection.isEmpty() ? this.ctx.selection.read(rr) : null;
    if (sel) for (let i = 0; i < c.length; i++) c[i] *= sel[i];
    this.dab(d, c, rr);
    this.dirty = union(this.dirty, rr);
  }

  protected local(r: Rect): Rect {
    return translate(r, -this.ctx.target.x, -this.ctx.target.y);
  }

  protected abstract dab(d: Dab, cov: Float32Array, r: Rect): void;
}

function subCov(cov: Float32Array, r: Rect, sub: Rect): Float32Array {
  const out = new Float32Array(sub.w * sub.h);
  for (let y = 0; y < sub.h; y++) {
    const so = (y + sub.y - r.y) * r.w + (sub.x - r.x);
    out.set(cov.subarray(so, so + sub.w), y * sub.w);
  }
  return out;
}

/** Brush / pencil / eraser (and painting into masks, channels, quick mask). */
export class PaintOp extends StrokeOp {
  private stroke = new TiledRaster(1, 32, 0);
  constructor(
    ctx: StrokeContext,
    private color: RGB,
    private mode: BlendMode,
    private erase: boolean,
    private eraseColor: RGB,
  ) {
    super(ctx);
  }

  protected dab(d: Dab, cov: Float32Array, r: Rect): void {
    const lr = this.local(r);
    const t = this.ctx.target;
    const orig = this.ctx.original.readFloat(lr);
    const S = this.stroke.readFloat(lr);
    const n = r.w * r.h;
    for (let i = 0; i < n; i++) {
      const c = cov[i] * d.flow;
      if (c > 0) S[i] = S[i] + (1 - S[i]) * c;
    }
    this.stroke.writeFloat(lr, S);
    const out = orig; // reuse buffer
    if (t.channels === 1) {
      const src = this.erase ? this.eraseColor : this.color;
      const g = lum(src.r, src.g, src.b);
      for (let i = 0; i < n; i++) {
        const e = S[i] * d.opacity;
        if (e > 0) out[i] = out[i] + (g - out[i]) * e;
      }
    } else if (this.erase && !this.ctx.lockAlpha) {
      for (let i = 0; i < n; i++) {
        const e = S[i] * d.opacity;
        if (e > 0) out[i * 4 + 3] *= 1 - e;
      }
    } else {
      const col = this.erase ? this.eraseColor : this.color;
      for (let i = 0; i < n; i++) {
        const e = S[i] * d.opacity;
        if (e > 0) blendStraightPixel(this.mode, out, i * 4, col.r, col.g, col.b, e, this.ctx.lockAlpha);
      }
    }
    t.raster.writeFloat(lr, out);
  }
}

export type SourceSampler = (docRect: Rect) => Float32Array;

/** Clone Stamp (and the sampling half of the Healing Brush). */
export class CloneOp extends StrokeOp {
  constructor(
    ctx: StrokeContext,
    private sample: SourceSampler,
    private dx: number,
    private dy: number,
    private heal: boolean,
  ) {
    super(ctx);
  }

  protected dab(d: Dab, cov: Float32Array, r: Rect): void {
    const t = this.ctx.target;
    if (t.channels !== 4) return;
    const lr = this.local(r);
    const cur = t.raster.readFloat(lr);
    let src = this.sample(translate(r, this.dx, this.dy));
    if (this.heal) src = healColors(src, this.ctx.original.readFloat(lr), r.w, r.h, Math.max(2, d.radius / 2));
    const n = r.w * r.h;
    for (let i = 0; i < n; i++) {
      const e = cov[i] * d.flow * d.opacity;
      if (e <= 0 || src[i * 4 + 3] <= 0) continue;
      blendStraightPixel('normal', cur, i * 4, src[i * 4], src[i * 4 + 1], src[i * 4 + 2], e * src[i * 4 + 3], this.ctx.lockAlpha);
    }
    t.raster.writeFloat(lr, cur);
  }
}

/** Transfers low-frequency color of the destination onto the source texture (Poisson-like). */
export function healColors(src: Float32Array, dst: Float32Array, w: number, h: number, radius: number): Float32Array {
  const bs = src.slice(), bd = dst.slice();
  boxBlur(bs, w, h, 4, radius);
  boxBlur(bs, w, h, 4, radius);
  boxBlur(bd, w, h, 4, radius);
  boxBlur(bd, w, h, 4, radius);
  const out = new Float32Array(src.length);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(1, src[i * 4 + c] - bs[i * 4 + c] + bd[i * 4 + c]));
    out[i * 4 + 3] = Math.max(src[i * 4 + 3], dst[i * 4 + 3]);
  }
  return out;
}

export class PatternStampOp extends StrokeOp {
  private cache: Float32Array;
  constructor(
    ctx: StrokeContext,
    private pattern: PatternDef,
  ) {
    super(ctx);
    this.cache = pattern.raster.readFloat({ x: 0, y: 0, w: pattern.width, h: pattern.height });
  }
  protected dab(d: Dab, cov: Float32Array, r: Rect): void {
    const t = this.ctx.target;
    const lr = this.local(r);
    const cur = t.raster.readFloat(lr);
    const p = this.pattern;
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        const i = y * r.w + x;
        const e = cov[i] * d.flow * d.opacity;
        if (e <= 0) continue;
        const px = (((r.x + x) % p.width) + p.width) % p.width, py = (((r.y + y) % p.height) + p.height) % p.height;
        const si = (py * p.width + px) * 4;
        if (t.channels === 4) blendStraightPixel('normal', cur, i * 4, this.cache[si], this.cache[si + 1], this.cache[si + 2], e * this.cache[si + 3], this.ctx.lockAlpha);
        else cur[i] += (lum(this.cache[si], this.cache[si + 1], this.cache[si + 2]) - cur[i]) * e;
      }
    t.raster.writeFloat(lr, cur);
  }
}

/** Blur / Sharpen tools. */
export class FocusOp extends StrokeOp {
  constructor(
    ctx: StrokeContext,
    private sharpen: boolean,
    private strength: number,
  ) {
    super(ctx);
  }
  protected dab(d: Dab, cov: Float32Array, r: Rect): void {
    const t = this.ctx.target;
    const ch = t.channels;
    const pad = 3;
    const pr = expand(r, pad);
    const lpr = this.local(pr);
    const cur = t.raster.readFloat(lpr);
    const blurred = cur.slice();
    boxBlur(blurred, pr.w, pr.h, ch, 1.5);
    const out = t.raster.readFloat(this.local(r));
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        const i = y * r.w + x;
        const e = cov[i] * d.flow * this.strength * 0.5;
        if (e <= 0) continue;
        const pi = ((y + pad) * pr.w + (x + pad)) * ch;
        for (let c = 0; c < ch; c++) {
          if (ch === 4 && c === 3 && this.sharpen) continue;
          const v = cur[pi + c], b = blurred[pi + c];
          const target = this.sharpen ? v + (v - b) * 1.5 : b;
          out[i * ch + c] = Math.max(0, Math.min(1, v + (target - v) * e));
        }
      }
    t.raster.writeFloat(this.local(r), out);
  }
}

/** Smudge: drags color from the previous dab. */
export class SmudgeOp extends StrokeOp {
  private carried: Float32Array | null = null;
  private carriedRect: Rect | null = null;
  constructor(
    ctx: StrokeContext,
    private strength: number,
    private fingerColor: RGB | null,
  ) {
    super(ctx);
  }
  protected dab(d: Dab, cov: Float32Array, r: Rect): void {
    const t = this.ctx.target;
    const ch = t.channels;
    const lr = this.local(r);
    const cur = t.raster.readFloat(lr);
    if (!this.carried || !this.carriedRect || this.carriedRect.w !== r.w || this.carriedRect.h !== r.h) {
      this.carried = cur.slice();
      if (this.fingerColor && ch === 4) for (let i = 0; i < r.w * r.h; i++) { this.carried[i * 4] = this.fingerColor.r; this.carried[i * 4 + 1] = this.fingerColor.g; this.carried[i * 4 + 2] = this.fingerColor.b; this.carried[i * 4 + 3] = 1; }
      this.carriedRect = r;
      return;
    }
    const k = this.strength;
    for (let i = 0; i < r.w * r.h; i++) {
      const e = cov[i] * k;
      if (e <= 0) continue;
      for (let c = 0; c < ch; c++) {
        const v = cur[i * ch + c] + (this.carried[i * ch + c] - cur[i * ch + c]) * e;
        cur[i * ch + c] = v;
        this.carried[i * ch + c] = this.carried[i * ch + c] + (v - this.carried[i * ch + c]) * (1 - k);
      }
    }
    this.carriedRect = r;
    t.raster.writeFloat(lr, cur);
  }
}

/**
 * Mixer Brush: the brush holds a per-pixel reservoir of wet paint (loaded with the foreground
 * color, or empty when "clean"). Each dab picks up canvas paint into the reservoir (Wet),
 * deposits a blend of reservoir and canvas (Mix) and slowly runs dry (Load). Colors are mixed
 * premultiplied so transparent areas mix correctly.
 */
export class MixerOp extends StrokeOp {
  private reservoir: Float32Array | null = null;
  private resRect: Rect | null = null;
  private remaining = 1;
  constructor(
    ctx: StrokeContext,
    private loadColor: RGB | null,
    private wet: number,
    private load: number,
    private mix: number,
    private flow: number,
    private sampler: ((r: Rect) => Float32Array) | null,
  ) {
    super(ctx);
  }
  protected dab(_d: Dab, cov: Float32Array, r: Rect): void {
    const t = this.ctx.target;
    if (t.channels !== 4) return;
    const lr = this.local(r);
    const cur = t.raster.readFloat(lr);
    const src = this.sampler ? this.sampler(r) : cur;
    const n = r.w * r.h;
    // Premultiplied canvas colors (the sampled source may be all layers).
    const canvas = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { const a = src[i * 4 + 3]; canvas[i * 4] = src[i * 4] * a; canvas[i * 4 + 1] = src[i * 4 + 1] * a; canvas[i * 4 + 2] = src[i * 4 + 2] * a; canvas[i * 4 + 3] = a; }
    if (!this.reservoir || !this.resRect || this.resRect.w !== r.w || this.resRect.h !== r.h) {
      const res = new Float32Array(n * 4);
      if (this.loadColor) for (let i = 0; i < n; i++) { res[i * 4] = this.loadColor.r; res[i * 4 + 1] = this.loadColor.g; res[i * 4 + 2] = this.loadColor.b; res[i * 4 + 3] = 1; }
      else res.set(canvas);
      this.reservoir = res;
    }
    const res = this.reservoir;
    const dry = this.loadColor ? this.remaining : 1;
    for (let i = 0; i < n; i++) {
      const e = cov[i];
      if (e <= 0) continue;
      const o = i * 4;
      // Pick up wet paint from the canvas into the brush.
      const pick = this.wet * e;
      for (let c = 0; c < 4; c++) res[o + c] += (canvas[o + c] - res[o + c]) * pick;
      // Deposit: reservoir mixed with the canvas, scaled by flow and how much paint is left.
      const k = e * this.flow * dry;
      const ca = cur[o + 3];
      const pm = [cur[o] * ca, cur[o + 1] * ca, cur[o + 2] * ca, ca];
      for (let c = 0; c < 4; c++) {
        const paint = res[o + c] * (1 - this.mix) + canvas[o + c] * this.mix;
        pm[c] += (paint - pm[c]) * k;
      }
      const a = Math.max(0, Math.min(1, pm[3]));
      cur[o + 3] = a;
      for (let c = 0; c < 3; c++) cur[o + c] = a > 1e-6 ? Math.max(0, Math.min(1, pm[c] / a)) : 0;
    }
    this.resRect = r;
    // Paint runs dry: a full load (1) lasts, a small load fades quickly.
    this.remaining *= 1 - (1 - this.load) * 0.08;
    t.raster.writeFloat(lr, cur);
  }
}

/** Dodge / Burn / Sponge. */
export class ToneOp extends StrokeOp {
  constructor(
    ctx: StrokeContext,
    private kind: 'dodge' | 'burn' | 'sponge',
    private range: 'shadows' | 'midtones' | 'highlights',
    private exposure: number,
    private spongeMode: 'saturate' | 'desaturate',
  ) {
    super(ctx);
  }
  protected dab(d: Dab, cov: Float32Array, r: Rect): void {
    const t = this.ctx.target;
    if (t.channels !== 4) return;
    const lr = this.local(r);
    const cur = t.raster.readFloat(lr);
    for (let i = 0; i < r.w * r.h; i++) {
      const e = cov[i] * d.flow * this.exposure * 0.25;
      if (e <= 0 || cur[i * 4 + 3] <= 0) continue;
      const o = i * 4;
      if (this.kind === 'sponge') {
        const hsl = rgbToHsl({ r: cur[o], g: cur[o + 1], b: cur[o + 2] });
        hsl.s = this.spongeMode === 'saturate' ? hsl.s + (1 - hsl.s) * e : hsl.s * (1 - e);
        const c = hslToRgb(hsl);
        cur[o] = c.r; cur[o + 1] = c.g; cur[o + 2] = c.b;
        continue;
      }
      const L = lum(cur[o], cur[o + 1], cur[o + 2]);
      const w = this.range === 'shadows' ? (1 - L) * (1 - L) : this.range === 'highlights' ? L * L : 1 - Math.abs(L - 0.5) * 2;
      const k = e * Math.max(0, w);
      for (let c = 0; c < 3; c++) {
        const v = cur[o + c];
        cur[o + c] = this.kind === 'dodge' ? v + (1 - v) * k : v * (1 - k);
      }
    }
    t.raster.writeFloat(lr, cur);
  }
}

/** Color Replacement: hue/saturation of the foreground, luminosity of the image, within tolerance. */
export class ColorReplaceOp extends StrokeOp {
  private sampled: RGB | null = null;
  constructor(
    ctx: StrokeContext,
    private color: RGB,
    private tolerance: number,
  ) {
    super(ctx);
  }
  protected dab(d: Dab, cov: Float32Array, r: Rect): void {
    const t = this.ctx.target;
    if (t.channels !== 4) return;
    const lr = this.local(r);
    const cur = t.raster.readFloat(lr);
    if (!this.sampled) {
      const c = this.ctx.original.readFloat({ x: Math.floor(d.x) - t.x, y: Math.floor(d.y) - t.y, w: 1, h: 1 });
      this.sampled = { r: c[0], g: c[1], b: c[2] };
    }
    const s = this.sampled;
    const tol = this.tolerance / 100;
    const target = rgbToHsl(this.color);
    for (let i = 0; i < r.w * r.h; i++) {
      const o = i * 4;
      const dist = Math.max(Math.abs(cur[o] - s.r), Math.abs(cur[o + 1] - s.g), Math.abs(cur[o + 2] - s.b));
      if (dist > tol) continue;
      const e = cov[i] * d.flow * (1 - dist / Math.max(1e-6, tol) * 0.5);
      const hsl = rgbToHsl({ r: cur[o], g: cur[o + 1], b: cur[o + 2] });
      const c = hslToRgb({ h: target.h, s: target.s, l: hsl.l });
      cur[o] += (c.r - cur[o]) * e; cur[o + 1] += (c.g - cur[o + 1]) * e; cur[o + 2] += (c.b - cur[o + 2]) * e;
    }
    t.raster.writeFloat(lr, cur);
  }
}

/** Background Eraser: erases pixels similar to the sampled color. */
export class BackgroundEraseOp extends StrokeOp {
  private sampled: RGB | null = null;
  constructor(
    ctx: StrokeContext,
    private tolerance: number,
    private sampling: 'continuous' | 'once' | 'background',
    private bg: RGB,
    private protect: RGB | null,
  ) {
    super(ctx);
  }
  protected dab(d: Dab, cov: Float32Array, r: Rect): void {
    const t = this.ctx.target;
    if (t.channels !== 4) return;
    const lr = this.local(r);
    const cur = t.raster.readFloat(lr);
    if (this.sampling === 'background') this.sampled = this.bg;
    else if (!this.sampled || this.sampling === 'continuous') {
      const c = t.raster.readFloat({ x: Math.floor(d.x) - t.x, y: Math.floor(d.y) - t.y, w: 1, h: 1 });
      if (c[3] > 0) this.sampled = { r: c[0], g: c[1], b: c[2] };
    }
    const s = this.sampled;
    if (!s) return;
    const tol = Math.max(0.001, this.tolerance / 100);
    for (let i = 0; i < r.w * r.h; i++) {
      const o = i * 4;
      if (this.protect && Math.max(Math.abs(cur[o] - this.protect.r), Math.abs(cur[o + 1] - this.protect.g), Math.abs(cur[o + 2] - this.protect.b)) < 0.05) continue;
      const dist = Math.max(Math.abs(cur[o] - s.r), Math.abs(cur[o + 1] - s.g), Math.abs(cur[o + 2] - s.b));
      if (dist > tol) continue;
      const e = cov[i] * d.flow * (1 - dist / tol);
      cur[o + 3] *= 1 - Math.min(1, e * 1.5);
    }
    t.raster.writeFloat(lr, cur);
  }
}

/** Accumulates a coverage mask only (Spot Healing / Remove tools inpaint on release). */
export class MaskAccumulateOp extends StrokeOp {
  readonly mask = new TiledRaster(1, 8, 0);
  protected dab(_d: Dab, cov: Float32Array, r: Rect): void {
    const cur = this.mask.readFloat(r);
    for (let i = 0; i < cur.length; i++) cur[i] = Math.max(cur[i], cov[i] > 0.05 ? 1 : 0);
    this.mask.writeFloat(r, cur);
  }
}
