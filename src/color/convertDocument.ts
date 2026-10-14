/**
 * Colour mode conversion of a whole document between RGB, Grayscale, CMYK and Lab, through
 * LittleCMS (rendering intent + black point compensation):
 *  - pixel layers (and any layer showing stored pixels) are converted tile by tile, plate by plate;
 *  - parametric colours (text, shapes, fills, effects, colour-bearing adjustments) are converted
 *    and, for CMYK / Lab targets, carry exact values;
 *  - text, shape and smart object layers are re-rendered in the new mode;
 *  - masks, alpha channels and the selection are unchanged (they are not colour).
 */
import type { CelenneDocument } from '../document/document';
import type { ColorMode, ColorProfileRef, Layer } from '../document/types';
import { hasRaster } from '../document/types';
import { TiledRaster, keyToTile, TILE_SIZE } from '../image-engine/tiledRaster';
import { colorEngine, Intent, Xform } from './cms';
import { cmykFor, colorFromCmyk, colorFromLab, companionRead, decodeLab, encodeLab, ensureCompanion, labFor } from './plates';
import type { RGB } from './types';
import { updateAppearance } from '../layers/appearance';
import { renderSmartObject } from '../layers/smartObjects';
import { convertLayerColors } from '../document/layerColors';

export type ModeTarget = 'rgb' | 'grayscale' | 'cmyk' | 'lab';
type Space = 'rgb' | 'gray' | 'cmyk' | 'lab';

export const spaceOfMode = (m: ColorMode): Space => (m === 'cmyk' ? 'cmyk' : m === 'lab' ? 'lab' : m === 'grayscale' ? 'gray' : 'rgb');

/** Plates (straight RGBA floats) → LittleCMS values for the space. */
export function toLcms(space: Space, plates: Float32Array[], n: number): Float32Array {
  const p0 = plates[0];
  if (space === 'gray') { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = p0[i * 4]; return o; }
  if (space === 'cmyk') {
    const p1 = plates[1];
    const o = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      o[i * 4] = (1 - p0[i * 4]) * 100; o[i * 4 + 1] = (1 - p0[i * 4 + 1]) * 100; o[i * 4 + 2] = (1 - p0[i * 4 + 2]) * 100;
      o[i * 4 + 3] = p1 ? (1 - p1[i * 4]) * 100 : 0;
    }
    return o;
  }
  const o = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (space === 'lab') { const l = decodeLab(p0[i * 4], p0[i * 4 + 1], p0[i * 4 + 2]); o[i * 3] = l[0]; o[i * 3 + 1] = l[1]; o[i * 3 + 2] = l[2]; }
    else { o[i * 3] = p0[i * 4]; o[i * 3 + 1] = p0[i * 4 + 1]; o[i * 3 + 2] = p0[i * 4 + 2]; }
  }
  return o;
}

/** LittleCMS values → plates, with alpha from `alpha` (straight RGBA, channel 3). */
export function fromLcms(space: Space, v: Float32Array, n: number, alpha: Float32Array): Float32Array[] {
  const p0 = new Float32Array(n * 4);
  const cl = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  if (space === 'cmyk') {
    const p1 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const a = alpha[i * 4 + 3];
      p0[i * 4] = cl(1 - v[i * 4] / 100); p0[i * 4 + 1] = cl(1 - v[i * 4 + 1] / 100); p0[i * 4 + 2] = cl(1 - v[i * 4 + 2] / 100); p0[i * 4 + 3] = a;
      p1[i * 4] = p1[i * 4 + 1] = p1[i * 4 + 2] = cl(1 - v[i * 4 + 3] / 100); p1[i * 4 + 3] = a;
    }
    return [p0, p1];
  }
  for (let i = 0; i < n; i++) {
    const a = alpha[i * 4 + 3];
    if (space === 'gray') p0[i * 4] = p0[i * 4 + 1] = p0[i * 4 + 2] = cl(v[i]);
    else if (space === 'lab') { const e = encodeLab([v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]); p0[i * 4] = e[0]; p0[i * 4 + 1] = e[1]; p0[i * 4 + 2] = e[2]; }
    else { p0[i * 4] = cl(v[i * 3]); p0[i * 4 + 1] = cl(v[i * 3 + 1]); p0[i * 4 + 2] = cl(v[i * 3 + 2]); }
    p0[i * 4 + 3] = a;
  }
  return [p0];
}

/** Converts a layer raster (and its companion) in place. */
function convertRaster(r: TiledRaster, from: Space, to: Space, x: Xform): void {
  const keys = new Set<number>([...r.tiles.keys(), ...(r.companion ? r.companion.tiles.keys() : [])]);
  const comp = to === 'cmyk' ? r.companion ?? new TiledRaster(4, r.depth, r.fill) : null;
  const n = TILE_SIZE * TILE_SIZE;
  for (const k of keys) {
    const [tx, ty] = keyToTile(k);
    const rect = { x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE };
    const p0 = r.readFloat(rect);
    const plates = from === 'cmyk' ? [p0, companionRead(r, rect, 0, p0)] : [p0];
    const out = fromLcms(to, x.run(toLcms(from, plates, n), n), n, p0);
    r.writeFloat(rect, out[0]);
    if (comp) comp.writeFloat(rect, out[1]);
  }
  r.companion = comp;
  if (comp) comp.compact();
  r.compact();
}

const reRendered = (l: Layer) => ((l.kind === 'text' || l.kind === 'shape') && !l.usingPreservedPixels);

/**
 * Converts the document to `target` with `profile` (the target CMYK / RGB / Gray profile; Lab
 * uses CIE Lab D50). Requires the colour engine. Mutates the document.
 */
export function convertDocumentColor(doc: CelenneDocument, target: ModeTarget, profile: ColorProfileRef, intent: Intent, bpc: boolean): void {
  if (!colorEngine.ready) throw new Error('Color management is not available');
  const from = spaceOfMode(doc.canvas.colorMode);
  const to = spaceOfMode(target);
  const srcProfile: ColorProfileRef = from === 'lab' ? { name: 'Lab Color (D50)', builtin: 'labD50' } : doc.profile;
  const dstProfile: ColorProfileRef = to === 'lab' ? { name: 'Lab Color (D50)', builtin: 'labD50' } : profile;
  const x = colorEngine.transform(srcProfile, dstProfile, intent, bpc);

  // Parametric colours (before the mode switch: CMYK / Lab sources read exact values with the old profile).
  const convColor = (c: RGB): RGB => {
    let v: Float32Array;
    if (from === 'cmyk') v = Float32Array.from(cmykFor(doc, c).map((q) => q * 100));
    else if (from === 'lab') v = Float32Array.from(labFor(c));
    else if (from === 'gray') v = Float32Array.of(0.299 * c.r + 0.587 * c.g + 0.114 * c.b);
    else v = Float32Array.of(c.r, c.g, c.b);
    const o = x.run(v, 1);
    if (to === 'cmyk') return colorFromCmyk([o[0] / 100, o[1] / 100, o[2] / 100, o[3] / 100].map((q) => Math.max(0, Math.min(1, q))) as [number, number, number, number], dstProfile);
    if (to === 'lab') return colorFromLab([o[0], o[1], o[2]]);
    if (to === 'gray') { const g = Math.max(0, Math.min(1, o[0])); return { r: g, g, b: g }; }
    return { r: Math.max(0, Math.min(1, o[0])), g: Math.max(0, Math.min(1, o[1])), b: Math.max(0, Math.min(1, o[2])) };
  };

  const layers = [...doc.walk()];
  for (const l of layers) {
    convertLayerColors(l, convColor);
    if (hasRaster(l) && !reRendered(l)) convertRaster(l.raster, from, to, x);
  }
  doc.canvas = { ...doc.canvas, colorMode: target, colorTable: undefined, colorTableTransparent: undefined };
  doc.profile = dstProfile;
  for (const l of layers) {
    if (reRendered(l)) updateAppearance(doc, l);
    else if (l.kind === 'smartObject' && !l.usingPreservedPixels && doc.smartSources.get(l.sourceId)?.decoded) renderSmartObject(doc, l);
    l.rev++;
  }
}

/** A document's colour space (for moving pixels / layers between documents). */
export interface ColorSpaceRef {
  mode: ColorMode;
  profile: ColorProfileRef;
}

export function spaceOfDoc(doc: CelenneDocument): ColorSpaceRef {
  return { mode: doc.canvas.colorMode, profile: doc.profile };
}

function sameSpace(a: ColorSpaceRef, b: ColorSpaceRef): boolean {
  const sa = spaceOfMode(a.mode), sb = spaceOfMode(b.mode);
  if (sa !== sb) return false;
  if (sa === 'lab') return true;
  return colorEngine.ready ? colorEngine.sameProfile(a.profile, b.profile) : a.profile.name === b.profile.name;
}

function profileFor(s: ColorSpaceRef): ColorProfileRef {
  return spaceOfMode(s.mode) === 'lab' ? { name: 'Lab Color (D50)', builtin: 'labD50' } : s.profile;
}

/** Converts a raster (and companion) between colour spaces in place; a no-op for equal spaces. */
export function convertRasterSpace(r: TiledRaster, from: ColorSpaceRef, to: ColorSpaceRef, intent: Intent = 'relative', bpc = true): void {
  if (sameSpace(from, to)) return;
  if (!colorEngine.ready) {
    // Without the engine only the structure can be fixed: CMYK targets get an empty (no-black) plate.
    if (spaceOfMode(to.mode) === 'cmyk' && !r.companion) ensureCompanion(r);
    if (spaceOfMode(to.mode) !== 'cmyk') r.companion = null;
    return;
  }
  convertRaster(r, spaceOfMode(from.mode), spaceOfMode(to.mode), colorEngine.transform(profileFor(from), profileFor(to), intent, bpc));
}

/**
 * Makes layers that come from another document (paste, duplicate to document, drag) fit `doc`'s
 * colour space: pixels and parametric colours are converted, parametric layers re-rendered.
 */
export function adoptLayers(doc: CelenneDocument, from: ColorSpaceRef, layers: Layer[]): void {
  const to = spaceOfDoc(doc);
  if (sameSpace(from, to)) return;
  const fs = spaceOfMode(from.mode), ts = spaceOfMode(to.mode);
  const x = colorEngine.ready ? colorEngine.transform(profileFor(from), profileFor(to), 'relative', true) : null;
  // Colour objects: read in the source space, written with exact values for CMYK / Lab targets.
  const src = { canvas: { colorMode: from.mode }, profile: from.profile } as unknown as CelenneDocument;
  const convColor = (c: RGB): RGB => {
    if (!x) return c;
    let v: Float32Array;
    if (fs === 'cmyk') v = Float32Array.from(cmykFor(src, c).map((q) => q * 100));
    else if (fs === 'lab') v = Float32Array.from(labFor(c));
    else if (fs === 'gray') v = Float32Array.of(0.299 * c.r + 0.587 * c.g + 0.114 * c.b);
    else v = Float32Array.of(c.r, c.g, c.b);
    const o = x.run(v, 1);
    const cl = (q: number) => Math.max(0, Math.min(1, q));
    if (ts === 'cmyk') return colorFromCmyk([cl(o[0] / 100), cl(o[1] / 100), cl(o[2] / 100), cl(o[3] / 100)], to.profile);
    if (ts === 'lab') return colorFromLab([o[0], o[1], o[2]]);
    if (ts === 'gray') { const g = cl(o[0]); return { r: g, g, b: g }; }
    return { r: cl(o[0]), g: cl(o[1]), b: cl(o[2]) };
  };
  const all: Layer[] = [];
  const collect = (l: Layer) => { all.push(l); if (l.kind === 'group') l.children.forEach(collect); };
  layers.forEach(collect);
  for (const l of all) {
    convertLayerColors(l, convColor);
    if (hasRaster(l) && !reRendered(l)) {
      if (x) convertRaster(l.raster, fs, ts, x);
      else convertRasterSpace(l.raster, from, to);
    }
  }
  for (const l of all) if (reRendered(l)) updateAppearance(doc, l);
}
