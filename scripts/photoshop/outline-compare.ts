/**
 * Celenne's layout vs Photoshop's, glyph for glyph: for each PSD in <celenne dir>, the file of the
 * same name in <photoshop dir> holds Photoshop's outlines of the same text (outline.jsx). Both are
 * filled by the same rasterizer, so the IoU measures placement only (no anti-aliasing differences).
 *   powershell scripts/photoshop/outline.ps1 -In <celenne dir> -Out <photoshop dir>
 *   node scripts/run-ts.mjs scripts/photoshop/outline-compare.ts <celenne dir> <photoshop dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { importPsd } from '../../src/psd/import';
import { FaceRegistry } from '../../src/typography/engine/registry';
import { registerFontFolder } from '../../src/typography/engine/nodeFonts';
import { layoutEngine } from '../../src/typography/engine/layout';
import { layoutCoverage, pathCoverage } from '../../src/typography/engine/raster';
import type { ShapeLayer, TextLayer } from '../../src/document/types';

const [celDir, psDir] = process.argv.slice(2);
const reg = new FaceRegistry();
await registerFontFolder(reg);
for (const name of fs.readdirSync(celDir).filter((f) => f.endsWith('.psd')).sort()) {
  const psFile = path.join(psDir, name);
  if (!fs.existsSync(psFile)) { console.log(`${name}: no Photoshop copy`); continue; }
  const cel = importPsd(new Uint8Array(fs.readFileSync(path.join(celDir, name))), name).doc;
  const ps = importPsd(new Uint8Array(fs.readFileSync(psFile)), name).doc;
  const W = cel.width, H = cel.height;
  for (const l of cel.allLayers().filter((x): x is TextLayer => x.kind === 'text')) {
    const outline = ps.allLayers().find((x): x is ShapeLayer => x.kind === 'shape' && x.name === `${l.name} outline`);
    if (!outline) { console.log(`${name.padEnd(26)} "${l.name.slice(0, 24)}": no outline`); continue; }
    const L = layoutEngine(l.text, reg, { ignoreStoredBreaks: !process.env.STORED });
    const ours = layoutCoverage(L, l.text.transform, 0, 0, W, H);
    const theirs = pathCoverage(outline.path, 0, 0, W, H);
    let inter = 0, uni = 0;
    for (let i = 0; i < W * H; i++) { inter += Math.min(ours[i], theirs[i]); uni += Math.max(ours[i], theirs[i]); }
    console.log(`${name.padEnd(26)} "${l.name.slice(0, 24)}"  outline IoU ${(uni ? inter / uni : 1).toFixed(4)}`);
  }
}
