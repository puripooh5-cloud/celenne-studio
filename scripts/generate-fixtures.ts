/**
 * Writes the PSD compatibility fixtures and their visual-regression reference renders.
 *
 *   npm run fixtures            # PSD/PSB files only (tests/fixtures/psd)
 *   npm run fixtures -- --refs  # also (re)generate reference PNGs (tests/fixtures/reference)
 *
 * References are renders produced by the current compositor; regenerate them only after
 * intentional rendering changes (and review the diff report first).
 */
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES } from '../tests/helpers/fixtures';
import { renderAtZoom, ZOOMS } from '../tests/helpers/render';
import { importPsd } from '../src/psd/import';
import { encodePNG } from '../src/formats/codecs';

const root = path.resolve('tests/fixtures');
const psdDir = path.join(root, 'psd');
const refDir = path.join(root, 'reference');
fs.mkdirSync(psdDir, { recursive: true });
const withRefs = process.argv.includes('--refs');
if (withRefs) fs.mkdirSync(refDir, { recursive: true });

for (const f of FIXTURES) {
  const t = performance.now();
  const bytes = f.build();
  fs.writeFileSync(path.join(psdDir, f.file), bytes);
  let line = `${f.file.padEnd(34)} ${(bytes.length / 1024).toFixed(1).padStart(9)} KB`;
  if (withRefs) {
    const { doc } = importPsd(bytes, f.file);
    for (const z of ZOOMS) {
      const img = renderAtZoom(doc, z);
      if (!img) continue;
      fs.writeFileSync(path.join(refDir, `${f.id}@${Math.round(z * 100)}.png`), encodePNG(img.width, img.height, img.data, 8));
    }
    line += '  + references';
  }
  console.log(`${line}  (${Math.round(performance.now() - t)} ms)`);
}
console.log(`\nWrote ${FIXTURES.length} fixtures to ${psdDir}`);
