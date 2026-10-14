/** Indexed Color and Bitmap modes: palettes, dithering, edit conformance and PSD round trips. */
import { describe, expect, it } from 'vitest';
import { add, newDoc, solidLayer } from '../helpers/build';
import { buildPalette, DEFAULT_INDEXED, exactColors, quantize, toBitmap, DEFAULT_BITMAP, BitmapMethod } from '../../src/color/indexed';
import { conformAfterStep, markConformed } from '../../src/color/modeConform';
import { History } from '../../src/history/history';
import { editRaster } from '../../src/commands/rasterCommands';
import { CreateLayerCommand } from '../../src/commands/layerCommands';
import { createPixelLayer } from '../../src/document/layerFactory';
import { exportPsd } from '../../src/psd/export';
import { importPsd } from '../../src/psd/import';
import { parseContainer } from '../../src/psd/container';
import { TiledRaster } from '../../src/image-engine/tiledRaster';
import type { CelenneDocument } from '../../src/document/document';
import type { PixelLayer } from '../../src/document/types';

function gradient(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    px[i] = (x * 255) / (w - 1); px[i + 1] = (y * 255) / (h - 1); px[i + 2] = 128; px[i + 3] = 255;
  }
  return px;
}

const inPalette = (px: Uint8ClampedArray, pal: number[]) => {
  const set = new Set<number>();
  for (let i = 0; i < pal.length; i += 3) set.add((pal[i] << 16) | (pal[i + 1] << 8) | pal[i + 2]);
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] && !set.has((px[i] << 16) | (px[i + 1] << 8) | px[i + 2])) return false;
  return true;
};

function indexedDoc(): CelenneDocument {
  const doc = newDoc(40, 30);
  const px = gradient(40, 30);
  const pal = buildPalette(px, { ...DEFAULT_INDEXED, colors: 16, transparency: false });
  quantize(px, 40, 30, pal, { ...DEFAULT_INDEXED, transparency: false });
  // Transparent corner.
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) px.fill(0, (y * 40 + x) * 4, (y * 40 + x) * 4 + 4);
  add(doc, createPixelLayer('Background', 8, TiledRaster.fromPixels(40, 30, 4, 8, px)));
  doc.canvas = { ...doc.canvas, colorMode: 'indexed', colorTable: pal, colorTableTransparent: true };
  return doc;
}

describe('Indexed Color', () => {
  it('builds exact, adaptive, uniform and web palettes', () => {
    const three = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255]);
    expect(exactColors(three)!.length / 3).toBe(3);
    const g = gradient(64, 64);
    for (const palette of ['adaptive', 'perceptual'] as const) {
      const pal = buildPalette(g, { ...DEFAULT_INDEXED, palette, colors: 16, transparency: false });
      expect(pal.length / 3).toBe(16);
      expect(pal.slice(-6)).toEqual(expect.arrayContaining([0, 255])); // forced black & white
    }
    expect(buildPalette(g, { ...DEFAULT_INDEXED, palette: 'uniform', colors: 27, forced: 'none', transparency: false }).length / 3).toBe(27);
    expect(buildPalette(g, { ...DEFAULT_INDEXED, palette: 'web', transparency: false }).length / 3).toBe(216);
    // One slot is reserved for transparency.
    expect(buildPalette(g, { ...DEFAULT_INDEXED, colors: 256, transparency: true }).length / 3).toBeLessThanOrEqual(255);
  });

  it('maps every pixel into the palette with each dither', () => {
    const g0 = gradient(64, 48);
    const pal = buildPalette(g0, { ...DEFAULT_INDEXED, colors: 8, transparency: false });
    for (const dither of ['none', 'diffusion', 'pattern', 'noise'] as const) {
      const g = gradient(64, 48);
      quantize(g, 64, 48, pal, { dither, amount: 1, transparency: false, matte: [255, 255, 255] });
      expect(inPalette(g, pal)).toBe(true);
    }
    // Diffusion keeps the average colour much closer than no dithering.
    const mean = (p: Uint8ClampedArray) => { let s = 0; for (let i = 0; i < p.length; i += 4) s += p[i]; return s / (p.length / 4); };
    const a = gradient(64, 48), b = gradient(64, 48);
    const two = [0, 0, 128, 255, 255, 128];
    quantize(a, 64, 48, two, { dither: 'none', amount: 1, transparency: false, matte: [255, 255, 255] });
    quantize(b, 64, 48, two, { dither: 'diffusion', amount: 1, transparency: false, matte: [255, 255, 255] });
    expect(Math.abs(mean(b) - 127.5)).toBeLessThan(4);
  });

  it('snaps edited pixels to the table and rejects extra layers', () => {
    const doc = indexedDoc();
    markConformed(doc);
    const h = new History(doc);
    const bg = doc.root.children[0] as PixelLayer;
    // Paint an off-palette colour.
    const cmd = editRaster(doc, { kind: 'layer', layerId: bg.id }, 'Paint', (r) => {
      r.writeFloat({ x: 10, y: 10, w: 4, h: 4 }, new Float32Array(64).map((_, i) => ((i & 3) === 3 ? 1 : (i & 3) === 0 ? 0.93 : 0.11)));
      return { x: 10, y: 10, w: 4, h: 4 };
    });
    h.push(cmd!, true);
    expect(conformAfterStep(doc, h)).toBeNull();
    const out = bg.raster.readFloat(doc.bounds);
    const px8 = new Uint8ClampedArray(out.length).map((_, i) => Math.round(out[i] * 255));
    expect(inPalette(px8, doc.canvas.colorTable!)).toBe(true);
    expect(px8[3]).toBe(0); // transparency kept
    // A second layer is not allowed: the step is reverted and dropped.
    const before = h.entries.length;
    const extra = createPixelLayer('Layer 1', 8);
    doc.insertLayer(extra, doc.root);
    h.push(new CreateLayerCommand('New Layer', extra, doc.root.id, 1), true);
    expect(conformAfterStep(doc, h)).toMatch(/single pixel layer/);
    expect(doc.root.children.length).toBe(1);
    expect(h.entries.length).toBe(before);
  });

  it('round-trips through PSD as an Indexed Color file with transparency', () => {
    const doc = indexedDoc();
    const bytes = exportPsd(doc);
    const c = parseContainer(bytes);
    expect([c.colorMode, c.depth, c.channels, c.layers.length, c.colorModeData.length]).toEqual([2, 8, 1, 0, 768]);
    const back = importPsd(bytes, 'i.psd').doc;
    expect(back.canvas.colorMode).toBe('indexed');
    expect(back.canvas.colorTable).toEqual(doc.canvas.colorTable);
    expect(back.canvas.colorTableTransparent).toBe(true);
    const a = (doc.root.children[0] as PixelLayer).raster.readFloat(doc.bounds);
    const b = (back.root.children[0] as PixelLayer).raster.readFloat(doc.bounds);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    expect(diff).toBeLessThan(1 / 255 + 1e-6);
    expect(back.compatibility.find((i) => i.feature === 'Color mode')?.status).toBe('editable');
  });
});

describe('Bitmap', () => {
  it('produces pure black and white with every method', () => {
    for (const method of ['threshold', 'pattern', 'diffusion', 'halftone'] as BitmapMethod[]) {
      const g = gradient(64, 48);
      toBitmap(g, 64, 48, { ...DEFAULT_BITMAP, method, frequency: 20 }, 144);
      const values = new Set<number>();
      for (let i = 0; i < g.length; i += 4) { values.add(g[i]); expect(g[i]).toBe(g[i + 1]); expect(g[i + 3]).toBe(255); }
      expect([...values].sort()).toEqual([0, 255]);
    }
    // Diffusion preserves mean tone (~ 50 % black for mid gray).
    const gray = new Uint8ClampedArray(64 * 64 * 4).map((_, i) => ((i & 3) === 3 ? 255 : 128));
    toBitmap(gray, 64, 64, { ...DEFAULT_BITMAP, method: 'diffusion' }, 72);
    let white = 0;
    for (let i = 0; i < gray.length; i += 4) if (gray[i]) white++;
    expect(white / 4096).toBeGreaterThan(0.45);
    expect(white / 4096).toBeLessThan(0.56);
  });

  it('round-trips through PSD as a 1-bit Bitmap file', () => {
    const doc = newDoc(21, 9);
    const l = solidLayer(doc, 'Background', 0, 0, 21, 9, [1, 1, 1, 1]);
    add(doc, l);
    l.raster.writeFloat({ x: 3, y: 2, w: 9, h: 4 }, new Float32Array(9 * 4 * 4).map((_, i) => ((i & 3) === 3 ? 1 : 0)));
    doc.canvas = { ...doc.canvas, colorMode: 'bitmap' };
    const bytes = exportPsd(doc);
    const c = parseContainer(bytes);
    expect([c.colorMode, c.depth, c.channels, c.layers.length]).toEqual([0, 1, 1, 0]);
    const back = importPsd(bytes, 'b.psd').doc;
    expect(back.canvas.colorMode).toBe('bitmap');
    const px = (back.root.children[0] as PixelLayer).raster.readFloat(back.bounds);
    expect(px[(2 * 21 + 3) * 4]).toBe(0);
    expect(px[(2 * 21 + 12) * 4]).toBe(1);
    expect(px[(6 * 21 + 3) * 4]).toBe(1);
  });
});
