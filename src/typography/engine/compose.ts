/**
 * Line breaking for paragraph text, following the behaviour measured from Photoshop
 * (scripts/photoshop/compare-text-lines.ts against the text corpus):
 *
 * Adobe Single-line composer, one line at a time:
 *  - justified text fits as many words as possible with word spaces compressed to the minimum
 *    word spacing; when the line would then need more than the maximum spacing, the next word is
 *    hyphenated (when allowed) at the last point that still fits; otherwise the line stretches;
 *  - ragged text fits words at the desired spacing, and hyphenates the next word only when the
 *    gap left at the end of the line is wider than the hyphenation zone.
 * A word longer than the whole line is split between characters.
 *
 * Thai (measured on 1,400 Photoshop line decisions, Tahoma and Leelawadee UI): a ragged line may
 * run past the box by the advance of its last glyph when it ends with a spacing Thai character
 * (not a vowel or tone mark above / below, not a space); the layout then squeezes it to fit
 * (layout.ts). A justified Thai line takes one more segment when the squeeze that needs (after
 * the overhang) is at most 4.75 % of the longer line and less than 3 × the gap the shorter line
 * would leave: this weighs squeezing against stretching as Photoshop does and reproduces 95 % of
 * its decisions in 1,449 measured cases (Tahoma, Leelawadee UI, Cordia New; 18–44 px).
 */
import type { ParagraphStyle } from '../types';
import { PARAGRAPH_DEFAULTS } from '../types';
import type { Cell } from './layout';
import { hyphenPoints } from './hyphenate';

export interface ComposedLine {
  /** Cell indices on the line (including trailing spaces). */
  cells: number[];
  /** A hyphen glyph is added at the end of the line. */
  hyphen: boolean;
}

export interface ComposeContext {
  /** Paragraph text and the text index of its first character (cells carry text indices). */
  text: string;
  base: number;
  /** Width of a hyphen in the style of `cell`. */
  hyphenWidth(cell: Cell): number;
}

interface Segment { start: number; end: number; textEnd: number }

const THAI = /[฀-๿]/;

/** How far a ragged line ending with segment `sg` may run past the box (Photoshop's Thai rule). */
function thaiOverhang(cells: Cell[], sg: Segment, ctx: ComposeContext): number {
  if (sg.end !== sg.textEnd || sg.textEnd < sg.start) return 0; // ends with a space
  const next = cells[sg.end + 1]?.index ?? ctx.base + ctx.text.length;
  const ch = ctx.text[next - 1 - ctx.base] ?? '';
  return THAI.test(ch) && !/\p{M}/u.test(ch) ? cells[sg.textEnd].adv : 0;
}

/** Segments end at break opportunities and include their trailing spaces: [start, end] cell ranges. */
function segments(cells: Cell[]): Segment[] {
  const out: Segment[] = [];
  let s = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].breakAfter || i === cells.length - 1) {
      let te = i;
      while (te >= s && cells[te].space) te--;
      out.push({ start: s, end: i, textEnd: te });
      s = i + 1;
    }
  }
  return out;
}

/**
 * Whole-paragraph line breaking (a Knuth–Plass style total fit): every way of breaking the
 * paragraph is weighed at once and the one with the least total cost wins. A line costs
 * (line + badness)² plus hyphen costs, where the badness grows with how far its word spaces must
 * stretch or shrink (q = change per unit of space width), or, for ragged lines, with the room left
 * at the end.
 */
export interface TotalFit {
  /** Cost of every line (fewer lines when large). */
  line: number;
  hyphen: number;
  consecutiveHyphens: number;
  stretch: number; stretchExp: number;
  /** Extra weight on stretching past the maximum word spacing (per unit of q beyond it). */
  overMax: number;
  shrink: number; shrinkExp: number;
  /** Lowest q allowed (spaces shrunk to 1 + q of their width); null = the paragraph's minimum word spacing. */
  minQ: number | null;
  /** Ragged lines: cost of the room left at the end (relative to the width), and of shrinking spaces. */
  rag: number; ragExp: number;
  ragShrink: number;
  /** A last line holding one short word (less than this share of the width). */
  runt: number; runtShare: number;
}

/**
 * Photoshop's Every-line composer, approximated: costs fitted to 246 paragraphs Photoshop laid out
 * (scripts/photoshop/cases-text.jsx probe-every-*: Arial, Times New Roman, Georgia; ragged and
 * justified, with and without hyphenation, 41 widths each). It reproduces Photoshop's breaks for
 * 44 % of the paragraphs and 70 % of the line starts (Single-line rules: 23 % / 60 %). Photoshop
 * shrinks word spaces well below the minimum word spacing (to about half) and also in ragged text.
 */
export const EVERY_LINE: TotalFit = { line: 300, hyphen: 100, consecutiveHyphens: 3000, stretch: 30, stretchExp: 1.5, overMax: 0, shrink: 300, shrinkExp: 2, minQ: -0.5, rag: 1000, ragExp: 2, ragShrink: 1000, runt: 0, runtShare: 0 };

/**
 * Celenne's composer: word spaces stay within the paragraph's spacing limits (Photoshop's
 * Every-line composer squeezes them to about half), even spacing weighs most, a lone short word on
 * the last line and hyphens on consecutive lines are avoided. On the 246 probe paragraphs, against
 * Photoshop's Every-line breaks: 1 short last line instead of 23, no hyphen stacks instead of 4,
 * justified spacing more even (spread of the word-space change 0.31 instead of 0.41), no line
 * squeezed past the minimum (Photoshop: 88) and fewer stretched past the maximum (384 / 410); the
 * ragged edge is as even (3.46 % / 3.43 % of the width), with 3 % more lines.
 */
export const CELENNE_COMPOSER: TotalFit = { line: 3000, hyphen: 60, consecutiveHyphens: 1e9, stretch: 100, stretchExp: 3, overMax: 4, shrink: 100, shrinkExp: 3, minQ: null, rag: 300, ragExp: 2, ragShrink: 1000, runt: 1e8, runtShare: 0.25 };

/** Lines by total fit, or null when it does not apply (a word wider than the line, a very long paragraph). */
export function composeTotalFit(cells: Cell[], para: ParagraphStyle, availFirst: number, avail: number, ctx: ComposeContext, p: TotalFit): ComposedLine[] | null {
  const d = PARAGRAPH_DEFAULTS;
  const ws = para.wordSpacing ?? d.wordSpacing;
  const justified = para.align.startsWith('justify');
  const hy = para.hyphenation ?? d.hyphenation;
  const segs = segments(cells);
  if (!segs.length) return null;
  const pre = new Float64Array(cells.length + 1), preSpace = new Float64Array(cells.length + 1);
  for (let k = 0; k < cells.length; k++) { pre[k + 1] = pre[k] + cells[k].adv; preSpace[k + 1] = preSpace[k] + (cells[k].space ? cells[k].adv : 0); }
  // A word wider than the line: the single-line rules split it between characters.
  for (const sg of segs) if (pre[sg.textEnd + 1] - pre[sg.start] > Math.min(availFirst, avail) + 1e-6) return null;
  // Break candidates: the last cell of a line, and whether a hyphen is added there.
  const cand: { cell: number; hyphen: boolean }[] = [];
  segs.forEach((sg, k) => {
    if (para.hyphenate) {
      const t0 = cells[sg.start].index - ctx.base, t1 = cells[sg.textEnd].index - ctx.base + 1;
      const m = /^([^\p{L}]*)(\p{L}+)([^\p{L}]*)$/u.exec(ctx.text.slice(t0, t1));
      if (m && m[2].length >= hy.minWord && (hy.capitalized || !/^\p{Lu}/u.test(m[2]))) {
        for (const pt of hyphenPoints(m[2])) {
          if (pt < hy.afterFirst || m[2].length - pt < hy.beforeLast) continue;
          const textIdx = ctx.base + t0 + m[1].length + pt;
          let c = sg.start;
          while (c <= sg.textEnd && cells[c].index < textIdx) c++;
          if (c > sg.start && c <= sg.textEnd && cells[c].index === textIdx) cand.push({ cell: c - 1, hyphen: true });
        }
      }
    }
    if (k < segs.length - 1) cand.push({ cell: sg.end, hyphen: false });
  });
  cand.push({ cell: cells.length - 1, hyphen: false });
  if (cand.length > 4000) return null;
  const minQ = p.minQ ?? ws[0] / ws[1] - 1, maxQ = ws[2] / ws[1] - 1;
  const n = cand.length;
  const best = new Float64Array(n + 1).fill(Infinity), prev = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  const startCell = (node: number) => (node === 0 ? 0 : cand[node - 1].cell + 1);
  for (let j = 0; j < n; j++) {
    const c = cand[j], last = j === n - 1;
    for (let i = j; i >= 0; i--) {
      if (best[i] === Infinity) continue;
      const a = startCell(i);
      if (a > c.cell) continue;
      const W = i === 0 ? availFirst : avail;
      let e = c.cell;
      while (e >= a && cells[e].space) e--;
      const nat = pre[e + 1] - pre[a] + (c.hyphen ? ctx.hyphenWidth(cells[c.cell]) : 0);
      const spaceW = preSpace[e + 1] - preSpace[a];
      const slack = W - nat;
      const q = spaceW > 0 ? slack / spaceW : slack >= -1e-6 ? 0 : -Infinity;
      // Longer lines (earlier starts) only get tighter.
      if (q < minQ - 1e-9) break;
      let bad: number;
      if (justified && !last) bad = q >= 0 ? p.stretch * Math.pow(Math.min(q, 10), p.stretchExp) * (q > maxQ ? 1 + p.overMax * (q - maxQ) : 1) : p.shrink * Math.pow(-q, p.shrinkExp);
      else if (q < 0) { if (!Number.isFinite(p.ragShrink)) break; bad = p.ragShrink * Math.pow(-q, p.shrinkExp); }
      else bad = last ? 0 : p.rag * Math.pow(slack / W, p.ragExp);
      let dem = (p.line + bad) * (p.line + bad) + (c.hyphen ? p.hyphen * p.hyphen : 0);
      if (c.hyphen && i > 0 && cand[i - 1].hyphen) dem += p.consecutiveHyphens;
      // A last line with one short word (and an earlier line to take it).
      if (last && i > 0 && p.runt && spaceW === 0 && nat < p.runtShare * W) dem += p.runt;
      const tot = best[i] + dem;
      if (tot < best[j + 1]) { best[j + 1] = tot; prev[j + 1] = i; }
    }
  }
  if (!Number.isFinite(best[n])) return null;
  const nodes: number[] = [];
  for (let node = n; node > 0; node = prev[node]) nodes.push(node);
  nodes.reverse();
  // Consecutive-hyphen limit as a hard rule too (Photoshop's "hyphen limit").
  let run = 0;
  for (const node of nodes) { run = cand[node - 1].hyphen ? run + 1 : 0; if (run > hy.limit) return null; }
  return nodes.map((node) => {
    const a = startCell(prev[node]), c = cand[node - 1];
    const line: number[] = [];
    for (let k = a; k <= c.cell; k++) line.push(k);
    return { cells: line, hyphen: c.hyphen };
  });
}

export function composeParagraph(cells: Cell[], para: ParagraphStyle, availFirst: number, avail: number, ctx: ComposeContext): ComposedLine[] {
  // Whole-paragraph composers (Thai keeps the measured single-line rules under Every-line).
  if (para.composer === 'celenne' || (para.composer === 'every' && !THAI.test(ctx.text))) {
    const tf = composeTotalFit(cells, para, availFirst, avail, ctx, para.composer === 'celenne' ? CELENNE_COMPOSER : EVERY_LINE);
    if (tf) return tf;
  }
  const d = PARAGRAPH_DEFAULTS;
  const ws = para.wordSpacing ?? d.wordSpacing;
  const justified = para.align.startsWith('justify');
  const minK = ws[0] / ws[1], maxK = ws[2] / ws[1];
  const hy = para.hyphenation ?? d.hyphenation;
  const segs = segments(cells);
  const lines: ComposedLine[] = [];
  let consecutive = 0;

  // Widths of a candidate line made of segments [a, b) plus `tail` cells of segment b (hyphenated).
  const measure = (a: number, b: number, tailEnd = -1) => {
    let text = 0, space = 0;
    for (let k = a; k < b; k++) {
      const sg = segs[k];
      for (let c = sg.start; c <= sg.textEnd; c++) text += cells[c].adv;
      const last = k === b - 1 && tailEnd < 0;
      if (!last) for (let c = sg.textEnd + 1; c <= sg.end; c++) space += cells[c].adv;
    }
    if (tailEnd >= 0) for (let c = segs[b].start; c <= tailEnd; c++) text += cells[c].adv;
    return { text, space };
  };

  /** Hyphenation candidates for segment k: last cell index before each allowed point, longest first. */
  const hyphenCuts = (k: number): number[] => {
    if (!para.hyphenate || consecutive >= hy.limit) return [];
    const sg = segs[k];
    const t0 = cells[sg.start].index - ctx.base, t1 = cells[sg.textEnd].index - ctx.base + 1;
    const raw = ctx.text.slice(t0, t1);
    const m = /^([^\p{L}]*)(\p{L}+)([^\p{L}]*)$/u.exec(raw);
    if (!m) return [];
    const word = m[2];
    if (word.length < hy.minWord || (!hy.capitalized && /^\p{Lu}/u.test(word))) return [];
    const lead = m[1].length;
    const cuts: number[] = [];
    for (const p of hyphenPoints(word)) {
      if (p < hy.afterFirst || word.length - p < hy.beforeLast) continue;
      const textIdx = ctx.base + t0 + lead + p; // first character after the hyphen
      let c = sg.start;
      while (c <= sg.textEnd && cells[c].index < textIdx) c++;
      if (c > sg.start && c <= sg.textEnd && cells[c].index === textIdx) cuts.push(c - 1);
    }
    return cuts.reverse();
  };

  let k = 0;
  let resume = -1; // a hyphenated word continues on the next line from this cell
  while (k < segs.length) {
    const width = lines.length ? avail : availFirst;
    const startCell = resume >= 0 ? resume : segs[k].start;
    const firstSeg = k;
    // The first (possibly partial) segment's text width.
    const partialText = () => { let w = 0; for (let c = startCell; c <= segs[firstSeg].textEnd; c++) w += cells[c].adv; return w; };
    const lineMeasure = (b: number, tailEnd = -1) => {
      const m = measure(firstSeg, b, tailEnd);
      if (resume >= 0) { let full = 0; for (let c = segs[firstSeg].start; c <= segs[firstSeg].textEnd; c++) full += cells[c].adv; m.text += partialText() - full; }
      return m;
    };
    const spacingK = justified ? minK : 1;
    // Take segments while they fit.
    let b = firstSeg + 1;
    const hasThai = (a: number, z: number) => { for (let c = segs[a].start; c <= segs[z].end; c++) if (THAI.test(ctx.text[cells[c].index - ctx.base] ?? '')) return true; return false; };
    while (b < segs.length) {
      const m = lineMeasure(b + 1);
      const over = thaiOverhang(cells, segs[b], ctx);
      const fitsLatin = m.text + m.space * spacingK - (justified ? 0 : over) <= width + 1e-6;
      let fitsThai = false;
      if (!fitsLatin && justified && hasThai(firstSeg, b)) {
        const long = m.text + m.space, sq = long - over - width;
        const cur = lineMeasure(b), gap = width - (cur.text + cur.space);
        fitsThai = sq <= 0.0475 * long && sq < 3 * gap;
      }
      if (!fitsLatin && !fitsThai) break;
      b++;
    }
    let hyphenAt = -1;
    if (b < segs.length) {
      const m = lineMeasure(b);
      const fits = (tailEnd: number, kSpace: number) => { const t = lineMeasure(b, tailEnd); return t.text + ctx.hyphenWidth(cells[tailEnd]) + t.space * kSpace <= width + 1e-6; };
      if (justified) {
        const ratio = m.space > 0 ? (width - m.text) / m.space : Infinity;
        if (ratio > maxK) for (const cut of hyphenCuts(b)) if (fits(cut, minK)) { hyphenAt = cut; break; }
      } else {
        const gap = width - (m.text + m.space);
        if (gap > hy.zone) for (const cut of hyphenCuts(b)) if (fits(cut, 1)) { hyphenAt = cut; break; }
      }
    }
    // A single segment wider than the line: split between characters.
    if (b === firstSeg + 1 && hyphenAt < 0) {
      const m = lineMeasure(b);
      if (m.text > width + 1e-6 && segs[firstSeg].textEnd > startCell) {
        let w = 0, c = startCell;
        for (; c <= segs[firstSeg].textEnd; c++) { if (w + cells[c].adv > width + 1e-6 && c > startCell) break; w += cells[c].adv; }
        if (c <= segs[firstSeg].textEnd) {
          const line: number[] = [];
          for (let i = startCell; i < c; i++) line.push(i);
          lines.push({ cells: line, hyphen: false });
          resume = c;
          consecutive = 0;
          continue;
        }
      }
    }
    const line: number[] = [];
    const endCell = hyphenAt >= 0 ? hyphenAt : segs[b - 1].end;
    for (let i = startCell; i <= endCell; i++) line.push(i);
    lines.push({ cells: line, hyphen: hyphenAt >= 0 });
    if (hyphenAt >= 0) { k = b; resume = hyphenAt + 1; consecutive++; }
    else { k = b; resume = -1; consecutive = 0; }
  }
  if (!lines.length) lines.push({ cells: [], hyphen: false });
  return lines;
}
