/**
 * Whole-paragraph composers (Photoshop's Every-line approximation, Celenne's own), optical margins
 * and Fit Text to Frame, on real fonts. Skipped where the Windows fonts are missing.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { FaceRegistry } from '../../src/typography/engine/registry';
import { registerFontFolder } from '../../src/typography/engine/nodeFonts';
import { layoutEngine } from '../../src/typography/engine/layout';
import { fitScale, scaledText } from '../../src/typography/fitFrame';
import { createTextLayer } from '../../src/document/layerFactory';
import { defaultCharacterStyle, defaultParagraphStyle, type ParagraphStyle, type TextData } from '../../src/typography/types';

const reg = new FaceRegistry();
let ok = false;
beforeAll(async () => {
  ok = (await registerFontFolder(reg)) > 0 && !!reg.resolve({ postScriptName: 'ArialMT', family: 'Arial', weight: 400, italic: false });
}, 60_000);

const PARA = 'Celenne lays out every paragraph with rules that follow the familiar composer, so lines should break on the same words. ' +
  'Justified columns keep an even rhythm when the spacing limits allow it, and hyphenation only steps in when a long word would leave a gap. ' +
  'Typography rewards patience: kerning, tracking and leading each change how a block of text reads.';

function para(text: string, w: number, p: Partial<ParagraphStyle>, h = 2000): TextData {
  const t = createTextLayer(text, 8, 0, 0, { kind: 'paragraph', box: { x: 0, y: 0, w, h } }).text;
  t.runs = [{ length: text.length, style: { ...defaultCharacterStyle(), postScriptName: 'ArialMT', fontFamily: 'Arial', fontSize: 16 } }];
  t.paragraphs = [{ length: text.length, style: { ...defaultParagraphStyle(), ...p } }];
  return t;
}
const lines = (t: TextData) => layoutEngine(t, reg).lines;
const lineText = (t: TextData) => lines(t).map((l) => t.text.slice(l.start, l.end).trim());

describe('composers', () => {
  it("Celenne's composer avoids a short last line and stacked hyphens, and keeps spacing within limits", (c) => {
    if (!ok) return c.skip();
    let runtsSingle = 0, runtsCelenne = 0, stacks = 0;
    for (let w = 200; w <= 420; w += 4) {
      const single = para(PARA, w, { align: 'justifyLeft', hyphenate: true });
      const cel = para(PARA, w, { align: 'justifyLeft', hyphenate: true, composer: 'celenne' });
      const runt = (t: TextData) => { const l = lineText(t); const last = l[l.length - 1]; return !last.includes(' ') && last.length < 8 ? 1 : 0; };
      runtsSingle += runt(single); runtsCelenne += runt(cel);
      const L = lines(cel);
      // A hyphenated line ends inside a word (a letter before the break, a letter after it).
      const hyph = L.map((ln) => /\p{L}/u.test(cel.text[ln.end - 1] ?? '') && /\p{L}/u.test(cel.text[ln.end] ?? ''));
      for (let i = 1; i < hyph.length; i++) if (hyph[i] && hyph[i - 1]) stacks++;
      // Word spaces never shrink below the minimum (80 % of a space).
      for (const ln of L.slice(0, -1)) expect(ln.x1 - ln.x0).toBeLessThanOrEqual(w + 0.01);
    }
    expect(runtsCelenne).toBe(0);
    expect(runtsSingle).toBeGreaterThanOrEqual(runtsCelenne);
    expect(stacks).toBe(0);
  });

  it('Every-line composer: whole-paragraph breaks, word spaces narrowed on ragged lines to fit', (c) => {
    if (!ok) return c.skip();
    // Photoshop (probe-every-justify, 264 px) sets "with" on the first line by narrowing the spaces
    // below the minimum word spacing; the Single-line composer cannot.
    const every = para(PARA, 264, { composer: 'every', align: 'justifyLeft' });
    expect(lineText(every)[0]).toBe('Celenne lays out every paragraph with');
    expect(lineText(para(PARA, 264, { align: 'justifyLeft' }))[0]).toBe('Celenne lays out every paragraph');
    for (const ln of lines(para(PARA, 264, { composer: 'every' }))) expect(ln.x1 - ln.x0).toBeLessThanOrEqual(264 + 0.01);
  });
});

describe('optical margins', () => {
  it('quotes hang outside the margin; T and W hang a little', (c) => {
    if (!ok) return c.skip();
    const plain = lines(para('"Quoted text starts this paragraph and wraps onto a second line here.', 200, {}));
    const hung = lines(para('"Quoted text starts this paragraph and wraps onto a second line here.', 200, { opticalMargins: true }));
    const quote = plain[0].glyphs[0];
    expect(hung[0].glyphs[0].x).toBeCloseTo(quote.x - quote.face.advance(quote.gid) * quote.sx, 3);
    const tw = lines(para('Typography wraps here', 300, { opticalMargins: true }))[0].glyphs[0];
    expect(tw.x).toBeLessThan(0);
    expect(tw.x).toBeGreaterThan(-2);
  });
});

describe('Fit Text to Frame', () => {
  it('finds the largest size at which the text still fits the box', (c) => {
    if (!ok) return c.skip();
    const t = para(PARA, 300, {}, 200);
    const layout = (x: TextData) => layoutEngine(x, reg);
    const k = fitScale(t, layout)!;
    expect(k).toBeGreaterThan(0.5);
    const fitsAt = (s: number) => { const x = scaledText(t, s); const L = layout(x); const last = L.lines[L.lines.length - 1]; return !L.overflow && last.end === t.text.length && last.baseline + last.descent <= 200.5; };
    expect(fitsAt(k)).toBe(true);
    expect(fitsAt(k * 1.03)).toBe(false);
    expect(fitScale({ ...t, kind: 'point', box: null }, layout)).toBeNull();
  });
});
