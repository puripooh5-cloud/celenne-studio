/**
 * Renders every PSD of the Photoshop corpus in Celenne and compares it with Photoshop's composite.
 *   node scripts/run-ts.mjs scripts/photoshop/compare-corpus.ts [corpusDir] [outDir] [filter]
 * Prints a table, writes report.json and, for files over 2/255, diff PNGs (red = difference).
 */
import fs from 'node:fs';
import path from 'node:path';
import { compareWithPhotoshop, photoshopPlanes } from '../../tests/helpers/photoshopReference';
import { encodePNG } from '../../src/formats/codecs';
import { colorEngine } from '../../src/color/cms';

const corpus = process.argv[2] ?? 'tests/fixtures/photoshop/corpus';
const outDir = process.argv[3] ?? 'node_modules/.celenne-corpus-report';
const filter = process.argv[4] ?? '';
fs.mkdirSync(outDir, { recursive: true });
await colorEngine.init();

const rows: Record<string, unknown>[] = [];
for (const f of fs.readdirSync(corpus).filter((x) => /\.ps[db]$/i.test(x) && x.includes(filter)).sort()) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(corpus, f)));
  try {
    const { stats, issues, container: c, doc } = compareWithPhotoshop(bytes, f);
    rows.push({ file: f, max: stats.max, mean: stats.mean, p99: stats.p99, over2: stats.over2, issues: issues.filter((i) => i.status !== 'editable').map((i) => `${i.status}:${i.feature}`).join('; ') });
    if (stats.max > 2) {
      const n = c.width * c.height;
      const ps = photoshopPlanes(c);
      const img = new Uint8ClampedArray(n * 4 * 2);
      // Left: Photoshop composite (first three channels); right: difference.
      const W = c.width * 2;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = y * c.width + x, o = (y * W + x) * 4, o2 = (y * W + x + c.width) * 4;
        const g = ps.length >= 3 ? [ps[0][i], ps[1][i], ps[2][i]] : [ps[0][i], ps[0][i], ps[0][i]];
        img.set([g[0], g[1], g[2], 255], o);
        const d = stats.perPixel[i];
        img.set(d > 2 ? [Math.min(255, 60 + d * 6), 0, 0, 255] : [g[0] * 0.3, g[1] * 0.3, g[2] * 0.3, 255], o2);
      }
      fs.writeFileSync(path.join(outDir, f.replace(/\.ps[db]$/i, '-diff.png')), encodePNG(W, c.height, img, 8));
    }
    void doc;
  } catch (e) {
    rows.push({ file: f, error: (e as Error).message });
  }
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(rows, null, 1));
const pad = (s: unknown, n: number) => String(s ?? '').padEnd(n);
for (const r of rows) console.log(pad(r.file, 34), r.error ? `ERROR ${r.error}` : `${pad(r.max, 7)} mean ${pad(r.mean, 7)} p99 ${pad(r.p99, 6)} >2: ${pad(((r.over2 as number) * 100).toFixed(1) + '%', 7)} ${r.issues}`);
