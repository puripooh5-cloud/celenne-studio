/**
 * The 14 PSD compatibility fixtures. Each builder returns the PSD/PSB bytes.
 *
 * Fixtures 1–10, 12–14 are authored with Celenne's own document model and PSD writer; fixture 11
 * (CMYK) is written byte-by-byte because Celenne does not write CMYK. These are synthetic files:
 * they exercise the PSD structures listed in the spec but are not files saved by Photoshop.
 * Real-world Photoshop files can be dropped into tests/fixtures/psd/external/ and are picked up by
 * the compatibility suite automatically.
 */
import { CelenneDocument } from '../../src/document/document';
import { createAdjustmentLayer, createFillLayer, createGroupLayer, createMask, createShapeLayer, createSmartObjectLayer, createTextLayer } from '../../src/document/layerFactory';
import { defaultAdjustment } from '../../src/adjustments/types';
import { defaultBevel, defaultColorOverlay, defaultGlow, defaultGradientOverlay, defaultInnerGlow, defaultShadow, defaultStroke, emptyEffects } from '../../src/effects/types';
import { simpleGradient } from '../../src/color/types';
import { knot } from '../../src/vector/types';
import { rectPath, ellipsePath, polygonPath } from '../../src/vector/shapes';
import { TiledRaster } from '../../src/image-engine/tiledRaster';
import { encodePNG } from '../../src/formats/codecs';
import { renderSmartObject } from '../../src/layers/smartObjects';
import { updateAppearance } from '../../src/layers/appearance';
import { quadFromRect } from '../../src/image-engine/matrix';
import { exportPsd } from '../../src/psd/export';
import { Writer } from '../../src/psd/binary';
import { LAYER_BLEND_MODES } from '../../src/image-engine/blend';
import { uuid } from '../../src/document/ids';
import { add, complexDoc, newDoc, solidLayer } from './build';
import type { BitDepth } from '../../src/image-engine/pixels';

export interface Fixture {
  id: string;
  file: string;
  title: string;
  build(): Uint8Array;
  /** Whether Celenne is expected to write this document back (CMYK is converted on open). */
  roundTrip: boolean;
}

/** Deterministic gradient pixel layer (so renders exercise real colour variation). */
function gradientLayer(doc: CelenneDocument, name: string, x: number, y: number, w: number, h: number, hue = 0) {
  const d = doc.canvas.bitDepth;
  const l = solidLayer(doc, name, x, y, w, h, [0, 0, 0, 1]);
  const f = new Float32Array(w * h * 4);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const u = i / Math.max(1, w - 1), v = j / Math.max(1, h - 1);
      const k = (j * w + i) * 4;
      f[k] = (u + hue) % 1; f[k + 1] = v; f[k + 2] = 1 - u * v; f[k + 3] = 1;
    }
  l.raster.writeFloat({ x: 0, y: 0, w, h }, f);
  void d;
  return l;
}

function smartSource(doc: CelenneDocument, w: number, h: number) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = (j * w + i) * 4;
    const check = ((i >> 3) + (j >> 3)) & 1;
    px[k] = check ? 240 : 30; px[k + 1] = (i * 255) / w; px[k + 2] = (j * 255) / h; px[k + 3] = 255;
  }
  const png = encodePNG(w, h, px, 8);
  const raster = TiledRaster.fromPixels(w, h, 4, 8, px);
  const src = { id: uuid(), kind: 'embedded' as const, name: 'placed.png', fileType: 'png', data: png, decoded: { width: w, height: h, raster } };
  doc.smartSources.set(src.id, src);
  return src;
}

export const FIXTURES: Fixture[] = [
  {
    id: 'simple', file: '01-simple-one-layer.psd', title: 'Simple one-layer PSD', roundTrip: true,
    build: () => { const d = newDoc(120, 80, 8, 'Simple'); add(d, gradientLayer(d, 'Background', 0, 0, 120, 80)); return exportPsd(d); },
  },
  {
    id: 'multi', file: '02-multi-layer.psd', title: 'Multi-layer PSD', roundTrip: true,
    build: () => {
      const d = newDoc(160, 100, 8, 'Multi');
      add(d, solidLayer(d, 'Background', 0, 0, 160, 100, [1, 1, 1, 1]));
      add(d, gradientLayer(d, 'Gradient', 10, 10, 80, 60));
      const r = add(d, solidLayer(d, 'Red 70%', 60, 30, 70, 50, [0.9, 0.1, 0.1, 1])); r.opacity = 0.7;
      const h = add(d, solidLayer(d, 'Hidden', 0, 0, 40, 40, [0, 1, 0, 1])); h.visible = false;
      const o = add(d, solidLayer(d, 'Offscreen', 140, 80, 60, 60, [0, 0, 1, 1])); o.fillOpacity = 0.5;
      return exportPsd(d);
    },
  },
  {
    id: 'groups', file: '03-grouped.psd', title: 'Grouped PSD', roundTrip: true,
    build: () => {
      const d = newDoc(160, 100, 8, 'Groups');
      add(d, solidLayer(d, 'Background', 0, 0, 160, 100, [0.95, 0.95, 0.9, 1]));
      const g1 = add(d, createGroupLayer('Pass-through group'));
      const g2 = add(d, createGroupLayer('Nested (normal, 60%)'), g1 as never);
      g2.blendMode = 'normal'; g2.opacity = 0.6;
      const m = add(d, solidLayer(d, 'Multiply', 20, 20, 80, 50, [0.2, 0.6, 1, 1]), g2 as never); m.blendMode = 'multiply';
      add(d, solidLayer(d, 'Top of group', 70, 40, 60, 40, [1, 0.6, 0, 1]), g1 as never);
      const closed = add(d, createGroupLayer('Collapsed empty group'));
      (closed as { expanded?: boolean }).expanded = false;
      return exportPsd(d);
    },
  },
  {
    id: 'masks', file: '04-masks.psd', title: 'Mask PSD', roundTrip: true,
    build: () => {
      const d = newDoc(160, 100, 8, 'Masks');
      add(d, solidLayer(d, 'Background', 0, 0, 160, 100, [1, 1, 1, 1]));
      const l = add(d, gradientLayer(d, 'Masked', 0, 0, 160, 100));
      l.mask = createMask(true);
      const hole = new Float32Array(60 * 40);
      for (let j = 0; j < 40; j++) for (let i = 0; i < 60; i++) hole[j * 60 + i] = i / 59;
      l.mask.raster.writeFloat({ x: 50, y: 30, w: 60, h: 40 }, hole);
      l.mask.feather = 2; l.mask.density = 0.9;
      const v = add(d, solidLayer(d, 'Vector masked', 0, 0, 160, 100, [0.1, 0.2, 0.8, 1]));
      v.vectorMask = { path: ellipsePath(20, 20, 50, 50), enabled: true, invert: false, linked: true, density: 1, feather: 0 };
      const c = add(d, solidLayer(d, 'Clipped to vector-masked', 0, 0, 160, 100, [1, 0.8, 0, 1]));
      c.clipping = true; c.opacity = 0.5;
      return exportPsd(d);
    },
  },
  {
    id: 'text', file: '05-text.psd', title: 'Text PSD', roundTrip: true,
    build: () => {
      const d = newDoc(200, 100, 8, 'Text');
      add(d, solidLayer(d, 'Background', 0, 0, 200, 100, [1, 1, 1, 1]));
      const t1 = createTextLayer('Point text', 8, 10, 30);
      t1.text.runs[0].style = { ...t1.text.runs[0].style, fontSize: 24, fontFamily: 'Arial', color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } };
      add(d, t1);
      const t2 = createTextLayer('Paragraph text wraps inside its box. Second sentence.', 8, 10, 50);
      t2.text.kind = 'paragraph';
      t2.text.box = { x: 0, y: 0, w: 180, h: 40 };
      t2.text.runs[0].style = { ...t2.text.runs[0].style, fontSize: 12, fontFamily: 'Times New Roman' };
      add(d, t2);
      const t3 = createTextLayer('Missing font', 8, 110, 90);
      t3.text.runs[0].style = { ...t3.text.runs[0].style, fontFamily: 'Celenne Nonexistent Sans', postScriptName: 'CelenneNonexistentSans-Bold' };
      add(d, t3);
      return exportPsd(d);
    },
  },
  {
    id: 'adjustments', file: '06-adjustments.psd', title: 'Adjustment PSD', roundTrip: true,
    build: () => {
      const d = newDoc(160, 100, 8, 'Adjustments');
      add(d, gradientLayer(d, 'Background', 0, 0, 160, 100));
      const types = ['brightnessContrast', 'levels', 'curves', 'exposure', 'vibrance', 'hueSaturation', 'colorBalance', 'blackWhite', 'photoFilter', 'channelMixer', 'invert', 'posterize', 'threshold', 'gradientMap', 'selectiveColor'] as const;
      for (const t of types) {
        const a = add(d, createAdjustmentLayer(defaultAdjustment(t)));
        // Keep the render meaningful: only a few are visible.
        a.visible = t === 'curves' || t === 'hueSaturation' || t === 'colorBalance';
      }
      const c = d.allLayers().find((l) => l.kind === 'adjustment' && l.adjustment.type === 'curves');
      if (c && c.kind === 'adjustment' && c.adjustment.type === 'curves') c.adjustment.rgb = [{ x: 0, y: 0 }, { x: 96, y: 150 }, { x: 255, y: 255 }];
      const h = d.allLayers().find((l) => l.kind === 'adjustment' && l.adjustment.type === 'hueSaturation');
      if (h && h.kind === 'adjustment' && h.adjustment.type === 'hueSaturation') (h.adjustment as { master: { hue: number; saturation: number; lightness: number } }).master = { hue: 30, saturation: 20, lightness: 0 };
      add(d, createFillLayer({ type: 'gradient', gradient: simpleGradient({ r: 1, g: 0, b: 0.5 }, { r: 0, g: 0.5, b: 1 }), style: 'linear', angle: 45, scale: 100, reverse: false, dither: false, alignWithLayer: true, offsetX: 0, offsetY: 0 }, 'Gradient Fill')).opacity = 0.25;
      return exportPsd(d);
    },
  },
  {
    id: 'blend', file: '07-blend-modes.psd', title: 'Blend-mode PSD', roundTrip: true,
    build: () => {
      const modes = LAYER_BLEND_MODES.map((m) => m.id);
      const cols = 7, cell = 24;
      const d = newDoc(cols * cell, Math.ceil(modes.length / cols) * cell, 8, 'Blend modes');
      add(d, gradientLayer(d, 'Background', 0, 0, d.width, d.height, 0.3));
      modes.forEach((m, i) => {
        const l = add(d, solidLayer(d, m, (i % cols) * cell + 2, Math.floor(i / cols) * cell + 2, cell - 4, cell - 4, [0.8, 0.4, 0.2, 1]));
        l.blendMode = m;
      });
      return exportPsd(d);
    },
  },
  {
    id: 'smart', file: '08-smart-object.psd', title: 'Smart-object PSD', roundTrip: true,
    build: () => {
      const d = newDoc(160, 120, 8, 'Smart');
      add(d, solidLayer(d, 'Background', 0, 0, 160, 120, [0.9, 0.9, 0.9, 1]));
      const src = smartSource(d, 64, 48);
      const so = createSmartObjectLayer('Placed (scaled)', src.id, 64, 48, 8);
      so.quad = quadFromRect(20, 20, 96, 72);
      renderSmartObject(d, so);
      add(d, so);
      const so2 = createSmartObjectLayer('Placed (skewed)', src.id, 64, 48, 8);
      so2.quad = [{ x: 100, y: 60 }, { x: 150, y: 70 }, { x: 150, y: 110 }, { x: 95, y: 115 }] as never;
      renderSmartObject(d, so2);
      add(d, so2);
      return exportPsd(d);
    },
  },
  {
    id: 'vector', file: '09-vector.psd', title: 'Vector PSD', roundTrip: true,
    build: () => {
      const d = newDoc(200, 120, 8, 'Vector');
      add(d, solidLayer(d, 'Background', 0, 0, 200, 120, [1, 1, 1, 1]));
      const r = createShapeLayer('Rounded rectangle', rectPath(10, 10, 80, 50, [8, 8, 8, 8]), { kind: 'rectangle', x: 10, y: 10, w: 80, h: 50, radii: [8, 8, 8, 8] } as never, 8);
      r.fill = { type: 'solid', color: { r: 0.2, g: 0.5, b: 0.9 } };
      r.stroke = { ...r.stroke, enabled: true, width: 3, paint: { type: 'solid', color: { r: 0, g: 0, b: 0 } } };
      add(d, r);
      const e = createShapeLayer('Ellipse', ellipsePath(110, 15, 70, 40), { kind: 'ellipse', x: 110, y: 15, w: 70, h: 40 } as never, 8);
      e.fill = { type: 'gradient', gradient: simpleGradient({ r: 1, g: 0.8, b: 0 }, { r: 1, g: 0.2, b: 0.2 }), style: 'linear', angle: 90, scale: 100, reverse: false, dither: false };
      add(d, e);
      const star = createShapeLayer('Star', polygonPath(60, 90, 25, 5, 0.5), null, 8);
      star.fill = { type: 'solid', color: { r: 0.9, g: 0.2, b: 0.6 } };
      add(d, star);
      const free = createShapeLayer('Bezier', { fillRule: 'nonzero', subpaths: [{ closed: true, op: 'combine', knots: [{ ...knot(120, 70), outX: 175, outY: 60 }, knot(180, 110), { ...knot(120, 110), inX: 95, inY: 95 }] }] }, null, 8);
      free.fill = { type: 'solid', color: { r: 0.1, g: 0.7, b: 0.3 } };
      add(d, free);
      d.paths.push({ id: 'path-1', name: 'Saved path', kind: 'saved', path: ellipsePath(5, 5, 30, 30) });
      // Shapes are rasterized on creation in the app; do the same here.
      for (const l of d.allLayers()) if (l.kind === 'shape') updateAppearance(d, l);
      return exportPsd(d);
    },
  },
  {
    id: 'effects', file: '10-layer-effects.psd', title: 'Layer-effects PSD', roundTrip: true,
    build: () => {
      const d = newDoc(220, 140, 8, 'Effects');
      add(d, solidLayer(d, 'Background', 0, 0, 220, 140, [0.85, 0.85, 0.85, 1]));
      const mk = (name: string, x: number, y: number, set: (fx: ReturnType<typeof emptyEffects>) => void) => {
        const l = add(d, solidLayer(d, name, x, y, 40, 30, [0.2, 0.5, 0.9, 1]));
        l.effects = emptyEffects();
        set(l.effects);
      };
      mk('Drop shadow', 10, 10, (fx) => fx.dropShadow.push(defaultShadow(false)));
      mk('Inner shadow', 60, 10, (fx) => fx.innerShadow.push(defaultShadow(true)));
      mk('Outer glow', 110, 10, (fx) => { fx.outerGlow = defaultGlow(); });
      mk('Inner glow', 160, 10, (fx) => { fx.innerGlow = defaultInnerGlow(); });
      mk('Bevel', 10, 60, (fx) => { fx.bevel = defaultBevel(); });
      mk('Color overlay', 60, 60, (fx) => fx.colorOverlay.push({ ...defaultColorOverlay(), color: { r: 1, g: 0.3, b: 0 } }));
      mk('Gradient overlay', 110, 60, (fx) => fx.gradientOverlay.push(defaultGradientOverlay(simpleGradient({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }))));
      mk('Stroke', 160, 60, (fx) => fx.stroke.push({ ...defaultStroke(), size: 3, color: { r: 1, g: 0, b: 0 } }));
      mk('Stacked', 85, 100, (fx) => { fx.dropShadow.push(defaultShadow(false)); fx.stroke.push(defaultStroke()); fx.bevel = defaultBevel(); });
      return exportPsd(d);
    },
  },
  {
    id: 'cmyk', file: '11-cmyk.psd', title: 'CMYK PSD', roundTrip: false,
    build: () => {
      // Flat 8-bit CMYK file written directly (Photoshop stores CMYK inverted: 255 = no ink).
      const w = 64, h = 48;
      const out = new Writer();
      out.sig('8BPS'); out.u16(1); out.zeros(6); out.u16(4); out.u32(h); out.u32(w); out.u16(8); out.u16(4);
      out.u32(0); // color mode data
      out.u32(0); // image resources
      out.u32(0); // layer & mask info
      out.u16(0); // raw image data
      const inks = (x: number, y: number) => [x / (w - 1), y / (h - 1), (x < w / 2 ? 0.8 : 0), y > h * 0.75 ? 1 : 0];
      for (let c = 0; c < 4; c++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.u8(255 - Math.round(inks(x, y)[c] * 255));
      return out.result();
    },
  },
  {
    id: 'deep16', file: '12-16bit.psd', title: '16-bit PSD', roundTrip: true,
    build: () => {
      const d = newDoc(128, 96, 16 as BitDepth, '16-bit');
      add(d, gradientLayer(d, 'Smooth gradient', 0, 0, 128, 96));
      const l = add(d, solidLayer(d, 'Half-transparent', 20, 20, 60, 40, [0.123456, 0.654321, 0.333333, 0.5]));
      l.mask = createMask(true);
      add(d, createAdjustmentLayer(defaultAdjustment('curves'), 'Curves'));
      return exportPsd(d);
    },
  },
  {
    id: 'psb', file: '13-large.psb', title: 'Large PSB', roundTrip: true,
    build: () => {
      // Wider than the 30,000 px PSD limit; content is sparse to keep the fixture small.
      const d = newDoc(30200, 400, 8, 'Large PSB');
      add(d, solidLayer(d, 'Left block', 0, 0, 400, 400, [0.9, 0.2, 0.2, 1]));
      add(d, gradientLayer(d, 'Far right block', 29700, 50, 480, 300));
      add(d, createAdjustmentLayer(defaultAdjustment('invert'), 'Invert (hidden)')).visible = false;
      return exportPsd(d, { psb: true });
    },
  },
  {
    id: 'complex', file: '14-complex-professional.psd', title: 'Complex professional PSD', roundTrip: true,
    build: () => exportPsd(complexDoc(8)),
  },
];
