/** Native CMYK / Lab: the built-in CMYK profile, conversions and documents. */
import { describe, expect, it } from 'vitest';
import { cmykToLabModel, labToCmykModel, celenneCmykProfile } from '../../src/color/cmykProfile';
import { colorEngine } from '../../src/color/cms';
import { add, newDoc, solidLayer } from '../helpers/build';
import { convertDocumentColor } from '../../src/color/convertDocument';
import { createFillLayer } from '../../src/document/layerFactory';
import { compositeRegionPlates } from '../../src/rendering/compositor';
import { exactCmyk } from '../../src/color/plates';
import type { RGB } from '../../src/color/types';
import { exportPsd } from '../../src/psd/export';
import { importPsd } from '../../src/psd/import';
import { parseContainer, decodeMergedChannels } from '../../src/psd/container';
import type { TiledRaster } from '../../src/image-engine/tiledRaster';
import { createAdjustmentLayer } from '../../src/document/layerFactory';
import { defaultAdjustment, type Adjustment } from '../../src/adjustments/types';
import type { AdjustmentLayer } from '../../src/document/types';

describe('Built-in CMYK profile', () => {
  it('models paper, solids and overprints plausibly', () => {
    const paper = cmykToLabModel(0, 0, 0, 0);
    expect(paper[0]).toBeCloseTo(100, 1);
    const k = cmykToLabModel(0, 0, 0, 1);
    expect(k[0]).toBeGreaterThan(10);
    expect(k[0]).toBeLessThan(25);
    const cyan = cmykToLabModel(1, 0, 0, 0);
    expect(cyan[2]).toBeLessThan(-30);
    // Monotonic darkening with black.
    let prev = 101;
    for (let v = 0; v <= 1.0001; v += 0.1) { const L = cmykToLabModel(0, 0, 0, v)[0]; expect(L).toBeLessThan(prev); prev = L; }
  });

  it('inverts in-gamut colours accurately, with GCR and the ink limit', () => {
    for (const cmyk of [[0.2, 0.4, 0.1, 0], [0.7, 0.1, 0.5, 0], [0, 0.9, 0.8, 0], [0.3, 0.3, 0.3, 0.2]] as [number, number, number, number][]) {
      const lab = cmykToLabModel(...cmyk);
      const back = labToCmykModel(lab);
      const lab2 = cmykToLabModel(...back);
      const dE = Math.hypot(lab[0] - lab2[0], lab[1] - lab2[1], lab[2] - lab2[2]);
      expect(dE).toBeLessThan(1);
    }
    const black = labToCmykModel([8, 0, 0]);
    expect(black[3]).toBeGreaterThan(0.8); // GCR: dark neutrals use black ink
    expect(black[0] + black[1] + black[2] + black[3]).toBeLessThanOrEqual(3.0001);
    const midGray = labToCmykModel([60, 0, 0]);
    expect(midGray[3]).toBeGreaterThan(0.05);
  });

  it('is a valid ICC profile for LittleCMS', async () => {
    const icc = celenneCmykProfile();
    expect(String.fromCharCode(...icc.subarray(36, 40))).toBe('acsp');
    expect(await colorEngine.init()).toBe(true);
    const ref = { name: 'Celenne CMYK', icc };
    const red = colorEngine.rgbToCmyk([1, 0, 0], { name: 'sRGB', builtin: 'srgb' }, ref)!;
    expect(red[0]).toBeLessThan(15); // % values
    expect(red[1]).toBeGreaterThan(80);
    expect(red[2]).toBeGreaterThan(80);
    const conv = colorEngine.cmykConverter(icc)!;
    const rgb = conv(Float64Array.from([0, 0, 0, 1, 0, 0, 0, 0]), 2);
    expect(rgb[0]).toBeLessThan(0.3); // 100 % K is dark
    expect(rgb[3]).toBeGreaterThan(0.95); // paper is white (relative)
  });
});

describe('CMYK and Lab documents', () => {
  it('converts pixels to native CMYK plates and back', async () => {
    await colorEngine.init();
    const doc = newDoc(8, 4);
    const l = solidLayer(doc, 'red', 0, 0, 8, 4, [1, 0, 0, 1]);
    add(doc, l);
    const fill = createFillLayer({ type: 'solid', color: { r: 0, g: 0, b: 1 } });
    fill.opacity = 0; // present but invisible
    add(doc, fill);
    convertDocumentColor(doc, 'cmyk', { name: 'Celenne CMYK', builtin: 'celenneCMYK' }, 'relative', true);
    expect(doc.canvas.colorMode).toBe('cmyk');
    const p0 = l.raster.readFloat({ x: 0, y: 0, w: 1, h: 1 });
    const p1 = l.raster.companion!.readFloat({ x: 0, y: 0, w: 1, h: 1 });
    const ink = [1 - p0[0], 1 - p0[1], 1 - p0[2], 1 - p1[0]];
    expect(ink[0]).toBeLessThan(0.15);
    expect(ink[1]).toBeGreaterThan(0.8);
    expect(ink[2]).toBeGreaterThan(0.8);
    expect(p1[0]).toBe(p1[1]); // neutral K triple
    // The fill colour now carries exact CMYK.
    expect(exactCmyk((fill.fill as { color: RGB }).color)?.[2]).toBeLessThan(0.1);
    // Composite per plate equals the layer (normal, opaque).
    const [c0, c1] = compositeRegionPlates(doc, { x: 0, y: 0, w: 1, h: 1 }, { level: 0 });
    expect(c0[1]).toBeCloseTo(p0[1], 5);
    expect(c1[0]).toBeCloseTo(p1[0], 5);
    convertDocumentColor(doc, 'rgb', { name: 'sRGB', builtin: 'srgb' }, 'relative', true);
    expect(l.raster.companion).toBeNull();
    const back = l.raster.readFloat({ x: 0, y: 0, w: 1, h: 1 });
    expect(back[0]).toBeGreaterThan(0.85);
    expect(back[1]).toBeLessThan(0.25);
  });

  it('multiplies ink the way Photoshop CMYK does (plates of inverted ink)', async () => {
    await colorEngine.init();
    const doc = newDoc(2, 2);
    doc.canvas = { ...doc.canvas, colorMode: 'cmyk' };
    doc.profile = { name: 'Celenne CMYK', builtin: 'celenneCMYK' };
    const a = solidLayer(doc, 'c50', 0, 0, 2, 2, [0.5, 1, 1, 1]); // 50 % cyan
    a.raster.companion = solidLayer(doc, 'k', 0, 0, 2, 2, [1, 1, 1, 1]).raster;
    add(doc, a);
    const b = solidLayer(doc, 'm50k20', 0, 0, 2, 2, [1, 0.5, 1, 1]); // 50 % magenta
    b.raster.companion = solidLayer(doc, 'k', 0, 0, 2, 2, [0.8, 0.8, 0.8, 1]).raster; // 20 % black
    b.blendMode = 'multiply';
    add(doc, b);
    const [c0, c1] = compositeRegionPlates(doc, { x: 0, y: 0, w: 1, h: 1 }, { level: 0 });
    expect(1 - c0[0]).toBeCloseTo(0.5, 2); // cyan kept
    expect(1 - c0[1]).toBeCloseTo(0.5, 2); // magenta added
    expect(1 - c1[0]).toBeCloseTo(0.2, 2); // black from the top layer
  });

  it('converts to Lab and keeps neutrals neutral', async () => {
    await colorEngine.init();
    const doc = newDoc(4, 4);
    const l = solidLayer(doc, 'gray', 0, 0, 4, 4, [0.5, 0.5, 0.5, 1]);
    add(doc, l);
    convertDocumentColor(doc, 'lab', { name: 'Lab', builtin: 'labD50' }, 'relative', true);
    expect(doc.canvas.colorMode).toBe('lab');
    const px = l.raster.readFloat({ x: 0, y: 0, w: 1, h: 1 });
    expect(px[0] * 100).toBeCloseTo(53.4, 0); // L* of sRGB 50 % gray
    expect(Math.abs(px[1] * 255 - 128)).toBeLessThan(1);
    expect(Math.abs(px[2] * 255 - 128)).toBeLessThan(1);
    convertDocumentColor(doc, 'rgb', { name: 'sRGB', builtin: 'srgb' }, 'relative', true);
    expect(l.raster.readFloat({ x: 0, y: 0, w: 1, h: 1 })[0]).toBeCloseTo(0.5, 2);
  });

  it('fixes the float transform regression (sRGB → linear)', async () => {
    await colorEngine.init();
    const d = Float32Array.from([0.5, 0.5, 0.5, 1]);
    colorEngine.convertRGBA(d, 1, { name: 's', builtin: 'srgb' }, 'linearSRGB', 'relative', false);
    expect(d[0]).toBeCloseTo(0.214, 2);
  });
});

describe('CMYK and Lab PSD files', () => {
  const cmykDoc = () => {
    const doc = newDoc(6, 4);
    doc.canvas = { ...doc.canvas, colorMode: 'cmyk' };
    doc.profile = { name: 'Celenne CMYK', icc: celenneCmykProfile() };
    const l = solidLayer(doc, 'ink', 0, 0, 6, 4, [0.2, 0.6, 1, 1]); // C 80 %, M 40 %, Y 0 %
    l.raster.companion = solidLayer(doc, 'k', 0, 0, 6, 4, [0.7, 0.7, 0.7, 1]).raster; // K 30 %
    add(doc, l);
    const t = solidLayer(doc, 'half', 2, 1, 2, 2, [1, 1, 0, 0.5]); // Y 100 %, no K plate (= no black)
    add(doc, t);
    return doc;
  };

  it('writes CMYK files with a K channel per layer and reads them back exactly', () => {
    const doc = cmykDoc();
    const bytes = exportPsd(doc);
    const c = parseContainer(bytes);
    expect(c.colorMode).toBe(4);
    expect(c.layers.every((l) => l.channels.some((ch) => ch.id === 3))).toBe(true);
    expect(c.channels).toBeGreaterThanOrEqual(4);
    const back = importPsd(bytes, 'c.psd').doc;
    expect(back.canvas.colorMode).toBe('cmyk');
    expect(back.profile.icc?.length).toBe(doc.profile.icc!.length);
    const [ink, half] = back.root.children as typeof doc.root.children & { raster: TiledRaster }[];
    const p0 = (ink as unknown as { raster: TiledRaster }).raster.readFloat({ x: 0, y: 0, w: 1, h: 1 });
    const p1 = (ink as unknown as { raster: TiledRaster }).raster.companion!.readFloat({ x: 0, y: 0, w: 1, h: 1 });
    expect([p0[0], p0[1], p0[2]].map((v) => Math.round(v * 255))).toEqual([51, 153, 255]);
    expect(Math.round(p1[0] * 255)).toBe(179);
    const k2 = (half as unknown as { raster: TiledRaster }).raster.companion!.readFloat({ x: 0, y: 0, w: 1, h: 1 });
    expect(k2[0]).toBe(1);
    // Merged composite: four colour planes.
    const planes = decodeMergedChannels(c);
    expect(planes[3][0]).toBe(179);
  });

  it('writes and reads Lab files natively', () => {
    const doc = newDoc(4, 4);
    doc.canvas = { ...doc.canvas, colorMode: 'lab' };
    doc.profile = { name: 'Lab Color (D50)', builtin: 'labD50' };
    add(doc, solidLayer(doc, 'lab', 0, 0, 4, 4, [0.6, 0.7, 0.3, 1]));
    const bytes = exportPsd(doc);
    const c = parseContainer(bytes);
    expect(c.colorMode).toBe(9);
    const back = importPsd(bytes, 'l.psd').doc;
    expect(back.canvas.colorMode).toBe('lab');
    const px = (back.root.children[0] as unknown as { raster: TiledRaster }).raster.readFloat({ x: 0, y: 0, w: 1, h: 1 });
    expect([px[0], px[1], px[2]].map((v) => Math.round(v * 255))).toEqual([153, 179, 77]);
  });

  it('keeps the Black channel of Curves and Levels adjustment layers', () => {
    const doc = cmykDoc();
    const curves = createAdjustmentLayer({ ...(defaultAdjustment('curves') as Extract<Adjustment, { type: 'curves' }>), black: [{ x: 0, y: 0 }, { x: 128, y: 90 }, { x: 255, y: 255 }] }, 'Curves');
    const levels = createAdjustmentLayer({ ...(defaultAdjustment('levels') as Extract<Adjustment, { type: 'levels' }>), black: { inBlack: 10, inWhite: 240, gamma: 1.3, outBlack: 0, outWhite: 250 } }, 'Levels');
    add(doc, curves);
    add(doc, levels);
    const back = importPsd(exportPsd(doc), 'k.psd').doc;
    const [bc, bl] = back.root.children.filter((l) => l.kind === 'adjustment') as AdjustmentLayer[];
    expect((bc.adjustment as { black?: unknown }).black).toEqual([{ x: 0, y: 0 }, { x: 128, y: 90 }, { x: 255, y: 255 }]);
    expect((bl.adjustment as { black?: unknown }).black).toEqual({ inBlack: 10, inWhite: 240, gamma: 1.3, outBlack: 0, outWhite: 250 });
    // The K curve darkens the K plate only.
    const [, k] = compositeRegionPlates(back, { x: 0, y: 0, w: 1, h: 1 }, { level: 0 });
    expect(k[0]).not.toBeCloseTo(0.7, 2);
  });
});

