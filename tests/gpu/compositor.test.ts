/**
 * GPU compositor vs the CPU reference compositor, on documents that exercise every blend mode,
 * every adjustment type, groups, clipping, masks, Blend If, Lab, CMYK, 16/32-bit and pyramid
 * levels. Runs on headless WebGPU (Dawn); skipped when the machine has no GPU adapter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDevice, maxDiff } from '../helpers/gpu';
import { GpuCompositor } from '../../src/gpu/compositor';
import { compositeRegion } from '../../src/rendering/compositor';
import { add, newDoc } from '../helpers/build';
import { CelenneDocument } from '../../src/document/document';
import { createAdjustmentLayer, createFillLayer, createGroupLayer, createMask, createPixelLayer } from '../../src/document/layerFactory';
import { defaultAdjustment, type Adjustment, type AdjustmentType } from '../../src/adjustments/types';
import { TiledRaster } from '../../src/image-engine/tiledRaster';
import type { BitDepth } from '../../src/image-engine/pixels';
import { BLEND_MODES } from '../../src/image-engine/blend';
import type { Layer, PixelLayer } from '../../src/document/types';
import { knot } from '../../src/vector/types';
import { celenneCmykProfile } from '../../src/color/cmykProfile';

const TOL = 1 / 255;
let gpu: GpuCompositor | null = null;
let dev: GPUDevice | null = null;
beforeAll(async () => { dev = await testDevice(); if (dev) gpu = new GpuCompositor(dev); });
let worst = 0, worstName = '';
afterAll(() => { gpu?.dispose(); if (worst) console.log(`largest GPU−CPU difference: ${worst.toExponential(2)} (${(worst * 255).toFixed(3)}/255) in ${worstName}`); });
const gpuIt = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!gpu) return; await fn(); });

let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/** A layer of smooth colour ramps plus noise, with partially transparent areas. */
function noiseLayer(doc: CelenneDocument, name: string, x: number, y: number, w: number, h: number, alpha = true): PixelLayer {
  const d = doc.canvas.bitDepth;
  const f = new Float32Array(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const o = (j * w + i) * 4;
    f[o] = (i / w) * 0.8 + rnd() * 0.2; f[o + 1] = (j / h) * 0.7 + rnd() * 0.3; f[o + 2] = rnd();
    f[o + 3] = alpha ? Math.min(1, 0.3 + ((i + j) % 37) / 40) : 1;
  }
  const r = new TiledRaster(4, d);
  r.writeFloat({ x: 0, y: 0, w, h }, f);
  const l = createPixelLayer(name, d, r);
  l.x = x; l.y = y;
  return l;
}

async function compare(doc: CelenneDocument, r = doc.bounds, level = 0, plate?: number) {
  const g = await gpu!.compositeRead(doc, r, { level, plate });
  expect(g, 'GPU path accepted the document').not.toBeNull();
  const c = compositeRegion(doc, r, { level, plate });
  const d = maxDiff(g!, c);
  if (d.max > worst) { worst = d.max; worstName = expect.getState().currentTestName ?? ''; }
  return d;
}

function baseDoc(depth: BitDepth = 8, w = 96, h = 64): CelenneDocument {
  seed = 7;
  const doc = newDoc(w, h, depth);
  add(doc, noiseLayer(doc, 'Background', 0, 0, w, h, false));
  return doc;
}

describe('GPU compositor matches the CPU compositor', () => {
  for (const m of BLEND_MODES) {
    if (m.id === 'passThrough') continue;
    gpuIt(`blend mode ${m.id}`, async () => {
      const doc = baseDoc();
      const top = noiseLayer(doc, 'top', 13, -7, 70, 60);
      top.blendMode = m.id;
      top.opacity = 0.8;
      top.fillOpacity = 0.9;
      add(doc, top);
      const d = await compare(doc);
      expect(d.max).toBeLessThan(TOL);
    });
  }

  const adjustments: Adjustment[] = [
    { ...defaultAdjustment('curves'), rgb: [{ x: 0, y: 0 }, { x: 90, y: 140 }, { x: 255, y: 255 }], red: [{ x: 0, y: 20 }, { x: 255, y: 230 }] } as Adjustment,
    { ...defaultAdjustment('levels'), rgb: { inBlack: 20, inWhite: 230, gamma: 1.3, outBlack: 5, outWhite: 250 } } as Adjustment,
    { ...defaultAdjustment('brightnessContrast'), brightness: 30, contrast: 40 } as Adjustment,
    { ...defaultAdjustment('exposure'), exposure: 0.7, offset: 0.01, gamma: 1.1 } as Adjustment,
    { ...defaultAdjustment('vibrance'), vibrance: 40, saturation: -20 } as Adjustment,
    { ...defaultAdjustment('hueSaturation'), master: { hue: 30, saturation: 25, lightness: -10 }, ranges: [{ hue: -20, saturation: 40, lightness: 10, range: [315, 345, 15, 45] }] } as Adjustment,
    { ...defaultAdjustment('hueSaturation'), colorize: true, master: { hue: 200, saturation: 40, lightness: 10 } } as Adjustment,
    { ...defaultAdjustment('colorBalance'), shadows: [20, -10, 5], midtones: [-15, 10, 30], highlights: [5, 5, -20], preserveLuminosity: true } as Adjustment,
    { ...defaultAdjustment('blackWhite'), tint: true } as Adjustment,
    { ...defaultAdjustment('photoFilter'), density: 60, preserveLuminosity: true } as Adjustment,
    { ...defaultAdjustment('channelMixer'), red: [80, 20, 10, 2] } as Adjustment,
    { ...defaultAdjustment('channelMixer'), monochrome: true, gray: [40, 40, 20, 0] } as Adjustment,
    { type: 'colorLookup', name: 'test', lut: { size: 5, data: Float32Array.from({ length: 125 * 3 }, (_, i) => ((i * 37) % 101) / 100) } },
    defaultAdjustment('invert'),
    { ...defaultAdjustment('posterize'), levels: 5 } as Adjustment,
    { ...defaultAdjustment('threshold'), level: 120 } as Adjustment,
    defaultAdjustment('gradientMap'),
    { ...defaultAdjustment('selectiveColor'), mode: 'relative', colors: { ...(defaultAdjustment('selectiveColor') as Extract<Adjustment, { type: 'selectiveColor' }>).colors, reds: { c: -30, m: 20, y: 10, k: 5 }, neutrals: { c: 10, m: -5, y: 0, k: -10 } } } as Adjustment,
  ];
  for (const adj of adjustments) {
    gpuIt(`adjustment ${adj.type}${'colorize' in adj && adj.colorize ? ' (colorize)' : ''}${'monochrome' in adj && adj.monochrome ? ' (mono)' : ''}`, async () => {
      const doc = baseDoc();
      add(doc, noiseLayer(doc, 'mid', 20, 10, 60, 40));
      const a = createAdjustmentLayer(adj, 'Adj');
      a.opacity = 0.85;
      a.mask = createMask(true);
      a.mask.raster.writeFloat({ x: 0, y: 0, w: 30, h: 64 }, new Float32Array(30 * 64).fill(0.3));
      add(doc, a);
      expect((await compare(doc)).max).toBeLessThan(TOL);
    });
  }

  gpuIt('groups, clipping, masks, Blend If, channels, Dissolve and fills', async () => {
    const doc = baseDoc(8, 300, 280);
    // Isolated group (multiply) with a feathered mask.
    const g = createGroupLayer('Group');
    g.blendMode = 'multiply';
    g.opacity = 0.9;
    g.mask = createMask(true);
    g.mask.raster.writeFloat({ x: 40, y: 40, w: 100, h: 100 }, new Float32Array(100 * 100).fill(0));
    g.mask.feather = 4;
    add(doc, g);
    add(doc, noiseLayer(doc, 'g1', 30, 20, 200, 150), g);
    const g2 = noiseLayer(doc, 'g2', 60, 50, 120, 120);
    g2.blendMode = 'overlay';
    add(doc, g2, g);
    // Pass-through group with opacity and a nested adjustment.
    const pt = createGroupLayer('Pass');
    pt.blendMode = 'passThrough';
    pt.opacity = 0.6;
    add(doc, pt);
    add(doc, createAdjustmentLayer({ ...defaultAdjustment('hueSaturation'), master: { hue: 60, saturation: 0, lightness: 0 } } as Adjustment, 'Hue'), pt);
    // Clipping group: base with fill opacity, clipped multiply + clipped curves.
    const base = noiseLayer(doc, 'base', 150, 120, 140, 140);
    base.fillOpacity = 0.7;
    base.blendMode = 'screen';
    add(doc, base);
    const c1 = noiseLayer(doc, 'clip1', 100, 100, 160, 160);
    c1.clipping = true; c1.blendMode = 'multiply';
    add(doc, c1);
    const c2 = createAdjustmentLayer({ ...defaultAdjustment('curves'), rgb: [{ x: 0, y: 30 }, { x: 255, y: 220 }] } as Adjustment, 'clip curves');
    c2.clipping = true;
    add(doc, c2);
    // Blend If on both ranges, and channel restriction.
    const bi = noiseLayer(doc, 'blendif', 10, 150, 160, 120);
    bi.advanced = { ...bi.advanced, blendIf: { gray: { thisLayer: [20, 60, 200, 240], underlying: [0, 30, 220, 255] }, red: { thisLayer: [0, 0, 255, 255], underlying: [0, 0, 255, 255] }, green: { thisLayer: [0, 0, 255, 255], underlying: [10, 40, 255, 255] }, blue: { thisLayer: [0, 0, 255, 255], underlying: [0, 0, 255, 255] } }, channels: [true, false, true] };
    add(doc, bi);
    // Dissolve and a vector-masked solid fill + a gradient fill.
    const dz = noiseLayer(doc, 'dissolve', 200, 10, 90, 90);
    dz.blendMode = 'dissolve'; dz.opacity = 0.5;
    add(doc, dz);
    const fill = createFillLayer({ type: 'solid', color: { r: 0.9, g: 0.3, b: 0.1 } }, 'Fill');
    fill.opacity = 0.4;
    fill.vectorMask = { path: { fillRule: 'nonzero', subpaths: [{ closed: true, op: 'combine', knots: [knot(5, 5), knot(120, 20), knot(60, 110)] }] }, enabled: true, invert: false, linked: true, density: 1, feather: 2 };
    add(doc, fill);
    const grad = createFillLayer({ type: 'gradient', gradient: (defaultAdjustment('gradientMap') as Extract<Adjustment, { type: 'gradientMap' }>).gradient, style: 'linear', angle: 30, scale: 100, reverse: false, dither: false, alignWithLayer: true, offsetX: 0, offsetY: 0 }, 'Gradient');
    grad.blendMode = 'softLight';
    grad.opacity = 0.5;
    add(doc, grad);
    for (const r of [{ x: 0, y: 0, w: 256, h: 256 }, { x: 256, y: 0, w: 44, h: 256 }, { x: 0, y: 256, w: 256, h: 24 }, { x: 37, y: 91, w: 200, h: 150 }]) {
      const d = await compare(doc, r);
      expect(d.max, `region ${JSON.stringify(r)}`).toBeLessThan(TOL);
    }
    // Zoomed-out pyramid levels.
    expect((await compare(doc, { x: 0, y: 0, w: 150, h: 140 }, 1)).max).toBeLessThan(TOL);
    expect((await compare(doc, { x: 0, y: 0, w: 75, h: 70 }, 2)).max).toBeLessThan(TOL);
  });

  for (const depth of [16, 32] as BitDepth[]) {
    gpuIt(`${depth}-bit documents`, async () => {
      const doc = baseDoc(depth);
      const t = noiseLayer(doc, 'top', 5, 5, 80, 50);
      t.blendMode = 'softLight';
      add(doc, t);
      add(doc, createAdjustmentLayer({ ...defaultAdjustment('levels'), rgb: { inBlack: 10, inWhite: 240, gamma: 0.8, outBlack: 0, outWhite: 255 } } as Adjustment, 'Levels'));
      expect((await compare(doc)).max).toBeLessThan(TOL);
    });
  }

  gpuIt('Lab documents (non-Normal blends and colour adjustments go through RGB)', async () => {
    const doc = baseDoc();
    doc.canvas = { ...doc.canvas, colorMode: 'lab' };
    doc.profile = { name: 'Lab Color (D50)', builtin: 'labD50' };
    const t = noiseLayer(doc, 'top', 10, 0, 70, 60);
    t.blendMode = 'multiply';
    add(doc, t);
    add(doc, createAdjustmentLayer({ ...defaultAdjustment('curves'), rgb: [{ x: 0, y: 10 }, { x: 128, y: 150 }, { x: 255, y: 255 }] } as Adjustment, 'Curves'));
    add(doc, createAdjustmentLayer({ ...defaultAdjustment('hueSaturation'), master: { hue: 25, saturation: 20, lightness: 0 } } as Adjustment, 'Hue'));
    const sc = noiseLayer(doc, 'screen', 30, 20, 50, 40);
    sc.blendMode = 'screen';
    add(doc, sc);
    expect((await compare(doc)).max).toBeLessThan(TOL);
  });

  gpuIt('CMYK documents (both plates, black plate adjustments)', async () => {
    const doc = baseDoc();
    doc.canvas = { ...doc.canvas, colorMode: 'cmyk' };
    doc.profile = { name: 'Celenne CMYK', icc: celenneCmykProfile() };
    for (const l of doc.root.children as PixelLayer[]) l.raster.companion = noiseLayer(doc, 'k', 0, 0, 96, 64, false).raster;
    const t = noiseLayer(doc, 'top', 10, 3, 60, 50);
    t.raster.companion = noiseLayer(doc, 'k2', 0, 0, 60, 50).raster;
    t.blendMode = 'multiply';
    add(doc, t);
    add(doc, createAdjustmentLayer({ ...defaultAdjustment('curves'), rgb: [{ x: 0, y: 0 }, { x: 128, y: 100 }, { x: 255, y: 255 }] } as Adjustment, 'Curves'));
    add(doc, createAdjustmentLayer({ ...defaultAdjustment('hueSaturation'), master: { hue: 40, saturation: 10, lightness: 5 } } as Adjustment, 'Hue'));
    for (const plate of [0, 1]) expect((await compare(doc, doc.bounds, 0, plate)).max, `plate ${plate}`).toBeLessThan(TOL);
  });

  gpuIt('falls back for layer effects and knockout (no wrong output)', async () => {
    const doc = baseDoc();
    const t = noiseLayer(doc, 'fx', 10, 10, 40, 40) as Layer;
    t.effects = { ...(await import('../../src/effects/types')).emptyEffects() };
    t.effects.dropShadow.push((await import('../../src/effects/types')).defaultShadow(false));
    add(doc, t);
    expect(await gpu!.compositeRead(doc, doc.bounds, { level: 0 })).toBeNull();
  });

  gpuIt('re-uses uploaded tiles until they change', async () => {
    const doc = baseDoc();
    const t = noiseLayer(doc, 'top', 0, 0, 96, 64);
    add(doc, t);
    expect((await compare(doc)).max).toBeLessThan(TOL);
    // Edit the layer in place: the GPU must see the new pixels.
    t.raster.writeFloat({ x: 10, y: 10, w: 20, h: 20 }, new Float32Array(20 * 20 * 4).fill(1));
    expect((await compare(doc)).max).toBeLessThan(TOL);
    // Move it: tiles are re-addressed, not re-uploaded.
    t.x = 13; t.y = -4;
    expect((await compare(doc)).max).toBeLessThan(TOL);
  });
});

void (null as unknown as AdjustmentType);
