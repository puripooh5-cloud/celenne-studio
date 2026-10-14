/**
 * Updates Photoshop's Txt2 block for text layers edited in Celenne, so a PSD that came from
 * Photoshop keeps Photoshop's own text frames (and their settings, such as where the first line of
 * a paragraph sits) when it goes back to Photoshop.
 *
 * Photoshop trusts Txt2 over the layer's EngineData: a stale object would show the old text, so
 * dropping the block was the only safe choice before. Each edited object now gets the new text and
 * runs: every run starts from the Photoshop run at the same place (keeping settings Celenne does
 * not model) and takes the settings Celenne does model; the finished layout is emptied so
 * Photoshop lays the text out again. Verified with Photoshop 2025: such files open without a
 * prompt, show the edited text, and keep the frame's first-baseline setting.
 *
 * Key meanings (scripts/photoshop/cases-text.jsx, one setting changed at a time):
 *  character run settings (run /0 /0 /6): 0 font index, 1 size, 2 faux bold, 3 faux italic,
 *    4 auto leading, 5 leading, 6 / 7 horizontal / vertical scale, 8 tracking, 9 baseline shift,
 *    11 kerning (0 manual, 1 metrics, 2 optical), 12 caps (1 small, 2 all), 13 super / subscript,
 *    15 underline, 16 strikethrough, 18 ligatures, 53 fill (SimplePaint [a r g b]);
 *  paragraph run settings (run /0 /0 /5): 0 alignment, 1 first indent, 2 start indent, 3 end
 *    indent, 4 space before, 5 space after, 7 auto leading, 9 hyphenate, 10–15 hyphenation,
 *    17 / 18 / 19 word / letter / glyph spacing, 29 every-line composer.
 */
import type { CharacterStyle, ParagraphStyle, StyleRun, TextData } from '../typography/types';
import { PARAGRAPH_DEFAULTS, runsPerParagraph } from '../typography/types';
import { readTxt2Lossless, writeTxt2Lossless, tget, tset, type TNode } from './txt2Write';
import { paramAtDistance } from '../typography/pathText';
import { postScriptNameFor } from './mapping';

export interface Txt2Edit {
  /** The layer's TextIndex (its object in Txt2). */
  index: number;
  text: TextData;
  /** Only colours changed: Photoshop's finished layout still describes the text and is kept. */
  sameLayout?: boolean;
  /** Photoshop's font type (0 PostScript / CFF, 1 TrueType) for fonts not yet in the block. */
  fontType?: (postScriptName: string) => number | undefined;
}

const int = (v: number): TNode => ({ k: 'int', v: Math.round(v) });
const real = (v: number): TNode => ({ k: 'real', v });
const bool = (v: boolean): TNode => ({ k: 'bool', v });
const clone = (n: TNode): TNode => JSON.parse(JSON.stringify(n));

const JUSTIFY: Record<ParagraphStyle['align'], number> = { left: 0, right: 1, center: 2, justifyLeft: 3, justifyRight: 4, justifyCenter: 5, justifyAll: 6 };

/** The run (item) of `runs` covering character `pos`, or the last one. */
function runAt(runs: TNode[], pos: number): TNode | undefined {
  let at = 0;
  for (const r of runs) {
    const len = tget(r, '1');
    const n = len?.k === 'int' || len?.k === 'real' ? len.v : 0;
    if (pos < at + n) return r;
    at += n;
  }
  return runs[runs.length - 1];
}

function fontIndex(root: TNode, name: string, type: number | undefined): number {
  const list = tget(root, '0', '1', '0');
  if (list?.k !== 'arr') return -1;
  const i = list.v.findIndex((f) => { const n = tget(f, '0', '0', '0'); return n?.k === 'str' && n.v === name; });
  if (i >= 0) return i;
  list.v.push({ k: 'dict', v: [['0', { k: 'dict', v: [['99', { k: 'name', v: 'CoolTypeFont' }], ['0', { k: 'dict', v: [['0', { k: 'str', v: name }], ['2', int(type ?? 1)]] }]] }]] });
  return list.v.length - 1;
}

function styleSettings(root: TNode, base: TNode, s: CharacterStyle, para: ParagraphStyle | undefined, fontType: Txt2Edit['fontType']): TNode {
  const run = clone(base);
  const st = tget(run, '0', '0', '6');
  if (!st || st.k !== 'dict') return run;
  const name = postScriptNameFor(s);
  const fi = fontIndex(root, name, s.fontType ?? fontType?.(name));
  if (fi >= 0) tset(st, '0', int(fi));
  tset(st, '1', real(s.fontSize));
  tset(st, '2', bool(s.fauxBold));
  tset(st, '3', bool(s.fauxItalic));
  tset(st, '4', bool(s.leading === null));
  tset(st, '5', real(s.leading ?? s.fontSize * (para?.autoLeading ?? PARAGRAPH_DEFAULTS.autoLeading)));
  tset(st, '6', real(s.horizontalScale));
  tset(st, '7', real(s.verticalScale));
  tset(st, '8', int(s.tracking));
  tset(st, '9', real(s.baselineShift));
  tset(st, '11', int(s.kerning === 'none' ? 0 : s.kerning === 'optical' ? 2 : 1));
  tset(st, '12', int(s.textCase === 'allCaps' ? 2 : s.textCase === 'smallCaps' ? 1 : 0));
  tset(st, '13', int(s.baseline === 'superscript' ? 1 : s.baseline === 'subscript' ? 2 : 0));
  tset(st, '15', int(s.underline ? 1 : 0));
  tset(st, '16', int(s.strikethrough ? 1 : 0));
  tset(st, '18', bool(s.ligatures));
  const paint = tget(st, '53', '0', '1');
  if (paint?.k === 'arr') paint.v = [1, s.color.r, s.color.g, s.color.b].map(real);
  return run;
}

function paraSettings(base: TNode, p: ParagraphStyle): TNode {
  const run = clone(base);
  const st = tget(run, '0', '0', '5');
  if (!st || st.k !== 'dict') return run;
  const d = PARAGRAPH_DEFAULTS;
  tset(st, '0', int(JUSTIFY[p.align] ?? 0));
  tset(st, '1', real(p.indentFirst));
  tset(st, '2', real(p.indentStart));
  tset(st, '3', real(p.indentEnd));
  tset(st, '4', real(p.spaceBefore));
  tset(st, '5', real(p.spaceAfter));
  tset(st, '7', real(p.autoLeading ?? d.autoLeading));
  tset(st, '9', bool(p.hyphenate));
  // (Hyphenation details 10–15 stay as Photoshop wrote them: Celenne does not edit them.)
  for (const [k, v] of [['17', p.wordSpacing ?? d.wordSpacing], ['18', p.letterSpacing ?? d.letterSpacing], ['19', p.glyphScaling ?? d.glyphScaling]] as const)
    tset(st, k, { k: 'arr', v: v.map(real) });
  tset(st, '29', bool((p.composer ?? d.composer) === 'every'));
  return run;
}

/** Runs of a TextData field as Txt2 items (lengths include Photoshop's closing "\r"). */
function rebuildRuns<T>(baseRuns: TNode[], runs: StyleRun<T>[], total: number, make: (base: TNode, style: T) => TNode): TNode[] {
  const out: TNode[] = [];
  let pos = 0;
  // (Empty text still has one run, over Photoshop's closing "\r".)
  const live = runs.filter((r) => r.length > 0);
  if (!live.length && runs.length) live.push({ length: total, style: runs[0].style });
  live.forEach((r, i) => {
    const len = i === live.length - 1 ? total - pos : r.length;
    const base = runAt(baseRuns, pos);
    if (!base) return;
    const item = make(base, r.style);
    tset(item, '1', int(len));
    out.push(item);
    pos += r.length;
  });
  return out;
}

// Run items as Photoshop writes them for text it builds from a layer (every setting at its default;
// the "/6" of a paragraph item and "/5" of a style item name the document's default style sheet).
const DEFAULT_PARA_ITEM = ' /X << /0 << /0 << /0 () /5 << /0 0 /1 0.0 /2 0.0 /3 0.0 /4 0.0 /5 0.0 /7 1.2 /8 0 /9 false /10 6 /11 2 /12 2 /13 8 /14 36.0 /17 [ .8 1.0 1.33 ] /18 [ 0.0 0.0 0.0 ] /19 [ 1.0 1.0 1.0 ] /21 false /23 true /24 0 /25 0 /27 /nil /28 /nil /29 false /33 0 /35 1 /36 /nil /37 0 /40 2 >> /6 0 >> >> /1 1 >>';
const DEFAULT_STYLE_ITEM = ' /X << /0 << /0 << /0 () /5 0 /6 << /0 0 /1 12.0 /2 false /3 false /4 true /5 14.4 /6 1.0 /7 1.0 /8 0 /9 0.0 /11 1 /12 0 /13 0 /14 0 /15 0 /16 0 /18 true /19 false /20 false /23 false /24 false /25 false /26 false /27 false /28 false /29 false /30 0 /31 false /32 false /33 false /35 1 /36 0.0 /37 2 /38 0 /39 0 /52 false /53 << /99 /SimplePaint /0 << /0 1 /1 [ 1.0 0.0 0.0 0.0 ] >> >> /54 << /99 /SimplePaint /0 << /0 1 /1 [ 1.0 0.0 0.0 0.0 ] >> >> /68 0 /70 0 /72 0.0 /73 0.0 /75 false /85 0 /87 100.0 /88 false /92 0.0 >> >> >> /1 1 >>';
const parseItem = (src: string): TNode => readTxt2Lossless(Uint8Array.from(src, (c) => c.charCodeAt(0)))[0][1];

/** Text that cannot be written exactly (its Txt2 keys are not known): nothing is written for it. */
const unsupported = (t: TextData) => t.runs.some((r) => r.style.openTypeFeatures.length || Object.keys(r.style.variationAxes ?? {}).length);

/**
 * A text frame as Photoshop builds one for a layer (frame keys: ag-psd's engineData2 names and
 * Photoshop's own files): /0 /1 /0 the frame's path as Bezier segments (anchor, two control points,
 * anchor), /0 /2 its settings: /0 type (absent = point, 1 = box, 2 = path), /1 orientation
 * (2 = vertical), /6 text range along a path (-1 / -2 for point / box frames), /10 where the first
 * line of a box sits (/0 2 = cap height: Celenne's default; Photoshop's own new text omits it),
 * /11 path data (/0 = text flipped to the other side of the path; written by Photoshop for point and
 * box frames as -1 / -2 placeholders, for a path only when flipped).
 */
function newFrame(t: TextData): TNode {
  // (Number types as Photoshop writes them: it does not lay out a box whose numbers are integers.)
  const unset = (v: number): TNode => ({ k: 'dict', v: [['4', int(v)], ['18', real(v)]] });
  const orient: [string, TNode][] = t.orientation === 'vertical' ? [['1', int(2)]] : [];
  const frame = (path: number[] | null, settings: [string, TNode][]): TNode => ({ k: 'dict', v: [['0', { k: 'dict', v: [...(path ? [['1', { k: 'dict', v: [['0', { k: 'arr', v: path.map(real) }]] }] as [string, TNode]] : []), ['2', { k: 'dict', v: settings }]] }]] });
  if (t.path) {
    const sp = t.path.subpath, k = sp.knots;
    const n = sp.closed ? k.length : k.length - 1;
    const pts: number[] = [];
    for (let i = 0; i < n; i++) { const a = k[i], b = k[(i + 1) % k.length]; pts.push(a.x, a.y, a.outX, a.outY, b.inX, b.inY, b.x, b.y); }
    const from = paramAtDistance(sp, t.path.start), to = t.path.end !== undefined ? paramAtDistance(sp, t.path.end) : n;
    // (Photoshop writes the path data only for flipped text, and then only the flip.)
    const flip: [string, TNode][] = t.path.flip ? [['11', { k: 'dict', v: [['0', bool(true)]] }]] : [];
    return frame(pts, [['0', int(2)], ...orient, ['6', { k: 'arr', v: [real(from), real(to)] }], ...flip]);
  }
  if (t.kind !== 'paragraph' || !t.box) return frame(null, [...orient, ['6', { k: 'arr', v: [real(-1), real(-1)] }], ['11', unset(-1)]]);
  const { x, y, w, h } = t.box;
  const c = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const path = c.flatMap((p, i) => { const q = c[(i + 1) % 4]; return [...p, ...p, ...q, ...q]; });
  const settings: [string, TNode][] = [['0', int(1)], ...orient, ['6', { k: 'arr', v: [real(-2), real(-2)] }]];
  if (t.firstBaseline !== 'ascent') settings.push(['10', { k: 'dict', v: [['0', int(2)], ['1', real(0)]] }]);
  settings.push(['11', unset(-2)]);
  return frame(path, settings);
}

/**
 * The frame of an edited layer: rebuilt from Celenne's text (its box, path or orientation may have
 * changed), keeping the settings Celenne does not model as Photoshop wrote them.
 */
function updatedFrame(old: TNode, t: TextData): TNode {
  const fresh = newFrame(t);
  const oldIn = tget(old, '0'), freshIn = tget(fresh, '0');
  const oldSet = tget(oldIn, '2'), freshSet = tget(freshIn, '2');
  if (oldIn?.k !== 'dict' || freshIn?.k !== 'dict' || freshSet?.k !== 'dict') return fresh;
  // Frame settings Celenne writes; Photoshop's own first-line setting is kept (Celenne reads it).
  const modeled = new Set(['0', '1', '6', '11']);
  if (oldSet?.k === 'dict') for (const [key, v] of oldSet.v) if (!modeled.has(key) && !freshSet.v.some(([k2]) => k2 === key)) freshSet.v.push([key, clone(v)]);
  if (oldSet?.k === 'dict' && t.firstBaseline === 'ascent') freshSet.v = freshSet.v.filter(([key]) => key !== '10');
  for (const [key, v] of oldIn.v) if (key !== '1' && key !== '2') freshIn.v.push([key, clone(v)]);
  return fresh;
}

/** The number of text objects in a Txt2 block (0 when it cannot be read). */
export function txt2ObjectCount(bytes: Uint8Array): number {
  try {
    const objs = tget({ k: 'dict', v: readTxt2Lossless(bytes) }, '1', '1');
    return objs?.k === 'arr' ? objs.v.length : 0;
  } catch { return 0; }
}

/** Writes `t` into a text object (its model and per-paragraph view entries). */
function writeObject(root: TNode, obj: TNode | undefined, t: TextData, fontType: Txt2Edit['fontType'], nextId: () => number): boolean {
  const model = tget(obj, '0');
  const view = tget(obj, '1');
  const styleRuns = tget(model, '6', '0'), paraRuns = tget(model, '5', '0');
  // view /1 /0: one entry per paragraph, << /0 << /1 id >> /1 length >>.
  const paras = tget(view, '1', '0');
  if (!model || !view || styleRuns?.k !== 'arr' || paraRuns?.k !== 'arr' || paras?.k !== 'arr' || !paras.v.length || !styleRuns.v.length || !paraRuns.v.length) return false;
  const text = t.text.replace(/\n/g, '\r') + '\r';
  const total = text.length;
  const para0 = t.paragraphs[0]?.style;
  styleRuns.v = rebuildRuns(styleRuns.v, t.runs, total, (b, s) => styleSettings(root, b, s, para0, fontType));
  paraRuns.v = rebuildRuns(paraRuns.v, runsPerParagraph(t), total, (b, p) => paraSettings(b, p));
  if (!styleRuns.v.length || !paraRuns.v.length) return false;
  tset(model, '0', { k: 'str', v: text });
  // Paragraph entries: Photoshop's in order; added paragraphs get new ids after the document's largest.
  // Each paragraph's length includes its closing "\r" (the last one Photoshop's final "\r").
  const lens = t.text.split('\n').map((p) => p.length + 1);
  paras.v = lens.map((len, i) => {
    const e = clone(paras.v[Math.min(i, paras.v.length - 1)]);
    if (i >= paras.v.length) { const id = tget(e, '0'); if (id) tset(id, '1', int(nextId())); }
    tset(e, '1', int(len));
    return e;
  });
  return true;
}

/**
 * Applies the edits to a Txt2 block and adds objects for `added` (text layers whose TextIndex is
 * after the block's objects, in that order). Returns the new block, or null when some text cannot
 * be written exactly (the caller then drops Txt2 and Photoshop rebuilds it from the layers' EngineData).
 */
export function patchTxt2(original: Uint8Array, edits: Txt2Edit[], added: { text: TextData; fontType?: Txt2Edit['fontType'] }[] = []): Uint8Array | null {
  let block;
  try { block = readTxt2Lossless(original); } catch { return null; }
  const root: TNode = { k: 'dict', v: block };
  const objects = tget(root, '1', '1'), frames = tget(root, '0', '8', '0');
  if (objects?.k !== 'arr' || frames?.k !== 'arr') return null;
  // Paragraph ids are unique in the document.
  let maxId = 0;
  for (const o of objects.v) {
    const ps = tget(o, '1', '1', '0');
    if (ps?.k === 'arr') for (const e of ps.v) { const id = tget(e, '0', '1'); if (id?.k === 'int') maxId = Math.max(maxId, id.v); }
  }
  const nextId = () => ++maxId;
  for (const e of edits) {
    // Features Celenne models but whose Txt2 keys are not known: write nothing rather than guess.
    if (unsupported(e.text)) return null;
    const obj = objects.v[e.index];
    if (!writeObject(root, obj, e.text, e.fontType, nextId)) return null;
    // Its frame follows the text's box, path and orientation.
    const fi = tget(obj, '1', '0', 0, '0');
    if (!e.sameLayout && fi?.k === 'int' && frames.v[fi.v]) frames.v[fi.v] = updatedFrame(frames.v[fi.v], e.text);
    // Photoshop lays the text out again (its finished layout described the old text).
    if (!e.sameLayout) tset(tget(obj, '1')!, '2', { k: 'arr', v: [] });
  }
  // New objects: Photoshop's default runs (naming this document's default style sheets, as its
  // first object does), a frame of their own, and no finished layout.
  const sheet = (key: string, at: string) => tget(objects.v[0], '0', key, '0', 0, '0', '0', at);
  for (const a of added) {
    if (unsupported(a.text)) return null;
    const para = parseItem(DEFAULT_PARA_ITEM), style = parseItem(DEFAULT_STYLE_ITEM);
    const ps = sheet('5', '6'), ss = sheet('6', '5');
    if (ps?.k === 'int') tset(tget(para, '0', '0')!, '6', ps);
    if (ss?.k === 'int') tset(tget(style, '0', '0')!, '5', ss);
    frames.v.push(newFrame(a.text));
    const entry: TNode = { k: 'dict', v: [['0', { k: 'dict', v: [['1', int(nextId())]] }], ['1', int(1)]] };
    const obj: TNode = { k: 'dict', v: [
      ['0', { k: 'dict', v: [['0', { k: 'str', v: '\r' }], ['5', { k: 'dict', v: [['0', { k: 'arr', v: [para] }]] }], ['6', { k: 'dict', v: [['0', { k: 'arr', v: [style] }]] }]] }],
      ['1', { k: 'dict', v: [['0', { k: 'arr', v: [{ k: 'dict', v: [['0', int(frames.v.length - 1)]] }] }], ['1', { k: 'dict', v: [['0', { k: 'arr', v: [entry] }]] }], ['2', { k: 'arr', v: [] }]] }],
    ] };
    if (!writeObject(root, obj, a.text, a.fontType, nextId)) return null;
    objects.v.push(obj);
  }
  return writeTxt2Lossless(block);
}
