/**
 * Re-renders layers whose appearance is derived from parameters (text, shapes, smart objects).
 * The rendered raster becomes part of document state (captured by history), so undo/redo
 * never needs to re-render.
 */
import type { CelenneDocument } from '../document/document';
import type { Layer, Paint, ShapeLayer, TextLayer } from '../document/types';
import { TiledRaster } from '../image-engine/tiledRaster';
import { renderText } from '../typography/render';
import { pathBounds, rasterizePath } from '../vector/rasterize';
import { dilateMask, erodeMask } from '../image-engine/blur';
import { buildGradientLUT, geometryFromAngle, renderGradient } from '../color/gradient';
import { expand, intersect, isEmpty, Rect } from '../image-engine/rect';
import { renderSmartObject } from './smartObjects';
import { fonts } from '../typography/fonts';
import { isCmykDoc, isLabDoc, mapColorsToPlate, plateCount } from '../color/plates';
import { platePatterns } from '../rendering/platePatterns';

/** CMYK and Lab documents render parametric layers with colours mapped to stored values. */
const mapsColors = (doc: CelenneDocument) => isCmykDoc(doc) || isLabDoc(doc);

export function updateAppearance(doc: CelenneDocument, layer: Layer): void {
  switch (layer.kind) {
    case 'text':
      renderTextLayer(doc, layer);
      break;
    case 'shape':
      renderShapeLayer(doc, layer);
      break;
    case 'smartObject':
      renderSmartObject(doc, layer);
      break;
  }
}

export function renderTextLayer(doc: CelenneDocument, layer: TextLayer): void {
  const rasters: TiledRaster[] = [];
  let alpha0: Float32Array | null = null;
  let browser = false;
  for (let p = 0; p < plateCount(doc); p++) {
    const r = renderText(mapsColors(doc) ? mapColorsToPlate(doc, layer.text, p) : layer.text);
    if (r && !r.engine) browser = true;
    const raster = new TiledRaster(4, doc.canvas.bitDepth);
    if (r) {
      const n = r.rect.w * r.rect.h * 4;
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = r.data[i] / 255;
      // Plates share one transparency (the browser's text anti-aliasing varies with the colour), so
      // every plate takes plate 0's coverage.
      if (p === 0) alpha0 = f;
      else if (alpha0 && alpha0.length === f.length) for (let i = 3; i < n; i += 4) f[i] = alpha0[i];
      raster.writeFloat({ x: 0, y: 0, w: r.rect.w, h: r.rect.h }, f);
      raster.compact();
      layer.x = r.rect.x;
      layer.y = r.rect.y;
    }
    rasters.push(raster);
  }
  const raster = rasters[0];
  raster.companion = rasters[1] ?? null;
  layer.raster = raster;
  layer.usingPreservedPixels = false;
  layer.browserRendered = browser;
  layer.missingFonts = [...new Set(layer.text.runs.filter((run) => !fonts.isAvailable(run.style.postScriptName ?? '', run.style.fontFamily)).map((run) => run.style.postScriptName ?? run.style.fontFamily))];
  layer.rev++;
}

/** Renders a Paint into straight RGBA for rect (document px); `plate` selects the CMYK plate. */
export function renderPaint(doc: CelenneDocument, paint: Paint, r: Rect, box: Rect, plate = 0): Float32Array {
  if (mapsColors(doc)) paint = mapColorsToPlate(doc, paint, plate);
  const n = r.w * r.h;
  const out = new Float32Array(n * 4);
  if (paint.type === 'solid') {
    for (let i = 0; i < n; i++) { out[i * 4] = paint.color.r; out[i * 4 + 1] = paint.color.g; out[i * 4 + 2] = paint.color.b; out[i * 4 + 3] = 1; }
  } else if (paint.type === 'gradient') {
    renderGradient(geometryFromAngle(paint.style, paint.angle, paint.scale, box), buildGradientLUT(paint.gradient, paint.reverse), r, 1, paint.dither, out);
  } else if (paint.type === 'pattern') {
    const p = platePatterns(doc, plate).get(paint.patternId);
    if (p) {
      const px = p.raster.readFloat({ x: 0, y: 0, w: p.width, h: p.height });
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const tx = (((r.x + x) % p.width) + p.width) % p.width, ty = (((r.y + y) % p.height) + p.height) % p.height;
          const si = (ty * p.width + tx) * 4, o = (y * r.w + x) * 4;
          out[o] = px[si]; out[o + 1] = px[si + 1]; out[o + 2] = px[si + 2]; out[o + 3] = px[si + 3];
        }
    }
  }
  return out;
}

function canvasStroke(layer: ShapeLayer, r: Rect): Float32Array | null {
  if (typeof OffscreenCanvas === 'undefined' || typeof Path2D === 'undefined') return null;
  const st = layer.stroke;
  const c = new OffscreenCanvas(r.w, r.h);
  const g = c.getContext('2d')!;
  const p = new Path2D();
  for (const sp of layer.path.subpaths) {
    const k = sp.knots;
    if (!k.length) continue;
    p.moveTo(k[0].x - r.x, k[0].y - r.y);
    const n = sp.closed ? k.length : k.length - 1;
    for (let i = 0; i < n; i++) {
      const a = k[i], b = k[(i + 1) % k.length];
      p.bezierCurveTo(a.outX - r.x, a.outY - r.y, b.inX - r.x, b.inY - r.y, b.x - r.x, b.y - r.y);
    }
    if (sp.closed) p.closePath();
  }
  const closed = layer.path.subpaths.every((s) => s.closed);
  const align = closed ? st.alignment : 'center';
  g.lineWidth = align === 'center' ? st.width : st.width * 2;
  g.lineCap = st.cap;
  g.lineJoin = st.join;
  g.miterLimit = st.miterLimit;
  if (st.dash.length) {
    g.setLineDash(st.dash.map((d) => d * st.width));
    g.lineDashOffset = st.dashOffset * st.width;
  }
  g.strokeStyle = '#fff';
  if (align === 'inside') {
    g.save();
    g.clip(p, layer.path.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
    g.stroke(p);
    g.restore();
  } else if (align === 'outside') {
    g.stroke(p);
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#fff';
    g.fill(p, layer.path.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
  } else g.stroke(p);
  const id = g.getImageData(0, 0, r.w, r.h).data;
  const out = new Float32Array(r.w * r.h);
  for (let i = 0; i < out.length; i++) out[i] = id[i * 4 + 3] / 255;
  return out;
}

export function renderShapeLayer(doc: CelenneDocument, layer: ShapeLayer): void {
  const raster = new TiledRaster(4, doc.canvas.bitDepth);
  if (isCmykDoc(doc)) raster.companion = new TiledRaster(4, doc.canvas.bitDepth);
  layer.raster = raster;
  const pb = pathBounds(layer.path);
  layer.x = 0;
  layer.y = 0;
  layer.usingPreservedPixels = false;
  layer.rev++;
  if (!pb) return;
  const pad = Math.ceil(layer.stroke.enabled ? layer.stroke.width * 1.5 + 2 : 2);
  // Limit to a generous area around the canvas to keep huge off-canvas shapes bounded.
  const r = intersect(expand(pb, pad), expand(doc.bounds, Math.max(doc.width, doc.height)));
  if (isEmpty(r)) return;
  const n = r.w * r.h;
  const fillCov = layer.fill.type !== 'none' ? rasterizePath(layer.path, r, 1) : null;
  const strokeCov = layer.stroke.enabled && layer.stroke.width > 0 ? strokeCoverage(layer, r) : null;
  for (let plate = 0; plate < plateCount(doc); plate++) {
    const out = shapePlate(doc, layer, r, pb, n, fillCov, strokeCov, plate);
    const target = plate === 0 ? raster : raster.companion!;
    target.writeFloat(r, out);
    target.compact();
  }
}

function strokeCoverage(layer: ShapeLayer, r: Rect): Float32Array {
  let sc = canvasStroke(layer, r);
  if (!sc) {
    // Headless fallback (closed paths): stroke from the fill coverage via distance transforms.
    const cov = rasterizePath(layer.path, r, 1);
    const w = layer.stroke.width;
    const al = layer.stroke.alignment;
    const outer = al === 'inside' ? cov : dilateMask(cov, r.w, r.h, al === 'center' ? w / 2 : w);
    const inner = al === 'outside' ? cov : erodeMask(cov, r.w, r.h, al === 'center' ? w / 2 : w);
    sc = outer.map((v, i) => Math.max(0, v - inner[i]));
  }
  return sc;
}

function shapePlate(doc: CelenneDocument, layer: ShapeLayer, r: Rect, pb: Rect, n: number, cov: Float32Array | null, sc: Float32Array | null, plate: number): Float32Array {
  const out = new Float32Array(n * 4);
  if (cov) {
    const paint = renderPaint(doc, layer.fill, r, pb, plate);
    for (let i = 0; i < n; i++) {
      const a = cov[i] * paint[i * 4 + 3];
      if (a <= 0) continue;
      out[i * 4] = paint[i * 4]; out[i * 4 + 1] = paint[i * 4 + 1]; out[i * 4 + 2] = paint[i * 4 + 2]; out[i * 4 + 3] = a;
    }
  }
  if (sc) {
    const paint = renderPaint(doc, layer.stroke.paint, r, pb, plate);
    const op = layer.stroke.opacity;
    for (let i = 0; i < n; i++) {
      const sa = sc[i] * paint[i * 4 + 3] * op;
      if (sa <= 0) continue;
      const da = out[i * 4 + 3];
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) out[i * 4 + c] = (paint[i * 4 + c] * sa + out[i * 4 + c] * da * (1 - sa)) / oa;
      out[i * 4 + 3] = oa;
    }
  }
  return out;
}
