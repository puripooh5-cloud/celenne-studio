/**
 * Live previews on the GPU (Gaussian Blur, Box Blur, Unsharp Mask, destructive adjustments) vs the
 * CPU preview path the app uses (override.read), including a selection and a zoomed-out level.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDevice, maxDiff } from '../helpers/gpu';
import { GpuCompositor } from '../../src/gpu/compositor';
import { compositeRegion, readLayerContent, type LayerOverride } from '../../src/rendering/compositor';
import { add, newDoc } from '../helpers/build';
import { createPixelLayer } from '../../src/document/layerFactory';
import { TiledRaster } from '../../src/image-engine/tiledRaster';
import { filterById } from '../../src/filters/builtin';
import { runFilterSync } from '../../src/filters/runner';
import { defaultAdjustment, type Adjustment } from '../../src/adjustments/types';
import { applyDocAdjustmentStraight } from '../../src/adjustments/docAdjust';
import { expand, type Rect } from '../../src/image-engine/rect';
import type { CelenneDocument } from '../../src/document/document';
import type { Layer } from '../../src/document/types';

let gpu: GpuCompositor | null = null;
beforeAll(async () => { const d = await testDevice(); if (d) gpu = new GpuCompositor(d); });
afterAll(() => { gpu?.dispose(); });
const run = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!gpu) return; await fn(); });

let seed = 9;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function photo(doc: CelenneDocument, w: number, h: number) {
  const f = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    f[o] = (Math.sin(x / 7) + 1) / 2; f[o + 1] = (Math.cos(y / 11) + 1) / 2; f[o + 2] = rnd(); f[o + 3] = x > w * 0.8 ? 0.4 : 1;
  }
  const r = new TiledRaster(4, 8);
  r.writeFloat({ x: 0, y: 0, w, h }, f);
  const l = createPixelLayer('photo', 8, r);
  l.x = 5; l.y = -3;
  return l;
}

/** The app's CPU filter preview (filterOps.setFilterPreview, local filters). */
function cpuFilterRead(doc: CelenneDocument, layer: Layer, id: string, params: Record<string, number>): LayerOverride['read'] {
  const def = filterById(id)!;
  return (r: Rect, level: number, plate = 0) => {
    const scale = 1 / (1 << level);
    const ctxBase = { doc, level, scale, opts: { level, plate } };
    const read = (rr: Rect) => readLayerContent(ctxBase, { ...layer, id: '__noop' } as never, rr);
    const orig = read(r);
    const pad = Math.ceil(def.padding(params as never) * scale) + 1;
    const pr = expand(r, pad);
    const out = runFilterSync(def, params as never, { w: pr.w, h: pr.h, ch: 4, data: read(pr) }, { scale, originX: pr.x, originY: pr.y, bounds: r, foreground: [0, 0, 0], background: [1, 1, 1] });
    const filtered = new Float32Array(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) filtered.set(out.data.subarray(((y + pad) * pr.w + pad) * 4, ((y + pad) * pr.w + pad + r.w) * 4), y * r.w * 4);
    if (!doc.selection.isEmpty()) {
      const cov = doc.selection.mask.readFloat(r, level);
      for (let i = 0; i < r.w * r.h; i++) for (let c = 0; c < 4; c++) filtered[i * 4 + c] = orig[i * 4 + c] + (filtered[i * 4 + c] - orig[i * 4 + c]) * cov[i];
    }
    return filtered;
  };
}

async function compare(doc: CelenneDocument, layer: Layer, ov: LayerOverride, level = 0, r?: Rect) {
  const reg = r ?? { x: 0, y: 0, w: Math.ceil(doc.width / (1 << level)), h: Math.ceil(doc.height / (1 << level)) };
  const overrides = new Map([[layer.id, ov]]);
  const before = gpu!.stats.gpuPreviews;
  const g = await gpu!.compositeRead(doc, reg, { level, overrides });
  expect(gpu!.stats.gpuPreviews, 'computed on the GPU').toBeGreaterThan(before);
  const c = compositeRegion(doc, reg, { level, overrides: new Map([[layer.id, { read: ov.read }]]) });
  return maxDiff(g!, c).max;
}

describe('GPU live previews match the CPU previews', () => {
  for (const [id, params] of [['gaussianBlur', { radius: 2.5 }], ['gaussianBlur', { radius: 9 }], ['boxBlur', { radius: 4 }], ['unsharpMask', { amount: 150, radius: 2, threshold: 3 }]] as [string, Record<string, number>][]) {
    run(`${id} ${JSON.stringify(params)}`, async () => {
      const doc = newDoc(220, 160);
      const l = photo(doc, 210, 160);
      add(doc, l);
      const ov: LayerOverride = { gpu: { filter: { id, params } }, read: cpuFilterRead(doc, l, id, params) };
      expect(await compare(doc, l, ov)).toBeLessThan(1 / 255);
      // With a selection, and at 50 %.
      doc.selection.mask.writeFloat({ x: 30, y: 20, w: 120, h: 90 }, new Float32Array(120 * 90).fill(0.75));
      doc.selection.mask.touch();
      expect(await compare(doc, l, ov)).toBeLessThan(1 / 255);
      expect(await compare(doc, l, ov, 1)).toBeLessThan(1 / 255);
    });
  }

  for (const adj of [{ ...defaultAdjustment('curves'), rgb: [{ x: 0, y: 0 }, { x: 100, y: 160 }, { x: 255, y: 255 }] }, { ...defaultAdjustment('hueSaturation'), master: { hue: 45, saturation: 30, lightness: 0 } }, { ...defaultAdjustment('levels'), rgb: { inBlack: 30, inWhite: 220, gamma: 1.4, outBlack: 0, outWhite: 255 } }] as Adjustment[]) {
    run(`adjustment dialog preview: ${adj.type}`, async () => {
      const doc = newDoc(200, 140);
      const l = photo(doc, 190, 140);
      add(doc, l);
      doc.selection.mask.writeFloat({ x: 0, y: 0, w: 100, h: 140 }, new Float32Array(100 * 140).fill(1));
      doc.selection.mask.touch();
      const ov: LayerOverride = {
        gpu: { adjustment: adj },
        read: (r, level, plate = 0) => {
          const px = readLayerContent({ doc, level, scale: 1 / (1 << level), opts: { level, plate } }, { ...l, id: '__noop' } as never, r);
          applyDocAdjustmentStraight(doc, adj, plate, px, r.w * r.h, doc.selection.mask.readFloat(r, level));
          return px;
        },
      };
      expect(await compare(doc, l, ov)).toBeLessThan(1 / 255);
    });
  }
});
