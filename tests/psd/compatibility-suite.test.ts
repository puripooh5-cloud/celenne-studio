/**
 * PSD compatibility suite (spec §60). For every fixture: open → render → edit → save → reopen →
 * compare structure (and pixels where the edit should not have changed them).
 *
 * Fixtures come from tests/fixtures/psd (run `npm run fixtures`); missing files are built in
 * memory. Photoshop-authored files placed in tests/fixtures/psd/external/ are opened, rendered,
 * saved and reopened too, with a structural comparison.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES } from '../helpers/fixtures';
import { structure } from '../helpers/build';
import { importPsd } from '../../src/psd/import';
import { exportPsd } from '../../src/psd/export';
import { compositeRegion } from '../../src/rendering/compositor';
import { createPixelLayer } from '../../src/document/layerFactory';
import type { CelenneDocument } from '../../src/document/document';

const dir = path.resolve('tests/fixtures/psd');

function load(file: string, build: () => Uint8Array): Uint8Array {
  const p = path.join(dir, file);
  return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : build();
}

function renderSample(doc: CelenneDocument): Float32Array {
  const w = Math.min(doc.width, 256), h = Math.min(doc.height, 256);
  return compositeRegion(doc, { x: 0, y: 0, w, h }, { level: 0 });
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** A structural "edit": adds a hidden pixel layer, then removes it after reopening. */
function edit(doc: CelenneDocument) {
  const l = createPixelLayer('Celenne edit marker', doc.canvas.bitDepth);
  l.visible = false;
  l.raster.writeFloat({ x: 0, y: 0, w: 2, h: 2 }, new Float32Array(16).fill(1));
  doc.insertLayer(l, doc.root);
  // Rename the bottom layer too (a real metadata edit).
  const first = doc.root.children[0];
  if (first) first.name = `${first.name} (edited)`;
}

describe('PSD compatibility suite', () => {
  for (const f of FIXTURES) {
    it(`${f.title} — open, render, edit, save, reopen, compare`, () => {
      const bytes = load(f.file, f.build);
      // Open
      const opened = importPsd(bytes, f.file);
      expect(opened.doc.width).toBeGreaterThan(0);
      // Render
      const before = renderSample(opened.doc);
      expect(before.some((v) => v > 0)).toBe(true);
      if (!f.roundTrip) {
        // CMYK: converted to RGB on open and reported, never silently.
        expect(opened.issues.some((i) => i.status === 'converted' || /cmyk/i.test(i.feature + i.message))).toBe(true);
        return;
      }
      // Edit
      edit(opened.doc);
      const expected = structure(opened.doc);
      // Save
      const saved = exportPsd(opened.doc, { psb: f.file.endsWith('.psb') });
      // Reopen
      const reopened = importPsd(saved, f.file);
      // Compare structure
      expect(structure(reopened.doc)).toEqual(expected);
      // The edit only added a hidden layer, so the render must be unchanged.
      const after = renderSample(reopened.doc);
      expect(maxDiff(before, after)).toBeLessThan(f.id === 'deep16' ? 1 / 4096 : 1.5 / 255);
    });
  }

  const external = path.join(dir, 'external');
  const files = fs.existsSync(external) ? fs.readdirSync(external).filter((n) => /\.(psd|psb)$/i.test(n)) : [];
  for (const name of files) {
    it(`external: ${name}`, () => {
      const bytes = new Uint8Array(fs.readFileSync(path.join(external, name)));
      const a = importPsd(bytes, name);
      renderSample(a.doc);
      const b = importPsd(exportPsd(a.doc, { psb: /\.psb$/i.test(name) }), name);
      expect(structure(b.doc)).toEqual(structure(a.doc));
    });
  }
});
