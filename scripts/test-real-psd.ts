/**
 * Tests a real-world PSD/PSB file without copying it into the repository:
 *   node scripts/run-ts.mjs scripts/test-real-psd.ts <file.psd> <outDir>
 *
 * 1. Open: structure, layer kinds, compatibility issues, timing.
 * 2. Render: Celenne's layered render vs. the composite Photoshop stored in the file.
 * 3. Round trip: edit → save → reopen → compare structure, render and preserved raw data.
 * Writes celenne-render.png, photoshop-composite.png, diff.png and report.json to outDir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { importPsd } from '../src/psd/import';
import { exportPsd } from '../src/psd/export';
import { parseContainer, decodeMergedChannels } from '../src/psd/container';
import { compositeRegion } from '../src/rendering/compositor';
import { encodePNG } from '../src/formats/codecs';
import { createPixelLayer } from '../src/document/layerFactory';
import { structure } from '../tests/helpers/build';
import type { Layer } from '../src/document/types';
import type { CelenneDocument } from '../src/document/document';

const [file, outDir] = process.argv.slice(2);
if (!file || !outDir) { console.error('usage: test-real-psd <file> <outDir>'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const bytes = new Uint8Array(fs.readFileSync(file));
const report: Record<string, unknown> = { file: path.basename(file), bytes: bytes.length };
const ms = (t: number) => Math.round(performance.now() - t);

// ------------------------------------------------------------------------------------------ open
let t = performance.now();
const c = parseContainer(bytes);
report.header = { version: c.version, width: c.width, height: c.height, depth: c.depth, colorMode: c.colorMode, channels: c.channels, layerRecords: c.layers.length, resources: c.resources.map((r) => r.id).sort((a, b) => a - b), globalBlocks: c.globalBlocks.map((b) => b.key) };
t = performance.now();
const opened = importPsd(bytes, path.basename(file));
report.openMs = ms(t);
const doc = opened.doc;
report.warnings = opened.warnings;
report.issues = opened.issues.map((i) => `${i.status} · ${i.feature}${i.layerName ? ` [${i.layerName}]` : ''} — ${i.message}`);

function tree(ls: Layer[], depth = 0): string[] {
  return ls.flatMap((l) => {
    const bits = [l.kind, l.blendMode !== 'normal' && l.blendMode !== 'passThrough' ? l.blendMode : '', l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : '', l.fillOpacity < 1 ? `fill ${Math.round(l.fillOpacity * 100)}%` : '', !l.visible ? 'hidden' : '', l.clipping ? 'clipped' : '', l.mask ? 'mask' : '', l.vectorMask ? 'vmask' : '', l.effects ? 'fx' : '', l.kind === 'text' ? `"${l.text.text.slice(0, 40).replace(/\s+/g, ' ')}" ${l.text.runs[0]?.style.fontFamily}${l.missingFonts.length ? ` MISSING:${l.missingFonts.join(',')}` : ''}` : '', l.kind === 'adjustment' ? l.adjustment.type : '', l.metadata.unsupported.length ? `unsupported:${l.metadata.unsupported.join(',')}` : ''].filter(Boolean).join(' ');
    const line = `${'  '.repeat(depth)}${l.name}  (${bits})`;
    return l.kind === 'group' ? [line, ...tree(l.children, depth + 1)] : [line];
  });
}
report.layers = tree(doc.root.children);
const kinds: Record<string, number> = {};
for (const l of doc.allLayers()) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
report.layerKinds = kinds;
report.textLayersUsingStoredPixels = doc.allLayers().filter((l) => l.kind === 'text' && l.usingPreservedPixels).length;

// ---------------------------------------------------------------------------------------- render
function render(d: CelenneDocument): Uint8ClampedArray {
  const buf = compositeRegion(d, d.bounds, { level: 0 });
  const out = new Uint8ClampedArray(d.width * d.height * 4);
  for (let i = 0; i < d.width * d.height; i++) {
    const a = buf[i * 4 + 3];
    // Photoshop's composite is flattened over white for opaque documents.
    for (let k = 0; k < 3; k++) out[i * 4 + k] = (buf[i * 4 + k] + (1 - a)) * 255 + 0.5;
    out[i * 4 + 3] = 255;
  }
  return out;
}
t = performance.now();
const celenne = render(doc);
report.renderMs = ms(t);
fs.writeFileSync(path.join(outDir, 'celenne-render.png'), encodePNG(doc.width, doc.height, celenne, 8));

function diff(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, name: string) {
  const img = new Uint8ClampedArray(w * h * 4);
  let max = 0, sum = 0, over2 = 0, over16 = 0;
  const hist = new Map<string, number>();
  for (let i = 0; i < w * h; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) { const v = Math.abs(a[i * 4 + k] - b[i * 4 + k]); d = Math.max(d, v); sum += v; }
    max = Math.max(max, d);
    if (d > 2) over2++;
    if (d > 16) { over16++; const key = `${Math.floor((i % w) / 64)},${Math.floor(i / w / 64)}`; hist.set(key, (hist.get(key) ?? 0) + 1); }
    // Diff visualization: grayscale image with differences in red.
    const g = (b[i * 4] * 0.3 + b[i * 4 + 1] * 0.59 + b[i * 4 + 2] * 0.11) * 0.35;
    img[i * 4] = d > 2 ? Math.min(255, 80 + d * 4) : g; img[i * 4 + 1] = d > 2 ? 0 : g; img[i * 4 + 2] = d > 2 ? 0 : g; img[i * 4 + 3] = 255;
  }
  fs.writeFileSync(path.join(outDir, name), encodePNG(w, h, img, 8));
  const hot = [...hist].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => { const [x, y] = k.split(',').map(Number); return `x${x * 64}-${x * 64 + 63} y${y * 64}-${y * 64 + 63}: ${n}px`; });
  return { maxDelta: max, meanDelta: +(sum / (w * h * 3)).toFixed(3), pixelsOver2: `${((over2 / (w * h)) * 100).toFixed(3)}%`, pixelsOver16: `${((over16 / (w * h)) * 100).toFixed(3)}%`, worstRegions: hot };
}

// Photoshop's own flattened rendering, stored in the file.
const planes = decodeMergedChannels(c);
if (c.depth === 8 && (c.colorMode === 3 || c.colorMode === 1)) {
  const n = c.width * c.height;
  const ps = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    if (c.colorMode === 3) { ps[i * 4] = planes[0][i]; ps[i * 4 + 1] = planes[1][i]; ps[i * 4 + 2] = planes[2][i]; }
    else ps[i * 4] = ps[i * 4 + 1] = ps[i * 4 + 2] = planes[0][i];
    ps[i * 4 + 3] = 255;
  }
  fs.writeFileSync(path.join(outDir, 'photoshop-composite.png'), encodePNG(c.width, c.height, ps, 8));
  report.renderVsPhotoshop = diff(celenne, ps, c.width, c.height, 'diff-vs-photoshop.png');
}

// ------------------------------------------------------------------------------------ round trip
const expected = (() => {
  // Edit: add a hidden marker layer and rename the bottom layer.
  const l = createPixelLayer('Celenne edit marker', doc.canvas.bitDepth);
  l.visible = false;
  l.raster.writeFloat({ x: 0, y: 0, w: 2, h: 2 }, new Float32Array(16).fill(1));
  doc.insertLayer(l, doc.root);
  if (doc.root.children[0]) doc.root.children[0].name += ' (edited)';
  return structure(doc);
})();
t = performance.now();
const saved = exportPsd(doc, { psb: c.version === 2 });
report.saveMs = ms(t);
report.savedBytes = saved.length;
fs.writeFileSync(path.join(outDir, 'resaved.psd'), saved);
t = performance.now();
const back = importPsd(saved, path.basename(file));
report.reopenMs = ms(t);
const same = JSON.stringify(structure(back.doc)) === JSON.stringify(expected);
report.structureAfterRoundTrip = same ? 'identical' : 'DIFFERENT';
if (!same) {
  const a = JSON.stringify(expected, null, 1).split('\n'), b = JSON.stringify(structure(back.doc), null, 1).split('\n');
  report.structureDiff = a.map((x, i) => (x !== b[i] ? `- ${x.trim()}  |  + ${(b[i] ?? '').trim()}` : null)).filter(Boolean).slice(0, 30);
}
report.renderAfterRoundTrip = diff(render(back.doc), celenne, doc.width, doc.height, 'diff-roundtrip.png');
report.issuesAfterRoundTrip = back.issues.length;

// Raw preservation: every additional-info block key from the original layers is still present.
const c2 = parseContainer(saved);
const keysOf = (cc: typeof c) => { const m = new Map<string, number>(); for (const l of cc.layers) for (const b of l.blocks) m.set(b.key, (m.get(b.key) ?? 0) + 1); return m; };
const k1 = keysOf(c), k2 = keysOf(c2);
report.layerBlockKeys = { original: Object.fromEntries(k1), resaved: Object.fromEntries(k2), missingAfterSave: [...k1.keys()].filter((k) => !k2.has(k)) };
report.resourcesMissingAfterSave = c.resources.map((r) => r.id).filter((id) => !c2.resources.some((r) => r.id === id));

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
