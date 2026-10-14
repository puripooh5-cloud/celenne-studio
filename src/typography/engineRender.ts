/**
 * Draws text with Celenne's own engine: HarfBuzz-shaped glyphs placed by the engine's layout (which
 * follows Photoshop's composer, and keeps Photoshop's own line breaks for unchanged paragraphs of
 * opened files), filled from the font outlines by the coverage rasterizer. Horizontal point and
 * paragraph text, also warped; vertical text and text on a path still use the browser's renderer.
 */
import type { TextData, CharacterStyle, AntiAliasMode } from './types';
import type { FaceRegistry } from './engine/registry';
import { layoutEngine, type EngineLayout, type PlacedGlyph } from './engine/layout';
import { drawGlyph } from './engine/raster';
import { CoverageRaster } from '../vector/coverage';
import { apply, type Affine, multiply } from '../image-engine/matrix';
import { roundOut, type Rect } from '../image-engine/rect';

export interface EngineRendered {
  /** Straight RGBA8 pixels. */
  data: Uint8ClampedArray;
  /** Document-space rectangle of the pixels. */
  rect: Rect;
  layout: EngineLayout;
}

/** Whether the engine draws this text (otherwise the browser's text renderer does). */
export function engineHandles(_t: TextData): boolean {
  return true;
}

/**
 * Underline / strikethrough rectangles under a glyph (text space), from the font's own metrics as
 * Photoshop places them (measured on Arial): both as thick as the font's underlineThickness, the
 * strikeout centred on yStrikeoutPosition, the underline's top one thickness below the font's
 * underlinePosition.
 */
function decorations(g: PlacedGlyph): { x: number; y: number; w: number; h: number }[] {
  const s = g.style;
  // (Not drawn for upright vertical glyphs or glyphs turned along a path yet.)
  if ((!s.underline && !s.strikethrough) || g.upright || g.rot) return [];
  const m = g.face.metrics;
  const w = g.face.advance(g.gid) * g.sx + (s.tracking / 1000) * s.fontSize;
  const out = [];
  if (s.underline) {
    const t = m.underlineThickness * g.sy;
    out.push({ x: g.x, y: g.y - m.underlinePosition * g.sy + t, w, h: t });
  }
  if (s.strikethrough) {
    // Photoshop draws the strikeout as thick as the underline (not the font's yStrikeoutSize).
    const t = m.underlineThickness * g.sy;
    out.push({ x: g.x, y: g.y - m.strikeoutPosition * g.sy - t / 2, w, h: t });
  }
  return out;
}

/** Text-space ink bounds of the layout (glyph boxes and decorations). */
export function inkBounds(L: EngineLayout): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ln of L.lines)
    for (const g of ln.glyphs) {
      const e = g.face.extents(g.gid);
      if (e && e.xMax > e.xMin) {
        const shear = g.style.fauxItalic ? 0.18 * g.style.fontSize : 0;
        const bold = g.style.fauxBold ? g.style.fontSize * 0.03 : 0;
        const lx0 = e.xMin * g.sx - bold - (e.yMin < 0 ? shear : 0), lx1 = e.xMax * g.sx + bold + shear;
        const ly0 = -e.yMax * g.sy - bold, ly1 = -e.yMin * g.sy + bold;
        if (g.rot) {
          // A glyph turned along a path: the corners of its turned box.
          const c = Math.cos(g.rot), s = Math.sin(g.rot);
          for (const [u, v] of [[lx0, ly0], [lx1, ly0], [lx1, ly1], [lx0, ly1]]) {
            const X = g.x + u * c - v * s, Y = g.y + u * s + v * c;
            x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
          }
        } else {
          x0 = Math.min(x0, g.x + lx0); x1 = Math.max(x1, g.x + lx1);
          y0 = Math.min(y0, g.y + ly0); y1 = Math.max(y1, g.y + ly1);
        }
      }
      for (const d of decorations(g)) { x0 = Math.min(x0, d.x); x1 = Math.max(x1, d.x + d.w); y0 = Math.min(y0, d.y); y1 = Math.max(y1, d.y + d.h); }
    }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * Photoshop's anti-aliasing modes, measured on the corpus (text-aa-*: Tahoma 14 and 40 px, each
 * mode's pixels against the exact coverage of Photoshop's own outlines of the same text):
 *  - None: aliased (a pixel is ink when at least half covered; no other threshold matches better);
 *  - Strong: heavier: this tone curve from coverage to alpha (fitted per 1/16 of coverage),
 *    which brings Celenne from 0.80 / 0.91 to 0.93 / 0.97 IoU with Photoshop's pixels;
 *  - Smooth, Crisp, Sharp: plain coverage. What remains between them is hinting (Photoshop snaps
 *    stems of small text to the pixel grid), which Celenne does not do; a tone curve does not help.
 */
const STRONG = [0, 0.207, 0.28, 0.334, 0.425, 0.505, 0.536, 0.596, 0.676, 0.751, 0.8, 0.825, 0.897, 0.983, 0.992, 0.999, 1];
export function antiAliasAlpha(mode: AntiAliasMode, c: number): number {
  if (mode === 'none') return c >= 0.5 ? 1 : 0;
  if (mode !== 'strong' || c <= 0) return c;
  const x = Math.min(1, c) * 16, i = Math.min(15, Math.floor(x)), f = x - i;
  return STRONG[i] * (1 - f) + STRONG[i + 1] * f;
}

const colorKey = (s: CharacterStyle) => `${s.color.r},${s.color.g},${s.color.b},${s.color.a}`;

/**
 * Fills the layout into a w × h RGBA8 image; `view` maps text space to image pixels. Glyphs are
 * filled per colour (one coverage pass each, in text order of first appearance).
 */
export function drawEngineLayout(L: EngineLayout, view: Affine, w: number, h: number, mode: AntiAliasMode = 'smooth'): Uint8ClampedArray {
  const groups = new Map<string, { style: CharacterStyle; glyphs: PlacedGlyph[] }>();
  for (const ln of L.lines)
    for (const g of ln.glyphs) {
      const k = colorKey(g.style);
      let grp = groups.get(k);
      if (!grp) groups.set(k, (grp = { style: g.style, glyphs: [] }));
      grp.glyphs.push(g);
    }
  const acc = new Float32Array(w * h * 4); // premultiplied
  for (const { style, glyphs } of groups.values()) {
    const r = new CoverageRaster(0, 0, w, h);
    for (const g of glyphs) {
      if (g.style.fauxBold) {
        // Faux bold: the outline thickened by stamping it around a small circle (union).
        const d = g.style.fontSize * 0.02;
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4;
          drawGlyph(r, { ...g, x: g.x + Math.cos(a) * d, y: g.y + Math.sin(a) * d }, view);
        }
      } else drawGlyph(r, g, view);
      for (const d of decorations(g)) {
        // Unrotated text: the line's top edge sits on a whole pixel (as in Photoshop).
        const upright = Math.abs(view[1]) < 1e-9 && Math.abs(view[2]) < 1e-9 && view[3] > 0;
        const top = upright ? (Math.round(view[3] * d.y + view[5]) - view[5]) / view[3] : d.y;
        const p = [apply(view, d.x, top), apply(view, d.x + d.w, top), apply(view, d.x + d.w, top + d.h), apply(view, d.x, top + d.h)];
        r.moveTo(p[0].x, p[0].y);
        for (let i = 1; i < 4; i++) r.lineTo(p[i].x, p[i].y);
        r.closePath();
      }
    }
    const cov = r.coverage();
    const c = style.color;
    for (let i = 0; i < w * h; i++) {
      let a = cov[i];
      if (mode !== 'smooth' && a > 0) a = antiAliasAlpha(mode, a);
      a *= c.a;
      if (a <= 0) continue;
      const o = i * 4, k = 1 - a;
      acc[o] = c.r * a + acc[o] * k;
      acc[o + 1] = c.g * a + acc[o + 1] * k;
      acc[o + 2] = c.b * a + acc[o + 2] * k;
      acc[o + 3] = a + acc[o + 3] * k;
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4, a = acc[o + 3];
    if (a <= 0) continue;
    // (Uint8ClampedArray rounds to the nearest value itself.)
    out[o] = (acc[o] / a) * 255;
    out[o + 1] = (acc[o + 1] / a) * 255;
    out[o + 2] = (acc[o + 2] / a) * 255;
    out[o + 3] = a * 255;
  }
  return out;
}

/**
 * Lays out and draws unwarped text into document space. Returns 'pending' while a face it needs is
 * still loading (the caller draws with the browser meanwhile and re-renders when it arrives).
 */
export function renderEngineText(t: TextData, reg: FaceRegistry): EngineRendered | 'pending' | null {
  if (!engineHandles(t)) return null;
  const L = layoutEngine(t, reg);
  if (L.missing) return 'pending';
  const m = t.transform;
  const ink = inkBounds(L);
  if (!ink) return { data: new Uint8ClampedArray(4), rect: { x: Math.round(m[4]), y: Math.round(m[5]), w: 1, h: 1 }, layout: L };
  const pad = 2;
  const b = { x: ink.x - pad, y: ink.y - pad, w: ink.w + pad * 2, h: ink.h + pad * 2 };
  const corners = [apply(m, b.x, b.y), apply(m, b.x + b.w, b.y), apply(m, b.x + b.w, b.y + b.h), apply(m, b.x, b.y + b.h)];
  const rect = roundOut(Math.min(...corners.map((c) => c.x)), Math.min(...corners.map((c) => c.y)), Math.max(...corners.map((c) => c.x)), Math.max(...corners.map((c) => c.y)));
  if (rect.w <= 0 || rect.h <= 0 || rect.w * rect.h > 16384 * 16384) return null;
  const data = drawEngineLayout(L, multiply([1, 0, 0, 1, -rect.x, -rect.y], m), rect.w, rect.h, t.antiAlias);
  return { data, rect, layout: L };
}
