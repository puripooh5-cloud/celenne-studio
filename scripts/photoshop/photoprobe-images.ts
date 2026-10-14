/**
 * Reference images for the photo adjustment probes (cases-photoprobes.jsx), written by Celenne:
 *   cube.psd: 256 × 128, the RGB cube in 32 steps (pixel i: r = i & 31, g = (i >> 5) & 31, b = i >> 10)
 *   ramp.psd: 256 × 8, gray 0..255 across
 *   rand.psd: 256 × 128, seeded random colours (validation; see randColor)
 *   node scripts/run-ts.mjs scripts/photoshop/photoprobe-images.ts <out folder>
 */
import fs from 'node:fs';
import path from 'node:path';
import { CelenneDocument } from '../../src/document/document';
import { createPixelLayer } from '../../src/document/layerFactory';
import { TiledRaster } from '../../src/image-engine/tiledRaster';
import { exportPsd } from '../../src/psd/export';

export const cubeLevel = (k: number) => Math.round((k * 255) / 31);
/** The colour at pixel i of cube.psd (0..255). */
export function cubeColor(i: number): [number, number, number] {
  return [cubeLevel(i & 31), cubeLevel((i >> 5) & 31), cubeLevel(i >> 10)];
}

/**
 * The colour at pixel i of rand.psd (0..255): seeded random colours for validation, half of them
 * near gray (where saturation-dependent adjustments change fastest).
 */
export function randColor(i: number): [number, number, number] {
  let h = (i + 1) * 0x9e3779b1;
  const next = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 256); };
  const c: [number, number, number] = [next(), next(), next()];
  if (i % 2) { const m = (c[0] + c[1] + c[2]) / 3; for (let k = 0; k < 3; k++) c[k] = Math.round(m + (c[k] - m) * 0.15); }
  return c;
}

function write(file: string, w: number, h: number, color: (x: number, y: number) => [number, number, number]) {
  const doc = new CelenneDocument(path.basename(file, '.psd'), { width: w, height: h, resolution: 72, colorMode: 'rgb', bitDepth: 8 });
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = color(x, y);
      px.set([r, g, b, 255], (y * w + x) * 4);
    }
  const l = createPixelLayer('Background', 8, TiledRaster.fromPixels(w, h, 4, 8, px));
  l.locks.position = true;
  doc.insertLayer(l, doc.root);
  fs.writeFileSync(file, exportPsd(doc, { maximizeCompatibility: true }));
}

if (import.meta.url.includes('photoprobe-images')) {
  const out = process.argv[2] ?? die();
  fs.mkdirSync(out, { recursive: true });
  write(path.join(out, 'cube.psd'), 256, 128, (x, y) => cubeColor(y * 256 + x));
  write(path.join(out, 'ramp.psd'), 256, 8, (x) => [x, x, x]);
  write(path.join(out, 'rand.psd'), 256, 128, (x, y) => randColor(y * 256 + x));
  console.log(`wrote cube.psd and ramp.psd to ${out}`);
}
function die(): never { console.error('usage: photoprobe-images.ts <out folder>'); process.exit(1); }
