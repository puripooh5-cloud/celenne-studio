/**
 * Adjustments in CMYK and Lab documents.
 *
 * CMYK (two plates of inverted ink, see color/plates.ts): plate 0 (C′ M′ Y′) takes the
 * adjustment as written — the inverted CMY channels behave like R, G, B, so hue, saturation and
 * per-channel edits work as in Photoshop's CMYK mode. Plate 1 (K′ K′ K′, a neutral triple) takes
 * only the neutral part: the composite curve / levels plus the Black channel, brightness,
 * exposure, invert, posterize, threshold. Hue / Saturation's Lightness leaves black alone, as in
 * Photoshop (measured). A no-op adjustment therefore never changes the black generation.
 *
 * Lab (encoded L, a, b): tonal adjustments act on Lightness (curves / levels: composite =
 * Lightness, first / second channel = a / b); colour adjustments are applied in RGB and
 * converted back.
 */
import type { Adjustment, LevelsChannel, CurvePoint } from './types';
import { exposureLinearPixel, prepareAdjustment } from './apply';
import type { CelenneDocument } from '../document/document';
import { isCmykDoc, isLabDoc, decodeLab, encodeLab, labToSrgb, srgbToLab } from '../color/plates';

const lvId = (): LevelsChannel => ({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
const cvId = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 255, y: 255 }];

const kCache = new WeakMap<Adjustment, Adjustment | null>();

/** The neutral part of an adjustment, for the K plate (null = leaves K unchanged). */
export function adjustmentForBlackPlate(adj: Adjustment): Adjustment | null {
  if (kCache.has(adj)) return kCache.get(adj)!;
  let k: Adjustment | null;
  switch (adj.type) {
    case 'levels': { const b = adj.black ?? lvId(); k = { type: 'levels', rgb: adj.rgb, red: b, green: b, blue: b }; break; }
    case 'curves': { const b = adj.black ?? cvId(); k = { type: 'curves', rgb: adj.rgb, red: b, green: b, blue: b }; break; }
    case 'brightnessContrast':
    case 'exposure':
    case 'invert':
    case 'posterize':
    case 'threshold':
      k = adj;
      break;
    default:
      k = null;
  }
  kCache.set(adj, k);
  return k;
}

type PixelFn = (c: Float32Array) => void;
const fnCache = new WeakMap<Adjustment, Map<string, PixelFn | null>>();

/** Per-pixel function (straight values, in place) for an adjustment in this document and plate. */
export function docAdjustmentPixel(doc: CelenneDocument, adj: Adjustment, plate: number): PixelFn | null {
  const mode = isCmykDoc(doc) ? `cmyk${plate}` : isLabDoc(doc) ? 'lab' : doc.canvas.bitDepth === 32 && adj.type === 'exposure' ? 'linear' : 'rgb';
  let m = fnCache.get(adj);
  if (!m) { m = new Map(); fnCache.set(adj, m); }
  if (m.has(mode)) return m.get(mode)!;
  let fn: PixelFn | null;
  if (mode === 'cmyk1') {
    const k = adjustmentForBlackPlate(adj);
    if (!k) fn = null;
    else {
      const f = prepareAdjustment(k).pixel;
      fn = (c) => { f(c); c[1] = c[2] = c[0]; };
    }
  } else if (mode === 'lab') fn = labPixel(adj);
  else if (mode === 'linear') fn = exposureLinearPixel(adj as Extract<Adjustment, { type: 'exposure' }>);
  else fn = prepareAdjustment(adj).pixel;
  m.set(mode, fn);
  return fn;
}

function labPixel(adj: Adjustment): PixelFn {
  switch (adj.type) {
    case 'levels':
    case 'curves': {
      // Composite → Lightness, first channel → a, second → b.
      const comp = prepareAdjustment(adj.type === 'levels' ? { type: 'levels', rgb: lvId(), red: adj.rgb, green: adj.red, blue: adj.green } : { type: 'curves', rgb: cvId(), red: adj.rgb, green: adj.red, blue: adj.green }).pixel;
      return comp;
    }
    case 'brightnessContrast':
    case 'exposure':
    case 'posterize':
    case 'threshold': {
      const f = prepareAdjustment(adj).pixel;
      const t = new Float32Array(3);
      return (c) => {
        t[0] = t[1] = t[2] = c[0];
        f(t);
        c[0] = t[0];
        if (adj.type === 'threshold') c[1] = c[2] = 128 / 255; // neutral
      };
    }
    case 'invert':
      return (c) => { c[0] = 1 - c[0]; c[1] = 1 - c[1]; c[2] = 1 - c[2]; };
    default: {
      const f = prepareAdjustment(adj).pixel;
      return (c) => {
        const rgb = labToSrgb(decodeLab(c[0], c[1], c[2]));
        c[0] = rgb.r; c[1] = rgb.g; c[2] = rgb.b;
        f(c);
        const e = encodeLab(srgbToLab({ r: c[0], g: c[1], b: c[2] }));
        c[0] = e[0]; c[1] = e[1]; c[2] = e[2];
      };
    }
  }
}

/** Compositor path: premultiplied backdrop in, straight adjusted colour out (alpha copied), as applyAdjustedSpan expects. */
export function applyDocAdjustmentPremultiplied(doc: CelenneDocument, adj: Adjustment, plate: number, src: Float32Array, out: Float32Array, n: number): void {
  const fn = docAdjustmentPixel(doc, adj, plate);
  const c = new Float32Array(3);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = src[o + 3];
    out[o + 3] = a;
    if (a <= 0) continue;
    const inv = 1 / a;
    c[0] = src[o] * inv; c[1] = src[o + 1] * inv; c[2] = src[o + 2] * inv;
    if (fn) fn(c);
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
  }
}

/** Destructive path (Image ▸ Adjustments): straight RGBA in place, blended by coverage. */
export function applyDocAdjustmentStraight(doc: CelenneDocument, adj: Adjustment, plate: number, buf: Float32Array, n: number, coverage?: Float32Array): void {
  const fn = docAdjustmentPixel(doc, adj, plate);
  if (!fn) return;
  const c = new Float32Array(3);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const k = coverage ? coverage[i] : 1;
    if (buf[o + 3] <= 0 || k <= 0) continue;
    c[0] = buf[o]; c[1] = buf[o + 1]; c[2] = buf[o + 2];
    fn(c);
    buf[o] += (c[0] - buf[o]) * k;
    buf[o + 1] += (c[1] - buf[o + 1]) * k;
    buf[o + 2] += (c[2] - buf[o + 2]) * k;
  }
}
