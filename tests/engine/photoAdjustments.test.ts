/**
 * Photo adjustments matched to Photoshop (Phase 4.1). The pixel results are checked against
 * Photoshop's own composites in the corpus (pp-* / pv-* probes, photoshop-corpus.test.ts); these
 * tests cover the settings that travel through PSD files and the measured Vibrance tables.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importPsd } from '../../src/psd/import';
import { exportPsd } from '../../src/psd/export';
import { colorBalanceLUTs, photoFilterMatrix, prepareAdjustment, vibranceLut } from '../../src/adjustments/apply';
import { defaultAdjustment, type Adjustment } from '../../src/adjustments/types';
import type { AdjustmentLayer } from '../../src/document/types';

const corpus = path.resolve('tests/fixtures/photoshop/corpus');
const adjOf = (bytes: Uint8Array) => importPsd(bytes, 'x').doc.allLayers().find((l): l is AdjustmentLayer => l.kind === 'adjustment')!.adjustment;
const run = (adj: Adjustment, rgb: number[]) => { const c = Float32Array.from(rgb.map((v) => v / 255)); prepareAdjustment(adj).pixel(c); return [...c].map((v) => Math.round(v * 255)); };

describe('Photo Filter', () => {
  it("reads Photoshop's density (a fraction) and Lab filter colour", () => {
    const a = adjOf(new Uint8Array(fs.readFileSync(path.join(corpus, 'pp-pf-warm-d50.psd'))));
    if (a.type !== 'photoFilter') throw new Error('not a photo filter');
    expect(a.density).toBe(50);
    expect([a.color.r, a.color.g, a.color.b].map((v) => Math.round(v * 255))).toEqual([236, 138, 0]);
  });

  it('writes density and colour back as Photoshop stores them', () => {
    const doc = importPsd(new Uint8Array(fs.readFileSync(path.join(corpus, 'pp-pf-cool-d100-pres.psd'))), 'x').doc;
    const before = adjOf(new Uint8Array(fs.readFileSync(path.join(corpus, 'pp-pf-cool-d100-pres.psd'))));
    const after = adjOf(exportPsd(doc));
    expect(after).toMatchObject({ density: 100, preserveLuminosity: true });
    if (after.type !== 'photoFilter' || before.type !== 'photoFilter') throw new Error('not a photo filter');
    for (const k of ['r', 'g', 'b'] as const) expect(after.color[k]).toBeCloseTo(before.color[k], 3);
  });

  it('density 0 leaves colours alone; white stays white at any density', () => {
    const base = { ...defaultAdjustment('photoFilter'), preserveLuminosity: false } as Extract<Adjustment, { type: 'photoFilter' }>;
    const id = photoFilterMatrix({ ...base, density: 0 });
    id.forEach((v, i) => expect(v).toBeCloseTo(i % 4 === 0 ? 1 : 0, 6));
    expect(run({ ...base, density: 100, color: { r: 1, g: 1, b: 1 } }, [200, 100, 50])).toEqual([200, 100, 50]);
  });
});

describe('Vibrance', () => {
  it('0 is no change; measured levels reproduce Photoshop on the cube', () => {
    expect(vibranceLut(0)).toBeNull();
    const v = { ...defaultAdjustment('vibrance'), vibrance: -100, saturation: 0 } as Adjustment;
    expect(run(v, [255, 0, 0])).toEqual([255, 137, 137]); // Photoshop 2025
    expect(run(v, [132, 132, 132])).toEqual([132, 132, 132]);
  });

  it('Saturation −100 uses ProPhoto luminance weights in linear light (pure blue turns black)', () => {
    const s = { ...defaultAdjustment('vibrance'), vibrance: 0, saturation: -100 } as Adjustment;
    expect(run(s, [0, 0, 255])).toEqual([0, 0, 0]);
    expect(run(s, [255, 0, 0])).toEqual([146, 146, 146]); // Photoshop 2025
  });
});

describe('Color Balance', () => {
  it('Preserve Luminosity shifts each range before the curves (no change when all values are equal)', () => {
    const cb = { ...defaultAdjustment('colorBalance'), shadows: [10, 10, 10], midtones: [20, 20, 20], highlights: [-15, -15, -15], preserveLuminosity: true } as Extract<Adjustment, { type: 'colorBalance' }>;
    for (const lut of colorBalanceLUTs(cb)) for (let i = 0; i < lut.length; i += 97) expect(lut[i]).toBeCloseTo(i / (lut.length - 1), 2);
  });
});

describe('Selective Color', () => {
  it('a full-strength change is clipped before it is weighted', () => {
    const sc = defaultAdjustment('selectiveColor') as Extract<Adjustment, { type: 'selectiveColor' }>;
    const reds = { ...sc, mode: 'relative', colors: { ...sc.colors, reds: { c: 0, m: 0, y: 0, k: 60 } } } as Adjustment;
    expect(run(reds, [255, 82, 0])).toEqual([255, 26, 0]); // Photoshop 2025
  });
});

describe('Hue/Saturation colour ranges', () => {
  const hs = (range: Partial<{ hue: number; saturation: number; lightness: number }>) => ({ ...defaultAdjustment('hueSaturation'), ranges: [{ hue: 0, saturation: 0, lightness: 0, ...range, range: [315, 345, 15, 45] }] }) as Adjustment;
  it('leave grays alone', () => { expect(run(hs({ lightness: 40 }), [0, 0, 0])).toEqual([0, 0, 0]); expect(run(hs({ lightness: -40 }), [132, 132, 132])).toEqual([132, 132, 132]); });
  it('Lightness moves toward the brightest / darkest channel', () => {
    expect(run(hs({ lightness: 40 }), [132, 0, 0])).toEqual([132, 53, 53]); // Photoshop 2025
    expect(run(hs({ lightness: -40 }), [255, 247, 247])).toEqual([252, 247, 247]);
  });
});
