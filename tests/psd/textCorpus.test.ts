/**
 * Corpus regression: every horizontal text file in tests/fixtures/photoshop/text laid out by
 * Celenne and compared line by line with the layout Photoshop stored in it (Txt2): line starts,
 * baselines and glyph x. Pins today's results so a change to the engine cannot quietly make them
 * worse. Needs the Windows fonts the corpus uses; skipped elsewhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FaceRegistry } from '../../src/typography/engine/registry';
import { registerFontFolder } from '../../src/typography/engine/nodeFonts';
import { compareTextLines } from '../../scripts/photoshop/textLinesCompare';

const dir = path.resolve('tests/fixtures/photoshop/text');
const reg = new FaceRegistry();
let fontsOk = false;

beforeAll(async () => {
  fontsOk = fs.existsSync(dir) && (await registerFontFolder(reg)) > 0
    && !!reg.resolve({ family: 'Arial', weight: 400, italic: false })
    && !!reg.resolve({ family: 'Leelawadee UI', weight: 400, italic: false })
    && !!reg.resolve({ family: 'Tahoma', weight: 400, italic: false });
}, 60_000);

const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.psd')).sort() : [];
const bytesOf = (f: string) => new Uint8Array(fs.readFileSync(path.join(dir, f)));

/**
 * Known glyph x differences (px) with the stored line breaks. Thai: Photoshop records marks at
 * their own pen positions, Celenne at the base's (the pixels match). Tahoma: Photoshop uses the
 * font's hinted advances. All caps: Photoshop's caps substitution is approximated.
 */
const X_LIMIT: Record<string, number> = {
  'text-allcaps': 0.7, 'text-point-tahoma': 1.9, 'text-thai': 1.6, 'text-thai-leelawadee': 3.5,
  'text-thai-marks-leelawadee': 7.9, 'text-thai-marks-tahoma': 6.7, 'text-thai-mixed': 3.3,
  'text-thai-para-every': 2.4, 'text-thai-para-justify': 2.4, 'text-thai-para-leelawadee': 2.4,
  'text-thai-para-narrow': 2.9, 'text-thai-para-tahoma': 3.2,
};
for (const aa of ['none', 'sharp', 'crisp', 'strong', 'smooth']) { X_LIMIT[`text-aa-${aa}-large`] = 24.7; X_LIMIT[`text-aa-${aa}-small`] = 8.7; }

/**
 * Re-composed by Celenne (as after an edit): files whose line starts do not all match Photoshop's,
 * with the number that must still match. All use Photoshop's Every-line composer, which Celenne
 * approximates (a different early break shifts the lines after it).
 */
const MIN_STARTS: Record<string, number> = {
  'text-para-hyphen-every': 1, 'text-para-justify-every': 2, 'text-para-segoe-every': 1,
  'text-thai-para-every': 2, 'text-thai-mixed': 3,
};

describe("Text corpus: Celenne's layout vs the layout Photoshop stored", () => {
  it('finds the corpus', () => { expect(files.length).toBeGreaterThan(70); });

  for (const f of files) {
    const name = f.replace(/\.psd$/, '');
    it(`${name}: unedited text keeps Photoshop's lines and glyph positions`, (ctx) => {
      if (!fontsOk) return ctx.skip();
      const r = compareTextLines(bytesOf(f), name, reg, { ignoreStoredBreaks: false });
      if (!r) return; // vertical text and type on a path: compared by outline in textEngine.test.ts
      expect(r.lines).toBe(r.psLines);
      expect(r.breaksOk).toBe(r.psLines);
      expect(r.baseline).toBeLessThan(0.05);
      expect(r.x).toBeLessThanOrEqual(X_LIMIT[name] ?? 0.05);
    });

    it(`${name}: re-composed text breaks like Photoshop`, (ctx) => {
      if (!fontsOk) return ctx.skip();
      const r = compareTextLines(bytesOf(f), name, reg, { ignoreStoredBreaks: true });
      if (!r) return;
      const min = MIN_STARTS[name];
      if (min === undefined) {
        expect(r.lines).toBe(r.psLines);
        expect(r.breaksOk).toBe(r.psLines);
      } else expect(r.breaksOk).toBeGreaterThanOrEqual(min);
      expect(r.baseline).toBeLessThan(0.05);
    });
  }

  it('overall: at least 50 files identical to Photoshop with stored breaks, 44 when re-composed', (ctx) => {
    if (!fontsOk) return ctx.skip();
    const perfect = (ignoreStoredBreaks: boolean) => files.filter((f) => {
      const r = compareTextLines(bytesOf(f), f, reg, { ignoreStoredBreaks });
      return r && r.lines === r.psLines && r.breaksOk === r.psLines && r.baseline < 0.05 && r.x < 0.05;
    }).length;
    expect(perfect(false)).toBeGreaterThanOrEqual(50);
    expect(perfect(true)).toBeGreaterThanOrEqual(44);
  }, 120_000);
});
