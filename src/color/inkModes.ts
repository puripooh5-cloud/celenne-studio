/**
 * Mode changes into and out of the ink modes: Duotone (Grayscale data + inks) and Multichannel
 * (every channel an ink, no layers). Conversions mirror Photoshop:
 *  - Grayscale ⇄ Duotone keeps the gray data (only the inks are added or dropped);
 *  - Duotone → colour converts every layer through how the inks print;
 *  - RGB / CMYK / Lab / Gray / Duotone → Multichannel flattens and makes one ink channel per colour
 *    channel (RGB → Cyan, Magenta, Yellow; CMYK → C, M, Y, K; Duotone → one plate per ink);
 *  - Multichannel → RGB / CMYK is exact when the channels are C M Y (K), otherwise the document
 *    is converted through how its inks print.
 */
import type { CelenneDocument } from '../document/document';
import type { AlphaChannel } from '../document/types';
import { hasRaster } from '../document/types';
import { createFillLayer, createGroupLayer, createPixelLayer } from '../document/layerFactory';
import { newId } from '../document/ids';
import { TiledRaster } from '../image-engine/tiledRaster';
import type { BitDepth } from '../image-engine/pixels';
import { convertLayerColors } from '../document/layerColors';
import { updateAppearance } from '../layers/appearance';
import { applyDuotone, duotoneColor, evalCurve, type DuotoneSpec } from './inks';
import { colorFromCmyk, isCmykDoc, isLabDoc } from './plates';
import { flattenToPixels } from '../rendering/flatten';
import type { RGB } from './types';
import { builtinProfileName } from './icc';
import { CELENNE_CMYK_NAME } from './cmykProfile';

const gray = (c: RGB) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
const reRendered = (l: import('../document/types').Layer) => (l.kind === 'text' || l.kind === 'shape') && !l.usingPreservedPixels;

/** Duotone → RGB (sRGB): every layer's gray values become the colours the inks print. */
export function duotoneToRgb(doc: CelenneDocument): void {
  const spec = doc.canvas.duotone;
  if (!spec) return;
  const layers = [...doc.walk()];
  for (const l of layers) {
    convertLayerColors(l, (c) => duotoneColor(spec, gray(c)));
    if (hasRaster(l) && !reRendered(l)) mapRaster(l.raster, (buf, n) => applyDuotone(spec, buf, n));
  }
  doc.canvas = { ...doc.canvas, colorMode: 'rgb', duotone: undefined };
  doc.profile = { name: builtinProfileName('srgb'), builtin: 'srgb' };
  for (const l of layers) { if (reRendered(l)) updateAppearance(doc, l); l.rev++; }
}

function mapRaster(r: TiledRaster, f: (buf: Float32Array, n: number) => void): void {
  const b = r.contentBounds();
  if (!b) return;
  const px = r.readFloat(b);
  f(px, b.w * b.h);
  r.writeFloat(b, px);
}

const INK_NAMES = { cmyk: ['Cyan', 'Magenta', 'Yellow', 'Black'], lab: ['Lightness', 'a', 'b'] };

/** Process ink colours for Multichannel channels made from colour channels. */
function processInks(doc: CelenneDocument): RGB[] {
  const prof = isCmykDoc(doc) ? doc.profile : { name: CELENNE_CMYK_NAME, builtin: 'celenneCMYK' as const };
  return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]].map((c) => {
    const v = colorFromCmyk(c as [number, number, number, number], prof);
    return { r: v.r, g: v.g, b: v.b };
  });
}

function inkChannel(name: string, color: RGB, depth: BitDepth, w: number, h: number, values: Float32Array): AlphaChannel {
  const raster = new TiledRaster(1, depth, 1);
  raster.writeFloat({ x: 0, y: 0, w, h }, values);
  raster.compact();
  return { id: newId('ch'), name, kind: 'spot', raster, visible: true, color, opacity: 0, indicatesSelected: false, solidity: 0 };
}

/**
 * Any mode → Multichannel. The document is flattened (Multichannel has no layers); channel values
 * are as Photoshop stores them (1 = no ink). Existing alpha / spot channels are kept after them.
 */
export function toMultichannel(doc: CelenneDocument): void {
  const w = doc.width, h = doc.height, n = w * h;
  const depth: BitDepth = doc.canvas.bitDepth === 32 ? 16 : doc.canvas.bitDepth;
  const made: AlphaChannel[] = [];
  const plane = (src: Float32Array, c: number, f: (v: number, a: number) => number = (v) => v) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = src[i * 4 + 3]; out[i] = f(src[i * 4 + c], a); }
    return out;
  };
  // Transparent areas print no ink.
  const paper = (v: number, a: number) => v * a + (1 - a);
  const inks = processInks(doc);
  if (isCmykDoc(doc)) {
    const p0 = flattenToPixels(doc, { depth: 16, plate: 0 }).data, p1 = flattenToPixels(doc, { depth: 16, plate: 1 }).data;
    const f0 = Float32Array.from(p0, (v) => v / 65535), f1 = Float32Array.from(p1, (v) => v / 65535);
    for (let c = 0; c < 3; c++) made.push(inkChannel(INK_NAMES.cmyk[c], inks[c], depth, w, h, plane(f0, c, paper)));
    made.push(inkChannel('Black', inks[3], depth, w, h, plane(f1, 0, paper)));
  } else if (isLabDoc(doc)) {
    const f = Float32Array.from(flattenToPixels(doc, { depth: 16, plate: 0 }).data, (v) => v / 65535);
    for (let c = 0; c < 3; c++) made.push(inkChannel(INK_NAMES.lab[c], { r: 0, g: 0, b: 0 }, depth, w, h, plane(f, c)));
  } else if (doc.canvas.duotone) {
    // One plate per ink: the gray tone through the ink's curve.
    const spec: DuotoneSpec = doc.canvas.duotone;
    const f = Float32Array.from(flattenToPixels(doc, { depth: 16 }).data, (v) => v / 65535);
    spec.inks.forEach((ink) => made.push(inkChannel(ink.name, { r: ink.color.r, g: ink.color.g, b: ink.color.b }, depth, w, h, plane(f, 0, (v, a) => 1 - evalCurve(ink.curve, 1 - paper(v, a))))));
  } else if (doc.canvas.colorMode === 'grayscale') {
    const f = Float32Array.from(flattenToPixels(doc, { depth: 16 }).data, (v) => v / 65535);
    made.push(inkChannel('Black', inks[3], depth, w, h, plane(f, 0, paper)));
  } else {
    // RGB: the red, green and blue channels print as cyan, magenta and yellow.
    const f = Float32Array.from(flattenToPixels(doc, { depth: 16 }).data, (v) => v / 65535);
    for (let c = 0; c < 3; c++) made.push(inkChannel(INK_NAMES.cmyk[c], inks[c], depth, w, h, plane(f, c, paper)));
  }
  for (const l of [...doc.root.children]) doc.removeLayer(l);
  doc.channels = [...made, ...doc.channels];
  doc.canvas = { ...doc.canvas, colorMode: 'multichannel', bitDepth: depth, duotone: undefined, colorTable: undefined, colorTableTransparent: undefined };
}

/**
 * Multichannel → a layered mode. Exact when the first channels are C M Y (K) and the target matches
 * (three channels → RGB, four → CMYK); otherwise one layer showing how the inks print (sRGB).
 * Returns the mode reached ('rgb' or 'cmyk'); the caller converts further when needed.
 */
export function fromMultichannel(doc: CelenneDocument, want: 'rgb' | 'cmyk'): 'rgb' | 'cmyk' {
  const w = doc.width, h = doc.height, n = w * h;
  const all = { x: 0, y: 0, w, h };
  const names = doc.channels.map((c) => c.name.toLowerCase());
  const isCmy = names[0] === 'cyan' && names[1] === 'magenta' && names[2] === 'yellow';
  const depth = doc.canvas.bitDepth;
  const exact = isCmy && (want === 'cmyk' ? names[3] === 'black' && doc.channels.length === 4 : doc.channels.length === 3);
  const layer = createPixelLayer('Background', depth);
  let reached: 'rgb' | 'cmyk' = 'rgb';
  if (exact) {
    const v = doc.channels.map((c) => c.raster.readFloat(all));
    const p0 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { p0[i * 4] = v[0][i]; p0[i * 4 + 1] = v[1][i]; p0[i * 4 + 2] = v[2][i]; p0[i * 4 + 3] = 1; }
    layer.raster.writeFloat(all, p0);
    if (want === 'cmyk') {
      const p1 = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { p1[i * 4] = p1[i * 4 + 1] = p1[i * 4 + 2] = v[3][i]; p1[i * 4 + 3] = 1; }
      layer.raster.companion = new TiledRaster(4, depth);
      layer.raster.companion.writeFloat(all, p1);
      reached = 'cmyk';
    }
    doc.channels = [];
  } else {
    const f = flattenToPixels(doc, { depth: 16, inks: true }).data;
    layer.raster.writeFloat(all, Float32Array.from(f, (x) => x / 65535));
    doc.channels = [];
  }
  layer.raster.compact();
  layer.locks = { ...layer.locks, position: true };
  doc.insertLayer(layer, doc.root);
  doc.canvas = { ...doc.canvas, colorMode: reached };
  if (reached === 'rgb') doc.profile = { name: builtinProfileName('srgb'), builtin: 'srgb' };
  return reached;
}

/** Why a spot channel cannot be merged in this document (null = it can). */
export function mergeSpotUnavailable(doc: CelenneDocument, channelId: string): string | null {
  const ch = doc.channels.find((c) => c.id === channelId);
  if (!ch || ch.kind !== 'spot') return 'Only spot channels can be merged.';
  const m = doc.canvas.colorMode;
  if (doc.canvas.duotone || m === 'multichannel' || m === 'indexed' || m === 'bitmap') return 'Merge Spot Channel needs an RGB, CMYK or Grayscale document.';
  if (m === 'lab') return 'Convert the document to RGB or CMYK first: inks do not mix meaningfully in Lab.';
  return null;
}

/**
 * Channels ▸ Merge Spot Channel: prints the spot ink into the image and removes the channel.
 * Photoshop flattens the image to do this; here the ink becomes Color Fill layers at the top of
 * the layer stack, masked by the channel, so the layers stay editable. The layers reproduce the
 * spot display exactly: with ink amount k (1 − channel value) and solidity s it shows
 * base·(1 − k) + k·(s·ink + (1 − s)·base·ink), which is a Multiply fill (mask k(1 − s)/(1 − ks))
 * under a Normal fill (mask k, opacity s). Returns the new top layer.
 */
export function mergeSpotChannel(doc: CelenneDocument, channelId: string): import('../document/types').Layer {
  const why = mergeSpotUnavailable(doc, channelId);
  if (why) throw new Error(why);
  const ch = doc.channels.find((c) => c.id === channelId)!;
  const s = Math.max(0, Math.min(1, ch.solidity ?? 0));
  const depth: BitDepth = ch.raster.depth === 8 ? 8 : 16;
  const color: RGB = { r: ch.color.r, g: ch.color.g, b: ch.color.b };
  const masked = (name: string, mode: 'multiply' | 'normal', amount: (k: number) => number, opacity: number) => {
    const l = createFillLayer({ type: 'solid', color }, name);
    l.blendMode = mode;
    l.opacity = opacity;
    const mask = new TiledRaster(1, depth, 0);
    // Strips over the document (the channel's values outside it are never printed).
    const W = doc.width, H = doc.height, STRIP = 256;
    for (let y = 0; y < H; y += STRIP) {
      const r = { x: 0, y, w: W, h: Math.min(STRIP, H - y) };
      const v = ch.raster.readFloat(r);
      let any = false;
      for (let i = 0; i < v.length; i++) { v[i] = amount(1 - v[i]); if (v[i] > 0) any = true; }
      if (any) mask.writeFloat(r, v);
    }
    l.mask = { raster: mask, x: 0, y: 0, enabled: true, linked: true, density: 1, feather: 0 };
    return l;
  };
  const layers: import('../document/types').Layer[] = [];
  if (s < 1) layers.push(masked(s > 0 ? `${ch.name} (ink)` : ch.name, 'multiply', (k) => (k <= 0 ? 0 : k * s >= 1 ? 1 : (k * (1 - s)) / (1 - k * s)), 1));
  if (s > 0) layers.push(masked(s < 1 ? `${ch.name} (opaque ink)` : ch.name, 'normal', (k) => Math.max(0, Math.min(1, k)), s));
  let top: import('../document/types').Layer;
  if (layers.length === 1) {
    top = layers[0];
    doc.insertLayer(top);
  } else {
    const g = createGroupLayer(ch.name);
    doc.insertLayer(g);
    for (const l of layers) doc.insertLayer(l, g);
    top = g;
  }
  doc.channels = doc.channels.filter((c) => c.id !== channelId);
  return top;
}
