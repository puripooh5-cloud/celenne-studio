/**
 * Celenne-saved text vs Photoshop's own layout of the same text: for each PSD in <celenne dir>,
 * the matching file in <photoshop dir> was opened by Photoshop, its text re-laid-out by Photoshop's
 * type engine and saved (retype.ps1). Compares Celenne's layout with Photoshop's (line starts,
 * baselines and glyph x from Photoshop's Txt2 data) and the text pixels.
 *   node scripts/run-ts.mjs scripts/photoshop/retype-compare.ts <celenne dir> <photoshop dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseContainer } from '../../src/psd/container';
import { parseTxt2, txt2Texts } from '../../src/psd/txt2';
import { importPsd } from '../../src/psd/import';
import { FaceRegistry } from '../../src/typography/engine/registry';
import { registerFontFolder } from '../../src/typography/engine/nodeFonts';
import { layoutEngine } from '../../src/typography/engine/layout';
import type { TextLayer } from '../../src/document/types';

const [celDir, psDir] = process.argv.slice(2);
const reg = new FaceRegistry();
await registerFontFolder(reg);

for (const name of fs.readdirSync(celDir).filter((f) => f.endsWith('.psd')).sort()) {
  const psFile = path.join(psDir, name);
  if (!fs.existsSync(psFile)) { console.log(`${name}: no Photoshop copy`); continue; }
  const cel = importPsd(new Uint8Array(fs.readFileSync(path.join(celDir, name))), name).doc;
  const psBytes = new Uint8Array(fs.readFileSync(psFile));
  const ps = importPsd(psBytes, name).doc;
  const blk = parseContainer(psBytes).globalBlocks.find((b) => b.key === 'Txt2');
  const t2 = blk ? txt2Texts(parseTxt2(blk.data)) : [];
  const celText = cel.allLayers().filter((l): l is TextLayer => l.kind === 'text');
  const psText = ps.allLayers().filter((l): l is TextLayer => l.kind === 'text');
  celText.forEach((cl, i) => {
    // Layers by name (else order); Photoshop's text object by the layer's TextIndex.
    const pl = psText.find((l) => l.name === cl.name) ?? psText[i];
    const index = (pl?.metadata.psd?.source as { text?: { index?: number } } | undefined)?.text?.index ?? i;
    const t = cl.text;
    // Celenne's layout (STORED=1: with the line breaks kept from Photoshop, as the app lays it out).
    const L = layoutEngine(t, reg, { ignoreStoredBreaks: !process.env.STORED });
    const x = t2[index];
    let breaks = 'n/a', maxX = NaN, maxB = NaN;
    if (x) {
      let same = 0;
      maxX = 0; maxB = 0;
      const bx = t.box?.x ?? 0, by = t.box?.y ?? 0;
      x.lines.forEach((b, k) => {
        const a = L.lines[k];
        if (!a) return;
        if ((a.glyphs[0]?.index ?? -1) === b.start) same++;
        maxB = Math.max(maxB, Math.abs(a.baseline - by - b.baseline));
        const xs = b.runs.flatMap((r) => r.x.slice(0, r.glyphs.length).map((v) => (r === b.runs[0] ? b.x : r.x0) + v));
        let lineX = 0;
        let worst = '';
        a.glyphs.forEach((g, j) => {
          // Marks (no advance) are placed by their anchors; Photoshop's x for them is not the drawn position.
          if (j >= xs.length || g.face.advance(g.gid) === 0) return;
          const e = Math.abs(g.x - bx - xs[j]);
          if (process.env.DETAIL === '2' && e > 0.5) console.log(`      glyph ${j} gid ${g.gid} char ${JSON.stringify(t.text[g.index])} U+${t.text.codePointAt(g.index)?.toString(16)} celenne ${(g.x - bx).toFixed(2)} photoshop ${xs[j].toFixed(2)} prev ${j ? (a.glyphs[j - 1].x - bx).toFixed(2) : '-'}`);
          if (e > lineX) { lineX = e; worst = `U+${t.text.codePointAt(g.index)?.toString(16)}`; }
        });
        maxX = Math.max(maxX, lineX);
        if (process.env.DETAIL) console.log(`    line ${k}: start ${a.glyphs[0]?.index}/${b.start}  glyphs ${a.glyphs.length}/${xs.length}  x err ${lineX.toFixed(3)} at ${worst}`);
      });
      breaks = `${same}/${x.lines.length} lines (Celenne ${L.lines.length})`;
    }
    // Pixels: Celenne's rendering (as saved) vs Photoshop's redraw.
    let inter = 0, uni = 0;
    if (pl) {
      const W = cel.width, H = cel.height;
      const a = cl.raster.readFloat({ x: -cl.x, y: -cl.y, w: W, h: H }), b = pl.raster.readFloat({ x: -pl.x, y: -pl.y, w: W, h: H });
      for (let k = 0; k < W * H; k++) { inter += Math.min(a[k * 4 + 3], b[k * 4 + 3]); uni += Math.max(a[k * 4 + 3], b[k * 4 + 3]); }
    }
    console.log(`${name.padEnd(28)} "${cl.name.slice(0, 24)}"  breaks ${breaks}  baseline err ${maxB.toFixed(3)}  x err ${maxX.toFixed(3)}  pixel IoU ${(uni ? inter / uni : 1).toFixed(3)}`);
  });
}
