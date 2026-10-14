/** Image menu operations: size, canvas, rotation, crop/trim, modes, profiles, pixel adjustments. */
import { convertDocumentColor } from '../../color/convertDocument';
import { applyDocAdjustmentStraight } from '../../adjustments/docAdjust';
import type { RGB } from '../../color/types';
import { ui } from '../store';
import type { DocumentSession } from '../session';
import { need, needLayer, errorText } from './common';
import { recordStateChange } from '../../history/history';
import type { CelenneDocument } from '../../document/document';
import type { Layer, ColorProfileRef } from '../../document/types';
import { hasRaster } from '../../document/types';
import { TiledRaster } from '../../image-engine/tiledRaster';
import { Affine, affineToHomography, apply, Homography, invertH, isTranslationOnly, multiply, translation } from '../../image-engine/matrix';
import { Interpolation, warpRaster } from '../../image-engine/resample';
import { intersect, isEmpty, Rect, roundOut, union } from '../../image-engine/rect';
import { rasterContentBounds, layerContentBounds } from '../../rendering/bounds';
import type { VectorPath } from '../../vector/types';
import { updateAppearance } from '../../layers/appearance';
import type { BitDepth } from '../../image-engine/pixels';
import { colorEngine, Intent } from '../../color/cms';
import { editor } from '../editor';
import type { Adjustment } from '../../adjustments/types';
import { applyAdjustmentToStraight } from '../../adjustments/apply';
import { editRaster } from '../../commands/rasterCommands';
import { platform } from '../platform/platform';
import { builtinProfileName, BuiltinProfileId } from '../../color/icc';
import { compositeStraight } from './common';
import { convertColorMode, leaveSingleLayerMode } from './modeOps';
import { convertLayerColors } from '../../document/layerColors';
import { isSingleLayerMode } from '../../color/modeConform';

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------
function transformPath(p: VectorPath, m: Affine) {
  for (const s of p.subpaths)
    for (const k of s.knots) {
      const a = apply(m, k.x, k.y), i = apply(m, k.inX, k.inY), o = apply(m, k.outX, k.outY);
      k.x = a.x; k.y = a.y; k.inX = i.x; k.inY = i.y; k.outX = o.x; k.outY = o.y;
    }
}

/** Exact pixel remap for 90°/180° rotations and flips (lossless). */
function orthoRemap(raster: TiledRaster, ox: number, oy: number, m: Affine, bounds?: Rect | null): { raster: TiledRaster; x: number; y: number } | null {
  const b = bounds !== undefined ? bounds : rasterContentBounds(raster) ?? (raster.channels === 1 ? raster.tileBounds() : null);
  const out = new TiledRaster(raster.channels, raster.depth, raster.fill);
  // CMYK: the K plate follows plate 0 exactly (same bounds, so the same new origin).
  if (raster.companion) out.companion = b ? orthoRemap(raster.companion, ox, oy, m, b)!.raster : new TiledRaster(4, raster.depth, raster.fill);
  if (!b) return { raster: out, x: ox, y: oy };
  const docB = { x: b.x + ox, y: b.y + oy, w: b.w, h: b.h };
  const corners = [apply(m, docB.x, docB.y), apply(m, docB.x + docB.w, docB.y + docB.h)];
  const nb = roundOut(Math.min(corners[0].x, corners[1].x), Math.min(corners[0].y, corners[1].y), Math.max(corners[0].x, corners[1].x), Math.max(corners[0].y, corners[1].y));
  const src = raster.readPixels(b);
  const ch = raster.channels;
  const dst = new (src.constructor as { new (n: number): typeof src })(nb.w * nb.h * ch);
  for (let y = 0; y < b.h; y++)
    for (let x = 0; x < b.w; x++) {
      const p = apply(m, docB.x + x + 0.5, docB.y + y + 0.5);
      const dx = Math.floor(p.x) - nb.x, dy = Math.floor(p.y) - nb.y;
      if (dx < 0 || dy < 0 || dx >= nb.w || dy >= nb.h) continue;
      for (let c = 0; c < ch; c++) dst[(dy * nb.w + dx) * ch + c] = src[(y * b.w + x) * ch + c];
    }
  out.writePixels({ x: 0, y: 0, w: nb.w, h: nb.h }, dst);
  return { raster: out, x: nb.x, y: nb.y };
}

function isOrthogonal(m: Affine): boolean {
  const r = (v: number) => Math.abs(v - Math.round(v)) < 1e-9;
  return r(m[0]) && r(m[1]) && r(m[2]) && r(m[3]) && Math.abs(Math.abs(m[0] * m[3] - m[1] * m[2]) - 1) < 1e-9 && r(m[4]) && r(m[5]);
}

/** Resamples a (layer-local) raster by a document-space homography. */
export function warpLayerRaster(raster: TiledRaster, ox: number, oy: number, H: Homography, interp: Interpolation, clip?: Rect, bounds?: Rect | null): { raster: TiledRaster; x: number; y: number } {
  const b = bounds !== undefined ? bounds : rasterContentBounds(raster);
  const out = new TiledRaster(raster.channels, raster.depth, raster.fill);
  // CMYK: the K plate is resampled with plate 0's bounds so both land at the same origin.
  if (raster.companion) out.companion = b ? warpLayerRaster(raster.companion, ox, oy, H, interp, clip, b).raster : new TiledRaster(4, raster.depth, raster.fill);
  if (!b) return { raster: out, x: 0, y: 0 };
  const docB = { x: b.x + ox, y: b.y + oy, w: b.w, h: b.h };
  const pts = [[docB.x, docB.y], [docB.x + docB.w, docB.y], [docB.x + docB.w, docB.y + docB.h], [docB.x, docB.y + docB.h]].map(([x, y]) => {
    const w = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
  });
  let nb = roundOut(Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.y)));
  if (clip) nb = intersect(nb, clip);
  if (isEmpty(nb)) return { raster: out, x: 0, y: 0 };
  // Inverse: new document → old document → raster local.
  const inv = invertH(H);
  const toLocal: Homography = [inv[0] - ox * inv[6], inv[1] - ox * inv[7], inv[2] - ox * inv[8], inv[3] - oy * inv[6], inv[4] - oy * inv[7], inv[5] - oy * inv[8], inv[6], inv[7], inv[8]];
  if (raster.channels === 4) {
    const TS = 1024;
    for (let y = nb.y; y < nb.y + nb.h; y += TS)
      for (let x = nb.x; x < nb.x + nb.w; x += TS) {
        const r = { x, y, w: Math.min(TS, nb.x + nb.w - x), h: Math.min(TS, nb.y + nb.h - y) };
        const px = warpRaster(raster, b, toLocal, r, interp);
        out.writeFloat({ x: r.x - nb.x, y: r.y - nb.y, w: r.w, h: r.h }, px);
      }
    out.compact();
    return { raster: out, x: nb.x, y: nb.y };
  }
  // Single channel (masks): expand to RGBA with value in R and full alpha.
  const tmp = new TiledRaster(4, 32, 0);
  const vals = raster.readFloat(b);
  const rgba = new Float32Array(b.w * b.h * 4);
  for (let i = 0; i < vals.length; i++) { rgba[i * 4] = vals[i]; rgba[i * 4 + 3] = 1; }
  tmp.writeFloat(b, rgba);
  const px = warpRaster(tmp, b, toLocal, nb, interp);
  const m = new Float32Array(nb.w * nb.h);
  const f = raster.fill;
  for (let i = 0; i < m.length; i++) m[i] = f + (px[i * 4] - f) * px[i * 4 + 3];
  out.writeFloat({ x: 0, y: 0, w: nb.w, h: nb.h }, m);
  out.compact();
  return { raster: out, x: nb.x, y: nb.y };
}

function transformRaster(raster: TiledRaster, ox: number, oy: number, m: Affine, interp: Interpolation) {
  if (isTranslationOnly(m)) {
    const dx = m[4], dy = m[5];
    if (Number.isInteger(dx) && Number.isInteger(dy)) return { raster, x: ox + dx, y: oy + dy };
  }
  if (isOrthogonal(m)) return orthoRemap(raster, ox, oy, m) ?? { raster, x: ox, y: oy };
  return warpLayerRaster(raster, ox, oy, affineToHomography(m), interp);
}

/** Applies a document-space affine transform to a layer and everything it owns. */
export function transformLayer(doc: CelenneDocument, l: Layer, m: Affine, interp: Interpolation, scaleStyles: number | null): void {
  if (hasRaster(l) && l.kind !== 'text' && l.kind !== 'shape' && l.kind !== 'smartObject') {
    const r = transformRaster(l.raster, l.x, l.y, m, interp);
    l.raster = r.raster;
    l.x = r.x;
    l.y = r.y;
  }
  if (l.mask) {
    const r = transformRaster(l.mask.raster, l.mask.x, l.mask.y, m, interp);
    l.mask = { ...l.mask, raster: r.raster, x: r.x, y: r.y };
  }
  if (l.vectorMask) transformPath(l.vectorMask.path, m);
  switch (l.kind) {
    case 'group':
      for (const c of l.children) transformLayer(doc, c, m, interp, scaleStyles);
      break;
    case 'text':
      l.text.transform = multiply(m, l.text.transform);
      if (l.usingPreservedPixels) {
        const r = transformRaster(l.raster, l.x, l.y, m, interp);
        l.raster = r.raster; l.x = r.x; l.y = r.y;
      } else updateAppearance(doc, l);
      break;
    case 'shape':
      transformPath(l.path, m);
      if (l.origin) {
        const a = apply(m, l.origin.x, l.origin.y), b = apply(m, l.origin.x + l.origin.w, l.origin.y + l.origin.h);
        l.origin = { ...l.origin, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
        if (!(m[1] === 0 && m[2] === 0)) l.origin.kind = 'custom';
      }
      if (scaleStyles) l.stroke.width *= scaleStyles;
      updateAppearance(doc, l);
      break;
    case 'smartObject':
      l.quad = l.quad.map((p) => apply(m, p.x, p.y)) as typeof l.quad;
      if (doc.smartSources.get(l.sourceId)?.decoded) updateAppearance(doc, l);
      else {
        const r = transformRaster(l.raster, l.x, l.y, m, interp);
        l.raster = r.raster; l.x = r.x; l.y = r.y;
      }
      break;
  }
  if (scaleStyles && l.effects) {
    const s = scaleStyles;
    const fx = l.effects;
    for (const e of [...fx.dropShadow, ...fx.innerShadow]) { e.distance *= s; e.size *= s; }
    if (fx.outerGlow) fx.outerGlow.size *= s;
    if (fx.innerGlow) fx.innerGlow.size *= s;
    if (fx.bevel) { fx.bevel.size *= s; fx.bevel.soften *= s; }
    if (fx.satin) { fx.satin.size *= s; fx.satin.distance *= s; }
    for (const e of fx.stroke) e.size *= s;
  }
  l.rev++;
}

/** Transforms the whole document (all layers, channels, selection, guides, paths). */
export function transformDocument(doc: CelenneDocument, m: Affine, newW: number, newH: number, interp: Interpolation, scaleStyles: number | null): void {
  for (const l of doc.root.children) transformLayer(doc, l, m, interp, scaleStyles);
  for (const c of doc.channels) {
    const r = transformRaster(c.raster, 0, 0, m, interp);
    const nr = new TiledRaster(1, 8, c.raster.fill);
    // Channels live at document origin.
    const b = rasterContentBounds(r.raster);
    if (b) nr.writeFloat({ x: b.x + r.x, y: b.y + r.y, w: b.w, h: b.h }, r.raster.readFloat(b));
    c.raster = nr;
  }
  {
    const sel = doc.selection;
    if (!sel.isEmpty()) {
      const full = sel.mask.fill > 0;
      const r = transformRaster(sel.mask, 0, 0, m, interp);
      const nr = new TiledRaster(1, 8, full ? 1 : 0);
      const b = rasterContentBounds(r.raster) ?? r.raster.tileBounds();
      if (b && !full) nr.writeFloat({ x: b.x + r.x, y: b.y + r.y, w: b.w, h: b.h }, r.raster.readFloat(b));
      sel.restore(nr.snapshot());
    }
  }
  doc.canvas = { ...doc.canvas, width: newW, height: newH };
  // A selection with nothing left on the new canvas selects nothing: drop it.
  if (!doc.selection.isEmpty() && !doc.selection.bounds(doc.bounds)) doc.selection.clear();
  for (const p of doc.paths) transformPath(p.path, m);
  doc.guides = doc.guides
    .map((g) => {
      const p = g.orientation === 'vertical' ? apply(m, g.position, 0) : apply(m, 0, g.position);
      const vertical = g.orientation === 'vertical' ? Math.abs(m[0]) > 0.5 : Math.abs(m[2]) > 0.5;
      return { ...g, orientation: (vertical ? 'vertical' : 'horizontal') as typeof g.orientation, position: vertical ? p.x : p.y };
    })
    .filter((g) => g.position >= 0 && g.position <= (g.orientation === 'vertical' ? newW : newH));
  // Slices follow the canvas (bounding box of the transformed rectangle, clipped to it).
  doc.slices = doc.slices
    .map((sl) => {
      const c = [apply(m, sl.rect.x, sl.rect.y), apply(m, sl.rect.x + sl.rect.w, sl.rect.y + sl.rect.h)];
      const r = intersect(roundOut(Math.min(c[0].x, c[1].x), Math.min(c[0].y, c[1].y), Math.max(c[0].x, c[1].x), Math.max(c[0].y, c[1].y)), { x: 0, y: 0, w: newW, h: newH });
      return { ...sl, rect: r };
    })
    .filter((sl) => !isEmpty(sl.rect));
  doc.canvas = { ...doc.canvas, width: newW, height: newH };
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------
export function imageSize(w: number, h: number, resolution: number, resample: Interpolation | null, scaleStyles: boolean): void {
  const s = need();
  if (!s) return;
  const d = s.doc;
  if (w < 1 || h < 1 || w > 300000 || h > 300000) {
    ui.toast('error', 'Invalid image size.');
    return;
  }
  recordStateChange(d, s.history, 'Image Size', () => {
    if (!resample) {
      d.canvas = { ...d.canvas, resolution };
      return;
    }
    const sx = w / d.width, sy = h / d.height;
    transformDocument(d, [sx, 0, 0, sy, 0, 0], w, h, resample, scaleStyles ? Math.sqrt(sx * sy) : null);
    d.canvas = { ...d.canvas, resolution };
  }, { action: 'image.size', args: { w, h, resolution, resample, scaleStyles } });
}

export type Anchor = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';

export function canvasSize(w: number, h: number, anchor: Anchor, fill: { r: number; g: number; b: number } | null): void {
  const s = need();
  if (!s) return;
  const d = s.doc;
  const ax = anchor.includes('l') ? 0 : anchor.includes('r') ? 1 : 0.5;
  const ay = anchor.startsWith('t') ? 0 : anchor.startsWith('b') ? 1 : 0.5;
  const dx = Math.round((w - d.width) * ax), dy = Math.round((h - d.height) * ay);
  recordStateChange(d, s.history, 'Canvas Size', () => {
    const oldW = d.width, oldH = d.height;
    transformDocument(d, translation(dx, dy), w, h, 'nearest', null);
    // Canvas extension color for an opaque Background layer.
    const bg = d.root.children[0];
    if (fill && bg && bg.kind === 'pixel' && bg.name === 'Background') {
      const regions: Rect[] = [
        { x: 0, y: 0, w, h: Math.max(0, dy) },
        { x: 0, y: dy + oldH, w, h: Math.max(0, h - dy - oldH) },
        { x: 0, y: Math.max(0, dy), w: Math.max(0, dx), h: oldH },
        { x: dx + oldW, y: Math.max(0, dy), w: Math.max(0, w - dx - oldW), h: oldH },
      ];
      for (const r0 of regions) {
        const r = intersect(r0, d.bounds);
        if (isEmpty(r)) continue;
        const buf = new Float32Array(r.w * r.h * 4);
        for (let i = 0; i < r.w * r.h; i++) { buf[i * 4] = fill.r; buf[i * 4 + 1] = fill.g; buf[i * 4 + 2] = fill.b; buf[i * 4 + 3] = 1; }
        bg.raster.writeFloat({ x: r.x - bg.x, y: r.y - bg.y, w: r.w, h: r.h }, buf);
      }
    }
  }, { action: 'image.canvasSize', args: { w, h, anchor } });
}

export function rotateCanvas(deg: number): void {
  const s = need();
  if (!s) return;
  const d = s.doc;
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad), sn = Math.sin(rad);
  const snap = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-12 ? Math.sign(v) : v);
  const C = snap(c), S = snap(sn);
  const W = d.width, H = d.height;
  const corners = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => [C * x - S * y, S * x + C * y]);
  const minX = Math.min(...corners.map((p) => p[0])), minY = Math.min(...corners.map((p) => p[1]));
  const nw = Math.round(Math.max(...corners.map((p) => p[0])) - minX), nh = Math.round(Math.max(...corners.map((p) => p[1])) - minY);
  const m: Affine = [C, S, -S, C, -Math.round(minX * 1e6) / 1e6, -Math.round(minY * 1e6) / 1e6];
  recordStateChange(d, s.history, `Rotate Canvas ${deg}°`, () => transformDocument(d, m, nw, nh, 'bicubic', null), { action: 'image.rotate', args: { deg } });
}

export function flipCanvas(horizontal: boolean): void {
  const s = need();
  if (!s) return;
  const d = s.doc;
  const m: Affine = horizontal ? [-1, 0, 0, 1, d.width, 0] : [1, 0, 0, -1, 0, d.height];
  recordStateChange(d, s.history, horizontal ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical', () => transformDocument(d, m, d.width, d.height, 'nearest', null), { action: 'image.flip', args: { horizontal } });
}

/** Crops to a document rectangle (optionally rotated by `angle` degrees around its center). */
export function crop(r: Rect, deletePixels: boolean, angle = 0): void {
  const s = need();
  if (!s) return;
  const d = s.doc;
  const rr = { x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) };
  recordStateChange(d, s.history, 'Crop', () => {
    let m: Affine = translation(-rr.x, -rr.y);
    if (angle) {
      const cx = rr.x + rr.w / 2, cy = rr.y + rr.h / 2;
      const a = (-angle * Math.PI) / 180;
      m = multiply(translation(rr.w / 2, rr.h / 2), multiply([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0], translation(-cx, -cy)));
    }
    transformDocument(d, m, rr.w, rr.h, 'bicubic', null);
    if (deletePixels) {
      for (const l of d.walk()) {
        if (!hasRaster(l) || l.kind !== 'pixel') continue;
        const keep = intersect({ x: -l.x, y: -l.y, w: d.width, h: d.height }, { x: -1e9, y: -1e9, w: 2e9, h: 2e9 });
        const px = l.raster.readFloat(keep);
        const nr = new TiledRaster(4, l.raster.depth);
        nr.writeFloat(keep, px);
        nr.compact();
        if (l.raster.companion) {
          nr.companion = new TiledRaster(4, l.raster.depth);
          nr.companion.writeFloat(keep, l.raster.companion.readFloat(keep));
          nr.companion.compact();
        }
        l.raster = nr;
      }
    }
  }, { action: 'image.crop', args: { ...rr, deletePixels, angle } });
}

export function cropToSelection(): void {
  const s = need();
  if (!s) return;
  const b = s.doc.selection.bounds(s.doc.bounds);
  if (!b) {
    ui.toast('info', 'Make a selection first.');
    return;
  }
  crop(b, false);
}

export function trim(basedOn: 'transparent' | 'topLeft' | 'bottomRight'): void {
  const s = need();
  if (!s) return;
  const d = s.doc;
  let bounds: Rect | null = null;
  if (basedOn === 'transparent') {
    for (const l of d.root.children) if (l.visible) bounds = union(bounds, layerContentBounds(l) ?? d.bounds);
    bounds = bounds ? intersect(bounds, d.bounds) : null;
  } else {
    const img = compositeStraight(s, d.bounds);
    const ref = basedOn === 'topLeft' ? 0 : (d.width * d.height - 1);
    const rc = [img[ref * 4], img[ref * 4 + 1], img[ref * 4 + 2], img[ref * 4 + 3]];
    let x0 = d.width, y0 = d.height, x1 = -1, y1 = -1;
    for (let y = 0; y < d.height; y++)
      for (let x = 0; x < d.width; x++) {
        const i = (y * d.width + x) * 4;
        if (Math.abs(img[i] - rc[0]) + Math.abs(img[i + 1] - rc[1]) + Math.abs(img[i + 2] - rc[2]) + Math.abs(img[i + 3] - rc[3]) > 1 / 255) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    bounds = x1 >= x0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
  }
  if (!bounds || isEmpty(bounds)) {
    ui.toast('info', 'Nothing to trim.');
    return;
  }
  crop(bounds, false);
}

export function revealAll(): void {
  const s = need();
  if (!s) return;
  let b: Rect | null = s.doc.bounds;
  for (const l of s.doc.walk()) b = union(b, layerContentBounds(l) ?? undefined);
  if (!b) return;
  const d = s.doc;
  const dx = -b.x, dy = -b.y;
  if (!dx && !dy && b.w === d.width && b.h === d.height) return;
  recordStateChange(d, s.history, 'Reveal All', () => transformDocument(d, translation(dx, dy), b!.w, b!.h, 'nearest', null));
}

// ---------------------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------------------
function convertRasterDepth(r: TiledRaster, depth: BitDepth): TiledRaster {
  const out = new TiledRaster(r.channels, depth, r.fill);
  for (const [k] of r.tiles) {
    const tx = (k % 65536) - 32768, ty = Math.floor(k / 65536) - 32768;
    const rect = { x: tx * 256, y: ty * 256, w: 256, h: 256 };
    out.writeFloat(rect, r.readFloat(rect));
  }
  if (r.companion) out.companion = convertRasterDepth(r.companion, depth);
  return out;
}

export async function setBitDepth(depth: BitDepth): Promise<void> {
  const cur = editor.active;
  if (cur && isSingleLayerMode(cur.doc) && depth !== 8) {
    ui.toast('info', `${cur.doc.canvas.colorMode === 'indexed' ? 'Indexed Color' : 'Bitmap'} documents are 8 bits/channel. Convert to RGB Color or Grayscale first.`);
    return;
  }
  const s = need();
  if (!s || s.doc.canvas.bitDepth === depth) return;
  const d = s.doc;
  if (depth < d.canvas.bitDepth) {
    const r = await platform().confirm(`Convert to ${depth} bits/channel?`, `This reduces color precision from ${d.canvas.bitDepth}-bit to ${depth}-bit. You can undo this step.`, ['Convert', 'Cancel']);
    if (r !== 0) return;
  }
  const from = d.canvas.bitDepth;
  recordStateChange(d, s.history, `${depth} Bits/Channel`, () => {
    for (const l of d.walk()) {
      if (hasRaster(l)) {
        let r = convertRasterDepth(l.raster, depth);
        // 32-bit documents store linear light; convert transfer function at the boundary.
        if (from === 32 || depth === 32) r = retransfer(r, depth === 32 ? 'toLinear' : 'toGamma');
        l.raster = r;
      }
    }
    for (const src of d.smartSources.values()) if (src.decoded) src.decoded = { ...src.decoded, raster: convertRasterDepth(src.decoded.raster, depth) };
    d.canvas = { ...d.canvas, bitDepth: depth };
  }, { action: 'image.bitDepth', args: { depth } });
}

function retransfer(r: TiledRaster, dir: 'toLinear' | 'toGamma'): TiledRaster {
  const f = dir === 'toLinear' ? (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)) : (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);
  for (const [k] of r.tiles) {
    const tx = (k % 65536) - 32768, ty = Math.floor(k / 65536) - 32768;
    const rect = { x: tx * 256, y: ty * 256, w: 256, h: 256 };
    const px = r.readFloat(rect);
    for (let i = 0; i < px.length; i += 4) { px[i] = f(px[i]); px[i + 1] = f(px[i + 1]); px[i + 2] = f(px[i + 2]); }
    r.writeFloat(rect, px);
  }
  return r;
}

export async function setColorMode(mode: 'rgb' | 'grayscale'): Promise<void> {
  const s = need();
  if (!s) return;
  // Duotone / Multichannel leave through their inks.
  if (s.doc.canvas.duotone || s.doc.canvas.colorMode === 'multichannel') return convertColorMode(mode);
  if (s.doc.canvas.colorMode === mode) return;
  if (leaveSingleLayerMode(mode)) return;
  // CMYK / Lab sources convert through colour management.
  if (s.doc.canvas.colorMode === 'cmyk' || s.doc.canvas.colorMode === 'lab') return convertColorMode(mode);
  const d = s.doc;
  if (mode === 'grayscale') {
    const r = await platform().confirm('Discard color information?', 'All pixel layers are converted to grayscale. You can undo this step.', ['Discard', 'Cancel']);
    if (r !== 0) return;
  }
  recordStateChange(d, s.history, mode === 'grayscale' ? 'Grayscale' : 'RGB Color', () => {
    if (mode === 'grayscale') {
      for (const l of d.walk()) {
        if (!hasRaster(l)) continue;
        for (const [k] of l.raster.tiles) {
          const rect = { x: ((k % 65536) - 32768) * 256, y: (Math.floor(k / 65536) - 32768) * 256, w: 256, h: 256 };
          const px = l.raster.readFloat(rect);
          for (let i = 0; i < px.length; i += 4) { const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; px[i] = px[i + 1] = px[i + 2] = g; }
          l.raster.writeFloat(rect, px);
        }
      }
      d.profile = { name: builtinProfileName('gray22'), builtin: 'gray22' };
    } else d.profile = { name: builtinProfileName('srgb'), builtin: 'srgb' };
    d.canvas = { ...d.canvas, colorMode: mode };
  }, { action: 'image.mode', args: { mode } });
}

export function assignProfile(p: ColorProfileRef): void {
  const s = need();
  if (!s) return;
  recordStateChange(s.doc, s.history, 'Assign Profile', () => {
    s.doc.profile = { ...p };
  }, { action: 'image.assignProfile', args: { name: p.name } });
  s.engine.invalidateAll();
}

export async function convertToProfile(to: ColorProfileRef | BuiltinProfileId, intent: Intent, bpc: boolean): Promise<void> {
  const s = need();
  if (!s) return;
  if (!(await colorEngine.init())) {
    ui.toast('error', 'Color management engine failed to load', colorEngine.error ?? undefined);
    return;
  }
  const d = s.doc;
  const target: ColorProfileRef = typeof to === 'string' ? { name: builtinProfileName(to), builtin: to } : to;
  // CMYK targets (and CMYK documents) convert through the document colour engine.
  if (colorEngine.spaceOf(target) === 'CMYK' || d.canvas.colorMode === 'cmyk') {
    if (d.canvas.colorMode !== 'cmyk') return convertColorMode('cmyk', target);
    recordStateChange(d, s.history, 'Convert to Profile', () => convertDocumentColor(d, 'cmyk', target, intent, bpc), { action: 'image.convertProfile', args: { name: target.name, intent, bpc } });
    s.engine.invalidateAll();
    return;
  }
  const p = ui.progress('Converting to profile…');
  try {
    await new Promise((r) => setTimeout(r, 16));
    recordStateChange(d, s.history, 'Convert to Profile', () => {
      for (const l of d.walk()) {
        if (hasRaster(l)) {
          for (const [k] of l.raster.tiles) {
            const rect = { x: ((k % 65536) - 32768) * 256, y: (Math.floor(k / 65536) - 32768) * 256, w: 256, h: 256 };
            const px = l.raster.readFloat(rect);
            colorEngine.convertRGBA(px, 256 * 256, d.profile, target, intent, bpc);
            l.raster.writeFloat(rect, px);
          }
        }
        // Parametric colors (so re-rendered text, shapes, fills and effects stay converted).
        convertLayerColors(l, (c) => {
          const px = new Float32Array([c.r, c.g, c.b, 1]);
          colorEngine.convertRGBA(px, 1, d.profile, target, intent, bpc);
          return { r: px[0], g: px[1], b: px[2] };
        });
      }
      d.profile = target;
    }, { action: 'image.convertProfile', args: { name: target.name, intent, bpc } });
  } catch (e) {
    ui.toast('error', 'Conversion failed', errorText(e));
  } finally {
    p.done();
  }
}

export { convertLayerColors } from '../../document/layerColors';

/** Image › Adjustments (destructive, on the active pixel layer within the selection). */
export function applyPixelAdjustment(adj: Adjustment): void {
  const r = needLayer();
  if (!r) return;
  const { s, l } = r;
  if (l.kind !== 'pixel') {
    ui.toast('info', 'Pixel adjustments require a pixel layer. Use an adjustment layer for non-destructive editing.');
    return;
  }
  const sel = s.doc.selection;
  const cmd = editRaster(s.doc, { kind: 'layer', layerId: l.id }, adjLabel(adj), (raster, ox, oy, plate) => {
    const b = rasterContentBounds(raster);
    if (!b) return null;
    const selB = sel.isEmpty() ? null : sel.bounds(s.doc.bounds);
    const region = selB ? intersect(b, { x: selB.x - ox, y: selB.y - oy, w: selB.w, h: selB.h }) : b;
    if (isEmpty(region)) return null;
    const px = raster.readFloat(region);
    const cov = sel.isEmpty() ? undefined : sel.read({ x: region.x + ox, y: region.y + oy, w: region.w, h: region.h });
    applyDocAdjustmentStraight(s.doc, adj, plate, px, region.w * region.h, cov);
    raster.writeFloat(region, px);
    return { x: region.x + ox, y: region.y + oy, w: region.w, h: region.h };
  }, { action: 'image.adjust', args: { adjustment: adj as unknown as Record<string, unknown> } }, { labRaw: true });
  if (cmd) s.push(cmd, true);
}

function adjLabel(a: Adjustment): string {
  return a.type.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

export function duplicateProfileRef(s: DocumentSession): ColorProfileRef {
  return { ...s.doc.profile };
}

export { editor };
