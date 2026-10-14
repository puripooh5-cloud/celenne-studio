/**
 * Prints what a text-corpus PSD holds: the text layer's model (as Celenne reads it) and the outline
 * copy's glyph contours (Photoshop's exact glyph geometry).
 *   node scripts/run-ts.mjs scripts/photoshop/inspect-text.ts <file.psd>
 */
import fs from 'node:fs';
import { importPsd } from '../../src/psd/import';

const file = process.argv[2];
const { doc } = importPsd(new Uint8Array(fs.readFileSync(file)), file);
for (const l of doc.allLayers()) {
  if (l.kind === 'text') {
    const t = l.text;
    console.log(`TEXT "${l.name}" kind=${t.kind} orient=${t.orientation} aa=${t.antiAlias} box=${JSON.stringify(t.box)} transform=${JSON.stringify(t.transform)}`);
    console.log('  text:', JSON.stringify(t.text));
    for (const r of t.runs) console.log('  run', r.length, JSON.stringify({ ...r.style, color: undefined }));
    for (const p of t.paragraphs) console.log('  para', p.length, JSON.stringify(p.style));
  } else if (l.kind === 'shape') {
    const subs = l.path.subpaths;
    console.log(`SHAPE "${l.name}" contours=${subs.length} visible=${l.visible}`);
    for (const sp of subs.slice(0, 4)) {
      const xs = sp.knots.map((k) => k.x), ys = sp.knots.map((k) => k.y);
      console.log(`  contour knots=${sp.knots.length} x=[${Math.min(...xs).toFixed(2)}, ${Math.max(...xs).toFixed(2)}] y=[${Math.min(...ys).toFixed(2)}, ${Math.max(...ys).toFixed(2)}]`);
    }
  } else console.log(`${l.kind} "${l.name}"`);
}
