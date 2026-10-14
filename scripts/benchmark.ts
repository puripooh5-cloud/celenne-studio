/**
 * Performance benchmark (headless, Node). Measures the engine paths that dominate interactive
 * performance and writes the results to docs/BENCHMARK_RESULTS.md.
 *
 *   npm run benchmark            # default size 4000 × 3000
 *   npm run benchmark -- --quick # 2000 × 1500
 *
 * The GPU section runs the WebGPU compositor headless (Dawn via the `webgpu` dev dependency) and
 * times work until the GPU has finished it; it is skipped when no GPU adapter is available.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newDoc, add, solidLayer } from '../tests/helpers/build';
import { createAdjustmentLayer, createMask } from '../src/document/layerFactory';
import { defaultAdjustment } from '../src/adjustments/types';
import { compositeRegion } from '../src/rendering/compositor';
import { RenderEngine, setGpuCompositor } from '../src/rendering/renderEngine';
import { testDevice } from '../tests/helpers/gpu';
import { GpuCompositor } from '../src/gpu/compositor';
import { createPixelLayer } from '../src/document/layerFactory';
import { TiledRaster } from '../src/image-engine/tiledRaster';
import { filterById } from '../src/filters/builtin';
import { runFilterSync } from '../src/filters/runner';
import { readLayerContent } from '../src/rendering/compositor';
import { exportPsd } from '../src/psd/export';
import { importPsd } from '../src/psd/import';
import { gaussianBlur } from '../src/image-engine/blur';
import { History } from '../src/history/history';
import { editRaster } from '../src/commands/rasterCommands';
import { DabEmitter } from '../src/brush/engine';
import { defaultBrush } from '../src/tools/toolTypes';
import { LiquifyMesh, DEFAULT_LIQUIFY_BRUSH } from '../src/filters/liquify';
import type { BitDepth } from '../src/image-engine/pixels';

const quick = process.argv.includes('--quick');
const W = quick ? 2000 : 4000, H = quick ? 1500 : 3000;
const rows: [string, string, string][] = [];

function time<T>(label: string, detail: string, fn: () => T, repeat = 1): T {
  let r!: T;
  const t = performance.now();
  for (let i = 0; i < repeat; i++) r = fn();
  const ms = (performance.now() - t) / repeat;
  rows.push([label, `${ms.toFixed(1)} ms`, detail]);
  console.log(`${label.padEnd(44)} ${ms.toFixed(1).padStart(9)} ms  ${detail}`);
  return r;
}

function buildDoc(depth: BitDepth) {
  const d = newDoc(W, H, depth, `Bench ${depth}-bit`);
  add(d, solidLayer(d, 'Background', 0, 0, W, H, [0.9, 0.9, 0.9, 1]));
  for (let i = 0; i < 8; i++) {
    const l = add(d, solidLayer(d, `Layer ${i}`, (i * W) / 12, (i * H) / 12, W / 2, H / 2, [(i % 3) / 2, ((i + 1) % 3) / 2, ((i + 2) % 3) / 2, 1]));
    l.opacity = 0.7;
    l.blendMode = (['normal', 'multiply', 'screen', 'overlay'] as const)[i % 4];
    if (i % 3 === 0) l.mask = createMask(true);
  }
  add(d, createAdjustmentLayer(defaultAdjustment('curves')));
  add(d, createAdjustmentLayer(defaultAdjustment('hueSaturation')));
  return d;
}

console.log(`Celenne Studio benchmark — ${W}×${H}, ${os.cpus()[0]?.model ?? 'CPU'} (${os.cpus().length} threads), Node ${process.version}\n`);

for (const depth of [8, 16] as const) {
  const doc = time(`Build ${depth}-bit document (11 layers)`, `${W}×${H}`, () => buildDoc(depth));
  const eng = new RenderEngine(doc);
  time(`Display tiles, level 0 (${depth}-bit)`, '256×256 tile, 11 layers + 2 adjustments', () => { eng.purge(); eng.request(0, 3, 3, 0); eng.process(1e9); }, 5);
  time(`Full composite at 25% (level 2, ${depth}-bit)`, `${Math.ceil(W / 4)}×${Math.ceil(H / 4)}`, () => compositeRegion(doc, { x: 0, y: 0, w: Math.ceil(W / 4), h: Math.ceil(H / 4) }, { level: 2 }));
  const psd = time(`PSD export (${depth}-bit)`, 'layers + composite', () => exportPsd(doc));
  rows[rows.length - 1][2] += `, ${(psd.length / 1048576).toFixed(1)} MB`;
  time(`PSD import (${depth}-bit)`, 'full decode', () => importPsd(psd, 'bench.psd'));
}

const img = new Float32Array(2048 * 2048 * 4).fill(0.5);
time('Gaussian blur σ=2 (2048², RGBA float)', 'separable exact kernel', () => gaussianBlur(img, 2048, 2048, 4, 2));
time('Gaussian blur σ=4 (2048², RGBA float)', '3-pass box approximation', () => gaussianBlur(img, 2048, 2048, 4, 4));
time('Gaussian blur σ=40 (2048², RGBA float)', '3-pass box approximation', () => gaussianBlur(img, 2048, 2048, 4, 40));

{
  const doc = buildDoc(8);
  const layer = doc.allLayers()[1];
  const h = new History(doc);
  time('Undoable raster edit (512² region)', 'tile snapshot + write', () => {
    const cmd = editRaster(doc, { kind: 'layer', layerId: layer.id }, 'Edit', (r) => { r.writeFloat({ x: 0, y: 0, w: 512, h: 512 }, new Float32Array(512 * 512 * 4).fill(1)); return { x: 0, y: 0, w: 512, h: 512 }; });
    if (cmd) h.push(cmd, true);
  }, 10);
  time('Undo + redo of that edit', 'restores shared tiles', () => { h.undo(); h.redo(); }, 10);
  rows.push(['History memory (10 edits)', `${(h.memoryBytes() / 1048576).toFixed(1)} MB`, 'copy-on-write tiles']);
}

{
  const e = new DabEmitter({ ...defaultBrush(), size: 30, spacing: 0.1 });
  const s = (x: number, t: number) => ({ x, y: 100 + Math.sin(x / 50) * 40, pressure: 0.8, tiltX: 0, tiltY: 0, twist: 0, time: t });
  let n = 0;
  time('Brush dab emission (10,000 px stroke)', 'spacing 10%, smoothing on', () => { n = e.begin(s(0, 0)).length; for (let x = 1; x <= 10000; x += 4) n += e.move(s(x, x)).length; n += e.end(s(10000, 10001)).length; });
  rows[rows.length - 1][2] += `, ${n} dabs`;
}

{
  const m = new LiquifyMesh(1400, 1000);
  time('Liquify forward-warp dab (brush 200 px)', 'proxy 1400×1000', () => m.apply('forwardWarp', 700, 500, { x: 695, y: 500 }, { ...DEFAULT_LIQUIFY_BRUSH, size: 200 }), 50);
}

// ---------------------------------------------------------------------------------------------
// GPU (WebGPU) compositing and previews, timed until the GPU has finished
// ---------------------------------------------------------------------------------------------
async function timeAsync(label: string, detail: string, fn: () => Promise<void>, repeat = 1): Promise<number> {
  await fn(); // warm-up: shader compilation, first uploads are reported separately
  const t = performance.now();
  for (let i = 0; i < repeat; i++) await fn();
  const ms = (performance.now() - t) / repeat;
  rows.push([label, `${ms.toFixed(1)} ms`, detail]);
  console.log(`${label.padEnd(44)} ${ms.toFixed(1).padStart(9)} ms  ${detail}`);
  return ms;
}
const device = await testDevice();
let gpuInfo = 'no WebGPU adapter: GPU rows skipped';
if (device) {
  const gpu = new GpuCompositor(device);
  const adapterDesc = (device as unknown as { adapterInfo?: GPUAdapterInfo }).adapterInfo;
  gpuInfo = adapterDesc ? [adapterDesc.vendor, adapterDesc.architecture, adapterDesc.description].filter(Boolean).join(' ') : 'WebGPU adapter';
  const done = () => device.queue.onSubmittedWorkDone();
  for (const depth of [8, 16] as const) {
    const doc = buildDoc(depth);
    const eng = new RenderEngine(doc);
    setGpuCompositor(gpu);
    // First render of a tile includes uploading its layer tiles to the GPU.
    {
      const t = performance.now();
      eng.purge(); eng.request(0, 3, 3, 0); eng.process(1e9); await done();
      const ms = performance.now() - t;
      rows.push([`GPU display tile, level 0, first render (${depth}-bit)`, `${ms.toFixed(1)} ms`, depth === 8 ? 'one-time: compiles the GPU shaders, uploads the layer tiles' : 'uploads the layer tiles']);
      console.log(`${`GPU display tile, level 0, first render (${depth}-bit)`.padEnd(44)} ${ms.toFixed(1).padStart(9)} ms`);
    }
    await timeAsync(`GPU display tile, level 0 (${depth}-bit)`, 'layers already on the GPU (e.g. after an opacity or adjustment change)', async () => { eng.invalidateAll(); eng.request(0, 3, 3, 0); eng.process(1e9); await done(); }, 10);
    await timeAsync(`GPU full view at 25% (level 2, ${depth}-bit)`, `${Math.ceil(W / 4)}×${Math.ceil(H / 4)}, all tiles`, async () => { eng.invalidateAll(); eng.renderLevelSync(2); await done(); }, 5);
    setGpuCompositor(null);
    time(`CPU full view at 25% (level 2, ${depth}-bit)`, 'same tiles on the CPU, for comparison', () => { eng.invalidateAll(); eng.renderLevelSync(2); });
    eng.dispose();
  }
  // Blur / sharpen previews of a 2048² layer, tile by tile on the GPU.
  const doc = newDoc(2048, 2048, 8);
  const f = new Float32Array(2048 * 2048 * 4);
  for (let i = 0; i < f.length; i++) f[i] = (i % 4 === 3) ? 1 : ((i * 2654435761) >>> 0) / 4294967296;
  const r = new TiledRaster(4, 8);
  r.writeFloat({ x: 0, y: 0, w: 2048, h: 2048 }, f);
  const l = createPixelLayer('photo', 8, r);
  add(doc, l);
  const eng = new RenderEngine(doc);
  setGpuCompositor(gpu);
  for (const [label, id, params] of [['σ=2', 'gaussianBlur', { radius: 2 }], ['σ=4', 'gaussianBlur', { radius: 4 }], ['σ=40', 'gaussianBlur', { radius: 40 }]] as const) {
    eng.setOverride(l.id, { read: () => { throw new Error('CPU preview path used'); }, gpu: { filter: { id, params: { ...params } } } });
    await timeAsync(`GPU Gaussian blur preview ${label} (2048²)`, 'on-canvas preview, 64 display tiles', async () => { eng.invalidateAll(); eng.renderLevelSync(0); await done(); }, 3);
  }
  // The CPU preview path the app uses without the GPU (filterOps.setFilterPreview).
  setGpuCompositor(null);
  const def = filterById('gaussianBlur')!;
  for (const [label, radius] of [['σ=2', 2], ['σ=40', 40]] as const) {
    eng.setOverride(l.id, {
      read: (rr, level, plate = 0) => {
        const pad = Math.ceil(def.padding({ radius }) / (1 << level)) + 1;
        const pr = { x: rr.x - pad, y: rr.y - pad, w: rr.w + 2 * pad, h: rr.h + 2 * pad };
        const src = readLayerContent({ doc, level, scale: 1 / (1 << level), opts: { level, plate } }, { ...l, id: '__noop' } as never, pr);
        const o = runFilterSync(def, { radius }, { w: pr.w, h: pr.h, ch: 4, data: src }, { scale: 1, originX: pr.x, originY: pr.y, bounds: rr, foreground: [0, 0, 0], background: [1, 1, 1] });
        const f = new Float32Array(rr.w * rr.h * 4);
        for (let y = 0; y < rr.h; y++) f.set(o.data.subarray(((y + pad) * pr.w + pad) * 4, ((y + pad) * pr.w + pad + rr.w) * 4), y * rr.w * 4);
        return f;
      },
    });
    time(`CPU Gaussian blur preview ${label} (2048²)`, 'the same preview on the CPU, for comparison', () => { eng.invalidateAll(); eng.renderLevelSync(0); });
  }
  eng.dispose();
  if (gpu.stats.cpuTiles) throw new Error(`${gpu.stats.cpuTiles} tiles fell back to the CPU (${gpu.stats.lastFallback})`);
  console.log(`GPU tiles: ${gpu.stats.gpuTiles}, previews on the GPU: ${gpu.stats.gpuPreviews}, CPU fallbacks: ${gpu.stats.cpuTiles}`);
  gpu.dispose();
}

const out = [
  '# Benchmark results',
  '',
  `Generated ${new Date().toISOString()} by \`npm run benchmark${quick ? ' -- --quick' : ''}\`.`,
  '',
  `Machine: ${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.cpus().length} threads, ${(os.totalmem() / 1024 ** 3).toFixed(0)} GB RAM, Node ${process.version}. Document size ${W}×${H}. GPU: ${gpuInfo}.`,
  '',
  '| Operation | Time | Notes |',
  '|---|---|---|',
  ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`),
  '',
].join('\n');
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(path.join('docs', 'BENCHMARK_RESULTS.md'), out);
console.log('\nWrote docs/BENCHMARK_RESULTS.md');
