/** Editable text model. Kept independent from any rendering backend. */
import type { RGBA } from '../color/types';
import type { Affine } from '../image-engine/matrix';

export type TextAlign = 'left' | 'center' | 'right' | 'justifyLeft' | 'justifyCenter' | 'justifyRight' | 'justifyAll';
export type AntiAliasMode = 'none' | 'sharp' | 'crisp' | 'strong' | 'smooth';
export type TextCase = 'none' | 'allCaps' | 'smallCaps';
export type BaselinePosition = 'normal' | 'superscript' | 'subscript';

export interface CharacterStyle {
  fontFamily: string;
  /** PostScript name when known (PSD stores fonts by PostScript name). */
  postScriptName?: string;
  /** Photoshop's font record: type (0 = PostScript / CFF, 1 = TrueType) and script, kept for the round trip. */
  fontType?: number;
  fontScript?: number;
  fontStyleName: string;
  fontWeight: number;
  italic: boolean;
  /** Font size in text-space units (pixels before the layer transform). */
  fontSize: number;
  /** Leading in text-space pixels; null = auto (120%). */
  leading: number | null;
  /** Tracking in 1/1000 em. */
  tracking: number;
  kerning: 'metrics' | 'optical' | 'none';
  baselineShift: number;
  horizontalScale: number;
  verticalScale: number;
  color: RGBA;
  fauxBold: boolean;
  fauxItalic: boolean;
  underline: boolean;
  strikethrough: boolean;
  textCase: TextCase;
  baseline: BaselinePosition;
  ligatures: boolean;
  /** OpenType feature tags, e.g. ["liga", "ss01"]. */
  openTypeFeatures: string[];
  /** Variable font axes, e.g. { wght: 650 }. */
  variationAxes: Record<string, number>;
}

export interface ParagraphStyle {
  align: TextAlign;
  indentFirst: number;
  indentStart: number;
  indentEnd: number;
  spaceBefore: number;
  spaceAfter: number;
  hyphenate: boolean;
  /**
   * Line breaking: Photoshop's Adobe Single-line (default) or Every-line composer, or Celenne's own
   * ('celenne': plans the whole paragraph for even spacing and a balanced rag, avoids a lone short
   * word on the last line and stacks of hyphens). Photoshop lays 'celenne' paragraphs out with its
   * Single-line composer.
   */
  composer?: 'single' | 'every' | 'celenne';
  /** Optical margins (Celenne): punctuation and the overhang of letters such as T, V, W, Y hang past the margins. */
  opticalMargins?: boolean;
  /** Justification limits as fractions [minimum, desired, maximum] (Photoshop: 80/100/133 %, 0/0/0 %, 100/100/100 %). */
  wordSpacing?: [number, number, number];
  letterSpacing?: [number, number, number];
  glyphScaling?: [number, number, number];
  /** Auto leading as a fraction of the font size (Photoshop default 1.2). */
  autoLeading?: number;
  /** Hyphenation rules (Photoshop defaults: words of 6+ letters, 2 before / 2 after, 8 in a row, 36 pt zone). */
  hyphenation?: { minWord: number; afterFirst: number; beforeLast: number; limit: number; zone: number; capitalized: boolean };
  /** Roman hanging punctuation. */
  hanging?: boolean;
}

export const PARAGRAPH_DEFAULTS = {
  composer: 'single' as const,
  wordSpacing: [0.8, 1, 1.33] as [number, number, number],
  letterSpacing: [0, 0, 0] as [number, number, number],
  glyphScaling: [1, 1, 1] as [number, number, number],
  autoLeading: 1.2,
  hyphenation: { minWord: 6, afterFirst: 2, beforeLast: 2, limit: 8, zone: 36, capitalized: true },
  hanging: false,
};

export interface StyleRun<T> {
  length: number;
  style: T;
}

export interface TextData {
  /** Paragraphs separated by "\n". */
  text: string;
  runs: StyleRun<CharacterStyle>[];
  paragraphs: StyleRun<ParagraphStyle>[];
  kind: 'point' | 'paragraph';
  /** Paragraph text box in text space. */
  box: { x: number; y: number; w: number; h: number } | null;
  orientation: 'horizontal' | 'vertical';
  /** Text space → document transform. */
  transform: Affine;
  antiAlias: AntiAliasMode;
  /**
   * Warp Text settings, in Photoshop's own representation (style, bend `value`, horizontal
   * `perspective`, vertical `perspectiveOther`, orientation `rotate`). Unknown fields read from a
   * PSD are kept for the round trip.
   */
  warp?: TextWarp;
  /** Type on a path (horizontal glyphs follow the path; the warp is ignored). */
  path?: import('./pathText').TextPath;
  /**
   * Where the first line of paragraph text sits: at the font's ascent (the height of its "d"), as
   * in text Photoshop created, or at its cap height, which is what Photoshop uses for text layers
   * saved without its Txt2 layout data (Celenne's own text). Unset = cap height.
   */
  firstBaseline?: 'ascent' | 'capHeight';
  /**
   * Line breaks Photoshop chose for paragraphs of an opened PSD (from its Txt2 layout data), per
   * paragraph fingerprint (text, character and paragraph styles except colour, box width). A
   * paragraph whose fingerprint still matches keeps Photoshop's breaks exactly; an edited one is
   * re-flowed by Celenne's composer. `spans` (per line, when known) is the distance from the first
   * to the last visible glyph: Photoshop's Every-line composer narrows word spaces to fit lines.
   */
  psBreaks?: { key: number; starts: number[]; spans?: (number | null)[]; whole?: boolean; hyphens?: number[]; xs?: (number[] | null)[] }[];
}

export interface TextWarp {
  style?: string;
  /** Bend, −100..100. */
  value?: number;
  /** Horizontal distortion, −100..100. */
  perspective?: number;
  /** Vertical distortion, −100..100. */
  perspectiveOther?: number;
  rotate?: 'horizontal' | 'vertical';
  [key: string]: unknown;
}

/**
 * Paragraph runs split at every paragraph break (one run per paragraph, its line break included),
 * as Photoshop stores them: a run that spans a break makes Photoshop treat the break as an
 * ordinary character. Runs with the same style may be merged in Celenne's own model.
 */
export function runsPerParagraph(t: Pick<TextData, 'text' | 'paragraphs'>): StyleRun<ParagraphStyle>[] {
  const out: StyleRun<ParagraphStyle>[] = [];
  const styleAt = (i: number) => {
    let at = 0;
    for (const p of t.paragraphs) { if (i < at + p.length) return p.style; at += p.length; }
    return t.paragraphs[t.paragraphs.length - 1]?.style ?? defaultParagraphStyle();
  };
  let start = 0;
  const lines = t.text.split('\n');
  lines.forEach((ln, i) => {
    out.push({ length: ln.length + (i < lines.length - 1 ? 1 : 0), style: styleAt(start) });
    start += ln.length + 1;
  });
  return out;
}

export function defaultCharacterStyle(): CharacterStyle {
  return {
    fontFamily: 'Arial',
    fontStyleName: 'Regular',
    fontWeight: 400,
    italic: false,
    fontSize: 48,
    leading: null,
    tracking: 0,
    kerning: 'metrics',
    baselineShift: 0,
    horizontalScale: 1,
    verticalScale: 1,
    color: { r: 0, g: 0, b: 0, a: 1 },
    fauxBold: false,
    fauxItalic: false,
    underline: false,
    strikethrough: false,
    textCase: 'none',
    baseline: 'normal',
    ligatures: true,
    openTypeFeatures: [],
    variationAxes: {},
  };
}

export function defaultParagraphStyle(): ParagraphStyle {
  return { align: 'left', indentFirst: 0, indentStart: 0, indentEnd: 0, spaceBefore: 0, spaceAfter: 0, hyphenate: false };
}
