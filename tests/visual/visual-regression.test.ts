/**
 * Visual regression (spec §61): every fixture is opened and rendered at 50%, 100% and 200%, then
 * compared with the reference PNGs in tests/fixtures/reference. A JSON + Markdown report of the
 * pixel differences is written to tests/visual/report/.
 *
 * Without references (fresh checkout), run `npm run fixtures -- --refs` first; missing references
 * are reported as "no reference" and do not fail the run.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES } from '../helpers/fixtures';
import { diffImages, DiffResult, renderAtZoom, ZOOMS } from '../helpers/render';
import { importPsd } from '../../src/psd/import';
import { decodePNG } from '../../src/formats/codecs';

const refDir = path.resolve('tests/fixtures/reference');
const psdDir = path.resolve('tests/fixtures/psd');
const reportDir = path.resolve('tests/visual/report');
/** Allowed differences: rounding in 8-bit output. */
const MAX_DELTA = 3;
const MAX_CHANGED = 0.001;

const rows: { fixture: string; zoom: number; result: DiffResult | null; note: string }[] = [];

describe('Visual regression', () => {
  for (const f of FIXTURES) {
    it(`${f.title} at 50/100/200%`, () => {
      const p = path.join(psdDir, f.file);
      const bytes = fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : f.build();
      const { doc } = importPsd(bytes, f.file);
      for (const z of ZOOMS) {
        const img = renderAtZoom(doc, z)!;
        const ref = path.join(refDir, `${f.id}@${Math.round(z * 100)}.png`);
        if (!fs.existsSync(ref)) {
          rows.push({ fixture: f.id, zoom: z, result: null, note: 'no reference' });
          continue;
        }
        const r = decodePNG(new Uint8Array(fs.readFileSync(ref)));
        const d = diffImages(img, { width: r.width, height: r.height, data: r.data as ArrayLike<number> });
        const pass = !d.sizeMismatch && d.maxDelta <= MAX_DELTA && d.changedFraction <= MAX_CHANGED;
        rows.push({ fixture: f.id, zoom: z, result: d, note: pass ? 'pass' : 'DIFFERENT' });
        expect(d.sizeMismatch, `${f.id}@${z}`).toBe(false);
        expect(d.changedFraction, `${f.id}@${z} changed pixels`).toBeLessThanOrEqual(MAX_CHANGED);
        expect(d.maxDelta, `${f.id}@${z} max delta`).toBeLessThanOrEqual(MAX_DELTA);
      }
    });
  }
});

afterAll(() => {
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'visual-report.json'), JSON.stringify(rows, null, 2));
  const md = [
    '# Visual regression report',
    '',
    `Generated ${new Date().toISOString()} — thresholds: max Δ ≤ ${MAX_DELTA}, changed pixels ≤ ${(MAX_CHANGED * 100).toFixed(2)}%`,
    '',
    '| Fixture | Zoom | Size | Max Δ | Mean Δ | Changed | Result |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => r.result
      ? `| ${r.fixture} | ${r.zoom * 100}% | ${r.result.width}×${r.result.height} | ${r.result.maxDelta} | ${r.result.meanDelta.toFixed(3)} | ${(r.result.changedFraction * 100).toFixed(3)}% | ${r.note} |`
      : `| ${r.fixture} | ${r.zoom * 100}% | — | — | — | — | ${r.note} |`),
  ].join('\n');
  fs.writeFileSync(path.join(reportDir, 'visual-report.md'), md + '\n');
});
