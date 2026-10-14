/**
 * Compares Celenne's text engine with Photoshop on the text corpus:
 *  - layout: Celenne's glyph outlines vs Photoshop's own outlines (the hidden "outline" shape
 *    layer), both filled by the same rasterizer, so only glyph placement differs;
 *  - rendering: Celenne's anti-aliased coverage vs the text layer's pixels Photoshop stored.
 *   node scripts/run-ts.mjs scripts/photoshop/compare-text.ts [dir|file.psd] [--png outDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { encodePNG } from '../../src/formats/codecs';
import { importPsd } from '../../src/psd/import';
import { FaceRegistry } from '../../src/typography/engine/registry';
import { registerFontFolder } from '../../src/typography/engine/nodeFonts';
import { layoutEngine } from '../../src/typography/engine/layout';
import { layoutCoverage, pathCoverage } from '../../src/typography/engine/raster';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--')) ?? 'tests/fixtures/photoshop/text';
const pngDir = args.includes('--png') ? args[args.indexOf('--png') + 1] : null;
const files = fs.statSync(target).isDirectory() ? fs.readdirSync(target).filter((f) => f.endsWith('.psd')).sort().map((f) => path.join(target, f)) : [target];

const reg = new FaceRegistry();
await registerFontFolder(reg);

export function stats(a: Float32Array, b: Float32Array) {
  let max = 0, sum = 0, inter = 0, uni = 0;
  const d: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const e = Math.abs(a[i] - b[i]);
    if (e > max) max = e;
    sum += e;
    inter += Math.min(a[i], b[i]);
    uni += Math.max(a[i], b[i]);
    if (a[i] > 0.001 || b[i] > 0.001) d.push(e);
  }
  d.sort((x, y) => x - y);
  return { max: Math.round(max * 255), p99: Math.round((d[Math.floor(d.length * 0.99)] ?? 0) * 255), iou: uni ? inter / uni : 1 };
}

for (const file of files) {
  const { doc } = importPsd(new Uint8Array(fs.readFileSync(file)), file);
  const layers = doc.allLayers();
  const text = layers.find((l) => l.kind === 'text');
  const outline = layers.find((l) => l.kind === 'shape' && / outline$/.test(l.name));
  if (!text || text.kind !== 'text' || !outline || outline.kind !== 'shape') { console.log(path.basename(file), 'no text/outline pair'); continue; }
  const W = doc.width, H = doc.height;
  const layout = layoutEngine(text.text, reg, { ignoreStoredBreaks: !process.env.STORED });
  const ours = layoutCoverage(layout, text.text.transform, 0, 0, W, H);
  const ps = pathCoverage(outline.path, 0, 0, W, H);
  const lay = stats(ours, ps);
  // Photoshop's anti-aliased pixels: the text layer's alpha.
  const px = text.raster.readFloat({ x: -text.x, y: -text.y, w: W, h: H });
  const alpha = new Float32Array(W * H);
  for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3];
  const aa = stats(ours, alpha);
  const psVsAa = stats(ps, alpha);
  console.log(`${path.basename(file, '.psd').padEnd(36)} layout max ${String(lay.max).padStart(3)} p99 ${String(lay.p99).padStart(3)} IoU ${lay.iou.toFixed(4)} | pixels max ${String(aa.max).padStart(3)} p99 ${String(aa.p99).padStart(3)} (PS outline vs PS pixels: max ${psVsAa.max} p99 ${psVsAa.p99})${layout.missing ? ' [fonts loading]' : ''}`);
  if (pngDir) {
    fs.mkdirSync(pngDir, { recursive: true });
    const img = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { img[i * 4] = 255 * (1 - ps[i]); img[i * 4 + 1] = 255 * (1 - Math.max(ps[i], ours[i]) * 0.6); img[i * 4 + 2] = 255 * (1 - ours[i]); img[i * 4 + 3] = 255; }
    fs.writeFileSync(path.join(pngDir, `${path.basename(file, '.psd')}.png`), encodePNG(W, H, img, 8));
  }
}
