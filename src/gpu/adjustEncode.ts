/**
 * Adjustments → the GPU compositor's parameter layout (see shaders.ts, adjCore / adjPixel).
 * LUT-based adjustments use the CPU's own tables (curveLUT, levelsLUT, toneLUT, gradient LUT), so
 * both paths evaluate the same numbers; formula-based ones are ported line by line.
 */
import type { Adjustment, CurvePoint, LevelsChannel } from '../adjustments/types';
import { colorBalanceLUTs, curveLUT, levelsLUT, photoFilterMatrix, toneLUT, vibranceLut, LUT_N } from '../adjustments/apply';
import { adjustmentForBlackPlate } from '../adjustments/docAdjust';
import { buildGradientLUT } from '../color/gradient';
import { ADJ, WRAP } from './shaders';

export interface EncodedAdjustment {
  code: number;
  wrap: number;
  /** f32 values (written into the data buffer at adjBase). */
  values: Float32Array;
}

const lvId = (): LevelsChannel => ({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
const cvId = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 255, y: 255 }];

const cache = new WeakMap<Adjustment, Map<string, EncodedAdjustment | null>>();

/** Largest Color Lookup table the GPU path takes (larger ones render on the CPU). */
export const MAX_GPU_LUT3D = 65;

/**
 * Encodes `adj` for a document kind and plate: 'rgb' (RGB / Gray), 'cmyk0' / 'cmyk1' (plates),
 * 'lab'. Returns null when the GPU path cannot evaluate it.
 */
export function encodeAdjustment(adj: Adjustment, mode: 'rgb' | 'cmyk0' | 'cmyk1' | 'lab'): EncodedAdjustment | null {
  let m = cache.get(adj);
  if (!m) { m = new Map(); cache.set(adj, m); }
  if (m.has(mode)) return m.get(mode)!;
  let e: EncodedAdjustment | null;
  if (mode === 'cmyk1') {
    const k = adjustmentForBlackPlate(adj);
    e = k ? withWrap(core(k), WRAP.neutral) : { code: ADJ.identity, wrap: WRAP.none, values: new Float32Array(0) };
  } else if (mode === 'lab') e = labEncode(adj);
  else e = core(adj);
  m.set(mode, e);
  return e;
}

function withWrap(e: EncodedAdjustment | null, wrap: number): EncodedAdjustment | null {
  return e ? { ...e, wrap } : null;
}

function labEncode(adj: Adjustment): EncodedAdjustment | null {
  switch (adj.type) {
    case 'levels':
      return channelLuts([levelsLUT(lvId()), levelsLUT(adj.rgb), levelsLUT(adj.red), levelsLUT(adj.green)]);
    case 'curves':
      return channelLuts([curveLUT(cvId()), curveLUT(adj.rgb), curveLUT(adj.red), curveLUT(adj.green)]);
    case 'brightnessContrast':
    case 'exposure':
    case 'posterize':
      return withWrap(core(adj), WRAP.lOnly);
    case 'threshold':
      return withWrap(core(adj), WRAP.lOnlyThreshold);
    case 'invert':
      return core(adj);
    default:
      return withWrap(core(adj), WRAP.viaRgb);
  }
}

function channelLuts(l: Float32Array[]): EncodedAdjustment {
  const v = new Float32Array(LUT_N * 4);
  l.forEach((t, i) => v.set(t, i * LUT_N));
  return { code: ADJ.channelLuts, wrap: WRAP.none, values: v };
}

const f = (...xs: number[]) => Float32Array.from(xs);

function core(adj: Adjustment): EncodedAdjustment | null {
  const E = (code: number, values: Float32Array): EncodedAdjustment => ({ code, wrap: WRAP.none, values });
  switch (adj.type) {
    case 'curves': return channelLuts([curveLUT(adj.rgb), curveLUT(adj.red), curveLUT(adj.green), curveLUT(adj.blue)]);
    case 'levels': return channelLuts([levelsLUT(adj.rgb), levelsLUT(adj.red), levelsLUT(adj.green), levelsLUT(adj.blue)]);
    case 'brightnessContrast':
    case 'exposure': return E(ADJ.toneLut, toneLUT(adj));
    case 'vibrance': {
      // [saturation, has table, table size, table…] (vibranceLut / vibranceSaturation).
      const lut = vibranceLut(adj.vibrance);
      const v = new Float32Array(3 + (lut ? lut.data.length : 0));
      v[0] = adj.saturation / 100; v[1] = lut ? 1 : 0;
      if (lut) { new Uint32Array(v.buffer)[2] = lut.size; v.set(lut.data, 3); }
      return E(ADJ.vibrance, v);
    }
    case 'hueSaturation': {
      if (adj.colorize) {
        const h = adj.master.hue < 0 ? adj.master.hue + 360 : adj.master.hue;
        const sat = Math.max(0, Math.min(1, adj.master.saturation / 100));
        return E(ADJ.hueSat, f(1, h, sat, adj.master.lightness / 100, 0, 0, 0, 0));
      }
      const ranges = adj.ranges.filter((r) => r.hue || r.saturation || r.lightness);
      const m = adj.master;
      const v = [0, 0, 0, 0, m.hue, m.saturation, m.lightness, ranges.length];
      for (const r of ranges) v.push(r.hue, r.saturation, r.lightness, ...r.range);
      const out = Float32Array.from(v);
      // The range count is read as an integer.
      new Uint32Array(out.buffer)[7] = ranges.length;
      return E(ADJ.hueSat, out);
    }
    case 'colorBalance': {
      const l = colorBalanceLUTs(adj);
      const v = new Float32Array(4 + 3 * LUT_N);
      v[0] = adj.preserveLuminosity ? 1 : 0;
      l.forEach((t, i) => v.set(t, 4 + i * LUT_N));
      return E(ADJ.colorBalance, v);
    }
    case 'blackWhite':
      return E(ADJ.blackWhite, f(adj.reds / 100, adj.yellows / 100, adj.greens / 100, adj.cyans / 100, adj.blues / 100, adj.magentas / 100, adj.tint ? 1 : 0, adj.tintColor.r, adj.tintColor.g, adj.tintColor.b));
    case 'photoFilter':
      return E(ADJ.photoFilter, f(adj.preserveLuminosity ? 1 : 0, ...photoFilterMatrix(adj)));
    case 'channelMixer':
      return E(ADJ.channelMixer, f(adj.monochrome ? 1 : 0, ...adj.red.map((x) => x / 100), ...adj.green.map((x) => x / 100), ...adj.blue.map((x) => x / 100), ...adj.gray.map((x) => x / 100)));
    case 'colorLookup': {
      const lut = adj.lut;
      if (!lut) return E(ADJ.identity, new Float32Array(0));
      if (lut.size > MAX_GPU_LUT3D || lut.size < 2) return null;
      const v = new Float32Array(1 + lut.data.length);
      new Uint32Array(v.buffer)[0] = lut.size;
      v.set(lut.data, 1);
      return E(ADJ.colorLookup, v);
    }
    case 'invert': return E(ADJ.invert, new Float32Array(0));
    case 'posterize': return E(ADJ.posterize, f(Math.max(2, Math.min(255, Math.round(adj.levels)))));
    case 'threshold': return E(ADJ.threshold, f(adj.level / 255));
    case 'gradientMap': return E(ADJ.gradientMap, buildGradientLUT(adj.gradient, adj.reverse, 1024));
    case 'selectiveColor': {
      const keys = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'] as const;
      const v = [adj.mode === 'relative' ? 1 : 0];
      for (const k of keys) { const c = adj.colors[k]; v.push(c.c / 100, c.m / 100, c.y / 100, c.k / 100); }
      return E(ADJ.selectiveColor, Float32Array.from(v));
    }
  }
  return null;
}
