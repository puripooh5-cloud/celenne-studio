/**
 * Line-by-line comparison with Photoshop's own layout (the Txt2 data in each corpus PSD): where
 * each line starts in the text, its baseline, and every glyph's x position.
 *   node scripts/run-ts.mjs scripts/photoshop/compare-text-lines.ts [dir|file.psd] [--detail] [--stored] [key=value]
 */
import fs from 'node:fs';
import path from 'node:path';
import { FaceRegistry } from '../../src/typography/engine/registry';
import { registerFontFolder } from '../../src/typography/engine/nodeFonts';
import type { ComposeOptions } from '../../src/typography/engine/layout';
import { compareTextLines, type LineReport } from './textLinesCompare';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--') && !a.includes('=')) ?? 'tests/fixtures/photoshop/text';
const detail = args.includes('--detail');
// --stored: lay out with the line breaks stored from Photoshop (as the app does for unedited paragraphs).
const opts: ComposeOptions = { ignoreStoredBreaks: !args.includes('--stored') };
for (const a of args.filter((x) => x.includes('='))) { const [k, v] = a.split('='); (opts as Record<string, unknown>)[k] = v === 'true' ? true : v === 'false' ? false : Number(v); }
const files = fs.statSync(target).isDirectory() ? fs.readdirSync(target).filter((f) => f.endsWith('.psd')).sort().map((f) => path.join(target, f)) : [target];

const reg = new FaceRegistry();
await registerFontFolder(reg);

const reports: LineReport[] = [];
for (const file of files) {
  const r = compareTextLines(new Uint8Array(fs.readFileSync(file)), path.basename(file, '.psd'), reg, opts, detail);
  if (!r) continue;
  reports.push(r);
  console.log(`${r.file.padEnd(32)} lines ${String(r.lines).padStart(2)}/${String(r.psLines).padEnd(2)} same starts ${String(r.breaksOk).padStart(2)}  baseline err ${r.baseline.toFixed(3).padStart(7)}  x err ${r.x.toFixed(3).padStart(7)}`);
  for (const d of r.detail) console.log(d);
}
const perfect = reports.filter((r) => r.lines === r.psLines && r.breaksOk === r.psLines && r.baseline < 0.05 && r.x < 0.05).length;
console.log(`\n${perfect}/${reports.length} files with identical line breaks, baselines and glyph positions (±0.05 px)`);
