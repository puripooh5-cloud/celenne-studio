/**
 * Debug view of one corpus file: Celenne's parsed layers (as JSON, rasters omitted), and a PNG with
 * Photoshop's composite, Celenne's render and the difference side by side.
 *   node scripts/run-ts.mjs scripts/photoshop/inspect.ts <file.psd> [out.png] [x,y …]
 */
import fs from 'node:fs';
import { compareWithPhotoshop, photoshopPlanes, celennePlanes } from '../../tests/helpers/photoshopReference';
import { encodePNG } from '../../src/formats/codecs';
import { colorEngine } from '../../src/color/cms';

const [file, out, ...points] = process.argv.slice(2);
await colorEngine.init();
const { doc, stats, container: c } = compareWithPhotoshop(new Uint8Array(fs.readFileSync(file)), file);
const skip = new Set(['raster', 'parent', 'companion', 'preserved', 'pixels', 'metadata', 'textRendering']);
const json = (l: unknown) => JSON.stringify(l, (k, v) => (skip.has(k) ? undefined : ArrayBuffer.isView(v) ? `<${(v as unknown as ArrayLike<number>).length}>` : v), 1);
for (const l of doc.allLayers()) console.log(json(l));
console.log('stats', { max: stats.max, mean: stats.mean, p99: stats.p99, over2: stats.over2 });
const ps = photoshopPlanes(c), lu = celennePlanes(doc);
for (const p of points) {
  const [x, y] = p.split(',').map(Number);
  const i = y * c.width + x;
  console.log(`(${x},${y}) photoshop`, ps.map((q) => q[i].toFixed(1)).join(' '), ' celenne', lu.map((q) => q[i].toFixed(1)).join(' '));
}
if (out) {
  const w = c.width, h = c.height, W = w * 3;
  const img = new Uint8ClampedArray(W * h * 4);
  const rgbOf = (pl: Float32Array[], i: number) => (pl.length >= 3 ? [pl[0][i], pl[1][i], pl[2][i]] : [pl[0][i], pl[0][i], pl[0][i]]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    img.set([...rgbOf(ps, i), 255], (y * W + x) * 4);
    img.set([...rgbOf(lu, i), 255], (y * W + x + w) * 4);
    const d = stats.perPixel[i];
    img.set([Math.min(255, d * 4), Math.min(255, d * 4), Math.min(255, d * 4), 255], (y * W + x + 2 * w) * 4);
  }
  fs.writeFileSync(out, encodePNG(W, h, img, 8));
}
