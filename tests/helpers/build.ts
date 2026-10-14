/** Programmatic document builders shared by tests, fixtures and benchmarks. */
import { CelenneDocument } from '../../src/document/document';
import { createAdjustmentLayer, createGroupLayer, createMask, createPixelLayer, createShapeLayer, createTextLayer, createFillLayer } from '../../src/document/layerFactory';
import { defaultAdjustment } from '../../src/adjustments/types';
import type { BitDepth } from '../../src/image-engine/pixels';
import { allocPixels, maxValue } from '../../src/image-engine/pixels';
import type { Layer, PixelLayer } from '../../src/document/types';
import { defaultShadow, defaultStroke, emptyEffects, defaultColorOverlay } from '../../src/effects/types';
import { knot } from '../../src/vector/types';
import { TiledRaster } from '../../src/image-engine/tiledRaster';
import { newId } from '../../src/document/ids';

export function newDoc(w = 64, h = 48, depth: BitDepth = 8, name = 'Test'): CelenneDocument {
  return new CelenneDocument(name, { width: w, height: h, resolution: 72, colorMode: 'rgb', bitDepth: depth });
}

/** Solid rectangle layer. Color components 0..1. */
export function solidLayer(doc: CelenneDocument, name: string, x: number, y: number, w: number, h: number, rgba: [number, number, number, number]): PixelLayer {
  const d = doc.canvas.bitDepth;
  const max = maxValue(d);
  const px = allocPixels(d, w * h * 4);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 4; c++) px[i * 4 + c] = d === 32 ? rgba[c] : Math.round(rgba[c] * max);
  const l = createPixelLayer(name, d, TiledRaster.fromPixels(w, h, 4, d, px));
  l.x = x;
  l.y = y;
  return l;
}

export function add(doc: CelenneDocument, l: Layer, parent = doc.root): Layer {
  doc.insertLayer(l, parent);
  return l;
}

/** A document exercising most PSD features. */
export function complexDoc(depth: BitDepth = 8): CelenneDocument {
  const doc = newDoc(96, 64, depth, 'Complex');
  add(doc, solidLayer(doc, 'Background', 0, 0, 96, 64, [1, 1, 1, 1]));
  const g = createGroupLayer('Group A');
  add(doc, g);
  const red = solidLayer(doc, 'Red', 8, 8, 40, 30, [1, 0, 0, 1]);
  red.opacity = 0.8;
  red.blendMode = 'multiply';
  red.mask = createMask(true);
  // Paint a black rectangle into the mask.
  const m = new Float32Array(10 * 10);
  red.mask.raster.writeFloat({ x: 10, y: 10, w: 10, h: 10 }, m);
  add(doc, red, g);
  const blue = solidLayer(doc, 'Blue clipped', 20, 20, 50, 30, [0, 0, 1, 1]);
  blue.clipping = true;
  blue.blendMode = 'screen';
  add(doc, blue, g);
  const curves = createAdjustmentLayer({ ...defaultAdjustment('curves'), rgb: [{ x: 0, y: 0 }, { x: 128, y: 160 }, { x: 255, y: 255 }] } as never, 'Curves 1');
  add(doc, curves);
  const levels = createAdjustmentLayer(defaultAdjustment('levels'), 'Levels 1');
  levels.visible = false;
  add(doc, levels);
  const fx = solidLayer(doc, 'With effects', 50, 10, 30, 30, [0, 0.6, 0.2, 1]);
  fx.effects = emptyEffects();
  fx.effects.dropShadow.push(defaultShadow(false));
  fx.effects.stroke.push({ ...defaultStroke(), size: 2, color: { r: 1, g: 1, b: 0 } });
  fx.effects.colorOverlay.push({ ...defaultColorOverlay(), opacity: 0.5 });
  add(doc, fx);
  const shape = createShapeLayer('Rectangle 1', { fillRule: 'nonzero', subpaths: [{ closed: true, op: 'combine', knots: [knot(60, 40), knot(90, 40), knot(90, 60), knot(60, 60)] }] }, { kind: 'rectangle', x: 60, y: 40, w: 30, h: 20 }, depth);
  shape.fill = { type: 'solid', color: { r: 0.2, g: 0.3, b: 0.9 } };
  add(doc, shape);
  const text = createTextLayer('Hello PSD', depth, 5, 55);
  add(doc, text);
  const fill = createFillLayer({ type: 'solid', color: { r: 0.9, g: 0.8, b: 0.1 } }, 'Color Fill 1');
  fill.opacity = 0.3;
  fill.vectorMask = { path: { fillRule: 'nonzero', subpaths: [{ closed: true, op: 'combine', knots: [knot(0, 0), knot(20, 0), knot(20, 20), knot(0, 20)] }] }, enabled: true, invert: false, linked: true, density: 1, feather: 0 };
  add(doc, fill);
  doc.guides.push({ id: newId('guide'), orientation: 'vertical', position: 48 }, { id: newId('guide'), orientation: 'horizontal', position: 32 });
  const alpha = new TiledRaster(1, 8, 0);
  alpha.writeFloat({ x: 0, y: 0, w: 32, h: 32 }, new Float32Array(32 * 32).fill(1));
  doc.channels.push({ id: newId('ch'), name: 'Alpha 1', kind: 'alpha', raster: alpha, visible: false, color: { r: 1, g: 0, b: 0 }, opacity: 0.5, indicatesSelected: false });
  doc.paths.push({ id: newId('path'), name: 'Path 1', kind: 'saved', path: { fillRule: 'nonzero', subpaths: [{ closed: true, op: 'combine', knots: [knot(10, 10), knot(50, 12), knot(30, 40)] }] } });
  return doc;
}

/** Structural summary used to compare documents before/after a round trip. */
export function structure(doc: CelenneDocument): unknown {
  const walk = (ls: Layer[]): unknown[] =>
    ls.map((l) => ({
      name: l.name,
      kind: l.kind,
      visible: l.visible,
      opacity: Math.round(l.opacity * 100),
      blend: l.blendMode,
      clipping: l.clipping,
      mask: !!l.mask,
      vectorMask: !!l.vectorMask,
      effects: l.effects ? { ds: l.effects.dropShadow.length, st: l.effects.stroke.length, co: l.effects.colorOverlay.length } : null,
      children: l.kind === 'group' ? walk(l.children) : undefined,
      adjustment: l.kind === 'adjustment' ? l.adjustment.type : undefined,
      text: l.kind === 'text' ? l.text.text : undefined,
    }));
  return { w: doc.width, h: doc.height, depth: doc.canvas.bitDepth, layers: walk(doc.root.children), guides: doc.guides.length, channels: doc.channels.map((c) => c.name), paths: doc.paths.map((p) => p.name) };
}
