/**
 * Text layout with real font data (HarfBuzz shaping). Produces positioned glyphs in text space
 * (point text: origin on the first baseline; paragraph text: the box's top-left), which the
 * renderer fills from the glyph outlines.
 */
import { flattenTextPath, pointAtDistance, spanOnFlat } from '../pathText';
import type { CharacterStyle, ParagraphStyle, TextData } from '../types';
import { PARAGRAPH_DEFAULTS } from '../types';
import { composeParagraph, type ComposedLine } from './compose';
import { hyphenPoints } from './hyphenate';
import type { FontFace, ShapedGlyph } from './face';
import type { FaceRegistry } from './registry';

export interface PlacedGlyph {
  face: FontFace;
  gid: number;
  /** Pen position of the glyph origin on its baseline, text space. */
  x: number;
  y: number;
  /** Font units → text-space pixels, horizontally and vertically (includes the H/V scale). */
  sx: number;
  sy: number;
  style: CharacterStyle;
  /** Character index in TextData.text. */
  index: number;
  /** Vertical text: the glyph is set upright (see layoutVertical). */
  upright?: Upright;
  /** Rotation about the glyph origin, radians (type on a path). */
  rot?: number;
}

/** An upright glyph in vertical text: its horizontal advance and shaping offsets. */
interface Upright { hAdv: number; dx: number; dy: number }

export interface EngineLine {
  glyphs: PlacedGlyph[];
  baseline: number;
  /** The line's characters in TextData.text: [start, end) (the paragraph's line break excluded). */
  start: number;
  end: number;
  /** Ink-free extent of the line along the baseline (start, end), text space. */
  x0: number;
  x1: number;
  ascent: number;
  descent: number;
  para: ParagraphStyle;
}

export interface EngineLayout {
  lines: EngineLine[];
  bounds: { x: number; y: number; w: number; h: number };
  /** Faces still loading (the layout used fallbacks or skipped those runs). */
  missing: boolean;
  /** Paragraph text that does not fit: lines whose baseline falls below the box are not shown. */
  overflow: boolean;
}

interface Item { start: number; end: number; style: CharacterStyle; face: FontFace }

function styleAtIndex(t: TextData): CharacterStyle[] {
  const out: CharacterStyle[] = [];
  let i = 0;
  for (const r of t.runs) for (let k = 0; k < r.length && i < t.text.length; k++) out[i++] = r.style;
  const last = t.runs[t.runs.length - 1]?.style;
  while (i < t.text.length) out[i++] = last;
  return out;
}

function paraAtIndex(t: TextData): ParagraphStyle[] {
  const out: ParagraphStyle[] = [];
  let i = 0;
  for (const p of t.paragraphs) for (let k = 0; k < p.length && i <= t.text.length; k++) out[i++] = p.style;
  const last = t.paragraphs[t.paragraphs.length - 1]?.style;
  while (i <= t.text.length) out[i++] = last;
  return out;
}

const caseOf = (s: CharacterStyle, ch: string) => (s.textCase === 'allCaps' ? ch.toUpperCase() : ch);

export function featuresFor(s: CharacterStyle, face?: FontFace): Record<string, number> {
  const f: Record<string, number> = {};
  if (s.kerning === 'none' || (face && face.kerningSource() !== 'gpos')) f.kern = 0;
  // All Caps: Photoshop switches on the font's capital spacing and case-sensitive forms.
  if (s.textCase === 'allCaps') { f.cpsp = 1; f.case = 1; }
  if (!s.ligatures) { f.liga = 0; f.clig = 0; }
  if (s.textCase === 'smallCaps') f.smcp = 1;
  for (const tag of s.openTypeFeatures ?? []) f[tag] = 1;
  return f;
}

/**
 * Splits one paragraph's characters into runs of the same style and face (fallback faces for
 * characters the requested font lacks), and shapes each run.
 */
function shapeParagraph(text: string, base: number, styles: CharacterStyle[], reg: FaceRegistry, state: { missing: boolean }): { glyphs: (ShapedGlyph & { face: FontFace; style: CharacterStyle; index: number })[] } {
  const items: Item[] = [];
  const cps = [...text];
  let pos = 0;
  for (const ch of cps) {
    const idx = base + pos;
    const st = styles[idx];
    const src = reg.resolve({ postScriptName: st.postScriptName, family: st.fontFamily, weight: st.fontWeight, italic: st.italic });
    let face = src ? reg.face(src) : null;
    // Still loading: the layout is provisional. (A face that could not be read uses the fallbacks.)
    if (!face && src && reg.loading(src)) state.missing = true;
    const cp = caseOf(st, ch).codePointAt(0)!;
    if (!face || (!face.hasGlyph(cp) && !/\s/.test(ch))) {
      const fb = reg.fallbackFor(cp, st.fontWeight, st.italic);
      // A fallback face may still be loading: wait for it rather than drop the character.
      if (!fb && reg.busy) state.missing = true;
      face = fb ?? face;
    }
    if (face) {
      const last = items[items.length - 1];
      if (last && last.style === st && last.face === face && last.end === pos) last.end = pos + ch.length;
      else items.push({ start: pos, end: pos + ch.length, style: st, face });
    }
    pos += ch.length;
  }
  const glyphs: (ShapedGlyph & { face: FontFace; style: CharacterStyle; index: number })[] = [];
  for (const it of items) {
    const sub = [...text.slice(it.start, it.end)].map((c) => caseOf(it.style, c)).join('');
    const shaped = it.face.shape(sub, { features: featuresFor(it.style, it.face) });
    // Fonts kerned only by a TrueType 'kern' table: each pair's value is added to the left glyph's advance.
    // (Photoshop's Txt2 caret positions split it between both glyphs, but the glyphs are drawn this way.)
    if (it.style.kerning !== 'none' && it.face.kerningSource() === 'table') {
      for (let i = 0; i + 1 < shaped.length; i++) shaped[i].ax += it.face.tableKern(shaped[i].gid, shaped[i + 1].gid);
    }
    for (const g of shaped) glyphs.push({ ...g, face: it.face, style: it.style, index: base + it.start + g.cluster });
  }
  return { glyphs };
}

/** One shaped glyph, sized in text-space pixels, before it is placed on a line. */
export interface Cell {
  face: FontFace;
  gid: number;
  style: CharacterStyle;
  index: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  /** Advance including tracking. */
  adv: number;
  space: boolean;
  /** A line may break after this glyph. */
  breakAfter: boolean;
  /** Vertical text: set upright (its advance is then along the column). */
  upright?: Upright;
}

export interface ComposeOptions {
  /** Compose every paragraph, ignoring line breaks stored from Photoshop (comparisons, tests). */
  ignoreStoredBreaks?: boolean;
}

/** 32-bit FNV-1a hash of a string. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * Fingerprint of one paragraph's layout inputs: its text, the character styles of its characters
 * (colour excluded: recolouring does not move glyphs), its paragraph style and the box width.
 */
export function paragraphKey(t: TextData, start: number, ptext: string, styles: CharacterStyle[], para: ParagraphStyle): number {
  const runs: string[] = [];
  let prev: CharacterStyle | undefined;
  for (let i = 0; i < ptext.length; i++) {
    const st = styles[start + i];
    if (st === prev) { runs[runs.length - 1] += '+'; continue; }
    prev = st;
    const { color: _c, ...rest } = st;
    void _c;
    runs.push(JSON.stringify(rest));
  }
  return fnv(JSON.stringify([ptext, runs, para, t.kind, t.kind === 'paragraph' ? t.box?.w ?? null : null, t.orientation]));
}

/** One of Photoshop's laid-out lines: its first character and its glyph runs (pen x positions). */
export interface StoredLine { start: number; runs: { glyphs: number[]; x: number[] }[] }

/** Photoshop's line breaks (and line spans), stored per paragraph fingerprint. */
export function photoshopBreaks(t: TextData, psLines: StoredLine[]): TextData['psBreaks'] {
  const styles = styleAtIndex(t), paras = paraAtIndex(t);
  const out: NonNullable<TextData['psBreaks']> = [];
  const lineStarts = psLines.map((l) => l.start);
  let start = 0;
  for (const ptext of t.text.split('\n')) {
    const end = start + ptext.length;
    const mine = psLines.filter((l) => l.start >= start && l.start <= end);
    const starts = lineStarts.filter((s) => s > start && s <= end).map((s) => s - start);
    // Glyph positions, kept for lines whose spacing Celenne does not reproduce exactly yet
    // (optical kerning, faux bold): pen x of each character relative to the line's first one.
    const xs = mine.map((l, i) => {
      const lineEnd = i + 1 < mine.length ? mine[i + 1].start : end;
      const chars = t.text.slice(l.start, lineEnd);
      let special = false;
      for (let k = l.start; k < lineEnd; k++) if (styles[k] && (styles[k].kerning === 'optical' || styles[k].fauxBold)) special = true;
      if (!special || l.runs.length !== 1 || /[฀-๿]/.test(chars)) return null;
      const n = l.runs[0].glyphs.length;
      if (n !== chars.length && n !== chars.length + 1) return null;
      const x = l.runs[0].x;
      return x.slice(0, chars.length).map((v) => +(v - x[0]).toFixed(4));
    });
    const keepXs = mine.length === starts.length + 1 && xs.some((v) => v);
    // Only paragraphs Photoshop wrapped (or whose glyph positions are kept) need an entry.
    if ((starts.length || keepXs) && starts.every((s, i) => i === 0 || s > starts[i - 1])) {
      const para = paras[start] ?? paras[paras.length - 1];
      // Span of each line: single-run lines with one glyph per character (no ligatures).
      // Thai lines keep only their break: Photoshop's glyph list does not map one to one onto the
      // characters (SARA AM is two glyphs), and their spacing follows the squeeze rule anyway.
      const thaiLine = (i: number) => /[฀-๿]/.test(t.text.slice(mine[i].start, i + 1 < mine.length ? mine[i + 1].start : end));
      const spans = mine.map((l, i) => {
        if (l.runs.length !== 1 || thaiLine(i)) return null;
        const lineEnd = i + 1 < mine.length ? mine[i + 1].start : end;
        const chars = t.text.slice(l.start, lineEnd);
        const xs = l.runs[0].x;
        // x also holds the end position. A paragraph's last line has an extra end-of-paragraph
        // glyph; a hyphenated line ends with the added hyphen.
        const n = l.runs[0].glyphs.length;
        const lastOfPara = i === mine.length - 1;
        let last = chars.length - 1;
        while (last > 0 && /\s/.test(chars[last])) last--;
        if (n === chars.length || (lastOfPara && n === chars.length + 1)) return last > 0 ? xs[last] - xs[0] : null;
        if (!lastOfPara && n === chars.length + 1 && /\p{L}/u.test(chars[chars.length - 1] ?? '')) return xs[n - 1] - xs[0];
        return null;
      });
      // Whether Photoshop's last line holds the rest of the paragraph (lines that overflow the box are not listed).
      const lastLine = mine[mine.length - 1];
      const restChars = lastLine ? t.text.slice(lastLine.start, end).replace(/\s+$/, '').length : -1;
      const restGlyphs = lastLine ? lastLine.runs.reduce((n, r) => n + r.glyphs.length, 0) : -2;
      const whole = mine.length === starts.length + 1 && restGlyphs >= restChars;
      // Lines Photoshop ended with an added hyphen (one glyph more than characters, ending inside a word).
      const hyphens = mine.slice(0, -1).map((l, i) => {
        const chars = t.text.slice(l.start, mine[i + 1].start);
        const n = l.runs.reduce((k, r) => k + r.glyphs.length, 0);
        return !thaiLine(i) && n === chars.length + 1 && /\p{L}$/u.test(chars) ? i : -1;
      }).filter((i) => i >= 0);
      out.push({ key: paragraphKey(t, start, ptext, styles, para), starts, spans: spans.length === starts.length + 1 ? spans : undefined, ...(whole ? { whole } : {}), ...(mine.length === starts.length + 1 ? { hyphens } : {}), ...(keepXs ? { xs } : {}) });
    }
    start = end + 1;
  }
  return out.length ? out : undefined;
}

/**
 * Lines for a paragraph from stored break positions: the lines Photoshop listed, then the composer
 * for whatever follows the last stored line (Photoshop does not list lines that overflow the box).
 */
type StoredGroup = ComposedLine & { span?: number; xs?: number[] };

function storedLines(cells: Cell[], stored: NonNullable<TextData['psBreaks']>[number], base: number, ptext: string, para: ParagraphStyle, compose: (from: number) => ComposedLine[]): StoredGroup[] | null {
  const { starts, spans, hyphens } = stored;
  const whole = !!stored.whole;
  const bounds = [0, ...starts];
  const lines: StoredGroup[] = [];
  let c = 0;
  for (let i = 0; i < bounds.length; i++) {
    const s = bounds[i], e = i + 1 < bounds.length ? bounds[i + 1] : -1;
    if (e < 0 && whole) {
      // Photoshop's last line holds the rest of the paragraph.
      const line: number[] = [];
      for (; c < cells.length; c++) line.push(c);
      if (!line.length) return null;
      lines.push({ cells: line, hyphen: false, span: spans?.[i] ?? undefined, xs: stored.xs?.[i] ?? undefined });
      return lines;
    }
    if (e < 0) {
      // The last stored line: compose from here (it normally fits on one line).
      const k0 = c;
      const restLines = compose(k0);
      restLines.forEach((g, j) => lines.push({ cells: g.cells, hyphen: g.hyphen, ...(j === 0 && restLines.length === 1 ? { span: spans?.[i] ?? undefined, xs: stored.xs?.[i] ?? undefined } : {}) }));
      return lines;
    }
    const line: number[] = [];
    while (c < cells.length && cells[c].index - base < e) { if (cells[c].index - base >= s) line.push(c); c++; }
    if (!line.length) return null;
    // A break between two letters at a hyphenation point is a hyphenated line.
    const before = ptext[e - 1] ?? '', after = ptext[e] ?? '';
    let hyphen = !!hyphens?.includes(i);
    if (!hyphens && para.hyphenate && /\p{L}/u.test(before) && /\p{L}/u.test(after)) {
      let ws = e - 1;
      while (ws > 0 && /\p{L}/u.test(ptext[ws - 1])) ws--;
      let we = e;
      while (we < ptext.length && /\p{L}/u.test(ptext[we])) we++;
      hyphen = hyphenPoints(ptext.slice(ws, we)).includes(e - ws);
    }
    lines.push({ cells: line, hyphen, span: spans?.[i] ?? undefined, xs: stored.xs?.[i] ?? undefined });
  }
  return lines;
}

const SPACE = /[\s  - 　]/;
const BREAK_SPACE = /[ \t - 　]/;
const NO_SPACE_SCRIPTS = /[฀-๿຀-໿ក-៿က-႟]/;
const CJK = /[぀-ヿ㐀-鿿가-힯＀-￯]/;

/** Break opportunities: after spaces, hyphens and dashes; between CJK characters; Thai word ends. */
export function breakAfterFlags(text: string): boolean[] {
  const out = new Array<boolean>(text.length).fill(false);
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1] ?? '';
    if (BREAK_SPACE.test(c) && !BREAK_SPACE.test(n)) out[i] = true;
    else if (/[-‐–—]/.test(c) && n && !SPACE.test(n) && i > 0 && !SPACE.test(text[i - 1])) out[i] = true;
    else if ((CJK.test(c) || CJK.test(n)) && n && !/[、。，．ー]/.test(n)) out[i] = true;
  }
  // Thai and other scripts written without spaces: dictionary word boundaries.
  if (NO_SPACE_SCRIPTS.test(text) && typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    type Seg = { segment(s: string): Iterable<{ index: number; segment: string }> };
    const seg = new (Intl as unknown as { Segmenter: new (l: string, o: { granularity: string }) => Seg }).Segmenter('th', { granularity: 'word' });
    for (const s of seg.segment(text)) {
      const end = s.index + s.segment.length - 1;
      if (end >= 0 && end < text.length - 1 && NO_SPACE_SCRIPTS.test(text[end]) && !SPACE.test(text[end + 1])) out[end] = true;
    }
  }
  return out;
}

export function cellsFor(ptext: string, base: number, styles: CharacterStyle[], reg: FaceRegistry, state: { missing: boolean }): Cell[] {
  const { glyphs } = shapeParagraph(ptext, base, styles, reg, state);
  const brk = breakAfterFlags(ptext);
  return glyphs.map((g, i) => {
    const s = g.style;
    const k = s.fontSize / g.face.metrics.upem;
    const sx = k * s.horizontalScale, sy = k * s.verticalScale;
    const local = g.index - base;
    const nextLocal = (glyphs[i + 1]?.index ?? base + ptext.length) - base;
    const ch = ptext[local] ?? '';
    return { face: g.face, gid: g.gid, style: s, index: g.index, dx: g.dx * sx, dy: g.dy * sy, sx, sy, adv: g.ax * sx + (s.tracking / 1000) * s.fontSize, space: SPACE.test(ch), breakAfter: nextLocal > local && brk[nextLocal - 1] };
  });
}

/**
 * First-baseline offset in a paragraph box: the height of the font's lowercase "d" (Photoshop's
 * ascent), or its cap height (see TextData.firstBaseline).
 */
export function boxAscent(face: FontFace, size: number, vScale: number, mode: TextData['firstBaseline'] = 'ascent'): number {
  let h: number;
  if (mode === 'capHeight') h = face.metrics.capHeight;
  else {
    const e = face.extents(face.glyphFor(0x64));
    h = e ? e.yMax : face.metrics.typoAscender;
  }
  return (h / face.metrics.upem) * size * vScale;
}

const isJustified = (a: ParagraphStyle['align'], last: boolean) => a === 'justifyAll' || (a.startsWith('justify') && !last);
const lastAlign = (a: ParagraphStyle['align']): 'left' | 'center' | 'right' => (a === 'center' || a === 'justifyCenter' ? 'center' : a === 'right' || a === 'justifyRight' ? 'right' : 'left');

/** A hyphen glyph in the style and face of `c` (added at the end of a hyphenated line). */
function hyphenCell(c: Cell): Cell {
  const g = c.face.shape('-', { features: featuresFor(c.style, c.face) })[0];
  const k = c.style.fontSize / c.face.metrics.upem;
  return { ...c, gid: g?.gid ?? 0, dx: 0, dy: 0, adv: (g?.ax ?? 0) * k * c.style.horizontalScale + (c.style.tracking / 1000) * c.style.fontSize, space: false, breakAfter: false };
}

/** Lays out point text (lines break at line breaks only) and paragraph text (wrapped to the box). */
export function layoutEngine(t: TextData, reg: FaceRegistry, o: ComposeOptions = {}): EngineLayout {
  if (t.path) return layoutOnPath(t, reg);
  if (t.orientation === 'vertical') return layoutVertical(t, reg, o);
  return layoutLines(t, reg, o, t.kind === 'paragraph' && t.box ? t.box : null, false);
}

/**
 * Vertical text as Photoshop sets it (measured on the corpus' vertical files): every character
 * upright, one em down the column (spaces: their own width; no kerning); columns run right to left,
 * one leading apart, and break like horizontal lines with the box height as their length. Each
 * glyph is centred across its column by its advance, with its ascent (the "d" height, or the cap
 * height for frames that use it) centred in its one-em slot; the first column of a box sits that
 * half-ascent in from the box's right edge. The lines are composed in a rotated frame, then turned.
 */
function layoutVertical(t: TextData, reg: FaceRegistry, o: ComposeOptions): EngineLayout {
  const box = t.kind === 'paragraph' && t.box ? t.box : null;
  // Rotated frame: x runs down the column, y across the columns (leftwards).
  const L = layoutLines(t, reg, o, box ? { x: box.y, y: 0, w: box.h, h: box.w } : null, true);
  const mode = box ? t.firstBaseline ?? 'capHeight' : 'ascent';
  const first = box ? L.lines[0]?.baseline ?? 0 : 0;
  const right = box ? box.x + box.w : 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const ln of L.lines) {
    const col = right - ln.baseline + first / 2;
    for (const g of ln.glyphs) {
      const u = g.upright ?? { hAdv: 0, dx: 0, dy: 0 };
      const em = g.style.fontSize * g.style.verticalScale;
      const along = g.x;
      g.x = col - u.hAdv / 2 + u.dx;
      g.y = along + em / 2 + boxAscent(g.face, g.style.fontSize, g.style.verticalScale, mode) / 2 - u.dy;
      minX = Math.min(minX, col - em / 2); maxX = Math.max(maxX, col + em / 2);
      minY = Math.min(minY, along); maxY = Math.max(maxY, along + em);
    }
    ln.baseline = col;
  }
  const bounds = box ? { ...box } : minX <= maxX ? { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) } : L.bounds;
  return { ...L, bounds };
}

/**
 * Type on a path: the text as one line (paragraphs joined by a space), placed between the start
 * and end markers by its alignment; each glyph is centred on the path at the middle of its advance
 * and turned to the path's direction, its baseline on the path. Glyphs that do not fit between the
 * markers are hidden, as in Photoshop.
 */
function layoutOnPath(t: TextData, reg: FaceRegistry): EngineLayout {
  const tp = t.path!;
  const flat: TextData = { ...t, text: t.text.replace(/\n/g, ' '), kind: 'point', box: null, path: undefined, warp: undefined, orientation: 'horizontal' };
  flat.paragraphs = [{ length: flat.text.length, style: t.paragraphs[0]?.style ?? t.paragraphs[0]!.style }];
  const L = layoutLines(flat, reg, {}, null, false);
  const f = flattenTextPath(tp.subpath, tp.flip);
  const ln = L.lines[0];
  if (!f || !ln) return { ...L, lines: [] };
  const { a: s0, b: s1 } = spanOnFlat(tp, f);
  const align = lastAlign(t.paragraphs[0]?.style.align ?? 'left');
  // (The point layout already offsets centred / right-aligned text by its width.)
  const anchor = align === 'center' ? (s0 + s1) / 2 : align === 'right' ? s1 : s0;
  const placed: PlacedGlyph[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of ln.glyphs) {
    const adv = g.face.advance(g.gid) * g.sx + (g.style.tracking / 1000) * g.style.fontSize;
    const d = anchor + g.x;
    if (d < s0 - 0.5 || d + adv > s1 + 0.5) continue;
    const pt = pointAtDistance(f, d + adv / 2);
    if (!pt) continue;
    const c = Math.cos(pt.angle), s = Math.sin(pt.angle), off = g.y; // baseline shift (y is 0 on the baseline)
    const x = pt.x - (adv / 2) * c - off * s, y = pt.y - (adv / 2) * s + off * c;
    placed.push({ ...g, x, y, rot: pt.angle });
    const asc = g.style.fontSize, desc = g.style.fontSize * 0.3;
    for (const [u, v] of [[0, -asc], [adv, -asc], [adv, desc], [0, desc]]) {
      const px = x + u * c - v * s, py = y + u * s + v * c;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
  }
  const bounds = minX <= maxX ? { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) } : { x: 0, y: 0, w: 1, h: 1 };
  return { ...L, lines: [{ ...ln, glyphs: placed }], bounds };
}

/** How far a character hangs past the start or end margin under optical margins (text-space px). */
function hangOf(ch: string, adv: number, side: 'start' | 'end'): number {
  let k = 0;
  if (/["'“”‘’«»‹›„‚]/.test(ch)) k = 1;
  else if (/[.,‐\-–—:;·]/.test(ch)) k = side === 'end' ? 0.5 : 0.2;
  else if (/[(\[{]/.test(ch)) k = side === 'start' ? 0.3 : 0;
  else if (/[)\]}]/.test(ch)) k = side === 'end' ? 0.3 : 0;
  else if (/[AVWYTvwy]/.test(ch)) k = 0.08;
  else if (/[CGOQo]/.test(ch)) k = 0.04;
  return k * Math.max(0, adv);
}

/** Upright cells for vertical text: one em along the column (spaces keep their width). */
function toUpright(cells: Cell[]): void {
  let base: Upright = { hAdv: 0, dx: 0, dy: 0 };
  for (const c of cells) {
    const track = (c.style.tracking / 1000) * c.style.fontSize;
    if (c.adv - track > 1e-9 || c.space) {
      // (No kerning in vertical text: the glyph's own advance.)
      const own = c.face.advance(c.gid) * c.sx;
      base = { hAdv: own, dx: 0, dy: c.dy };
      c.upright = base;
      c.adv = c.space ? own + track : c.style.fontSize * c.style.verticalScale + track;
    } else {
      // A mark (no advance) stays on its base's slot, at its own offset.
      c.upright = { hAdv: base.hAdv, dx: c.dx, dy: c.dy };
      c.adv = 0;
    }
    c.dx = 0;
    c.dy = 0;
  }
}

/** Lines of horizontal text (or of vertical text in its rotated frame, `upright`). */
function layoutLines(t: TextData, reg: FaceRegistry, o: ComposeOptions, box: { x: number; y: number; w: number; h: number } | null, upright: boolean): EngineLayout {
  const styles = styleAtIndex(t);
  const paras = paraAtIndex(t);
  const state = { missing: false };
  const lines: EngineLine[] = [];
  let start = 0;
  let y = 0;
  let firstLine = true;
  let prevSpaceAfter = 0;
  let overflow = false;
  const leadingOf = (cs: Cell[], para: ParagraphStyle, fallback: CharacterStyle) => {
    const auto = para.autoLeading ?? PARAGRAPH_DEFAULTS.autoLeading;
    if (!cs.length) return fallback.leading ?? fallback.fontSize * auto;
    let m = 0;
    for (const c of cs) m = Math.max(m, c.style.leading ?? c.style.fontSize * auto);
    return m;
  };
  for (const ptext of t.text.split('\n')) {
    const para = paras[start] ?? paras[paras.length - 1];
    const cells = cellsFor(ptext, start, styles, reg, state);
    if (upright) toUpright(cells);
    const fallbackStyle = styles[start] ?? styles[styles.length - 1] ?? t.runs[0].style;
    const inner = box ? box.w - para.indentStart - para.indentEnd : Infinity;
    const ctx = { text: ptext, base: start, hyphenWidth: (c: Cell) => hyphenCell(c).adv };
    let groups: StoredGroup[] | null = null;
    const stored = !o.ignoreStoredBreaks && t.psBreaks?.length ? t.psBreaks.find((b) => b.key === paragraphKey(t, start, ptext, styles, para)) : undefined;
    if (stored && box) {
      // The composer for the rest after the last stored line (a sub-paragraph starting at cell k0).
      const rest = (k0: number) => {
        const sub = cells.slice(k0);
        const firstAvail = k0 === 0 ? inner - para.indentFirst : inner;
        return composeParagraph(sub, para, firstAvail, inner, ctx).map((g) => ({ cells: g.cells.map((k) => k + k0), hyphen: g.hyphen }));
      };
      groups = storedLines(cells, stored, start, ptext, para, rest);
    } else if (stored?.xs?.[0]) groups = [{ cells: cells.map((_, k) => k), hyphen: false, xs: stored.xs[0] }];
    groups ??= box ? composeParagraph(cells, para, inner - para.indentFirst, inner, ctx) : [{ cells: cells.map((_, k) => k), hyphen: false }];
    const lineStart = (gi: number) => (gi === 0 ? start : cells[groups![gi].cells[0]]?.index ?? start + ptext.length);
    for (let gi = 0; gi < groups.length && !overflow; gi++) {
      const cs = groups[gi].cells.map((k) => cells[k]);
      if (groups[gi].hyphen && cs.length) cs.push(hyphenCell(cs[cs.length - 1]));
      const last = gi === groups.length - 1;
      // Vertical position.
      if (firstLine) {
        if (box) {
          let a = 0;
          for (const c of cs) a = Math.max(a, boxAscent(c.face, c.style.fontSize, c.style.verticalScale, t.firstBaseline ?? 'capHeight'));
          if (!cs.length) {
            const src = reg.resolve({ postScriptName: fallbackStyle.postScriptName, family: fallbackStyle.fontFamily, weight: fallbackStyle.fontWeight, italic: fallbackStyle.italic });
            const f = src ? reg.face(src) : null;
            a = f ? boxAscent(f, fallbackStyle.fontSize, fallbackStyle.verticalScale, t.firstBaseline ?? 'capHeight') : fallbackStyle.fontSize * 0.72;
          }
          y = box.y + a;
        } else y = 0;
      } else {
        y += leadingOf(cs, para, fallbackStyle);
        if (gi === 0) y += prevSpaceAfter + para.spaceBefore;
      }
      // Photoshop keeps a line in the box when its baseline is inside it (the descent may overhang).
      if (box && !firstLine && y > box.y + box.h + 1e-6) { overflow = true; break; }
      firstLine = false;
      // Horizontal placement.
      let trail = cs.length;
      while (trail > 0 && cs[trail - 1].space) trail--;
      let natural = 0, spaces = 0;
      for (let k = 0; k < trail; k++) { natural += cs[k].adv; if (cs[k].space) spaces++; }
      // No tracking after the last visible character of a line (as in Photoshop).
      const endTrack = trail > 0 ? (cs[trail - 1].style.tracking / 1000) * cs[trail - 1].style.fontSize : 0;
      natural -= endTrack;
      // A stored Photoshop line span: the word spaces of a ragged line take up the difference
      // (the Every-line composer narrows or widens them to fit the line).
      let fit = 0;
      const span = groups[gi].span;
      // Stored glyph positions (one per character of the line, no ligatures).
      const real = groups[gi].hyphen ? cs.length - 1 : cs.length;
      const sx = groups[gi].xs && groups[gi].xs!.length === real && cs.slice(0, real).every((c, k) => k === 0 || c.index > cs[k - 1].index) ? groups[gi].xs! : null;
      if (sx && trail > 0) natural = sx[trail - 1] + cs[trail - 1].adv - endTrack;
      else if (span !== undefined && !(box && isJustified(para.align, last)) && trail > 1) {
        let ns = 0;
        for (let k = 0; k < trail - 1; k++) ns += cs[k].adv;
        if (spaces > 0 && Math.abs(span - ns) > 1e-4) fit = (span - ns) / spaces;
        natural += fit * spaces;
      }
      const indent = para.indentStart + (gi === 0 ? para.indentFirst : 0);
      // Photoshop's Thai overhang (compose.ts): a ragged line wider than the box is squeezed to fit.
      // Word spaces give up to 80 % of their width first; the rest is taken evenly from the gaps
      // between glyphs (measured: within 0.2 px on 274 squeezed Photoshop lines).
      // Justified Thai lines are fitted the same way when too long; a justified Thai line without
      // spaces is stretched evenly between its glyphs (with spaces, the spaces take the stretch).
      let squeeze = 0, spaceCut = 0;
      const thai = cs.some((c) => /[฀-๿]/.test(t.text[c.index] ?? ''));
      if (box && !sx && thai && trail > 1 && isJustified(para.align, last) && spaces === 0) {
        const room = box.w - para.indentEnd - indent;
        let slots = 0;
        for (let k = 0; k < trail; k++) if (cs[k].adv > 0) slots++;
        if (natural < room && slots > 1) { squeeze = -(room - natural) / (slots - 1); natural = room; }
      }
      if (box && !sx && trail > 1 && thai && !squeeze) {
        const room = box.w - para.indentEnd - indent;
        if (natural > room + 1e-6) {
          const R = natural - room;
          let spaceW = 0, slots = 0;
          for (let k = 0; k < trail; k++) { if (cs[k].space) spaceW += cs[k].adv; if (cs[k].adv > 0) slots++; }
          spaceCut = spaceW > 0 ? Math.min(R, spaceW * 0.8) / spaceW : 0;
          squeeze = slots > 1 ? (R - spaceCut * spaceW) / (slots - 1) : 0;
          natural = room;
        }
      }
      // Optical margins (Celenne): punctuation, and a little of letters such as T, V, W and Y, hang
      // past the margins so that the edges look straight.
      let hangL = 0, hangR = 0;
      if (box && para.opticalMargins && trail > 0 && !upright && !sx && !squeeze && !spaceCut) {
        hangL = hangOf(t.text[cs[0].index] ?? '', cs[0].adv, 'start');
        hangR = hangOf(t.text[cs[trail - 1].index] ?? '', cs[trail - 1].adv - endTrack, 'end');
      }
      let x0 = 0, extra = 0;
      if (box) {
        const room = box.w - para.indentEnd - indent + hangL + hangR;
        // (Stored positions already include Photoshop's justification.)
        if (isJustified(para.align, last) && spaces > 0 && !sx && !squeeze && !spaceCut) extra = (room - natural) / spaces;
        // Whole-paragraph composers may set a ragged line with its word spaces narrowed to fit.
        else if ((para.composer === 'every' || para.composer === 'celenne') && !sx && !squeeze && !spaceCut && span === undefined && spaces > 0 && natural > room + 1e-6) extra = (room - natural) / spaces;
        else { const a = lastAlign(para.align); x0 = a === 'center' ? (room - natural) / 2 : a === 'right' ? room - natural : 0; }
        x0 += box.x + indent - hangL;
      } else {
        const a = lastAlign(para.align);
        x0 = a === 'center' ? -natural / 2 : a === 'right' ? -natural : 0;
      }
      let x = x0;
      const placed: PlacedGlyph[] = [];
      let asc = 0, desc = 0;
      for (let k = 0; k < cs.length; k++) {
        const c = cs[k];
        placed.push({ face: c.face, gid: c.gid, x: x + c.dx, y: y - c.style.baselineShift - c.dy, sx: c.sx, sy: c.sy, style: c.style, index: c.index, ...(c.upright ? { upright: c.upright } : {}) });
        x += c.adv + (c.space && k < trail ? extra + fit : 0) - (k === trail - 1 ? endTrack : 0);
        if (squeeze || spaceCut) {
          if (c.space && k < trail) x -= c.adv * spaceCut;
          if (k + 1 < trail && cs[k + 1].adv > 0) x -= squeeze;
        }
        if (sx && k + 1 < sx.length) x = x0 + sx[k + 1];
        asc = Math.max(asc, c.face.metrics.ascender * c.sy);
        desc = Math.max(desc, -c.face.metrics.descender * c.sy);
      }
      lines.push({ glyphs: placed, baseline: y, start: lineStart(gi), end: gi + 1 < groups.length ? lineStart(gi + 1) : start + ptext.length, x0, x1: x0 + natural + extra * spaces, ascent: asc, descent: desc, para });
    }
    prevSpaceAfter = para.spaceAfter;
    start += ptext.length + 1;
  }
  let bounds: EngineLayout['bounds'];
  if (box) bounds = { ...box };
  else {
    const minX = Math.min(...lines.map((l) => l.x0)), maxX = Math.max(...lines.map((l) => l.x1));
    const top = (lines[0]?.baseline ?? 0) - (lines[0]?.ascent ?? 0), bottom = (lines[lines.length - 1]?.baseline ?? 0) + (lines[lines.length - 1]?.descent ?? 0);
    bounds = { x: minX, y: top, w: Math.max(1, maxX - minX), h: Math.max(1, bottom - top) };
  }
  return { lines, bounds, missing: state.missing, overflow };
}
