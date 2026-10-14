/**
 * Photoshop's document-level text data ('Txt2' global layer info, Photoshop CS6 and later).
 *
 * Same syntax as the per-layer EngineData (dictionaries, arrays, names, numbers, strings) but with
 * numeric keys. Unlike EngineData it holds the authoritative character settings Photoshop uses
 * (for example the kerning mode: manual / metrics / optical) and Photoshop's finished layout:
 * lines with their glyph ids and glyph x positions. Key meanings were worked out by comparing
 * files Photoshop saved with one setting changed at a time (scripts/photoshop/cases-text.jsx).
 */
export type T2 = number | boolean | string | null | T2[] | { [k: string]: T2 };
export type T2Dict = { [k: string]: T2 };

/** Parses Txt2 / EngineData syntax. Strings are decoded from UTF-16BE (with BOM) or Latin-1. */
export function parseTxt2(bytes: Uint8Array): T2 {
  let p = 0;
  const n = bytes.length;
  const ws = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 0;
  const delim = (c: number) => ws(c) || c === 0x2f || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x28;
  const skip = () => { while (p < n && ws(bytes[p])) p++; };
  const word = () => { const s = p; while (p < n && !delim(bytes[p])) p++; return String.fromCharCode(...bytes.subarray(s, p)); };
  const str = (): string => {
    p++; // (
    const out: number[] = [];
    while (p < n && bytes[p] !== 0x29) {
      let c = bytes[p++];
      if (c === 0x5c && p < n) { c = bytes[p++]; if (c === 0x6e) c = 10; else if (c === 0x72) c = 13; else if (c === 0x74) c = 9; }
      out.push(c);
    }
    p++; // )
    if (out[0] === 0xfe && out[1] === 0xff) {
      let s = '';
      for (let i = 2; i + 1 < out.length; i += 2) s += String.fromCharCode((out[i] << 8) | out[i + 1]);
      return s;
    }
    return String.fromCharCode(...out);
  };
  const value = (): T2 => {
    skip();
    const c = bytes[p];
    if (c === 0x3c && bytes[p + 1] === 0x3c) {
      p += 2;
      const d: T2Dict = {};
      for (;;) {
        skip();
        if (p >= n) return d;
        if (bytes[p] === 0x3e && bytes[p + 1] === 0x3e) { p += 2; return d; }
        if (bytes[p] !== 0x2f) { p++; continue; }
        p++;
        const key = word();
        d[key] = value();
      }
    }
    if (c === 0x5b) {
      p++;
      const a: T2[] = [];
      for (;;) {
        skip();
        if (p >= n) return a;
        if (bytes[p] === 0x5d) { p++; return a; }
        a.push(value());
      }
    }
    if (c === 0x28) return str();
    if (c === 0x2f) { p++; return word(); }
    const w = word();
    if (!w) { p++; return null; }
    if (w === 'true') return true;
    if (w === 'false') return false;
    const num = Number(w);
    return Number.isNaN(num) ? w : num;
  };
  // The block is a sequence of top-level key / value pairs (no surrounding << >>).
  const root: T2Dict = {};
  while (p < n) {
    skip();
    if (bytes[p] === 0x2f) { p++; const k = word(); root[k] = value(); }
    else if (p < n) { const v = value(); if (v !== null && !('' in root)) root[''] = v; }
  }
  return root;
}

const dict = (v: T2 | undefined): T2Dict | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
const arr = (v: T2 | undefined): T2[] => (Array.isArray(v) ? v : []);
const num = (v: T2 | undefined): number | undefined => (typeof v === 'number' ? v : undefined);

/** Character style keys in Txt2 style sheets (only the ones Celenne uses). */
export const T2_STYLE = { fontIndex: '0', size: '1', fauxBold: '2', fauxItalic: '3', autoLeading: '4', leading: '5', hScale: '6', vScale: '7', tracking: '8', baselineShift: '9', kerning: '11', caps: '12' } as const;

export interface Txt2GlyphRun {
  /** Glyph ids and their x positions (relative to the run's pen start x0). */
  glyphs: number[];
  x: number[];
  /** Pen start of the run along the line (point text: relative to the origin; boxes: to the box). */
  x0: number;
}

export interface Txt2Line {
  /** Index in the text of the line's first character. */
  start: number;
  /** Line origin (x) and baseline (y), text space (paragraph text: relative to the box top-left). */
  x: number;
  baseline: number;
  ascent: number;
  descent: number;
  runs: Txt2GlyphRun[];
}

export interface Txt2Text {
  /** Character style runs: run lengths and their style sheet overrides (raw numeric keys). */
  styleRuns: { length: number; style: T2Dict }[];
  /** Paragraph runs with their paragraph settings (raw numeric keys). */
  paragraphRuns: { length: number; style: T2Dict }[];
  /** Photoshop's laid-out lines (in reading order), when the file has them. */
  lines: Txt2Line[];
  /**
   * The first-baseline setting of the object's text frame: Photoshop's own frames have none (the
   * first line sits at the font's ascent, the height of its "d"); frames Photoshop builds for text
   * layers that came without Txt2 data carry /10 << /0 2 >> and place it at the cap height.
   */
  firstBaseline: 'ascent' | 'capHeight';
}

/** The text objects of a Txt2 block, in TextIndex order (the TySh 'TextIndex' of each layer). */
export function txt2Texts(root: T2): Txt2Text[] {
  // root /1 /1 = the text objects; each is { /0 model, /1 view (layout tree) }.
  const objects = arr(dict(dict(root)?.['1'])?.['1']);
  // root /0 /8 /0 = the text frames; an object's view /1 /0 [ << /0 frame index >> ].
  const frames = arr(dict(dict(dict(root)?.['0'])?.['8'])?.['0']);
  return objects.map((o) => {
    const d = dict(o);
    const model = dict(d?.['0']);
    // model /0 text, /5 paragraph runs, /6 character runs: << /0 [ << /0 << /0 << /5|/6 {settings} >> >> /1 length >> … ] >>.
    const runs = (key: '5' | '6') => arr(dict(model?.[key])?.['0']).map((item) => {
      const it = dict(item);
      return { length: num(it?.['1']) ?? 0, style: dict(dict(dict(it?.['0'])?.['0'])?.[key]) ?? {} };
    });
    const styleRuns = runs('6');
    const paragraphRuns = runs('5');
    const lines: Txt2Line[] = [];
    collect(d, (_k, v) => {
      const L = dict(v);
      if (L?.['99'] !== 'L') return;
      const origin = arr(dict(L['0'])?.['0']);
      const line: Txt2Line = { start: -1, x: num(origin[0]) ?? 0, baseline: num(L['10']) ?? num(origin[1]) ?? 0, ascent: num(L['14']) ?? 0, descent: num(L['15']) ?? 0, runs: [] };
      collect(L, (_k2, g) => {
        const G = dict(g);
        if (G?.['99'] === 'S' && line.start < 0) line.start = num(G['20']) ?? 0;
        if (G?.['99'] !== 'G') return;
        line.runs.push({ glyphs: arr(G['5']).map((x) => (typeof x === 'number' ? x : 0)), x: arr(G['15']).map((x) => (typeof x === 'number' ? x : 0)), x0: num(arr(G['8'])[0]) ?? 0 });
      });
      if (line.start < 0) line.start = 0;
      lines.push(line);
    });
    const frameIndex = num(dict(arr(dict(d?.['1'])?.['0'])[0])?.['0']);
    const frame = dict(dict(dict(frames[frameIndex ?? -1])?.['0'])?.['2']);
    const firstBaseline = num(dict(frame?.['10'])?.['0']) === 2 ? 'capHeight' : 'ascent';
    return { styleRuns, paragraphRuns, lines, firstBaseline };
  });
}

/** Depth-first walk over every dictionary value (stops descending into L dictionaries handled by the caller). */
function collect(v: T2 | undefined, fn: (key: string, v: T2) => void) {
  if (!v || typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const x of v) { fn('', x); collect(x, fn); } return; }
  for (const [k, x] of Object.entries(v)) {
    fn(k, x);
    if (dict(x)?.['99'] === 'L') continue;
    collect(x, fn);
  }
}

/**
 * Applies the character settings that Photoshop keeps only in Txt2 to an imported text model.
 * Today that is the kerning mode: EngineData always says "auto kerning" (metrics), while Txt2
 * stores 0 = manual, 1 = metrics, 2 = optical.
 */
export function applyTxt2Styles(t: import('../typography/types').TextData, x: Txt2Text): void {
  const kern: (string | undefined)[] = [];
  for (const r of x.styleRuns) {
    const v = r.style[T2_STYLE.kerning];
    const k = v === 0 ? 'none' : v === 1 ? 'metrics' : v === 2 ? 'optical' : undefined;
    for (let i = 0; i < r.length; i++) kern.push(k);
  }
  if (!kern.some((k) => k && k !== 'metrics')) return;
  const out: typeof t.runs = [];
  let pos = 0;
  for (const run of t.runs) {
    for (let i = 0; i < run.length; ) {
      const k = (kern[pos + i] ?? run.style.kerning) as typeof run.style.kerning;
      let j = i + 1;
      while (j < run.length && (kern[pos + j] ?? run.style.kerning) === k) j++;
      const style = k === run.style.kerning ? run.style : { ...run.style, kerning: k };
      const last = out[out.length - 1];
      if (last && last.style === style) last.length += j - i;
      else out.push({ length: j - i, style });
      i = j;
    }
    pos += run.length;
  }
  t.runs = out;
}
