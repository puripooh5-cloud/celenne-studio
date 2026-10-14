/**
 * Celenne's render of every Photoshop-built corpus file against the composite Photoshop stored in
 * it (tests/fixtures/photoshop/corpus, built by scripts/photoshop/build-corpus.ps1). Each file
 * must stay within its recorded baseline (corpus-baseline.json) plus rounding slack, so a fix
 * that improves one file shows up as a lower number there and a regression fails here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { compareWithPhotoshop } from '../helpers/photoshopReference';
import { colorEngine } from '../../src/color/cms';

const dir = path.join(__dirname, '../fixtures/photoshop/corpus');
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/photoshop/corpus-baseline.json'), 'utf8')) as { files: Record<string, { max: number; p99: number; note?: string }> };
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.psd')).sort();

beforeAll(async () => { await colorEngine.init(); });

describe('Photoshop corpus: Celenne matches Photoshop’s composite', () => {
  it('has a baseline for every file', () => {
    expect(files.length).toBeGreaterThanOrEqual(90);
    for (const f of files) expect(baseline.files[f.replace(/\.psd$/, '')], f).toBeTruthy();
  });

  for (const f of files) {
    it(f, () => {
      const b = baseline.files[f.replace(/\.psd$/, '')];
      const { stats } = compareWithPhotoshop(new Uint8Array(fs.readFileSync(path.join(dir, f))), f);
      expect(stats.max, `largest difference (baseline ${b.max})`).toBeLessThanOrEqual(b.max + 1);
      expect(stats.p99, `99th percentile (baseline ${b.p99})`).toBeLessThanOrEqual(b.p99 + 1);
    });
  }

  it('matches within 4/255 for at least 95 % of the features Celenne models exactly', () => {
    const exact = Object.entries(baseline.files).filter(([, v]) => !v.note);
    const within = exact.filter(([, v]) => v.max <= 4).length;
    expect(within / exact.length).toBeGreaterThan(0.95);
  });
});
