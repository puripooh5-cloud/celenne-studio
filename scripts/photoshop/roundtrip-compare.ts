/**
 * Celenne → Photoshop round trip, step 3: for every file Photoshop re-saved, compares Photoshop's
 * composite of Celenne's file with Celenne's render of it, and checks that Photoshop kept the layer
 * structure (names and kinds as Celenne reads them back).
 *   node scripts/run-ts.mjs scripts/photoshop/roundtrip-compare.ts [roundtripDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { importPsd } from '../../src/psd/import';
import { parseContainer } from '../../src/psd/container';
import { diffPlanes, celennePlanes, photoshopPlanes } from '../../tests/helpers/photoshopReference';
import { colorEngine } from '../../src/color/cms';
import type { CelenneDocument } from '../../src/document/document';

const root = process.argv[2] ?? 'node_modules/.celenne-roundtrip';
await colorEngine.init();
const shape = (d: CelenneDocument) => d.allLayers().map((l) => `${l.kind}:${l.name}${l.kind === 'adjustment' ? `:${l.adjustment.type}` : ''}`).join(' | ');
const rows: Record<string, unknown>[] = [];
for (const f of fs.readdirSync(path.join(root, 'photoshop')).filter((x) => x.endsWith('.psd')).sort()) {
  const mine = importPsd(new Uint8Array(fs.readFileSync(path.join(root, 'celenne', f))), f).doc;
  const psBytes = new Uint8Array(fs.readFileSync(path.join(root, 'photoshop', f)));
  const c = parseContainer(psBytes);
  const stats = diffPlanes(celennePlanes(mine), photoshopPlanes(c), c.width * c.height);
  const back = importPsd(psBytes, f).doc;
  rows.push({ file: f, max: stats.max, p99: stats.p99, structure: shape(back) === shape(mine) ? 'same' : `DIFFERENT\n    celenne:     ${shape(mine)}\n    photoshop: ${shape(back)}` });
}
fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(rows, null, 1));
for (const r of rows) console.log(String(r.file).padEnd(34), String(r.max).padEnd(7), 'p99', String(r.p99).padEnd(6), r.structure);
