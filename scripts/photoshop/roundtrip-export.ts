/**
 * Celenne → Photoshop round trip, step 1: opens every corpus PSD in Celenne and saves it again, and
 * writes the Celenne-authored cases Photoshop cannot script (Blend If).
 *   node scripts/run-ts.mjs scripts/photoshop/roundtrip-export.ts [corpusDir] [outDir]
 * Step 2 (resave.ps1) lets Photoshop open and re-save them; step 3 (roundtrip-compare.ts)
 * compares Photoshop's composite of Celenne's file with Celenne's render.
 */
import fs from 'node:fs';
import path from 'node:path';
import { importPsd } from '../../src/psd/import';
import { exportPsd } from '../../src/psd/export';
import { colorEngine } from '../../src/color/cms';
import type { BlendIf, BlendIfChannel, BlendIfRange } from '../../src/document/types';

const corpus = process.argv[2] ?? 'tests/fixtures/photoshop/corpus';
const out = process.argv[3] ?? 'node_modules/.celenne-roundtrip/celenne';
fs.mkdirSync(out, { recursive: true });
await colorEngine.init();
let n = 0;
for (const f of fs.readdirSync(corpus).filter((x) => x.endsWith('.psd')).sort()) {
  const { doc } = importPsd(new Uint8Array(fs.readFileSync(path.join(corpus, f))), f);
  fs.writeFileSync(path.join(out, f), exportPsd(doc));
  n++;
}
// Blend If (not scriptable in Photoshop): the corpus "blend-normal" document with ranges set in Celenne.
const src = new Uint8Array(fs.readFileSync(path.join(corpus, 'blend-normal.psd')));
const all: BlendIfRange = [0, 0, 255, 255];
const ranges = (gray: BlendIfChannel, red?: BlendIfChannel): BlendIf => ({ gray, red: red ?? { thisLayer: all, underlying: all }, green: { thisLayer: all, underlying: all }, blue: { thisLayer: all, underlying: all } });
const variants: [string, BlendIf][] = [
  ['celenne-blendif-gray', ranges({ thisLayer: [30, 80, 255, 255], underlying: [0, 0, 160, 220] })],
  ['celenne-blendif-red', ranges({ thisLayer: all, underlying: all }, { thisLayer: [0, 0, 120, 200], underlying: all })],
  ['celenne-blendif-under', ranges({ thisLayer: all, underlying: [40, 90, 200, 240] })],
];
for (const [name, bi] of variants) {
  const d = importPsd(src, 'b.psd').doc;
  const top = d.root.children[d.root.children.length - 1];
  top.advanced = { ...top.advanced, blendIf: bi };
  fs.writeFileSync(path.join(out, `${name}.psd`), exportPsd(d));
  n++;
}
console.log(`wrote ${n} files to ${out}`);
