/**
 * Celenne against Photoshop on the photo adjustment probes (cases-photoprobes.jsx):
 *   node scripts/run-ts.mjs scripts/photoshop/photoprobe-compare.ts <folder> [prefix] [--worst N]
 * Prints the largest and 99th-percentile difference per probe; --worst lists the input colours
 * with the largest differences (input → Photoshop / Celenne).
 */
import fs from 'node:fs';
import path from 'node:path';
import { celennePlanes, compareWithPhotoshop, photoshopPlanes } from '../../tests/helpers/photoshopReference';
import { parseContainer } from '../../src/psd/container';
import { colorEngine } from '../../src/color/cms';
import { cubeColor, randColor } from './photoprobe-images';

export interface ProbeSample { input: [number, number, number]; ps: [number, number, number] }

/** The input colour of each pixel of a probe and Photoshop's result (0..255). */
export function probeSamples(file: string): ProbeSample[] {
  const c = parseContainer(new Uint8Array(fs.readFileSync(file)));
  const p = photoshopPlanes(c);
  const out: ProbeSample[] = [];
  const cube = c.width === 256 && c.height === 128;
  const rand = path.basename(file).startsWith('pv-');
  for (let i = 0; i < c.width * c.height; i++) {
    const input: [number, number, number] = rand ? randColor(i) : cube ? cubeColor(i) : [i % 256, i % 256, i % 256];
    out.push({ input, ps: [p[0][i], p[1][i], p[2][i]] });
  }
  return out;
}

if (import.meta.url.includes('photoprobe-compare')) {
  const args = process.argv.slice(2);
  const dir = args[0];
  const prefix = args[1] && !args[1].startsWith('--') ? args[1] : 'pp-';
  const wi = args.indexOf('--worst');
  const worst = wi >= 0 ? Number(args[wi + 1] ?? 10) : 0;
  await colorEngine.init();
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.psd')).sort();
  const groups = new Map<string, number[]>();
  for (const f of files) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    const { stats, container: c } = compareWithPhotoshop(bytes, f);
    console.log(`${f.replace(/\.psd$/, '').padEnd(34)} max ${String(stats.max).padStart(6)}  p99 ${String(stats.p99).padStart(6)}  mean ${stats.mean}`);
    const g = f.split('-').slice(0, 2).join('-');
    groups.set(g, [...(groups.get(g) ?? []), stats.max]);
    if (worst) {
      const ours = celennePlanes(compareWithPhotoshop(bytes, f).doc);
      const order = [...stats.perPixel.keys()].sort((a, b) => stats.perPixel[b] - stats.perPixel[a]).slice(0, worst);
      const samples = probeSamples(path.join(dir, f));
      for (const i of order) {
        const s = samples[i];
        console.log(`   ${s.input.join(',').padEnd(12)} → ps ${s.ps.map((v) => v.toFixed(0)).join(',').padEnd(12)} ours ${ours.map((p) => p[i].toFixed(0)).join(',').padEnd(12)} diff ${stats.perPixel[i].toFixed(1)}`);
      }
    }
  }
  console.log('\nworst per group:');
  for (const [g, v] of groups) console.log(`  ${g.padEnd(10)} ${Math.max(...v).toFixed(1)}`);
}
