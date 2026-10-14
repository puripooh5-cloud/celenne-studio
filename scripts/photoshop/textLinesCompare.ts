/**
 * Compares Celenne's layout of a corpus file with Photoshop's own layout (the Txt2 data stored in
 * the PSD): where each line starts in the text, its baseline, and every glyph's x position.
 * Used by compare-text-lines.ts and by the corpus regression test (tests/psd/textCorpus.test.ts).
 */
import { parseContainer } from '../../src/psd/container';
import { parseTxt2, txt2Texts } from '../../src/psd/txt2';
import { importPsd } from '../../src/psd/import';
import type { FaceRegistry } from '../../src/typography/engine/registry';
import { layoutEngine, type ComposeOptions } from '../../src/typography/engine/layout';

export interface LineReport { file: string; lines: number; psLines: number; breaksOk: number; baseline: number; x: number; detail: string[] }

/** Null for files without horizontal text in Txt2 (vertical text and type on a path are compared by outline). */
export function compareTextLines(bytes: Uint8Array, file: string, reg: FaceRegistry, opts: ComposeOptions, detail = false): LineReport | null {
  const blk = parseContainer(bytes).globalBlocks.find((b) => b.key === 'Txt2');
  if (!blk) return null;
  const ps = txt2Texts(parseTxt2(blk.data))[0];
  const layer = importPsd(bytes, file).doc.allLayers().find((l) => l.kind === 'text');
  if (!ps || !layer || layer.kind !== 'text') return null;
  const t = layer.text;
  if (t.orientation === 'vertical' || t.path) return null;
  const L = layoutEngine(t, reg, opts);
  const bx = t.box?.x ?? 0;
  const out: string[] = [];
  let breaksOk = 0, maxB = 0, maxX = 0;
  const n = Math.max(L.lines.length, ps.lines.length);
  for (let i = 0; i < n; i++) {
    const a = L.lines[i], b = ps.lines[i];
    if (!a || !b) continue;
    const startA = a.glyphs[0]?.index ?? -1;
    const ok = startA === b.start || (!a.glyphs.length && i > 0);
    if (ok) breaksOk++;
    maxB = Math.max(maxB, Math.abs(a.baseline - (t.box?.y ?? 0) - b.baseline));
    if (ok) {
      // Run start: Photoshop's G /8 box is the union of the pen box and the ink box, so it only marks
      // the pen start when the line is not flush left (centred / right / justified-centre lines).
      const flushLeft = ['left', 'justifyLeft', 'justifyAll'].includes(a.para.align) || (a.para.align.startsWith('justify') && i < ps.lines.length - 1 && a.para.align !== 'justifyCenter' && a.para.align !== 'justifyRight');
      const xs = b.runs.flatMap((r, ri) => r.x.map((x) => (flushLeft && ri === 0 ? b.x : r.x0) + x));
      let lineMax = 0, firstBad = -1;
      a.glyphs.forEach((g, k) => { if (k < xs.length) { const e = Math.abs(g.x - bx - xs[k]); if (e > 0.05 && firstBad < 0) firstBad = k; lineMax = Math.max(lineMax, e); } });
      maxX = Math.max(maxX, lineMax);
      if (detail && lineMax > 0.05) out.push(`   line ${i}: x err ${lineMax.toFixed(3)} from glyph ${firstBad} (${JSON.stringify(t.text[a.glyphs[firstBad]?.index] ?? '')}), ours ${(a.glyphs[firstBad].x - bx).toFixed(3)} ps ${xs[firstBad]?.toFixed(3)}; glyphs ${a.glyphs.length}/${xs.length}`);
    }
    if (detail && (!ok || maxX > 0.5)) {
      const textA = t.text.slice(startA, (L.lines[i + 1]?.glyphs[0]?.index ?? t.text.length)).replace(/\n/g, '⏎');
      const textB = t.text.slice(b.start, ps.lines[i + 1]?.start ?? t.text.length).replace(/\n/g, '⏎');
      out.push(`   line ${i}: ${ok ? 'same start' : 'DIFFERENT'}\n     ours: ${JSON.stringify(textA)}\n     ps:   ${JSON.stringify(textB)}`);
    }
  }
  return { file, lines: L.lines.length, psLines: ps.lines.length, breaksOk, baseline: maxB, x: maxX, detail: out };
}
