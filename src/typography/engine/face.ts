/**
 * Font faces for Celenne's own text engine: HarfBuzz (WebAssembly) shapes text with the font's
 * real kerning, ligatures and complex-script rules, and supplies the glyph outlines that the
 * engine rasterizes itself. Units are font units (y up) unless stated otherwise.
 */
import { KernTable } from './kernTable';

type HB = typeof import('harfbuzzjs');

let hb: HB | null = null;
let loading: Promise<HB | null> | null = null;

/** Loads HarfBuzz once. Resolves to null when WebAssembly is unavailable. */
export function initShaper(): Promise<HB | null> {
  if (hb) return Promise.resolve(hb);
  loading ??= import('harfbuzzjs').then((m) => (hb = m)).catch((e) => { console.warn('[text] HarfBuzz unavailable:', e); return null; });
  return loading;
}

export const shaperReady = () => hb !== null;

export interface ShapedGlyph {
  gid: number;
  /** Index of the first UTF-16 code unit of the cluster in the shaped string. */
  cluster: number;
  /** Advance and offsets in font units. */
  ax: number;
  ay: number;
  dx: number;
  dy: number;
}

export interface ShapeOptions {
  /** OpenType features, e.g. { kern: 0, liga: 0, smcp: 1 }. */
  features?: Record<string, number>;
  direction?: 'ltr' | 'rtl' | 'ttb';
  /** ISO 15924 script tag ("Latn", "Thai") and BCP 47 language ("en", "th"); guessed when absent. */
  script?: string;
  language?: string;
}

/** Outline commands in font units: M x y, L x y, Q cx cy x y, C c1x c1y c2x c2y x y, Z. */
export type OutlineCmd = ['M', number, number] | ['L', number, number] | ['Q', number, number, number, number] | ['C', number, number, number, number, number, number] | ['Z'];

export interface FaceMetrics {
  upem: number;
  /** hhea ascender / descender (descender negative) / line gap. */
  ascender: number;
  descender: number;
  lineGap: number;
  /** OS/2 typographic values when present, else hhea. */
  typoAscender: number;
  typoDescender: number;
  capHeight: number;
  xHeight: number;
  /** Windows clipping ascent / descent (OS/2 usWinAscent / usWinDescent, descent positive). */
  winAscent: number;
  winDescent: number;
  /** post underlinePosition (negative: below the baseline) and underlineThickness. */
  underlinePosition: number;
  underlineThickness: number;
  /** OS/2 yStrikeoutPosition (above the baseline) and yStrikeoutSize. */
  strikeoutPosition: number;
  strikeoutSize: number;
}

export class FontFace {
  readonly metrics: FaceMetrics;
  readonly postScriptName: string;
  readonly family: string;
  readonly subfamily: string;
  /** TrueType outlines ('glyf'), as opposed to CFF; Photoshop records it as the font's type. */
  readonly trueType: boolean;
  private face: InstanceType<HB['Face']>;
  private font: InstanceType<HB['Font']>;
  private outlines = new Map<number, OutlineCmd[]>();
  private draw: InstanceType<HB['DrawFuncs']>;
  private sink: OutlineCmd[] = [];
  private cmap = new Map<number, number>();
  private kernMode: 'gpos' | 'table' | 'none' | null = null;
  private kernTable: KernTable | null = null;

  constructor(readonly bytes: ArrayBuffer, readonly index = 0) {
    if (!hb) throw new Error('HarfBuzz is not initialized');
    this.face = new hb.Face(new hb.Blob(bytes), index);
    this.font = new hb.Font(this.face);
    const upem = this.face.upem;
    const ext = this.font.hExtents();
    const m = (tag: Parameters<InstanceType<HB['Font']>['getMetricPosition']>[0], fb: number) => this.font.getMetricPosition(tag) ?? fb;
    const T = hb.MetricsTag;
    const os2 = this.face.referenceTable('OS/2');
    let typoA = ext.ascender, typoD = ext.descender, winA = ext.ascender, winD = -ext.descender;
    let strikeP = upem * 0.26, strikeS = upem * 0.05, underP = -upem * 0.1, underT = upem * 0.05;
    if (os2 && os2.length >= 78) {
      const v = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
      typoA = v.getInt16(68); typoD = v.getInt16(70); winA = v.getUint16(74); winD = v.getUint16(76);
      if (v.getInt16(26) > 0) { strikeS = v.getInt16(26); strikeP = v.getInt16(28); }
    }
    const post = this.face.referenceTable('post');
    if (post && post.length >= 12) {
      const v = new DataView(post.buffer, post.byteOffset, post.byteLength);
      if (v.getInt16(10) > 0) { underP = v.getInt16(8); underT = v.getInt16(10); }
    }
    this.metrics = {
      upem, ascender: ext.ascender, descender: ext.descender, lineGap: ext.lineGap,
      typoAscender: typoA, typoDescender: typoD, winAscent: winA, winDescent: winD,
      capHeight: m(T.CAP_HEIGHT, upem * 0.7), xHeight: m(T.X_HEIGHT, upem * 0.5),
      underlinePosition: underP, underlineThickness: underT, strikeoutPosition: strikeP, strikeoutSize: strikeS,
    };
    this.postScriptName = this.face.getName(6, 'en') || '';
    this.family = this.face.getName(16, 'en') || this.face.getName(1, 'en') || '';
    this.subfamily = this.face.getName(17, 'en') || this.face.getName(2, 'en') || '';
    this.trueType = !!this.face.referenceTable('glyf')?.length;
    this.draw = new hb.DrawFuncs();
    this.draw.setMoveToFunc((x, y) => { this.sink.push(['M', x, y]); });
    this.draw.setLineToFunc((x, y) => { this.sink.push(['L', x, y]); });
    this.draw.setQuadraticToFunc((cx, cy, x, y) => { this.sink.push(['Q', cx, cy, x, y]); });
    this.draw.setCubicToFunc((c1x, c1y, c2x, c2y, x, y) => { this.sink.push(['C', c1x, c1y, c2x, c2y, x, y]); });
    this.draw.setClosePathFunc(() => { this.sink.push(['Z']); });
  }

  /** Glyph id for a code point (0 = missing). */
  glyphFor(codePoint: number): number {
    let g = this.cmap.get(codePoint);
    if (g === undefined) { g = this.font.glyph(codePoint) ?? 0; this.cmap.set(codePoint, g); }
    return g;
  }

  hasGlyph(codePoint: number): boolean { return this.glyphFor(codePoint) !== 0; }

  shape(text: string, o: ShapeOptions = {}): ShapedGlyph[] {
    const lib = hb!;
    const buf = new lib.Buffer();
    try {
      buf.addText(text);
      if (o.direction) buf.setDirection(o.direction === 'rtl' ? lib.Direction.RTL : o.direction === 'ttb' ? lib.Direction.TTB : lib.Direction.LTR);
      if (o.script) buf.setScript(o.script);
      if (o.language) buf.setLanguage(o.language);
      buf.guessSegmentProperties();
      const feats = Object.entries(o.features ?? {}).map(([tag, v]) => new lib.Feature(tag, v));
      lib.shape(this.font, buf, feats.length ? feats : undefined);
      return buf.getGlyphInfosAndPositions().map((g) => ({ gid: g.codepoint, cluster: g.cluster, ax: g.xAdvance ?? 0, ay: g.yAdvance ?? 0, dx: g.xOffset ?? 0, dy: g.yOffset ?? 0 }));
    } finally {
      (buf as unknown as { destroy?: () => void }).destroy?.();
    }
  }

  advance(gid: number): number { return this.font.glyphHAdvance(gid); }

  /**
   * How Photoshop's metrics kerning applies to this font: GPOS pair positioning when the font's
   * GPOS kerns Latin pairs, otherwise the TrueType 'kern' table (see kernTable.ts), else none.
   */
  kerningSource(): 'gpos' | 'table' | 'none' {
    if (this.kernMode) return this.kernMode;
    const probe = 'AVATAR WAVE To Ty Yo Vo P. LT AY F, r.';
    const a = this.shape(probe), b = this.shape(probe, { features: { kern: 0 } });
    const gposKerns = a.length === b.length && a.some((g, i) => g.ax !== b[i].ax || g.dx !== b[i].dx);
    this.kernTable = KernTable.parse(this.face.referenceTable('kern'));
    this.kernMode = gposKerns ? 'gpos' : this.kernTable ? 'table' : 'none';
    return this.kernMode;
  }

  /** 'kern' table value between two glyphs (font units). */
  tableKern(left: number, right: number): number { this.kerningSource(); return this.kernTable?.get(left, right) ?? 0; }

  outline(gid: number): OutlineCmd[] {
    let o = this.outlines.get(gid);
    if (!o) {
      this.sink = [];
      this.font.drawGlyph(gid, this.draw);
      o = this.sink;
      this.outlines.set(gid, o);
    }
    return o;
  }

  /** Ink bounds of a glyph in font units (null for empty glyphs). */
  extents(gid: number): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
    const e = this.font.glyphExtents(gid);
    if (!e || (!e.width && !e.height)) return null;
    return { xMin: e.xBearing, xMax: e.xBearing + e.width, yMax: e.yBearing, yMin: e.yBearing + e.height };
  }

  setVariations(axes: Record<string, number>) {
    const lib = hb!;
    const v = Object.entries(axes).map(([tag, value]) => new lib.Variation(tag, value));
    this.font.setVariations(v);
    this.outlines.clear();
  }
}

/** Number of faces in a font file (TrueType collections hold several). */
export function faceCount(bytes: ArrayBuffer): number {
  const v = new DataView(bytes);
  if (bytes.byteLength >= 12 && v.getUint32(0) === 0x74746366) return v.getUint32(8); // 'ttcf'
  return 1;
}
