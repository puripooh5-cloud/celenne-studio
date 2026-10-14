/**
 * Display tiles: the render engine's GPU path (composite + output pass into a tile texture) vs its
 * CPU path, compared on the final 8-bit straight RGBA the viewport shows. Includes CMYK through a
 * real profile transform (4D LUT on the GPU vs per-pixel LittleCMS on the CPU).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDevice } from '../helpers/gpu';
import { GpuCompositor } from '../../src/gpu/compositor';
import { RenderEngine, setGpuCompositor, type DisplayTile } from '../../src/rendering/renderEngine';
import { add, complexDoc, newDoc } from '../helpers/build';
import { createAdjustmentLayer, createPixelLayer } from '../../src/document/layerFactory';
import { defaultAdjustment, type Adjustment } from '../../src/adjustments/types';
import { TiledRaster } from '../../src/image-engine/tiledRaster';
import type { CelenneDocument } from '../../src/document/document';
import { colorEngine } from '../../src/color/cms';
import { celenneCmykProfile } from '../../src/color/cmykProfile';
import { buildCmykGrid, evalCmykGrid } from '../../src/color/cmykDisplayGrid';

let gpu: GpuCompositor | null = null;
beforeAll(async () => { const d = await testDevice(); if (d) gpu = new GpuCompositor(d); });
afterAll(() => { setGpuCompositor(null); gpu?.dispose(); });

let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function noise(doc: CelenneDocument, name: string, x: number, y: number, w: number, h: number) {
  const f = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) f.set([rnd(), rnd() * 0.8, (i % w) / w, 0.4 + 0.6 * rnd()], i * 4);
  const r = new TiledRaster(4, doc.canvas.bitDepth);
  r.writeFloat({ x: 0, y: 0, w, h }, f);
  const l = createPixelLayer(name, doc.canvas.bitDepth, r);
  l.x = x; l.y = y;
  return l;
}

/** Renders tile (level, tx, ty) on the CPU and on the GPU; returns the largest 8-bit difference. */
async function compareTile(doc: CelenneDocument, level: number, tx: number, ty: number, setup?: (e: RenderEngine) => void): Promise<{ max: number; gpu: boolean }> {
  const e = new RenderEngine(doc);
  setup?.(e);
  setGpuCompositor(null);
  e.renderLevelSync(level);
  const cpuTile = e.getTile(level, tx, ty)!;
  const cpu = cpuTile.data.slice();
  setGpuCompositor(gpu);
  e.invalidateAll();
  e.renderLevelSync(level);
  const t = e.getTile(level, tx, ty) as DisplayTile;
  if (!t.gpu) { e.dispose(); return { max: 0, gpu: false }; }
  const g = await gpu!.readTile(t);
  let max = 0;
  for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) for (let c = 0; c < 4; c++) {
    const i = (y * 256 + x) * 4 + c;
    // Fully transparent pixels carry no colour.
    if (cpu[(y * 256 + x) * 4 + 3] === 0 && g[(y * 256 + x) * 4 + 3] === 0) continue;
    max = Math.max(max, Math.abs(cpu[i] - g[i]));
  }
  setGpuCompositor(null);
  e.dispose();
  return { max, gpu: true };
}

const run = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!gpu) return; await fn(); });

describe('GPU display tiles match the CPU display tiles', () => {
  run('RGB document with groups, clipping and adjustments (complexDoc without effects)', async () => {
    const doc = complexDoc();
    for (const l of doc.allLayers()) l.effects = null;
    for (const level of [0, 1]) {
      const r = await compareTile(doc, level, 0, 0);
      expect(r.gpu).toBe(true);
      expect(r.max, `level ${level}`).toBeLessThanOrEqual(1);
    }
  });

  run('32-bit document (linear → sRGB on output)', async () => {
    const doc = newDoc(120, 80, 32);
    add(doc, noise(doc, 'a', 0, 0, 120, 80));
    add(doc, createAdjustmentLayer({ ...defaultAdjustment('exposure'), exposure: 0.5 } as Adjustment, 'Exposure'));
    const r = await compareTile(doc, 0, 0, 0);
    expect(r.gpu).toBe(true);
    expect(r.max).toBeLessThanOrEqual(1);
  });

  run('CMYK document through the profile (4D LUT)', async () => {
    await colorEngine.init();
    const doc = newDoc(140, 90);
    doc.canvas = { ...doc.canvas, colorMode: 'cmyk' };
    doc.profile = { name: 'Celenne CMYK', icc: celenneCmykProfile() };
    const a = noise(doc, 'a', 0, 0, 140, 90);
    a.raster.companion = noise(doc, 'k', 0, 0, 140, 90).raster;
    add(doc, a);
    // The display transform as the app sets it up: one grid, evaluated by both paths.
    const x = colorEngine.transform(doc.profile, 'srgb', 'relative', true);
    const grid = buildCmykGrid((v, n) => x.run(v, n));
    const r = await compareTile(doc, 0, 0, 0, (e) => e.setView({ cmykDisplay: (ink, n) => evalCmykGrid(grid, ink, n), cmykGrid: grid }));
    expect(r.gpu).toBe(true);
    expect(r.max).toBeLessThanOrEqual(1);
  });
});
