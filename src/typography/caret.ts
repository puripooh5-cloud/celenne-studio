/**
 * Caret and selection geometry for text being edited, from the engine's own layout, so the caret
 * sits where the engine draws the text (its line breaks, Thai squeezing, justification) rather than
 * where the hidden text field would put it.
 *
 * The caret only stops at grapheme boundaries (Intl.Segmenter, as the text field itself moves): in
 * Thai a consonant with its vowel and tone marks is one stop, and SARA AM stays with the consonant
 * before it. All positions are UTF-16 indexes into TextData.text; geometry is in text space.
 */
import type { TextData } from './types';
import type { EngineLayout, EngineLine, PlacedGlyph } from './engine/layout';

export interface CaretBox { x: number; top: number; bottom: number; line: number }
export interface Rect { x: number; y: number; w: number; h: number }

interface Seg { segment(s: string): Iterable<{ index: number }> }
const segmenter: Seg | null = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new (Intl as unknown as { Segmenter: new (l: string, o: { granularity: string }) => Seg }).Segmenter('th', { granularity: 'grapheme' })
  : null;

const stopsCache = new Map<string, Set<number>>();
/** Grapheme boundaries of `text` (always including 0 and its length). */
export function caretStops(text: string): Set<number> {
  let s = stopsCache.get(text);
  if (s) return s;
  s = new Set([0, text.length]);
  if (segmenter) for (const g of segmenter.segment(text)) s.add(g.index);
  else for (let i = 0; i < text.length; i++) if (!(i > 0 && /\p{M}/u.test(text[i])) && !(i > 0 && /[\uDC00-\uDFFF]/.test(text[i]))) s.add(i);
  if (stopsCache.size > 64) stopsCache.clear();
  stopsCache.set(text, s);
  return s;
}

/** The nearest caret stop at or before `pos` (dir -1) or at or after it (dir 1). */
export function snapToStop(text: string, pos: number, dir: -1 | 1 = -1): number {
  const stops = caretStops(text);
  let p = Math.max(0, Math.min(text.length, pos));
  while (!stops.has(p)) p += dir;
  return p;
}

const advanceOf = (g: PlacedGlyph) => g.face.advance(g.gid) * g.sx;
const trackOf = (g: PlacedGlyph) => (g.style.tracking / 1000) * g.style.fontSize;

/**
 * The line showing position `pos`. At a soft line break the position is the start of the next line,
 * unless `upstream` (the caret was put at the end of the earlier line, by End or a click there).
 */
export function lineAt(L: EngineLayout, pos: number, upstream = false): number {
  let found = -1;
  for (let i = 0; i < L.lines.length; i++) {
    const ln = L.lines[i];
    if (ln.start <= pos && pos <= ln.end) {
      found = i;
      if (upstream && pos === ln.end) break;
    }
  }
  if (found >= 0) return found;
  // Past the last shown line (overflowing box text): the last line.
  return pos < (L.lines[0]?.start ?? 0) ? 0 : L.lines.length - 1;
}

/** The x of position `pos` on line `ln`: the left edge of the first character from `pos` on, else the line's end. */
export function xOnLine(ln: EngineLine, pos: number): number {
  let end = ln.x0;
  for (const g of ln.glyphs) {
    const adv = advanceOf(g);
    if (adv <= 0) continue; // marks sit on their base
    if (g.index >= pos) return g.x;
    end = g.x + adv + trackOf(g);
  }
  return ln.glyphs.length ? end : ln.x0;
}

function lineBox(t: TextData, ln: EngineLine, pos: number): { top: number; bottom: number } {
  if (ln.ascent > 0 || ln.descent > 0) return { top: ln.baseline - ln.ascent, bottom: ln.baseline + ln.descent };
  // An empty line: the size of the type at that position.
  let at = 0, size = t.runs[0]?.style.fontSize ?? 12;
  for (const r of t.runs) { if (pos < at + r.length || r === t.runs[t.runs.length - 1]) { size = r.style.fontSize; break; } at += r.length; }
  return { top: ln.baseline - size * 0.8, bottom: ln.baseline + size * 0.2 };
}

/** The caret at `pos`, or null when nothing is laid out. */
export function caretAt(L: EngineLayout, t: TextData, pos: number, upstream = false): CaretBox | null {
  if (!L.lines.length) return null;
  const i = lineAt(L, pos, upstream);
  const ln = L.lines[i];
  return { x: xOnLine(ln, Math.min(pos, ln.end + 1)), ...lineBox(t, ln, pos), line: i };
}

/** Highlight rectangles for the selection [a, b). */
export function selectionRects(L: EngineLayout, t: TextData, a: number, b: number): Rect[] {
  if (a === b) return [];
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const out: Rect[] = [];
  L.lines.forEach((ln) => {
    if (hi < ln.start || lo > ln.end || (hi === ln.start && ln.start !== ln.end)) return;
    const x0 = xOnLine(ln, Math.max(lo, ln.start));
    // A selected line break shows as a sliver after the line's text.
    let x1 = hi > ln.end ? xOnLine(ln, ln.end + 1) : xOnLine(ln, hi);
    if (hi > ln.end && t.text[ln.end] === '\n') x1 += (ln.ascent + ln.descent || 10) * 0.25;
    const { top, bottom } = lineBox(t, ln, ln.start);
    if (x1 > x0) out.push({ x: x0, y: top, w: x1 - x0, h: bottom - top });
  });
  return out;
}

/** The caret position on line `i` nearest to x, and whether it is that line's end (for `upstream`). */
export function indexOnLine(L: EngineLayout, t: TextData, i: number, x: number): { pos: number; upstream: boolean } {
  const ln = L.lines[i];
  const stops = caretStops(t.text);
  let best = ln.start, bestD = Math.abs(x - xOnLine(ln, ln.start));
  const consider = (p: number) => {
    if (p < ln.start || p > ln.end || !stops.has(p)) return;
    const d = Math.abs(x - xOnLine(ln, p));
    if (d < bestD) { best = p; bestD = d; }
  };
  for (const g of ln.glyphs) if (advanceOf(g) > 0) consider(g.index);
  consider(ln.end);
  // (At a soft break the line's end is also the next line's start: keep the caret on this line.)
  const next = L.lines[i + 1];
  return { pos: best, upstream: best === ln.end && !!next && next.start === ln.end };
}

/** The caret position at a text-space point. */
export function indexAtPoint(L: EngineLayout, t: TextData, x: number, y: number): { pos: number; upstream: boolean } {
  if (!L.lines.length) return { pos: 0, upstream: false };
  let best = 0, bestD = Infinity;
  L.lines.forEach((ln, i) => {
    const { top, bottom } = lineBox(t, ln, ln.start);
    const d = y < top ? top - y : y > bottom ? y - bottom : 0;
    if (d < bestD) { best = i; bestD = d; }
  });
  return indexOnLine(L, t, best, x);
}

/** Up / down one line from `pos`, keeping the column `goalX` (text space). */
export function verticalMove(L: EngineLayout, t: TextData, pos: number, dir: -1 | 1, goalX: number, upstream = false): { pos: number; upstream: boolean } {
  const i = lineAt(L, pos, upstream);
  const j = i + dir;
  if (j < 0) return { pos: 0, upstream: false };
  if (j >= L.lines.length) return { pos: t.text.length, upstream: false };
  return indexOnLine(L, t, j, goalX);
}

/** Start and end of the line showing `pos` (Home / End). */
export function lineEnds(L: EngineLayout, pos: number, upstream = false): { start: number; end: number; softEnd: boolean } {
  const i = lineAt(L, pos, upstream);
  const ln = L.lines[i];
  if (!ln) return { start: 0, end: 0, softEnd: false };
  const next = L.lines[i + 1];
  return { start: ln.start, end: ln.end, softEnd: !!next && next.start === ln.end };
}
