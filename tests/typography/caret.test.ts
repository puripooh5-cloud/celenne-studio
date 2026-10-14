/**
 * Caret geometry from the text engine's layout, on Photoshop's Thai paragraph (Tahoma, wrapped by
 * Photoshop's rules): stops at grapheme boundaries only, follows the drawn glyphs and lines, and
 * maps points back to positions. Needs the Windows fonts; skipped elsewhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { importPsd } from '../../src/psd/import';
import { FaceRegistry } from '../../src/typography/engine/registry';
import { registerFontFolder } from '../../src/typography/engine/nodeFonts';
import { layoutEngine, type EngineLayout } from '../../src/typography/engine/layout';
import { caretAt, caretStops, indexAtPoint, lineEnds, selectionRects, snapToStop, verticalMove } from '../../src/typography/caret';
import type { TextData } from '../../src/typography/types';

const file = path.resolve('tests/fixtures/photoshop/text/text-thai-para-tahoma.psd');
const reg = new FaceRegistry();
let t: TextData;
let L: EngineLayout;
let ok = false;

beforeAll(async () => {
  ok = fs.existsSync(file) && (await registerFontFolder(reg)) > 0 && !!reg.resolve({ postScriptName: 'Tahoma', family: 'Tahoma', weight: 400, italic: false });
  if (!ok) return;
  const { doc } = importPsd(new Uint8Array(fs.readFileSync(file)), 'x');
  t = (doc.allLayers().find((l) => l.kind === 'text') as { text: TextData }).text;
  L = layoutEngine(t, reg);
}, 60_000);

describe('caret', () => {
  it('stops only between Thai grapheme clusters', () => {
    // ที่ = ท + ี + ่ (one stop), ทำ = ท + ำ (SARA AM stays with its consonant).
    const s = caretStops('ที่ทำ');
    expect([...s].sort((a, b) => a - b)).toEqual([0, 3, 5]);
    expect(snapToStop('ที่ทำ', 2)).toBe(0);
    expect(snapToStop('ที่ทำ', 2, 1)).toBe(3);
  });

  it('follows the engine layout', (c) => {
    if (!ok) return c.skip();
    expect(L.lines.length).toBeGreaterThan(3);
    // Lines cover the text in order.
    L.lines.forEach((ln, i) => { if (i) expect(ln.start).toBe(L.lines[i - 1].end); });
    expect(L.lines[L.lines.length - 1].end).toBe(t.text.length);
    // Along a line, carets move right; each sits on its line's baseline band.
    const ln = L.lines[1];
    let prev = -Infinity;
    for (const p of [...caretStops(t.text)].filter((p) => p >= ln.start && p < ln.end).sort((a, b) => a - b)) {
      const k = caretAt(L, t, p)!;
      expect(k.line).toBe(1);
      expect(k.x).toBeGreaterThan(prev);
      expect(k.top).toBeLessThan(ln.baseline);
      expect(k.bottom).toBeGreaterThan(ln.baseline);
      prev = k.x;
    }
    // At a soft break: the next line's start, or the earlier line's end when upstream.
    expect(caretAt(L, t, ln.end)!.line).toBe(2);
    expect(caretAt(L, t, ln.end, true)!.line).toBe(1);
  });

  it('maps points to positions and moves by line', (c) => {
    if (!ok) return c.skip();
    const stops = caretStops(t.text);
    for (const p of [...stops].filter((_, i) => i % 7 === 3)) {
      const k = caretAt(L, t, p)!;
      const back = indexAtPoint(L, t, k.x + 0.01, (k.top + k.bottom) / 2);
      expect(caretAt(L, t, back.pos, back.upstream)!.x).toBeCloseTo(k.x, 3);
      expect(stops.has(back.pos)).toBe(true);
    }
    const from = caretAt(L, t, L.lines[2].start + 5)!;
    const down = verticalMove(L, t, L.lines[2].start + 5, 1, from.x);
    expect(caretAt(L, t, down.pos, down.upstream)!.line).toBe(3);
    expect(Math.abs(caretAt(L, t, down.pos, down.upstream)!.x - from.x)).toBeLessThan(20);
    expect(verticalMove(L, t, 3, -1, 0).pos).toBe(0);
    const ends = lineEnds(L, L.lines[2].start + 5);
    expect([ends.start, ends.end, ends.softEnd]).toEqual([L.lines[2].start, L.lines[2].end, true]);
  });

  it('highlights a selection across lines', (c) => {
    if (!ok) return c.skip();
    const a = L.lines[1].start + 4, b = L.lines[3].start + 4;
    const rects = selectionRects(L, t, a, b);
    expect(rects.length).toBe(3);
    expect(rects[1].x).toBeCloseTo(L.lines[2].x0, 3);
  });
});
