/**
 * Layer-style rendering. Works on a region (at any pyramid scale) with padding large enough
 * for the spread of every enabled effect, so results are seamless across tiles.
 *
 * Stacking order (bottom → top):
 *   Drop Shadow, Outer Glow | content (× fill opacity), Pattern Overlay, Gradient Overlay,
 *   Color Overlay, Satin, Inner Glow, Inner Shadow, Stroke, Bevel & Emboss
 * Below-content effects blend directly onto the backdrop; the styled content is then blended
 * with the layer's blend mode. Layer opacity scales everything; fill opacity only the content.
 */
import type { LayerEffects, ShadowEffect } from './types';
import type { Rect } from '../image-engine/rect';
import { expand } from '../image-engine/rect';
import { BlendMode, compositeAtopSpan, compositePremultipliedSpan, compositeSpan } from '../image-engine/blend';
import { boxBlur, edgeDistance, gaussianBlur, tentBlurMask } from '../image-engine/blur';
import { buildGradientLUT, geometryFromAngle, renderGradient } from '../color/gradient';
import type { PatternDef } from '../document/types';
import type { CurvePoint } from '../adjustments/types';
import { curveLUT } from '../adjustments/apply';

export interface EffectsContext {
  scale: number;
  globalLight: { angle: number; altitude: number };
  patterns: Map<string, PatternDef>;
  /** Layer content bounds in document px (for "align with layer" gradients). */
  layerBounds: Rect;
}

export function effectsExtent(fx: LayerEffects | null): number {
  if (!fx || !fx.enabled) return 0;
  let e = 0;
  const on = <T extends { enabled: boolean }>(l: T[]) => l.filter((x) => x.enabled);
  for (const s of on(fx.dropShadow)) e = Math.max(e, s.distance + s.size * 1.5 + 2);
  for (const s of on(fx.innerShadow)) e = Math.max(e, s.distance + s.size * 1.5 + 2);
  if (fx.outerGlow?.enabled) e = Math.max(e, fx.outerGlow.size * 1.5 + 2);
  if (fx.innerGlow?.enabled) e = Math.max(e, fx.innerGlow.size * 1.5 + 2);
  if (fx.bevel?.enabled) e = Math.max(e, fx.bevel.size * 2 + fx.bevel.soften + 2);
  if (fx.satin?.enabled) e = Math.max(e, fx.satin.distance + fx.satin.size * 1.5 + 2);
  for (const s of on(fx.stroke)) e = Math.max(e, s.size + 2);
  return Math.ceil(e * (fx.scale || 1));
}

/** Blur helper on single channel buffers approximating Photoshop "size". */
/**
 * Shadow / "softer" glow falloff (Photoshop, measured on straight edges): the shape grown by
 * size × spread (whole pixels from the edge), then a tent blur of radius size × (1 − spread).
 */
/** The shape grown by r px from its (sub-pixel) edge. */
function growMask(a: Float32Array, w: number, h: number, r: number, sd = edgeDistance(a, w, h)): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(a[i], Math.min(1, Math.max(0, r + 0.5 - sd[i])));
  return out;
}

function softMask(a: Float32Array, w: number, h: number, size: number, spread01: number): Float32Array {
  const hard = size * spread01;
  const m = hard >= 0.5 ? growMask(a, w, h, hard) : a;
  const soft = size * (1 - spread01);
  return soft >= 0.5 ? tentBlurMask(m, w, h, soft) : m.slice();
}

/** "Precise" glow falloff: linear with distance from the shape, (size + 1 − d) / (size + 1). */
function preciseMask(a: Float32Array, w: number, h: number, size: number, spread01: number): Float32Array {
  const sd = edgeDistance(a, w, h);
  const hard = size * spread01, span = size + 1 - hard;
  const m = new Float32Array(w * h);
  // d = distance between the pixel centre and the nearest covered centre (edge distance + 0.5).
  for (let i = 0; i < m.length; i++) m[i] = Math.max(a[i], Math.min(1, Math.max(0, 1 - Math.max(0, sd[i] + 0.5 - hard) / span)));
  return m;
}

/** Glow strength: Range scales the falloff by 100 / range (50 % doubles it), capped at full. */
function glowRange(m: Float32Array, range: number) {
  const k = 100 / Math.max(1, range);
  for (let i = 0; i < m.length; i++) m[i] = Math.min(1, m[i] * k);
}

function shiftMask(a: Float32Array, w: number, h: number, dx: number, dy: number, outside = 0): Float32Array {
  const out = new Float32Array(w * h);
  const ix = Math.round(dx), iy = Math.round(dy);
  for (let y = 0; y < h; y++) {
    const sy = y - iy;
    for (let x = 0; x < w; x++) {
      const sx = x - ix;
      out[y * w + x] = sx >= 0 && sy >= 0 && sx < w && sy < h ? a[sy * w + sx] : outside;
    }
  }
  return out;
}

/** Maps an effect's falloff through its contour curve (0..255 points; null or linear = unchanged). */
function applyContour(m: Float32Array, contour: CurvePoint[] | null | undefined): void {
  if (!contour || contour.length < 2) return;
  if (contour.length === 2 && contour[0].x === 0 && contour[0].y === 0 && contour[1].x === 255 && contour[1].y === 255) return;
  const lut = curveLUT(contour);
  const k = lut.length - 1;
  for (let i = 0; i < m.length; i++) m[i] = lut[Math.max(0, Math.min(k, Math.round(m[i] * k)))];
}

/** Effect noise: random alpha dither stable in document space (0..100 %). */
function applyNoise(m: Float32Array, noise: number, pr: Rect, scale: number): void {
  const amt = noise / 100;
  if (amt <= 0) return;
  for (let y = 0; y < pr.h; y++)
    for (let x = 0; x < pr.w; x++) {
      const gx = Math.floor((pr.x + x) / scale), gy = Math.floor((pr.y + y) / scale);
      let h = (gx * 374761393 + gy * 668265263) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      const r = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
      m[y * pr.w + x] *= 1 - amt * r;
    }
}

/** Composites a solid color with per-pixel alpha onto a premultiplied buffer over region `inner` of padded `pr`. */
function compositeColor(dst: Float32Array, rect: Rect, pr: Rect, alpha: Float32Array, color: { r: number; g: number; b: number }, mode: BlendMode, opacity: number) {
  const w = rect.w;
  const src = new Float32Array(w * 4);
  const cov = new Float32Array(w);
  for (let y = 0; y < rect.h; y++) {
    const py = y + rect.y - pr.y;
    for (let x = 0; x < w; x++) {
      const px = x + rect.x - pr.x;
      src[x * 4] = color.r; src[x * 4 + 1] = color.g; src[x * 4 + 2] = color.b; src[x * 4 + 3] = 1;
      cov[x] = alpha[py * pr.w + px];
    }
    compositeSpan(mode, dst, y * w * 4, src, 0, w, { opacity, mask: cov, x0: rect.x, y0: rect.y + y, width: w });
  }
}

/** Like compositeColor, but inside the destination's existing alpha (it never grows). */
function compositeColorAtop(dst: Float32Array, rect: Rect, pr: Rect, alpha: Float32Array, color: { r: number; g: number; b: number }, mode: BlendMode, opacity: number) {
  const w = rect.w;
  const src = new Float32Array(w * 4);
  const cov = new Float32Array(w);
  for (let y = 0; y < rect.h; y++) {
    const py = y + rect.y - pr.y;
    for (let x = 0; x < w; x++) {
      src[x * 4] = color.r; src[x * 4 + 1] = color.g; src[x * 4 + 2] = color.b; src[x * 4 + 3] = 1;
      cov[x] = alpha[py * pr.w + x + rect.x - pr.x];
    }
    compositeAtopSpan(mode, dst, y * w * 4, src, 0, w, { opacity, mask: cov });
  }
}

function crop(buf: Float32Array, pr: Rect, rect: Rect, ch: number): Float32Array {
  const out = new Float32Array(rect.w * rect.h * ch);
  for (let y = 0; y < rect.h; y++) {
    const so = ((y + rect.y - pr.y) * pr.w + (rect.x - pr.x)) * ch;
    out.set(buf.subarray(so, so + rect.w * ch), y * rect.w * ch);
  }
  return out;
}

function lightAngle(e: { useGlobalLight?: boolean; angle: number }, ctx: EffectsContext): number {
  return e.useGlobalLight ? ctx.globalLight.angle : e.angle;
}

function samplePatternColor(p: PatternDef, x: number, y: number, s: number): [number, number, number, number] {
  const px = Math.floor(x / s), py = Math.floor(y / s);
  const tx = ((px % p.width) + p.width) % p.width, ty = ((py % p.height) + p.height) % p.height;
  const v = p.raster.readFloat({ x: tx, y: ty, w: 1, h: 1 });
  return [v[0], v[1], v[2], v[3]];
}

export interface EffectsInput {
  rect: Rect;
  /** Reads straight RGBA of the layer content (mask already applied to alpha) for any region. */
  readContent: (r: Rect) => Float32Array;
  effects: LayerEffects;
  blendMode: BlendMode;
  opacity: number;
  fillOpacity: number;
}

/** Renders a layer with its effects onto the premultiplied `backdrop` (covering `rect`). */
export function renderWithEffects(backdrop: Float32Array, input: EffectsInput, ctx: EffectsContext): void {
  const { rect, effects: fx } = input;
  const s = ctx.scale * (fx.scale || 1);
  const pad = Math.ceil(effectsExtent(fx) * ctx.scale) + 2;
  const pr = expand(rect, pad);
  const n = pr.w * pr.h;
  const content = input.readContent(pr);
  const A = new Float32Array(n);
  for (let i = 0; i < n; i++) A[i] = content[i * 4 + 3];
  const opacity = input.opacity;

  // ---- Below content ------------------------------------------------------------------
  const shadowMask = (e: ShadowEffect, inner: boolean) => {
    const ang = (lightAngle(e, ctx) * Math.PI) / 180;
    const dx = -Math.cos(ang) * e.distance * s, dy = Math.sin(ang) * e.distance * s;
    const base = inner ? A.map((v) => 1 - v) : A;
    const soft = softMask(base, pr.w, pr.h, e.size * s, e.spread / 100);
    applyContour(soft, e.contour);
    const m = shiftMask(soft, pr.w, pr.h, dx, dy, inner ? 1 : 0);
    applyNoise(m, e.noise, pr, ctx.scale);
    return m;
  };

  for (const e of fx.dropShadow) {
    if (!e.enabled) continue;
    const m = shadowMask(e, false);
    // "Layer Knocks Out Drop Shadow" hides the shadow only as far as fill opacity makes the layer
    // see-through (Photoshop, measured): nothing at 100 % fill, the whole shape at 0 %.
    if (e.layerKnocksOut) { const k = 1 - input.fillOpacity; if (k > 0) for (let i = 0; i < n; i++) m[i] *= 1 - A[i] * k; }
    compositeColor(backdrop, rect, pr, m, e.color, e.blendMode, e.opacity * opacity);
  }
  if (fx.outerGlow?.enabled) {
    const g = fx.outerGlow;
    let m: Float32Array;
    if (g.technique === 'precise') m = preciseMask(A, pr.w, pr.h, g.size * s, g.spread / 100);
    else { m = softMask(A, pr.w, pr.h, g.size * s, g.spread / 100); glowRange(m, g.range); }
    applyContour(m, g.contour);
    applyNoise(m, g.noise, pr, ctx.scale);
    for (let i = 0; i < n; i++) m[i] *= 1 - A[i];
    if (g.gradient) {
      const lut = buildGradientLUT(g.gradient, false, 256);
      const buf = new Float32Array(rect.w * rect.h * 4);
      for (let y = 0; y < rect.h; y++)
        for (let x = 0; x < rect.w; x++) {
          const mi = (y + rect.y - pr.y) * pr.w + (x + rect.x - pr.x);
          const li = Math.round((1 - m[mi]) * 255) * 4;
          const o = (y * rect.w + x) * 4;
          buf[o] = lut[li]; buf[o + 1] = lut[li + 1]; buf[o + 2] = lut[li + 2]; buf[o + 3] = lut[li + 3] * m[mi];
        }
      for (let y = 0; y < rect.h; y++) compositeSpan(g.blendMode, backdrop, y * rect.w * 4, buf, y * rect.w * 4, rect.w, { opacity: g.opacity * opacity });
    } else compositeColor(backdrop, rect, pr, m, g.color, g.blendMode, g.opacity * opacity);
  }

  // Bevel & Emboss: the parts outside the shape shade what is below the layer.
  const bevel = fx.bevel?.enabled ? bevelMasks(A, pr.w, pr.h, fx, ctx, s) : null;
  if (bevel) {
    const b = fx.bevel!;
    compositeColor(backdrop, rect, pr, bevel.shOut, b.shadowColor, b.shadowMode, b.shadowOpacity * opacity);
    compositeColor(backdrop, rect, pr, bevel.hiOut, b.highlightColor, b.highlightMode, b.highlightOpacity * opacity);
  }

  // ---- Styled content (premultiplied, rect-sized) -----------------------------------------
  // Interior effects (overlays, satin, inner glow / shadow) are composited onto the layer's
  // colour without its transparency (content at fill opacity, coverage 1) and the result is
  // masked by the layer's alpha once (Photoshop, measured): soft edges are neither weakened nor
  // thickened, and a 0 % fill still shows the overlays at full strength.
  const inner = crop(content, pr, rect, 4);
  const Ain = crop(A, pr, rect, 1);
  const styled = new Float32Array(rect.w * rect.h * 4);
  const fillOp = input.fillOpacity;
  for (let i = 0; i < rect.w * rect.h; i++) {
    if (Ain[i] <= 0) continue;
    const o = i * 4;
    styled[o] = inner[o] * fillOp; styled[o + 1] = inner[o + 1] * fillOp; styled[o + 2] = inner[o + 2] * fillOp; styled[o + 3] = fillOp;
  }
  const ones = new Float32Array(rect.w * rect.h).fill(1);

  if (fx.patternOverlay?.enabled) {
    const p = ctx.patterns.get(fx.patternOverlay.patternId);
    if (p) {
      const e = fx.patternOverlay;
      const buf = new Float32Array(rect.w * rect.h * 4);
      const ps = (e.scale / 100) * ctx.scale;
      for (let y = 0; y < rect.h; y++)
        for (let x = 0; x < rect.w; x++) {
          const c = samplePatternColor(p, rect.x + x - e.phaseX * ctx.scale, rect.y + y - e.phaseY * ctx.scale, ps);
          const o = (y * rect.w + x) * 4;
          buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = c[3];
        }
      for (let y = 0; y < rect.h; y++) compositeSpan(e.blendMode, styled, y * rect.w * 4, buf, y * rect.w * 4, rect.w, { opacity: e.opacity });
    }
  }
  for (const e of fx.gradientOverlay) {
    if (!e.enabled) continue;
    const box = e.alignWithLayer ? ctx.layerBounds : ctx.layerBounds;
    const geom = geometryFromAngle(e.style, e.angle, e.scale, box, e.offsetX, e.offsetY);
    const lut = buildGradientLUT(e.gradient, e.reverse);
    const buf = renderGradient(geom, lut, rect, ctx.scale, e.dither);
    for (let y = 0; y < rect.h; y++) compositeSpan(e.blendMode, styled, y * rect.w * 4, buf, y * rect.w * 4, rect.w, { opacity: e.opacity });
  }
  for (const e of fx.colorOverlay) {
    if (!e.enabled) continue;
    compositeColor(styled, rect, rect, ones, e.color, e.blendMode, e.opacity);
  }
  if (fx.satin?.enabled) {
    const e = fx.satin;
    const ang = (e.angle * Math.PI) / 180;
    const dx = Math.cos(ang) * e.distance * s, dy = -Math.sin(ang) * e.distance * s;
    const b = A.slice();
    if (e.size * s >= 0.5) gaussianBlur(b, pr.w, pr.h, 1, (e.size * s) / 2);
    const m1 = shiftMask(b, pr.w, pr.h, dx, dy), m2 = shiftMask(b, pr.w, pr.h, -dx, -dy);
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = Math.abs(m1[i] - m2[i]);
      if (e.invert) v = 1 - v;
      m[i] = v;
    }
    compositeColor(styled, rect, pr, m, e.color, e.blendMode, e.opacity);
  }
  if (fx.innerGlow?.enabled) {
    const g = fx.innerGlow;
    const size = g.size * s;
    let m: Float32Array;
    const inv = A.map((v) => 1 - v);
    if (g.technique === 'precise') m = preciseMask(inv, pr.w, pr.h, size, g.spread / 100);
    else { m = softMask(inv, pr.w, pr.h, size, g.spread / 100); glowRange(m, g.range); }
    // Center: the glow sits away from the edge (the edge falloff inverted, inside the shape).
    if (g.source !== 'edge') for (let i = 0; i < n; i++) m[i] = 1 - m[i];
    applyContour(m, g.contour);
    applyNoise(m, g.noise, pr, ctx.scale);
    compositeColor(styled, rect, pr, m, g.color, g.blendMode, g.opacity);
  }
  for (const e of fx.innerShadow) {
    if (!e.enabled) continue;
    compositeColor(styled, rect, pr, shadowMask(e, true), e.color, e.blendMode, e.opacity);
  }
  // Mask the interior by the layer's alpha.
  for (let i = 0; i < rect.w * rect.h; i++) {
    const a = Ain[i], o = i * 4;
    styled[o] *= a; styled[o + 1] *= a; styled[o + 2] *= a; styled[o + 3] *= a;
  }
  for (const e of fx.stroke) {
    if (!e.enabled) continue;
    const size = e.size * s;
    // Strokes are bands measured from the shape's sub-pixel edge (Photoshop: a 3 px outside stroke
    // covers 3 full pixels). The outside part lies behind the content, the inside part on it.
    const sd = edgeDistance(A, pr.w, pr.h);
    const outW = e.position === 'outside' ? size : e.position === 'center' ? size / 2 : 0;
    const inW = e.position === 'inside' ? size : e.position === 'center' ? size / 2 : 0;
    const behind = outW > 0 ? growMask(A, pr.w, pr.h, outW, sd) : null;
    const onTop = inW > 0 ? sd.map((d, i) => (d > 0 ? (A[i] > 0 ? 1 : 0) : Math.min(1, Math.max(0, inW + 0.5 + d)))) : null;
    const paint = (dst: Float32Array, m: Float32Array, atop: boolean) => {
      if (e.fillType === 'gradient' && e.gradient) {
        const geom = geometryFromAngle(e.gradientStyle, e.gradientAngle, 100, ctx.layerBounds);
        const buf = renderGradient(geom, buildGradientLUT(e.gradient), rect, ctx.scale);
        for (let y = 0; y < rect.h; y++)
          for (let x = 0; x < rect.w; x++) buf[(y * rect.w + x) * 4 + 3] *= m[(y + rect.y - pr.y) * pr.w + (x + rect.x - pr.x)];
        for (let y = 0; y < rect.h; y++) (atop ? compositeAtopSpan : compositeSpan)(e.blendMode, dst, y * rect.w * 4, buf, y * rect.w * 4, rect.w, { opacity: e.opacity });
      } else (atop ? compositeColorAtop : compositeColor)(dst, rect, pr, m, e.color, e.blendMode, e.opacity);
    };
    if (onTop) paint(styled, onTop, true);
    if (behind) {
      // Behind the content: paint the stroke alone, then the content over it.
      const under = new Float32Array(styled.length);
      paint(under, behind, false);
      for (let i = 0; i < rect.w * rect.h; i++) {
        const o = i * 4, k = 1 - styled[o + 3];
        styled[o] += under[o] * k; styled[o + 1] += under[o + 1] * k; styled[o + 2] += under[o + 2] * k; styled[o + 3] += under[o + 3] * k;
      }
    }
  }
  if (bevel) {
    const b = fx.bevel!;
    // Shading inside the shape, within its alpha.
    compositeColorAtop(styled, rect, pr, bevel.shIn, b.shadowColor, b.shadowMode, b.shadowOpacity);
    compositeColorAtop(styled, rect, pr, bevel.hiIn, b.highlightColor, b.highlightMode, b.highlightOpacity);
  }

  // ---- Styled content onto backdrop -------------------------------------------------------
  for (let y = 0; y < rect.h; y++) compositePremultipliedSpan(input.blendMode, backdrop, y * rect.w * 4, styled, y * rect.w * 4, rect.w, { opacity, x0: rect.x, y0: rect.y + y, width: rect.w });
}

/**
 * Bevel & Emboss (Photoshop, measured on straight edges, within ~1/255): a height field — Smooth:
 * the shape tent-blurred with radius `size` (Emboss / Pillow: size / 2, straddling the edge);
 * Chisel: the distance from the edge, linear up to `size` — shaded by a light at the angle and
 * altitude: with I = N·L and I0 = sin(altitude), highlight = (I − I0)/(1 − I0), shadow =
 * (I0 − I)/I0. Slopes: Smooth size × depth, Chisel depth · size / (2 (size + 1)) per pixel.
 * Returns highlight and shadow strengths inside (`hiIn`, `shIn`) and outside the shape.
 */
function bevelMasks(A: Float32Array, w: number, h: number, fx: LayerEffects, ctx: EffectsContext, s: number) {
  const b = fx.bevel!;
  const n = w * h;
  const size = Math.max(1, b.size * s);
  const embossLike = b.style === 'emboss' || b.style === 'pillowEmboss' || b.style === 'strokeEmboss';
  const r = embossLike ? Math.max(1, size / 2) : size;
  let hgt: Float32Array, scale: number;
  if (b.technique === 'smooth') {
    hgt = tentBlurMask(A, w, h, r);
    scale = r * (b.depth / 100);
  } else {
    // Distance from the (sub-pixel) edge, positive inside the shape.
    const sd = edgeDistance(A, w, h);
    hgt = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = -sd[i];
      // The ramp runs half a pixel past `size` (Photoshop's last bevel pixel is half-sloped).
      hgt[i] = embossLike ? Math.max(-r - 0.5, Math.min(r + 0.5, d)) / (2 * r) + 0.5 : b.style === 'outerBevel' ? Math.min(1, Math.max(-r - 0.5, d)) / r + 1 : Math.min(r + 0.5, Math.max(-1, d)) / r;
    }
    scale = (b.depth / 100) * (r * r) / (2 * (r + 1));
  }
  if (b.soften > 0) hgt = tentBlurMask(hgt, w, h, b.soften * s);
  const ang = ((b.useGlobalLight ? ctx.globalLight.angle : b.angle) * Math.PI) / 180;
  const alt = ((b.useGlobalLight ? ctx.globalLight.altitude : b.altitude) * Math.PI) / 180;
  const lx = Math.cos(ang) * Math.cos(alt), ly = -Math.sin(ang) * Math.cos(alt), lz = Math.sin(alt);
  const k = scale * (b.direction === 'up' ? 1 : -1);
  const hiIn = new Float32Array(n), shIn = new Float32Array(n), hiOut = new Float32Array(n), shOut = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = ((x + 1 < w ? hgt[i + 1] : hgt[i]) - (x > 0 ? hgt[i - 1] : hgt[i])) * 0.5 * k;
      const gy = ((y + 1 < h ? hgt[i + w] : hgt[i]) - (y > 0 ? hgt[i - w] : hgt[i])) * 0.5 * k;
      if (gx === 0 && gy === 0) continue;
      const norm = Math.sqrt(1 + gx * gx + gy * gy);
      const light = (I: number): [number, number] => [I > lz ? Math.min(1, (I - lz) / Math.max(1e-6, 1 - lz)) : 0, I < lz ? Math.min(1, (lz - I) / Math.max(1e-6, lz)) : 0];
      const [hi, sh] = light((-gx * lx - gy * ly + lz) / norm);
      const a = A[i];
      if (b.style !== 'outerBevel') { hiIn[i] = hi; shIn[i] = sh; }
      if (b.style === 'outerBevel' || embossLike) {
        // Pillow Emboss: the outer half slopes the other way (a groove around the shape).
        const [ho, so] = b.style === 'pillowEmboss' ? light((gx * lx + gy * ly + lz) / norm) : [hi, sh];
        hiOut[i] = ho * (1 - a); shOut[i] = so * (1 - a);
      }
    }
  }
  applyContourPair(hiIn, shIn, b.contour);
  applyContourPair(hiOut, shOut, b.contour);
  return { hiIn, shIn, hiOut, shOut };
}

function applyContourPair(hi: Float32Array, sh: Float32Array, contour: CurvePoint[] | null | undefined) {
  applyContour(hi, contour);
  applyContour(sh, contour);
}
