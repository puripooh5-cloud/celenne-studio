/**
 * CPU reference compositor.
 *
 * Composites the layer tree for a region at a pyramid level (level 0 = 100%, level L = 1/2^L).
 * Output is premultiplied RGBA float. This is the source of truth for correctness; the GPU
 * path and display caches are built on top of it.
 *
 * Semantics:
 *  - Children composite bottom → top.
 *  - Pass-through groups composite children straight onto the backdrop (opacity/mask via lerp).
 *  - Other groups are isolated: children composite onto transparent, then the result blends.
 *  - Clipping groups are isolated: base content, then clipped layers "atop" (limited to base
 *    alpha), then the result blends with the base layer's mode and opacity.
 *  - Adjustment layers transform the current backdrop; alpha is never increased.
 *
 * CMYK documents composite each plate separately (`plate` 0 = C'M'Y', 1 = K'; see
 * color/plates.ts): layer rasters read plate 0 or their companion, and colours in fills, gradients,
 * patterns and effects are mapped to the plate's stored values. Lab documents composite encoded
 * L a b; blend modes other than Normal / Dissolve are evaluated in RGB.
 */
import { applyBlendIf, blendIfActive, channelsRestricted, restrictChannels } from './blendIf';
import type { CelenneDocument } from '../document/document';
import type { FillLayer, GroupLayer, Layer, LayerId } from '../document/types';
import { hasRaster } from '../document/types';
import type { Rect } from '../image-engine/rect';
import { expand, intersect, isEmpty } from '../image-engine/rect';
import { applyAdjustedSpan, compositeAtopSpan, compositePremultipliedSpan, compositeSpan, fillIsSpecial, specialFillSource } from '../image-engine/blend';
import { gaussianBlur } from '../image-engine/blur';
import type { Adjustment } from '../adjustments/types';
import { rasterizePath } from '../vector/rasterize';
import { hasEnabledEffect } from '../effects/types';
import { effectsExtent, renderWithEffects } from '../effects/render';
import { buildGradientLUT, geometryFromAngle, renderGradient } from '../color/gradient';
import { isUnbounded, layerContentBounds, layerVisualBounds } from './bounds';
import { applyDocAdjustmentPremultiplied } from '../adjustments/docAdjust';
import { companionRead, isLabDoc, mapColorsToPlate, plateColor, plateCount, decodeLab, encodeLab, labToSrgb, srgbToLab } from '../color/plates';
import { platePatterns } from './platePatterns';
import type { LayerEffects as Effects } from '../effects/types';
import type { BlendMode } from '../image-engine/blend';

export interface LayerOverride {
  hidden?: boolean;
  /** Replaces content sampling (live transform / filter preview). Straight RGBA for rect at level (and CMYK plate). */
  read?: (r: Rect, level: number, plate?: number) => Float32Array;
  adjustment?: Adjustment;
  opacity?: number;
  blendMode?: Layer['blendMode'];
  /** `read` already applies the layer's (transformed) masks. */
  includesMask?: boolean;
  /**
   * The same preview described for the GPU compositor, which then computes it itself (`read`
   * stays the CPU path): a destructive adjustment or a filter on the layer's pixels, blended by
   * the selection.
   */
  gpu?: { adjustment?: Adjustment; filter?: { id: string; params: Record<string, unknown> } };
}

export interface CompositeOptions {
  level: number;
  overrides?: Map<LayerId, LayerOverride>;
  noEffects?: boolean;
  /** Render only this subtree (e.g. "sample current layer", thumbnails). */
  root?: GroupLayer;
  /** Stop before reaching this layer (used by tools that sample "current and below"). */
  stopAt?: LayerId;
  /** CMYK documents: which plate to composite (0 = C'M'Y', 1 = K'). */
  plate?: number;
}

export interface Ctx {
  doc: CelenneDocument;
  level: number;
  scale: number;
  opts: CompositeOptions;
  stopped: boolean;
  plate: number;
}

export function compositeRegion(doc: CelenneDocument, r: Rect, opts: CompositeOptions): Float32Array {
  const out = new Float32Array(Math.max(0, r.w * r.h * 4));
  if (r.w <= 0 || r.h <= 0) return out;
  const ctx: Ctx = { doc, level: opts.level, scale: 1 / (1 << opts.level), opts, stopped: false, plate: opts.plate ?? 0 };
  compositeChildren(ctx, opts.root ?? doc.root, out, r);
  return out;
}

/** All plates of the document's composite (one for RGB / Gray / Lab, two for CMYK). */
export function compositeRegionPlates(doc: CelenneDocument, r: Rect, opts: CompositeOptions): Float32Array[] {
  const out: Float32Array[] = [];
  for (let p = 0; p < plateCount(doc); p++) out.push(compositeRegion(doc, r, { ...opts, plate: p }));
  return out;
}

export const labBlends = (ctx: Ctx, mode: string) => isLabDoc(ctx.doc) && mode !== 'normal' && mode !== 'passThrough' && mode !== 'dissolve';

/** Lab documents: premultiplied / straight encoded Lab <-> RGB, in place. */
function labToRgbBuf(buf: Float32Array, n: number, premultiplied: boolean) {
  for (let i = 0; i < n; i++) {
    const o = i * 4, a = buf[o + 3];
    if (premultiplied && a <= 0) continue;
    const k = premultiplied ? 1 / a : 1;
    const c = labToSrgb(decodeLab(buf[o] * k, buf[o + 1] * k, buf[o + 2] * k));
    const m = premultiplied ? a : 1;
    buf[o] = c.r * m; buf[o + 1] = c.g * m; buf[o + 2] = c.b * m;
  }
}
function rgbToLabBuf(buf: Float32Array, n: number, premultiplied: boolean) {
  for (let i = 0; i < n; i++) {
    const o = i * 4, a = buf[o + 3];
    if (premultiplied && a <= 0) continue;
    const k = premultiplied ? 1 / a : 1;
    const e = encodeLab(srgbToLab({ r: buf[o] * k, g: buf[o + 1] * k, b: buf[o + 2] * k }));
    const m = premultiplied ? a : 1;
    buf[o] = e[0] * m; buf[o + 1] = e[1] * m; buf[o + 2] = e[2] * m;
  }
}

/** Runs a span blend; in Lab documents non-Normal modes are evaluated on RGB. */
function blendSpan(ctx: Ctx, mode: BlendMode, dst: Float32Array, src: Float32Array, n: number, srcPremultiplied: boolean, run: (dst: Float32Array, src: Float32Array) => void) {
  if (!labBlends(ctx, mode)) { run(dst, src); return; }
  const d = dst.subarray(0, n * 4), s = src.slice(0, n * 4);
  labToRgbBuf(d, n, true);
  labToRgbBuf(s, n, srcPremultiplied);
  run(dst, s);
  rgbToLabBuf(d, n, true);
}

export function isHidden(ctx: Ctx, l: Layer): boolean {
  return !l.visible || !!ctx.opts.overrides?.get(l.id)?.hidden;
}

function compositeChildren(ctx: Ctx, group: GroupLayer, dst: Float32Array, r: Rect) {
  const kids = group.children;
  // Knockout: shallow knocks through to the group's backdrop, deep to the Background layer.
  const knocks = kids.some((k) => k.advanced.knockout !== 'none' && !isHidden(ctx, k));
  const groupBackdrop = knocks ? dst.slice() : null;
  for (let i = 0; i < kids.length; i++) {
    if (ctx.stopped) return;
    const layer = kids[i];
    if (ctx.opts.stopAt && layer.id === ctx.opts.stopAt) {
      ctx.stopped = true;
      return;
    }
    // Collect layers clipped to this one.
    let j = i + 1;
    while (j < kids.length && kids[j].clipping) j++;
    const clipped = kids.slice(i + 1, j);
    if (layer.clipping && i > 0) continue; // handled by its base (orphan clipped layers at i=0 render normally)
    if (isHidden(ctx, layer)) {
      i = j - 1; // hidden base hides its clipping group
      continue;
    }
    // Layers (or clipping groups, via their base) that cannot touch this region are skipped:
    // a transparent source leaves the backdrop unchanged in every blend mode.
    if (!mayAffect(ctx, layer, r)) {
      i = j - 1;
      continue;
    }
    const visibleClipped = clipped.filter((c) => !isHidden(ctx, c));
    if (groupBackdrop && layer.advanced.knockout !== 'none' && layer.kind !== 'adjustment') {
      if (!visibleClipped.length && layer.kind !== 'group' && !hasEffects(ctx, layer)) { knockOutLayer(ctx, layer, dst, r, groupBackdrop); i = j - 1; continue; }
      knockOut(ctx, layer, dst, r, groupBackdrop);
    }
    if (visibleClipped.length) compositeClipGroup(ctx, layer, visibleClipped, dst, r);
    else compositeLayer(ctx, layer, dst, r);
    i = j - 1;
  }
}

function knockoutTarget(ctx: Ctx, layer: Layer, r: Rect, groupBackdrop: Float32Array): Float32Array {
  if (layer.advanced.knockout !== 'deep') return groupBackdrop;
  const target = new Float32Array(r.w * r.h * 4);
  const bg = ctx.doc.root.children[0];
  if (bg && bg.name === 'Background' && bg !== layer && !isHidden(ctx, bg)) compositeLayer({ ...ctx, stopped: false }, bg, target, r);
  return target;
}

/**
 * A knockout layer (Photoshop, measured): the knockout target with the layer drawn on it at its
 * fill opacity, mixed into the group by the layer's alpha × opacity — so a soft edge both knocks
 * out and shows the layer once, not twice.
 */
function knockOutLayer(ctx: Ctx, layer: Layer, dst: Float32Array, r: Rect, groupBackdrop: Float32Array) {
  const n = r.w * r.h;
  const t = knockoutTarget(ctx, layer, r, groupBackdrop).slice();
  const content = maskedContent(ctx, layer, r);
  const solid = content.slice();
  for (let i = 0; i < n; i++) solid[i * 4 + 3] = content[i * 4 + 3] > 0 ? 1 : 0;
  const mode = modeOf(ctx, layer), m = mode === 'passThrough' ? 'normal' : mode;
  const fill = layer.fillOpacity;
  if (fillIsSpecial(m, fill)) compositeSpan(m, t, 0, specialFillSource(m, solid, n, fill), 0, n, { opacity: 1, hardMixFill: m === 'hardMix' ? fill : undefined, x0: r.x, y0: r.y, width: r.w });
  else compositeSpan(m, t, 0, solid, 0, n, { opacity: fill, x0: r.x, y0: r.y, width: r.w });
  const k = opacityOf(ctx, layer);
  for (let i = 0; i < n; i++) {
    const c = content[i * 4 + 3] * k;
    if (c <= 0) continue;
    const o = i * 4;
    for (let ch = 0; ch < 4; ch++) dst[o + ch] += (t[o + ch] - dst[o + ch]) * c;
  }
}

/** Replaces the backdrop under a knockout layer's shape (× opacity) by the knockout target. */
function knockOut(ctx: Ctx, layer: Layer, dst: Float32Array, r: Rect, groupBackdrop: Float32Array) {
  const n = r.w * r.h;
  let target = groupBackdrop;
  if (layer.advanced.knockout === 'deep') {
    target = new Float32Array(n * 4);
    const bg = ctx.doc.root.children[0];
    if (bg && bg.name === 'Background' && bg !== layer && !isHidden(ctx, bg)) compositeLayer({ ...ctx, stopped: false }, bg, target, r);
  }
  const content = maskedContent(ctx, layer, r);
  const k = opacityOf(ctx, layer);
  for (let i = 0; i < n; i++) {
    const c = content[i * 4 + 3] * k;
    if (c <= 0) continue;
    const o = i * 4;
    for (let ch = 0; ch < 4; ch++) dst[o + ch] += (target[o + ch] - dst[o + ch]) * c;
  }
}

/** True when a layer is unbounded (adjustment/fill without a limiting mask), or a group containing one. */
function hasUnbounded(ctx: Ctx, layer: Layer): boolean {
  if (isUnbounded(layer)) return true;
  if (layer.kind !== 'group') return false;
  return layer.children.some((c) => !isHidden(ctx, c) && hasUnbounded(ctx, c));
}

/** Whether `layer` can change pixels in region r (level coordinates). Conservative. */
export function mayAffect(ctx: Ctx, layer: Layer, r: Rect): boolean {
  const ov = ctx.opts.overrides?.get(layer.id);
  // Overrides (live previews) may draw anywhere; groups with overridden children too.
  if (ov?.read || (ctx.opts.overrides?.size && layer.kind === 'group')) return true;
  if (layer.kind === 'adjustment' && layer.clipping) return true;
  if (hasUnbounded(ctx, layer)) return true;
  const b = layerVisualBounds(layer);
  if (!b) return false; // empty content
  const s = 1 << ctx.level;
  // Level-0 region of the tile, padded by one level pixel for pyramid sampling offsets.
  const r0 = { x: (r.x - 1) * s, y: (r.y - 1) * s, w: (r.w + 2) * s, h: (r.h + 2) * s };
  return !isEmpty(intersect(b, r0));
}

export function opacityOf(ctx: Ctx, l: Layer): number {
  return ctx.opts.overrides?.get(l.id)?.opacity ?? l.opacity;
}
export function modeOf(ctx: Ctx, l: Layer): Layer['blendMode'] {
  return ctx.opts.overrides?.get(l.id)?.blendMode ?? l.blendMode;
}

/** Straight RGBA content of a layer for region r (level coords), without mask. */
export function readLayerContent(ctx: { doc: CelenneDocument; level: number; scale: number; opts: CompositeOptions }, layer: Layer, r: Rect): Float32Array {
  const ov = ctx.opts.overrides?.get(layer.id);
  if (ov?.read) return ov.read(r, ctx.level, ctx.opts.plate ?? 0);
  if (hasRaster(layer)) {
    const s = 1 << ctx.level;
    const ox = Math.round(layer.x / s), oy = Math.round(layer.y / s);
    const rr = { x: r.x - ox, y: r.y - oy, w: r.w, h: r.h };
    if ((ctx.opts.plate ?? 0) === 1) return layer.raster.companion ? layer.raster.companion.readFloat(rr, ctx.level) : companionRead(layer.raster, rr, ctx.level, layer.raster.readFloat(rr, ctx.level));
    return layer.raster.readFloat(rr, ctx.level);
  }
  if (layer.kind === 'fill') return renderFillLayer(ctx.doc, layer, r, ctx.scale, ctx.opts.plate ?? 0);
  return new Float32Array(r.w * r.h * 4);
}

export function renderFillLayer(doc: CelenneDocument, layer: FillLayer, r: Rect, scale: number, plate = 0): Float32Array {
  const n = r.w * r.h;
  const out = new Float32Array(n * 4);
  const f = layer.fill;
  if (f.type === 'solid') {
    const c = plateColor(doc, f.color, plate);
    for (let i = 0; i < n; i++) {
      out[i * 4] = c.r; out[i * 4 + 1] = c.g; out[i * 4 + 2] = c.b; out[i * 4 + 3] = 1;
    }
  } else if (f.type === 'gradient') {
    const geom = geometryFromAngle(f.style, f.angle, f.scale, doc.bounds, f.offsetX, f.offsetY);
    renderGradient(geom, buildGradientLUT(platedGradient(doc, f.gradient, plate), f.reverse, undefined, plateCount(doc) > 1 || isLabDoc(doc)), r, scale, f.dither, out);
  } else {
    const p = platePatterns(doc, plate).get(f.patternId);
    if (p) {
      const ps = (f.scale / 100) * scale;
      const cache = p.raster.readFloat({ x: 0, y: 0, w: p.width, h: p.height });
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const px = Math.floor((r.x + x) / ps - f.phaseX), py = Math.floor((r.y + y) / ps - f.phaseY);
          const tx = ((px % p.width) + p.width) % p.width, ty = ((py % p.height) + p.height) % p.height;
          const si = (ty * p.width + tx) * 4, o = (y * r.w + x) * 4;
          out[o] = cache[si]; out[o + 1] = cache[si + 1]; out[o + 2] = cache[si + 2]; out[o + 3] = cache[si + 3];
        }
    }
  }
  return out;
}

/** Combined raster + vector mask coverage for region r, or null when unmasked. */
export function layerCoverage(ctx: { level: number; scale: number }, layer: Layer, r: Rect): Float32Array | null {
  let cov: Float32Array | null = null;
  const s = 1 << ctx.level;
  const m = layer.mask;
  if (m && m.enabled && m.density > 0) {
    const f = m.feather * ctx.scale;
    const pad = f > 0.3 ? Math.ceil(f * 3) : 0;
    const pr = pad ? expand(r, pad) : r;
    const mx = Math.round(m.x / s), my = Math.round(m.y / s);
    let buf = m.raster.readFloat({ x: pr.x - mx, y: pr.y - my, w: pr.w, h: pr.h }, ctx.level);
    if (pad) {
      gaussianBlur(buf, pr.w, pr.h, 1, f / 2);
      const c = new Float32Array(r.w * r.h);
      for (let y = 0; y < r.h; y++) c.set(buf.subarray((y + pad) * pr.w + pad, (y + pad) * pr.w + pad + r.w), y * r.w);
      buf = c;
    }
    if (m.density < 1) for (let i = 0; i < buf.length; i++) buf[i] = 1 - m.density * (1 - buf[i]);
    cov = buf;
  }
  const vm = layer.vectorMask;
  if (vm && vm.enabled && vm.path.subpaths.length) {
    const f = vm.feather * ctx.scale;
    const pad = f > 0.3 ? Math.ceil(f * 3) : 0;
    const pr = pad ? expand(r, pad) : r;
    let v = rasterizePath(vm.path, pr, ctx.scale);
    if (vm.invert) for (let i = 0; i < v.length; i++) v[i] = 1 - v[i];
    if (pad) {
      gaussianBlur(v, pr.w, pr.h, 1, f / 2);
      const c = new Float32Array(r.w * r.h);
      for (let y = 0; y < r.h; y++) c.set(v.subarray((y + pad) * pr.w + pad, (y + pad) * pr.w + pad + r.w), y * r.w);
      v = c;
    }
    if (vm.density < 1) for (let i = 0; i < v.length; i++) v[i] = 1 - vm.density * (1 - v[i]);
    if (cov) for (let i = 0; i < cov.length; i++) cov[i] *= v[i];
    else cov = v;
  }
  return cov;
}

function applyCoverageToAlpha(buf: Float32Array, cov: Float32Array | null) {
  if (!cov) return;
  for (let i = 0; i < cov.length; i++) buf[i * 4 + 3] *= cov[i];
}

/** Straight RGBA of a layer with its masks applied (group results are rendered isolated). */
function maskedContent(ctx: Ctx, layer: Layer, r: Rect): Float32Array {
  let buf: Float32Array;
  if (layer.kind === 'group') {
    buf = new Float32Array(r.w * r.h * 4);
    compositeChildren({ ...ctx, stopped: false }, layer, buf, r);
    for (let i = 0; i < r.w * r.h; i++) {
      const a = buf[i * 4 + 3];
      if (a > 1e-7) { const k = 1 / a; buf[i * 4] *= k; buf[i * 4 + 1] *= k; buf[i * 4 + 2] *= k; }
    }
  } else buf = readLayerContent(ctx, layer, r);
  if (!ctx.opts.overrides?.get(layer.id)?.includesMask) applyCoverageToAlpha(buf, layerCoverage(ctx, layer, r));
  return buf;
}

export function hasEffects(ctx: Ctx, l: Layer): boolean {
  return !ctx.opts.noEffects && hasEnabledEffect(l.effects);
}

function effectsCtx(ctx: Ctx, layer: Layer) {
  return {
    scale: ctx.scale,
    globalLight: ctx.doc.globalLight,
    patterns: isLabDoc(ctx.doc) ? ctx.doc.patterns : platePatterns(ctx.doc, ctx.plate),
    layerBounds: layerContentBounds(layer) ?? ctx.doc.bounds,
  };
}

/** Layer effects; Lab documents evaluate them in RGB so blend modes and colours behave as in RGB. */
function fxRender(ctx: Ctx, dst: Float32Array, p: Parameters<typeof renderWithEffects>[1], e: Parameters<typeof renderWithEffects>[2]) {
  if (!isLabDoc(ctx.doc)) { renderWithEffects(dst, p, e); return; }
  const n = p.rect.w * p.rect.h;
  labToRgbBuf(dst, n, true);
  const read = p.readContent;
  renderWithEffects(dst, { ...p, readContent: (pr) => { const b = read(pr); labToRgbBuf(b, pr.w * pr.h, false); return b; } }, e);
  rgbToLabBuf(dst, n, true);
}

const gradCache = new WeakMap<object, Map<string, import('../color/types').Gradient>>();
function platedGradient(doc: CelenneDocument, g: import('../color/types').Gradient, plate: number): import('../color/types').Gradient {
  if (plateCount(doc) === 1 && !isLabDoc(doc)) return g;
  const key = `${doc.canvas.colorMode}:${plate}:${doc.profile.name}`;
  let m = gradCache.get(g);
  if (!m) { m = new Map(); gradCache.set(g, m); }
  let v = m.get(key);
  if (!v) { v = mapColorsToPlate(doc, g, plate); m.set(key, v); }
  return v;
}

const fxCache = new WeakMap<Effects, Map<string, Effects>>();
/** A layer's effects with colours mapped to the plate's stored values (cached per effects object). */
function platedEffects(ctx: Ctx, fx: Effects): Effects {
  // Lab documents render effects in RGB (fxRender), with the original colours.
  if (plateCount(ctx.doc) === 1) return fx;
  const key = `${ctx.doc.canvas.colorMode}:${ctx.plate}:${ctx.doc.profile.name}`;
  let m = fxCache.get(fx);
  if (!m) { m = new Map(); fxCache.set(fx, m); }
  let v = m.get(key);
  if (!v) { v = mapColorsToPlate(ctx.doc, fx, ctx.plate); m.set(key, v); }
  return v;
}

function compositeLayer(ctx: Ctx, layer: Layer, dst: Float32Array, r: Rect) {
  const n = r.w * r.h;
  const opacity = opacityOf(ctx, layer);
  const mode = modeOf(ctx, layer);
  if (opacity <= 0 && !(layer.kind === 'group' && mode === 'passThrough')) return;

  if (layer.kind === 'adjustment') {
    const adj = ctx.opts.overrides?.get(layer.id)?.adjustment ?? layer.adjustment;
    const adjusted = new Float32Array(n * 4);
    applyDocAdjustmentPremultiplied(ctx.doc, adj, ctx.plate, dst, adjusted, n);
    blendSpan(ctx, mode, dst, adjusted, n, false, (d, a) => applyAdjustedSpan(mode, d, a, n, opacity * layer.fillOpacity, layerCoverage(ctx, layer, r) ?? undefined));
    return;
  }

  if (layer.kind === 'group' && mode === 'passThrough' && !hasEffects(ctx, layer)) {
    const cov = layerCoverage(ctx, layer, r);
    if (opacity >= 1 && !cov) {
      compositeChildren(ctx, layer, dst, r);
      return;
    }
    const copy = dst.slice();
    compositeChildren({ ...ctx, stopped: false }, layer, copy, r);
    for (let i = 0; i < n; i++) {
      const k = opacity * (cov ? cov[i] : 1);
      if (k <= 0) continue;
      const o = i * 4;
      dst[o] += (copy[o] - dst[o]) * k;
      dst[o + 1] += (copy[o + 1] - dst[o + 1]) * k;
      dst[o + 2] += (copy[o + 2] - dst[o + 2]) * k;
      dst[o + 3] += (copy[o + 3] - dst[o + 3]) * k;
    }
    return;
  }

  const bi = layer.advanced.blendIf;
  const biOn = blendIfActive(bi);
  const restricted = channelsRestricted(layer.advanced) && layer.kind !== 'group';
  const before = restricted ? dst.slice() : null;
  if (hasEffects(ctx, layer)) {
    fxRender(ctx,
      dst,
      {
        rect: r,
        // Blend If on layers with effects uses the This Layer ranges (the backdrop is not available for padded regions).
        readContent: (pr) => { const b = maskedContent(ctx, layer, pr); if (biOn) applyBlendIf(bi, b, null, pr.w * pr.h); return b; },
        effects: platedEffects(ctx, layer.effects!),
        blendMode: mode === 'passThrough' ? 'normal' : mode,
        opacity,
        fillOpacity: layer.kind === 'group' ? 1 : layer.fillOpacity,
      },
      effectsCtx(ctx, layer),
    );
    if (before) restrictChannels(before, dst, n, layer.advanced.channels);
    return;
  }

  const src = maskedContent(ctx, layer, r);
  if (biOn) applyBlendIf(bi, src, dst, n);
  const fill = layer.kind === 'group' ? 1 : layer.fillOpacity;
  const m = mode === 'passThrough' ? 'normal' : mode;
  if (fillIsSpecial(m, fill) && !labBlends(ctx, m)) {
    const s = specialFillSource(m, src, n, fill);
    blendSpan(ctx, m, dst, s, n, false, (d, sp) => compositeSpan(m, d, 0, sp, 0, n, { opacity, hardMixFill: m === 'hardMix' ? fill : undefined, x0: r.x, y0: r.y, width: r.w, hdr: ctx.doc.canvas.bitDepth === 32 }));
  } else blendSpan(ctx, m, dst, src, n, false, (d, s) => compositeSpan(m, d, 0, s, 0, n, { opacity: opacity * fill, x0: r.x, y0: r.y, width: r.w, hdr: ctx.doc.canvas.bitDepth === 32 }));
  if (before) restrictChannels(before, dst, n, layer.advanced.channels);
}

function compositeClipGroup(ctx: Ctx, base: Layer, clipped: Layer[], dst: Float32Array, r: Rect) {
  const n = r.w * r.h;
  const tmp = new Float32Array(n * 4);
  // Base content (isolated, normal mode). Base fill opacity applies; base opacity/mode apply at the end.
  if (base.kind === 'adjustment') {
    // An adjustment layer as clip base only contributes its mask shape; nothing to clip onto.
    compositeLayer(ctx, base, dst, r);
    for (const c of clipped) compositeLayer(ctx, c, dst, r);
    return;
  }
  const baseOpacity = opacityOf(ctx, base);
  const baseMode = modeOf(ctx, base);
  if (hasEffects(ctx, base)) {
    fxRender(ctx,
      tmp,
      { rect: r, readContent: (pr) => maskedContent(ctx, base, pr), effects: platedEffects(ctx, base.effects!), blendMode: 'normal', opacity: 1, fillOpacity: base.kind === 'group' ? 1 : base.fillOpacity },
      effectsCtx(ctx, base),
    );
  } else {
    const src = maskedContent(ctx, base, r);
    if (blendIfActive(base.advanced.blendIf)) applyBlendIf(base.advanced.blendIf, src, dst, n);
    compositeSpan('normal', tmp, 0, src, 0, n, { opacity: base.kind === 'group' ? 1 : base.fillOpacity });
  }
  for (const c of clipped) {
    const op = opacityOf(ctx, c);
    const mode = modeOf(ctx, c);
    if (c.kind === 'adjustment') {
      const adj = ctx.opts.overrides?.get(c.id)?.adjustment ?? c.adjustment;
      const adjusted = new Float32Array(n * 4);
      applyDocAdjustmentPremultiplied(ctx.doc, adj, ctx.plate, tmp, adjusted, n);
      blendSpan(ctx, mode, tmp, adjusted, n, false, (d, a) => applyAdjustedSpan(mode, d, a, n, op * c.fillOpacity, layerCoverage(ctx, c, r) ?? undefined));
      continue;
    }
    if (hasEffects(ctx, c)) {
      // Render the clipped layer with its effects isolated, then place it atop the base.
      const iso = new Float32Array(n * 4);
      fxRender(ctx, iso, { rect: r, readContent: (pr) => maskedContent(ctx, c, pr), effects: platedEffects(ctx, c.effects!), blendMode: 'normal', opacity: 1, fillOpacity: c.kind === 'group' ? 1 : c.fillOpacity }, effectsCtx(ctx, c));
      for (let i = 0; i < n; i++) {
        const a = iso[i * 4 + 3];
        if (a > 1e-7) { const k = 1 / a; iso[i * 4] *= k; iso[i * 4 + 1] *= k; iso[i * 4 + 2] *= k; }
      }
      const mm = mode === 'passThrough' ? 'normal' : mode;
      blendSpan(ctx, mm, tmp, iso, n, false, (d, s) => compositeAtopSpan(mm, d, 0, s, 0, n, { opacity: op }));
      continue;
    }
    const src = maskedContent(ctx, c, r);
    if (blendIfActive(c.advanced.blendIf)) applyBlendIf(c.advanced.blendIf, src, tmp, n);
    const fill = c.kind === 'group' ? 1 : c.fillOpacity;
    const mm = mode === 'passThrough' ? 'normal' : mode;
    if (fillIsSpecial(mm, fill) && !labBlends(ctx, mm)) {
      const s = specialFillSource(mm, src, n, fill);
      blendSpan(ctx, mm, tmp, s, n, false, (d, sp) => compositeAtopSpan(mm, d, 0, sp, 0, n, { opacity: op, hardMixFill: mm === 'hardMix' ? fill : undefined, hdr: ctx.doc.canvas.bitDepth === 32 }));
    } else blendSpan(ctx, mm, tmp, src, n, false, (d, s) => compositeAtopSpan(mm, d, 0, s, 0, n, { opacity: op * fill, hdr: ctx.doc.canvas.bitDepth === 32 }));
  }
  const bm = baseMode === 'passThrough' ? 'normal' : baseMode;
  blendSpan(ctx, bm, dst, tmp, n, true, (d, s) => compositePremultipliedSpan(bm, d, 0, s, 0, n, { opacity: baseOpacity, x0: r.x, y0: r.y, width: r.w }));
}

/** Pixel extent (level-0 px) by which a change to `layer` can affect the composite beyond its bounds. */
export function layerInfluencePadding(layer: Layer): number {
  let p = hasEnabledEffect(layer.effects) ? effectsExtent(layer.effects) : 0;
  if (layer.mask?.feather) p = Math.max(p, Math.ceil(layer.mask.feather * 3));
  let g = layer.parent;
  while (g) {
    if (hasEnabledEffect(g.effects)) p += effectsExtent(g.effects);
    g = g.parent;
  }
  return p;
}
