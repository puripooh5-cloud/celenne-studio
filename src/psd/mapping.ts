/**
 * Bidirectional mapping between ag-psd structures and the Celenne document model.
 * Every mapper is total: unknown values fall back to safe defaults and never throw.
 */
import { flattenTextPath } from '../typography/pathText';
import { exactCmyk, exactLab, labToSrgb } from '../color/plates';
import type * as Ag from 'ag-psd';
import type { BlendMode } from '../image-engine/blend';
import type { RGB } from '../color/types';
import type { Gradient, GradientType } from '../color/types';
import { cmykToRgb, hsvToRgb, labToRgb } from '../color/convert';
import type { Adjustment, CurvePoint, HueSatRange, LevelsChannel, SelectiveColorKey } from '../adjustments/types';
import { defaultAdjustment, HUE_RANGES_DEFAULT } from '../adjustments/types';
import type { LayerEffects, ShadowEffect, GlowEffect, InnerGlowEffect, BevelEffect, StrokeEffect } from '../effects/types';
import { emptyEffects } from '../effects/types';
import type { CharacterStyle, ParagraphStyle, StyleRun, TextAlign, TextData, TextWarp } from '../typography/types';
import { defaultCharacterStyle, defaultParagraphStyle, PARAGRAPH_DEFAULTS, runsPerParagraph } from '../typography/types';
import type { SubPath, VectorPath } from '../vector/types';
import { knotFromPsd, knotToPsd } from './paths';
import type { Paint } from '../document/types';

// ---------------------------------------------------------------------------------------------
// Blend modes
// ---------------------------------------------------------------------------------------------
const BLEND_TO: Record<string, BlendMode> = {
  'pass through': 'passThrough', normal: 'normal', dissolve: 'dissolve', darken: 'darken', multiply: 'multiply', 'color burn': 'colorBurn',
  'linear burn': 'linearBurn', 'darker color': 'darkerColor', lighten: 'lighten', screen: 'screen', 'color dodge': 'colorDodge',
  'linear dodge': 'linearDodge', 'lighter color': 'lighterColor', overlay: 'overlay', 'soft light': 'softLight', 'hard light': 'hardLight',
  'vivid light': 'vividLight', 'linear light': 'linearLight', 'pin light': 'pinLight', 'hard mix': 'hardMix', difference: 'difference',
  exclusion: 'exclusion', subtract: 'subtract', subtraction: 'subtract', divide: 'divide', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};
const BLEND_FROM: Record<BlendMode, Ag.BlendMode> = Object.fromEntries(
  Object.entries(BLEND_TO).filter(([k]) => k !== 'subtraction').map(([k, v]) => [v, k as Ag.BlendMode]),
) as Record<BlendMode, Ag.BlendMode>;

export function blendFromPsd(m: string | undefined, fallback: BlendMode = 'normal'): BlendMode {
  return (m && BLEND_TO[m]) || fallback;
}
export function blendToPsd(m: BlendMode): Ag.BlendMode {
  return BLEND_FROM[m] ?? 'normal';
}

// ---------------------------------------------------------------------------------------------
// Colors / units
// ---------------------------------------------------------------------------------------------
export function colorFromPsd(c: Ag.Color | undefined, fallback: RGB = { r: 0, g: 0, b: 0 }): RGB {
  if (!c) return { ...fallback };
  const a = c as Record<string, number>;
  if ('fr' in a) return { r: a.fr, g: a.fg, b: a.fb };
  if ('r' in a && 'g' in a) return { r: a.r / 255, g: a.g / 255, b: a.b / 255 };
  if ('h' in a && 's' in a) return hsvToRgb({ h: a.h * 360, s: a.s, v: a.b });
  if ('c' in a && 'k' in a) {
    // Exact ink values are kept (CMYK documents paint with them); RGB is a device approximation.
    const cmyk: [number, number, number, number] = [a.c / 255, a.m / 255, a.y / 255, a.k / 255];
    const rgb = cmykToRgb({ c: cmyk[0], m: cmyk[1], y: cmyk[2], k: cmyk[3] });
    return { ...rgb, exact: { ...rgb, cmyk } };
  }
  if ('l' in a && 'a' in a) {
    const lab: [number, number, number] = [a.l, a.a, a.b];
    const rgb = labToSrgb(lab);
    return { ...rgb, exact: { ...rgb, lab } };
  }
  if ('k' in a) return { r: 1 - a.k / 255, g: 1 - a.k / 255, b: 1 - a.k / 255 };
  return { ...fallback };
}

/** Writes exact CMYK / Lab values when the colour has them (CMYK / Lab documents), else RGB. */
export function colorToPsd(c: RGB): Ag.RGB {
  const cmyk = exactCmyk(c);
  if (cmyk) return { c: Math.round(cmyk[0] * 255), m: Math.round(cmyk[1] * 255), y: Math.round(cmyk[2] * 255), k: Math.round(cmyk[3] * 255) } as unknown as Ag.RGB;
  const lab = exactLab(c);
  if (lab) return { l: lab[0], a: lab[1], b: lab[2] } as unknown as Ag.RGB;
  return { r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255) };
}

/**
 * Photo Filter colours are stored as binary colours (Photoshop writes Lab), which ag-psd returns
 * normalised: L 0..1, a and b divided by 127 (positive) or 128 (negative). Other Lab colours come
 * from descriptors in plain units, which is what colorFromPsd / colorToPsd use.
 */
function photoFilterColorFromPsd(c: Ag.Color | undefined): RGB {
  const v = c as Record<string, number> | undefined;
  if (v && 'l' in v && 'a' in v) {
    const ab = (x: number) => x * (x < 0 ? 128 : 127);
    return colorFromPsd({ l: v.l * 100, a: ab(v.a), b: ab(v.b) } as unknown as Ag.Color);
  }
  return colorFromPsd(c, { r: 0.925, g: 0.541, b: 0 });
}
function photoFilterColorToPsd(c: RGB): Ag.Color {
  const lab = exactLab(c);
  if (lab) {
    const ab = (x: number) => x / (x < 0 ? 128 : 127);
    return { l: lab[0] / 100, a: ab(lab[1]), b: ab(lab[2]) } as unknown as Ag.Color;
  }
  return { r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255) };
}

export function unitPx(v: Ag.UnitsValue | number | undefined, fallback = 0, resolution = 72): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'number') return v;
  switch (v.units) {
    case 'Points': return (v.value * resolution) / 72;
    case 'Millimeters': return (v.value * resolution) / 25.4;
    case 'Centimeters': return (v.value * resolution) / 2.54;
    case 'Inches': return v.value * resolution;
    default: return v.value;
  }
}
export const px = (value: number): Ag.UnitsValue => ({ units: 'Pixels', value });

// ---------------------------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------------------------
/** Photoshop's gradient method (absent in files before Photoshop 2023, which are Classic). */
const methodOf = (m: string | undefined): Gradient['interpolation'] => (m === 'perceptual' || m === 'linear' || m === 'smooth' ? m : undefined);

/**
 * Photoshop stores stop locations on a fixed 0..4096 scale whatever the smoothness ('Intr'), but
 * ag-psd divides them by the smoothness value (gradients below 100 % smoothness come out
 * compressed) and multiplies by it when writing. Undo that here, and write 0 % smoothness as
 * 1/4096 so the stop locations survive.
 */
const agLocationScale = (smoothness: number | undefined) => (smoothness && smoothness > 0 ? smoothness : 1);

/** `rawLocations`: stop locations read from the raw block (0..1), when ag-psd's are unusable. */
export function gradientFromPsd(g: Ag.EffectSolidGradient | Ag.EffectNoiseGradient | undefined, method?: string, rawLocations?: { color: number[]; alpha: number[] }): Gradient {
  if (!g || g.type !== 'solid') {
    return { name: g?.name ?? 'Gradient', colorStops: [{ location: 0, color: { r: 0, g: 0, b: 0 }, midpoint: 0.5 }, { location: 1, color: { r: 1, g: 1, b: 1 }, midpoint: 0.5 }], alphaStops: [{ location: 0, opacity: 1, midpoint: 0.5 }, { location: 1, opacity: 1, midpoint: 0.5 }], smoothness: 1 };
  }
  const k = agLocationScale(g.smoothness);
  return {
    name: g.name ?? 'Gradient',
    // ag-psd already scales Photoshop's midpoint (0..100) to 0..1.
    colorStops: (g.colorStops ?? []).map((s, i) => ({ location: rawLocations?.color[i] ?? s.location * k, color: colorFromPsd(s.color), midpoint: s.midpoint ?? 0.5 })),
    alphaStops: (g.opacityStops ?? []).map((s, i) => ({ location: rawLocations?.alpha[i] ?? s.location * k, opacity: s.opacity, midpoint: s.midpoint ?? 0.5 })),
    smoothness: (g.smoothness ?? 1),
    interpolation: methodOf(method),
  };
}

export function gradientToPsd(g: Gradient): Ag.EffectSolidGradient {
  const s = Math.max(1 / 4096, Math.min(1, g.smoothness ?? 1));
  // ag-psd writes location × round(smoothness × 4096); Photoshop reads location × 4096.
  const k = Math.round(s * 4096) / 4096;
  return {
    name: g.name,
    type: 'solid',
    smoothness: s,
    colorStops: g.colorStops.map((c) => ({ location: c.location / k, color: colorToPsd(c.color), midpoint: c.midpoint })),
    opacityStops: g.alphaStops.map((a) => ({ location: a.location / k, opacity: a.opacity, midpoint: a.midpoint })),
  };
}

/**
 * Stop locations (0..1) and method of a raw 'grdm' (Gradient Map) block: ag-psd mis-scales the
 * locations and decodes the bare method code ('Gcls') as its default, Perceptual.
 */
export function gradientMapLocations(data: Uint8Array): { color: number[]; alpha: number[]; method?: string } | null {
  try {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const version = dv.getUint16(0);
    let o = 4;
    let method: string | undefined;
    if (version === 3) {
      const sig = String.fromCharCode(data[4], data[5], data[6], data[7]);
      method = ({ Perc: 'perceptual', 'Lnr ': 'linear', Gcls: 'classic', Smoo: 'smooth' } as Record<string, string>)[sig];
      o += 4;
    }
    const nameLen = dv.getUint32(o); o += 4 + nameLen * 2;
    const color: number[] = [], alpha: number[] = [];
    const nc = dv.getUint16(o); o += 2;
    for (let i = 0; i < nc; i++) { color.push(dv.getUint32(o) / 4096); o += 4 + 4 + 10 + 2; }
    const na = dv.getUint16(o); o += 2;
    for (let i = 0; i < na; i++) { alpha.push(dv.getUint32(o) / 4096); o += 4 + 4 + 2; }
    return color.every((v) => v >= 0 && v <= 1) && alpha.every((v) => v >= 0 && v <= 1) ? { color, alpha, method } : null;
  } catch {
    return null;
  }
}

function gradientType(t: string | undefined): GradientType {
  return (['linear', 'radial', 'angle', 'reflected', 'diamond'].includes(t ?? '') ? t : 'linear') as GradientType;
}

// ---------------------------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------------------------
function levelsFrom(c: Ag.LevelsAdjustmentChannel | undefined): LevelsChannel {
  if (!c) return { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
  return { inBlack: c.shadowInput, inWhite: c.highlightInput, gamma: c.midtoneInput || 1, outBlack: c.shadowOutput, outWhite: c.highlightOutput };
}
function levelsTo(c: LevelsChannel): Ag.LevelsAdjustmentChannel {
  return { shadowInput: c.inBlack, highlightInput: c.inWhite, midtoneInput: c.gamma, shadowOutput: c.outBlack, highlightOutput: c.outWhite };
}
function curveFrom(c: Ag.CurvesAdjustmentChannel | undefined): CurvePoint[] {
  if (!c || c.length < 2) return [{ x: 0, y: 0 }, { x: 255, y: 255 }];
  return c.map((p) => ({ x: p.input, y: p.output }));
}
function curveTo(c: CurvePoint[]): Ag.CurvesAdjustmentChannel {
  return c.map((p) => ({ input: Math.round(p.x), output: Math.round(p.y) }));
}
const mix4 = (c: Ag.ChannelMixerChannel | undefined, d: [number, number, number, number]): [number, number, number, number] => (c ? [c.red, c.green, c.blue, c.constant] : d);

/** `gradientStops`: Gradient Map stop locations from the raw block (see gradientMapLocations). */
export function adjustmentFromPsd(a: Ag.AdjustmentLayer, gradientStops?: { color: number[]; alpha: number[]; method?: string }): { adjustment: Adjustment; partial?: string } {
  switch (a.type) {
    case 'brightness/contrast':
      return { adjustment: { type: 'brightnessContrast', brightness: a.brightness ?? 0, contrast: a.contrast ?? 0, useLegacy: !!a.useLegacy } };
    case 'levels':
      return { adjustment: { type: 'levels', rgb: levelsFrom(a.rgb), red: levelsFrom(a.red), green: levelsFrom(a.green), blue: levelsFrom(a.blue) } };
    case 'curves':
      return { adjustment: { type: 'curves', rgb: curveFrom(a.rgb), red: curveFrom(a.red), green: curveFrom(a.green), blue: curveFrom(a.blue) } };
    case 'exposure':
      return { adjustment: { type: 'exposure', exposure: a.exposure ?? 0, offset: a.offset ?? 0, gamma: a.gamma ?? 1 } };
    case 'vibrance':
      return { adjustment: { type: 'vibrance', vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 } };
    case 'hue/saturation': {
      // ag-psd's "master" record packs [colorize flag|pad, colorization H, S, L, master H, S, L].
      const m = a.master;
      const colorize = !!m && ((m.a >> 8) & 1) === 1;
      const keys = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const;
      const ranges: HueSatRange[] = keys.map((k, i) => {
        const c = a[k];
        return c
          ? { hue: c.hue, saturation: c.saturation, lightness: c.lightness, range: [c.a, c.b, c.c, c.d] as [number, number, number, number] }
          : { hue: 0, saturation: 0, lightness: 0, range: [...HUE_RANGES_DEFAULT[i]] as [number, number, number, number] };
      });
      const master = colorize ? { hue: m!.b, saturation: m!.c, lightness: m!.d } : { hue: m?.hue ?? 0, saturation: m?.saturation ?? 0, lightness: m?.lightness ?? 0 };
      return { adjustment: { type: 'hueSaturation', colorize, master, ranges } };
    }
    case 'color balance': {
      const t = (v: Ag.ColorBalanceValues | undefined): [number, number, number] => (v ? [v.cyanRed, v.magentaGreen, v.yellowBlue] : [0, 0, 0]);
      return { adjustment: { type: 'colorBalance', shadows: t(a.shadows), midtones: t(a.midtones), highlights: t(a.highlights), preserveLuminosity: a.preserveLuminosity ?? true } };
    }
    case 'black & white':
      return {
        adjustment: {
          type: 'blackWhite', reds: a.reds ?? 40, yellows: a.yellows ?? 60, greens: a.greens ?? 40, cyans: a.cyans ?? 60, blues: a.blues ?? 20, magentas: a.magentas ?? 80,
          tint: !!a.useTint, tintColor: colorFromPsd(a.tintColor, { r: 0.88, g: 0.77, b: 0.6 }),
        },
      };
    case 'photo filter':
      return { adjustment: { type: 'photoFilter', color: photoFilterColorFromPsd(a.color), density: Math.round((a.density ?? 0.25) * 100), preserveLuminosity: a.preserveLuminosity ?? true } };
    case 'channel mixer':
      return { adjustment: { type: 'channelMixer', monochrome: !!a.monochrome, red: mix4(a.red, [100, 0, 0, 0]), green: mix4(a.green, [0, 100, 0, 0]), blue: mix4(a.blue, [0, 0, 100, 0]), gray: mix4(a.gray, [40, 40, 20, 0]) } };
    case 'color lookup':
      return { adjustment: { type: 'colorLookup', name: a.name ?? a.lut3DFileName ?? 'Lookup', lut: null, lutFileName: a.lut3DFileName, preserved: a }, partial: 'Color Lookup table data is preserved; rendering uses the embedded .cube data when available.' };
    case 'invert':
      return { adjustment: { type: 'invert' } };
    case 'posterize':
      return { adjustment: { type: 'posterize', levels: a.levels ?? 4 } };
    case 'threshold':
      return { adjustment: { type: 'threshold', level: a.level ?? 128 } };
    case 'gradient map': {
      const method = gradientStops ? gradientStops.method : (a as { method?: string }).method;
      const base = defaultAdjustment('gradientMap') as Extract<Adjustment, { type: 'gradientMap' }>;
      if (a.gradientType !== 'solid') return { adjustment: { ...base, reverse: !!a.reverse, dither: !!a.dither }, partial: 'Noise gradient maps render as a black→white gradient (original data preserved).' };
      const g = gradientFromPsd({ name: a.name ?? 'Gradient', type: 'solid', smoothness: a.smoothness, colorStops: a.colorStops ?? [], opacityStops: a.opacityStops ?? [] }, method, gradientStops);
      return { adjustment: { type: 'gradientMap', gradient: g, reverse: !!a.reverse, dither: !!a.dither } };
    }
    case 'selective color': {
      const keys: SelectiveColorKey[] = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];
      const colors = Object.fromEntries(keys.map((k) => [k, a[k] ? { c: a[k]!.c, m: a[k]!.m, y: a[k]!.y, k: a[k]!.k } : { c: 0, m: 0, y: 0, k: 0 }])) as Record<SelectiveColorKey, { c: number; m: number; y: number; k: number }>;
      return { adjustment: { type: 'selectiveColor', mode: a.mode ?? 'relative', colors } };
    }
  }
  return { adjustment: { type: 'invert' }, partial: 'Unknown adjustment' };
}

export function adjustmentToPsd(adj: Adjustment): Ag.AdjustmentLayer {
  switch (adj.type) {
    case 'brightnessContrast':
      return { type: 'brightness/contrast', brightness: adj.brightness, contrast: adj.contrast, useLegacy: adj.useLegacy, meanValue: 127, labColorOnly: false, auto: false };
    case 'levels':
      return { type: 'levels', rgb: levelsTo(adj.rgb), red: levelsTo(adj.red), green: levelsTo(adj.green), blue: levelsTo(adj.blue) };
    case 'curves':
      return { type: 'curves', rgb: curveTo(adj.rgb), red: curveTo(adj.red), green: curveTo(adj.green), blue: curveTo(adj.blue) };
    case 'exposure':
      return { type: 'exposure', exposure: adj.exposure, offset: adj.offset, gamma: adj.gamma };
    case 'vibrance':
      return { type: 'vibrance', vibrance: adj.vibrance, saturation: adj.saturation };
    case 'hueSaturation': {
      const keys = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const;
      const out: Ag.HueSaturationAdjustment = {
        type: 'hue/saturation',
        master: adj.colorize
          ? { a: 256, b: adj.master.hue, c: adj.master.saturation, d: adj.master.lightness, hue: 0, saturation: 0, lightness: 0 }
          : { a: 0, b: 0, c: 25, d: 0, hue: adj.master.hue, saturation: adj.master.saturation, lightness: adj.master.lightness },
      };
      keys.forEach((k, i) => {
        const r = adj.ranges[i];
        if (r) out[k] = { a: r.range[0], b: r.range[1], c: r.range[2], d: r.range[3], hue: r.hue, saturation: r.saturation, lightness: r.lightness };
      });
      return out;
    }
    case 'colorBalance': {
      const t = (v: [number, number, number]) => ({ cyanRed: v[0], magentaGreen: v[1], yellowBlue: v[2] });
      return { type: 'color balance', shadows: t(adj.shadows), midtones: t(adj.midtones), highlights: t(adj.highlights), preserveLuminosity: adj.preserveLuminosity };
    }
    case 'blackWhite':
      return { type: 'black & white', reds: adj.reds, yellows: adj.yellows, greens: adj.greens, cyans: adj.cyans, blues: adj.blues, magentas: adj.magentas, useTint: adj.tint, tintColor: colorToPsd(adj.tintColor) };
    case 'photoFilter':
      return { type: 'photo filter', color: photoFilterColorToPsd(adj.color), density: adj.density / 100, preserveLuminosity: adj.preserveLuminosity };
    case 'channelMixer': {
      const c = (v: [number, number, number, number]) => ({ red: v[0], green: v[1], blue: v[2], constant: v[3] });
      return { type: 'channel mixer', monochrome: adj.monochrome, red: c(adj.red), green: c(adj.green), blue: c(adj.blue), gray: c(adj.gray) };
    }
    case 'colorLookup':
      return (adj.preserved as Ag.ColorLookupAdjustment) ?? { type: 'color lookup', name: adj.name };
    case 'invert':
      return { type: 'invert' };
    case 'posterize':
      return { type: 'posterize', levels: adj.levels };
    case 'threshold':
      return { type: 'threshold', level: adj.level };
    case 'gradientMap': {
      const g = gradientToPsd(adj.gradient);
      return { type: 'gradient map', name: g.name, gradientType: 'solid', reverse: adj.reverse, dither: adj.dither, smoothness: g.smoothness, colorStops: g.colorStops, opacityStops: g.opacityStops };
      // The method is added to the raw 'grdm' block on export (ag-psd's writer cannot encode it).
    }
    case 'selectiveColor':
      return { type: 'selective color', mode: adj.mode, ...Object.fromEntries(Object.entries(adj.colors).map(([k, v]) => [k, { ...v }])) };
  }
}

// ---------------------------------------------------------------------------------------------
// Layer effects
// ---------------------------------------------------------------------------------------------
function shadowFrom(s: Ag.LayerEffectShadow, res: number): ShadowEffect {
  return {
    enabled: s.enabled !== false,
    blendMode: blendFromPsd(s.blendMode, 'multiply'),
    opacity: s.opacity ?? 0.75,
    color: colorFromPsd(s.color),
    angle: s.angle ?? 120,
    useGlobalLight: s.useGlobalLight ?? true,
    distance: unitPx(s.distance, 5, res),
    spread: unitPx(s.choke, 0),
    size: unitPx(s.size, 5, res),
    noise: 0,
    contour: s.contour?.curve ? s.contour.curve.map((p) => ({ x: p.x, y: p.y })) : null,
    layerKnocksOut: s.layerConceals ?? true,
  };
}
function shadowTo(s: ShadowEffect): Ag.LayerEffectShadow {
  return {
    present: true, showInDialog: true, enabled: s.enabled, blendMode: blendToPsd(s.blendMode), opacity: s.opacity, color: colorToPsd(s.color), angle: s.angle,
    useGlobalLight: s.useGlobalLight, distance: px(s.distance), choke: px(s.spread), size: px(s.size), antialiased: false, layerConceals: s.layerKnocksOut,
    ...(s.contour ? { contour: { name: 'Custom', curve: s.contour.map((p) => ({ x: p.x, y: p.y })) } } : {}),
  };
}
function glowFrom(g: Ag.LayerEffectsOuterGlow | Ag.LayerEffectInnerGlow, res: number): GlowEffect {
  return {
    enabled: g.enabled !== false, blendMode: blendFromPsd(g.blendMode, 'screen'), opacity: g.opacity ?? 0.75, color: colorFromPsd(g.color, { r: 1, g: 1, b: 0.745 }),
    gradient: null, technique: (g as Ag.LayerEffectInnerGlow).technique === 'precise' ? 'precise' : 'softer', spread: unitPx(g.choke, 0), size: unitPx(g.size, 5, res),
    range: (g.range ?? 0.5) * 100, noise: (g.noise ?? 0) * 100, contour: g.contour?.curve ? g.contour.curve.map((p) => ({ x: p.x, y: p.y })) : null,
  };
}
function glowTo(g: GlowEffect): Ag.LayerEffectsOuterGlow {
  return { present: true, showInDialog: true, enabled: g.enabled, blendMode: blendToPsd(g.blendMode), opacity: g.opacity, color: colorToPsd(g.color), choke: px(g.spread), size: px(g.size), range: g.range / 100, noise: g.noise / 100, antialiased: false, ...(g.contour ? { contour: { name: 'Custom', curve: g.contour.map((p) => ({ x: p.x, y: p.y })) } } : {}) };
}

export function effectsFromPsd(e: Ag.LayerEffectsInfo, res: number): LayerEffects {
  const fx = emptyEffects();
  fx.enabled = !e.disabled;
  fx.scale = e.scale ?? 1;
  fx.dropShadow = (e.dropShadow ?? []).map((s) => shadowFrom(s, res));
  fx.innerShadow = (e.innerShadow ?? []).map((s) => ({ ...shadowFrom(s, res), layerKnocksOut: false }));
  if (e.outerGlow) fx.outerGlow = glowFrom(e.outerGlow, res);
  if (e.innerGlow) fx.innerGlow = { ...glowFrom(e.innerGlow, res), source: e.innerGlow.source === 'center' ? 'center' : 'edge' } as InnerGlowEffect;
  if (e.bevel) {
    const b = e.bevel;
    const styles: Record<string, BevelEffect['style']> = { 'outer bevel': 'outerBevel', 'inner bevel': 'innerBevel', emboss: 'emboss', 'pillow emboss': 'pillowEmboss', 'stroke emboss': 'strokeEmboss' };
    const tech: Record<string, BevelEffect['technique']> = { smooth: 'smooth', 'chisel hard': 'chiselHard', 'chisel soft': 'chiselSoft' };
    fx.bevel = {
      enabled: b.enabled !== false, style: styles[b.style ?? 'inner bevel'] ?? 'innerBevel', technique: tech[b.technique ?? 'smooth'] ?? 'smooth', depth: (b.strength ?? 1) * 100, // ag-psd: strength as a fraction (1 = 100 %)
      direction: b.direction === 'down' ? 'down' : 'up', size: unitPx(b.size, 5, res), soften: unitPx(b.soften, 0, res), angle: b.angle ?? 120, altitude: b.altitude ?? 30,
      useGlobalLight: b.useGlobalLight ?? true, highlightMode: blendFromPsd(b.highlightBlendMode, 'screen'), highlightColor: colorFromPsd(b.highlightColor, { r: 1, g: 1, b: 1 }),
      highlightOpacity: b.highlightOpacity ?? 0.75, shadowMode: blendFromPsd(b.shadowBlendMode, 'multiply'), shadowColor: colorFromPsd(b.shadowColor), shadowOpacity: b.shadowOpacity ?? 0.75, contour: null,
    };
  }
  if (e.satin) {
    const s = e.satin;
    fx.satin = { enabled: s.enabled !== false, blendMode: blendFromPsd(s.blendMode, 'multiply'), opacity: s.opacity ?? 0.5, color: colorFromPsd(s.color), angle: s.angle ?? 19, distance: unitPx(s.distance, 11, res), size: unitPx(s.size, 14, res), invert: s.invert ?? true, contour: null };
  }
  fx.colorOverlay = (e.solidFill ?? []).map((s) => ({ enabled: s.enabled !== false, blendMode: blendFromPsd(s.blendMode), opacity: s.opacity ?? 1, color: colorFromPsd(s.color, { r: 1, g: 0, b: 0 }) }));
  fx.gradientOverlay = (e.gradientOverlay ?? []).map((g) => ({
    enabled: g.enabled !== false, blendMode: blendFromPsd(g.blendMode), opacity: g.opacity ?? 1, gradient: gradientFromPsd(g.gradient, g.interpolationMethod), style: gradientType(g.type), angle: g.angle ?? 90,
    scale: (g.scale ?? 1) * 100, reverse: !!g.reverse, dither: !!g.dither, alignWithLayer: g.align ?? true, offsetX: g.offset?.x ?? 0, offsetY: g.offset?.y ?? 0,
  }));
  if (e.patternOverlay) {
    const p = e.patternOverlay;
    fx.patternOverlay = { enabled: p.enabled !== false, blendMode: blendFromPsd(p.blendMode), opacity: p.opacity ?? 1, patternId: p.pattern?.id ?? '', patternName: p.pattern?.name ?? '', scale: (p.scale ?? 1) * 100, phaseX: p.phase?.x ?? 0, phaseY: p.phase?.y ?? 0 };
  }
  fx.stroke = (e.stroke ?? []).map((s): StrokeEffect => ({
    enabled: s.enabled !== false, blendMode: blendFromPsd(s.blendMode), opacity: s.opacity ?? 1, size: unitPx(s.size, 3, res), position: s.position ?? 'outside',
    fillType: s.fillType ?? 'color', color: colorFromPsd(s.color), gradient: s.gradient ? gradientFromPsd(s.gradient, (s.gradient as Ag.ExtraGradientInfo).interpolationMethod) : null, gradientStyle: gradientType(s.gradient?.style), gradientAngle: s.gradient?.angle ?? 90, patternId: s.pattern?.id ?? null,
  }));
  return fx;
}

export function effectsToPsd(fx: LayerEffects): Ag.LayerEffectsInfo {
  const out: Ag.LayerEffectsInfo = { disabled: !fx.enabled, scale: fx.scale };
  if (fx.dropShadow.length) out.dropShadow = fx.dropShadow.map(shadowTo);
  if (fx.innerShadow.length) out.innerShadow = fx.innerShadow.map(shadowTo);
  if (fx.outerGlow) out.outerGlow = glowTo(fx.outerGlow);
  if (fx.innerGlow) out.innerGlow = { ...glowTo(fx.innerGlow), source: fx.innerGlow.source, technique: fx.innerGlow.technique };
  if (fx.bevel) {
    const b = fx.bevel;
    const styles: Record<BevelEffect['style'], Ag.BevelStyle> = { outerBevel: 'outer bevel', innerBevel: 'inner bevel', emboss: 'emboss', pillowEmboss: 'pillow emboss', strokeEmboss: 'stroke emboss' };
    const tech: Record<BevelEffect['technique'], Ag.BevelTechnique> = { smooth: 'smooth', chiselHard: 'chisel hard', chiselSoft: 'chisel soft' };
    out.bevel = {
      present: true, showInDialog: true, enabled: b.enabled, style: styles[b.style], technique: tech[b.technique], strength: b.depth / 100, direction: b.direction, size: px(b.size), soften: px(b.soften),
      angle: b.angle, altitude: b.altitude, useGlobalLight: b.useGlobalLight, highlightBlendMode: blendToPsd(b.highlightMode), highlightColor: colorToPsd(b.highlightColor),
      highlightOpacity: b.highlightOpacity, shadowBlendMode: blendToPsd(b.shadowMode), shadowColor: colorToPsd(b.shadowColor), shadowOpacity: b.shadowOpacity,
    };
  }
  if (fx.satin) {
    const s = fx.satin;
    out.satin = { present: true, showInDialog: true, enabled: s.enabled, blendMode: blendToPsd(s.blendMode), opacity: s.opacity, color: colorToPsd(s.color), angle: s.angle, distance: px(s.distance), size: px(s.size), invert: s.invert, antialiased: false };
  }
  if (fx.colorOverlay.length) out.solidFill = fx.colorOverlay.map((c) => ({ present: true, showInDialog: true, enabled: c.enabled, blendMode: blendToPsd(c.blendMode), opacity: c.opacity, color: colorToPsd(c.color) }));
  if (fx.gradientOverlay.length)
    out.gradientOverlay = fx.gradientOverlay.map((g) => ({
      present: true, showInDialog: true, enabled: g.enabled, blendMode: blendToPsd(g.blendMode), opacity: g.opacity, gradient: gradientToPsd(g.gradient), type: g.style, angle: g.angle, interpolationMethod: g.gradient.interpolation,
      scale: g.scale / 100, reverse: g.reverse, dither: g.dither, align: g.alignWithLayer, offset: { x: g.offsetX, y: g.offsetY },
    }));
  if (fx.patternOverlay) {
    const p = fx.patternOverlay;
    out.patternOverlay = { present: true, showInDialog: true, enabled: p.enabled, blendMode: blendToPsd(p.blendMode), opacity: p.opacity, scale: p.scale / 100, pattern: { name: p.patternName, id: p.patternId }, phase: { x: p.phaseX, y: p.phaseY } };
  }
  if (fx.stroke.length)
    out.stroke = fx.stroke.map((s) => ({
      present: true, showInDialog: true, enabled: s.enabled, blendMode: blendToPsd(s.blendMode), opacity: s.opacity, size: px(s.size), position: s.position, fillType: s.fillType,
      color: colorToPsd(s.color), gradient: s.gradient ? { ...gradientToPsd(s.gradient), style: s.gradientStyle, angle: s.gradientAngle, interpolationMethod: s.gradient.interpolation } : undefined,
    }));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------
const JUST_TO: Record<string, TextAlign> = { left: 'left', right: 'right', center: 'center', 'justify-left': 'justifyLeft', 'justify-right': 'justifyRight', 'justify-center': 'justifyCenter', 'justify-all': 'justifyAll' };
const JUST_FROM: Record<TextAlign, Ag.Justification> = { left: 'left', right: 'right', center: 'center', justifyLeft: 'justify-left', justifyRight: 'justify-right', justifyCenter: 'justify-center', justifyAll: 'justify-all' };

/** Maps a PostScript name like "Arial-BoldItalicMT" to family/style hints. */
export function fontHintsFromPostScript(ps: string): { family: string; style: string; weight: number; italic: boolean } {
  const cleaned = ps.replace(/(PS)?MT$|PS$/, '');
  const [fam, sty = 'Regular'] = cleaned.split('-');
  // "SegoeUIEmoji" → "Segoe UI Emoji", "TimesNewRoman" → "Times New Roman", "SegoeUI" → "Segoe UI".
  const family = fam.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const s = sty.toLowerCase();
  const weight = /black|heavy/.test(s) ? 900 : /extrabold|ultrabold/.test(s) ? 800 : /bold/.test(s) ? 700 : /semibold|demibold/.test(s) ? 600 : /medium/.test(s) ? 500 : /extralight|ultralight/.test(s) ? 200 : /light/.test(s) ? 300 : /thin|hairline/.test(s) ? 100 : 400;
  return { family, style: sty.replace(/([a-z])([A-Z])/g, '$1 $2'), weight, italic: /italic|oblique/.test(s) };
}

function styleFrom(s: Ag.TextStyle | undefined, base: CharacterStyle): CharacterStyle {
  const out: CharacterStyle = { ...base, color: { ...base.color }, openTypeFeatures: [...base.openTypeFeatures], variationAxes: { ...base.variationAxes } };
  if (!s) return out;
  if (s.font?.name) {
    const h = fontHintsFromPostScript(s.font.name);
    out.postScriptName = s.font.name;
    if (s.font.type !== undefined) out.fontType = s.font.type;
    if (s.font.script !== undefined) out.fontScript = s.font.script;
    out.fontFamily = h.family;
    out.fontStyleName = h.style;
    out.fontWeight = h.weight;
    out.italic = h.italic;
  }
  if (s.fontSize !== undefined) out.fontSize = s.fontSize;
  if (s.autoLeading === false && s.leading !== undefined) out.leading = s.leading;
  else if (s.autoLeading) out.leading = null;
  if (s.tracking !== undefined) out.tracking = s.tracking;
  if (s.autoKerning !== undefined) out.kerning = s.autoKerning ? 'metrics' : 'none';
  if (s.baselineShift !== undefined) out.baselineShift = s.baselineShift;
  if (s.horizontalScale !== undefined) out.horizontalScale = s.horizontalScale;
  if (s.verticalScale !== undefined) out.verticalScale = s.verticalScale;
  if (s.fillColor) { const c = colorFromPsd(s.fillColor); out.color = { ...c, a: 1 }; }
  if (s.fauxBold !== undefined) out.fauxBold = s.fauxBold;
  if (s.fauxItalic !== undefined) out.fauxItalic = s.fauxItalic;
  if (s.underline !== undefined) out.underline = s.underline;
  if (s.strikethrough !== undefined) out.strikethrough = s.strikethrough;
  if (s.fontCaps !== undefined) out.textCase = s.fontCaps === 2 ? 'allCaps' : s.fontCaps === 1 ? 'smallCaps' : 'none';
  if (s.fontBaseline !== undefined) out.baseline = s.fontBaseline === 1 ? 'superscript' : s.fontBaseline === 2 ? 'subscript' : 'normal';
  if (s.ligatures !== undefined) out.ligatures = s.ligatures;
  return out;
}

/**
 * Tells the PSD writer whether an installed font has TrueType outlines (Photoshop records the font
 * type in the text engine data and measures the text accordingly); set by the app's text engine.
 */
let fontTypeOf: (postScriptName: string) => number | undefined = () => undefined;
export function setFontTypeResolver(fn: (postScriptName: string) => number | undefined): void {
  fontTypeOf = fn;
}
export function fontTypeFor(postScriptName: string): number | undefined {
  return fontTypeOf(postScriptName);
}

/**
 * Photoshop finds a text layer's font by its PostScript name only ("ArialMT", not "Arial"): a
 * guessed name makes it report the font as missing. Text whose font was chosen by family (new
 * text, or a family picked in Celenne) has no stored PostScript name; the app's installed fonts
 * give the real one, and well-known Windows fonts are named here for when they are not listed.
 */
let psNameOf: (s: CharacterStyle) => string | undefined = () => undefined;
export function setPostScriptNameResolver(fn: (s: CharacterStyle) => string | undefined): void {
  psNameOf = fn;
}
const KNOWN_PS: Record<string, string> = {
  'arial': 'ArialMT', 'arial-bold': 'Arial-BoldMT', 'arial-italic': 'Arial-ItalicMT', 'arial-bolditalic': 'Arial-BoldItalicMT',
  'times new roman': 'TimesNewRomanPSMT', 'times new roman-bold': 'TimesNewRomanPS-BoldMT', 'times new roman-italic': 'TimesNewRomanPS-ItalicMT', 'times new roman-bolditalic': 'TimesNewRomanPS-BoldItalicMT',
  'courier new': 'CourierNewPSMT', 'courier new-bold': 'CourierNewPS-BoldMT', 'courier new-italic': 'CourierNewPS-ItalicMT', 'courier new-bolditalic': 'CourierNewPS-BoldItalicMT',
  'arial black': 'Arial-Black', 'segoe ui': 'SegoeUI', 'segoe ui-bold': 'SegoeUI-Bold', 'leelawadee ui': 'LeelawadeeUI', 'leelawadee ui-bold': 'LeelawadeeUI-Bold',
  'cordia new': 'CordiaNew', 'cordia new-bold': 'CordiaNew-Bold', 'angsana new': 'AngsanaNew', 'angsana new-bold': 'AngsanaNew-Bold',
  'tahoma': 'Tahoma', 'tahoma-bold': 'Tahoma-Bold', 'verdana': 'Verdana', 'verdana-bold': 'Verdana-Bold', 'georgia': 'Georgia', 'georgia-bold': 'Georgia-Bold',
  'calibri': 'Calibri', 'calibri-bold': 'Calibri-Bold', 'trebuchet ms': 'TrebuchetMS', 'impact': 'Impact', 'comic sans ms': 'ComicSansMS',
};
/** The PostScript name Celenne writes for a character style. */
export function postScriptNameFor(s: CharacterStyle): string {
  if (s.postScriptName) return s.postScriptName;
  const resolved = psNameOf(s);
  if (resolved) return resolved;
  const style = (s.fontStyleName ?? '').replace(/\s+/g, '').toLowerCase();
  const key = s.fontFamily.toLowerCase() + (style && style !== 'regular' ? '-' + style : '');
  return KNOWN_PS[key] ?? `${s.fontFamily.replace(/\s+/g, '')}${s.fontStyleName && s.fontStyleName !== 'Regular' ? '-' + s.fontStyleName.replace(/\s+/g, '') : ''}`;
}

function styleTo(s: CharacterStyle): Ag.TextStyle {
  const name = postScriptNameFor(s);
  const type = s.fontType ?? fontTypeOf(name);
  return {
    font: { name, ...(type !== undefined ? { type } : {}), ...(s.fontScript !== undefined ? { script: s.fontScript } : {}) },
    fontSize: s.fontSize,
    autoLeading: s.leading === null,
    leading: s.leading ?? s.fontSize * 1.2,
    tracking: s.tracking,
    autoKerning: s.kerning !== 'none',
    kerning: 0,
    baselineShift: s.baselineShift,
    horizontalScale: s.horizontalScale,
    verticalScale: s.verticalScale,
    fillColor: colorToPsd(s.color),
    fauxBold: s.fauxBold,
    fauxItalic: s.fauxItalic,
    underline: s.underline,
    strikethrough: s.strikethrough,
    fontCaps: s.textCase === 'allCaps' ? 2 : s.textCase === 'smallCaps' ? 1 : 0,
    fontBaseline: s.baseline === 'superscript' ? 1 : s.baseline === 'subscript' ? 2 : 0,
    ligatures: s.ligatures,
  };
}

function paraFrom(p: Ag.ParagraphStyle | undefined, base: ParagraphStyle): ParagraphStyle {
  const out = { ...base };
  if (!p) return out;
  if (p.justification) out.align = JUST_TO[p.justification] ?? 'left';
  if (p.firstLineIndent !== undefined) out.indentFirst = p.firstLineIndent;
  if (p.startIndent !== undefined) out.indentStart = p.startIndent;
  if (p.endIndent !== undefined) out.indentEnd = p.endIndent;
  if (p.spaceBefore !== undefined) out.spaceBefore = p.spaceBefore;
  if (p.spaceAfter !== undefined) out.spaceAfter = p.spaceAfter;
  if (p.autoHyphenate !== undefined) out.hyphenate = p.autoHyphenate;
  if (p.everyLineComposer !== undefined) out.composer = p.everyLineComposer ? 'every' : 'single';
  const triple = (v: number[] | undefined): [number, number, number] | undefined => (v && v.length === 3 && v.every((x) => Number.isFinite(x)) ? [v[0], v[1], v[2]] : undefined);
  out.wordSpacing = triple(p.wordSpacing) ?? out.wordSpacing;
  out.letterSpacing = triple(p.letterSpacing) ?? out.letterSpacing;
  out.glyphScaling = triple(p.glyphSpacing) ?? out.glyphScaling;
  if (p.autoLeading !== undefined && p.autoLeading > 0) out.autoLeading = p.autoLeading;
  if (p.hyphenatedWordSize !== undefined || p.zone !== undefined) {
    const h = out.hyphenation ?? PARAGRAPH_DEFAULTS.hyphenation;
    out.hyphenation = { minWord: p.hyphenatedWordSize ?? h.minWord, afterFirst: p.preHyphen ?? h.afterFirst, beforeLast: p.postHyphen ?? h.beforeLast, limit: p.consecutiveHyphens ?? h.limit, zone: p.zone ?? h.zone, capitalized: h.capitalized };
  }
  if (p.hanging !== undefined) out.hanging = p.hanging;
  return out;
}

function paraTo(p: ParagraphStyle): Ag.ParagraphStyle {
  const d = PARAGRAPH_DEFAULTS, h = p.hyphenation ?? d.hyphenation;
  return {
    justification: JUST_FROM[p.align], firstLineIndent: p.indentFirst, startIndent: p.indentStart, endIndent: p.indentEnd, spaceBefore: p.spaceBefore, spaceAfter: p.spaceAfter, autoHyphenate: p.hyphenate,
    everyLineComposer: (p.composer ?? d.composer) === 'every', wordSpacing: [...(p.wordSpacing ?? d.wordSpacing)], letterSpacing: [...(p.letterSpacing ?? d.letterSpacing)], glyphSpacing: [...(p.glyphScaling ?? d.glyphScaling)],
    autoLeading: p.autoLeading ?? d.autoLeading, hyphenatedWordSize: h.minWord, preHyphen: h.afterFirst, postHyphen: h.beforeLast, consecutiveHyphens: h.limit, zone: h.zone, hanging: p.hanging ?? d.hanging,
  };
}

export function textFromPsd(t: Ag.LayerTextData): TextData {
  const text = (t.text ?? '').replace(/\r\n?/g, '\n');
  const baseStyle = styleFrom(t.style, defaultCharacterStyle());
  const basePara = paraFrom(t.paragraphStyle, defaultParagraphStyle());
  const runs: StyleRun<CharacterStyle>[] = t.styleRuns?.length ? t.styleRuns.map((r) => ({ length: r.length, style: styleFrom(r.style, baseStyle) })) : [{ length: text.length, style: baseStyle }];
  const paragraphs: StyleRun<ParagraphStyle>[] = t.paragraphStyleRuns?.length ? t.paragraphStyleRuns.map((r) => ({ length: r.length, style: paraFrom(r.style, basePara) })) : [{ length: text.length, style: basePara }];
  const tr = t.transform ?? [1, 0, 0, 1, t.left ?? 0, t.top ?? 0];
  const box = t.shapeType === 'box' && t.boxBounds ? { x: t.boxBounds[0], y: t.boxBounds[1], w: t.boxBounds[2] - t.boxBounds[0], h: t.boxBounds[3] - t.boxBounds[1] } : null;
  const aa = t.antiAlias;
  return {
    text,
    runs,
    paragraphs,
    kind: box ? 'paragraph' : 'point',
    box,
    orientation: t.orientation === 'vertical' ? 'vertical' : 'horizontal',
    transform: [tr[0], tr[1], tr[2], tr[3], tr[4], tr[5]],
    antiAlias: aa === 'none' ? 'none' : aa === 'sharp' ? 'sharp' : aa === 'crisp' ? 'crisp' : aa === 'strong' ? 'strong' : 'smooth',
    warp: t.warp && t.warp.style && t.warp.style !== 'none' ? ({ ...t.warp } as TextWarp) : undefined,
  };
}

export function textToPsd(t: TextData, original?: Ag.LayerTextData): Ag.LayerTextData {
  const runs = t.runs.filter((r) => r.length > 0);
  const out: Ag.LayerTextData = {
    ...(original ?? {}),
    text: t.text,
    transform: [...t.transform],
    antiAlias: t.antiAlias,
    orientation: t.orientation,
    style: styleTo(runs[0]?.style ?? defaultCharacterStyle()),
    styleRuns: runs.map((r) => ({ length: r.length, style: styleTo(r.style) })),
    paragraphStyle: paraTo(t.paragraphs[0]?.style ?? defaultParagraphStyle()),
    paragraphStyleRuns: runsPerParagraph(t).map((p) => ({ length: p.length, style: paraTo(p.style) })),
    shapeType: t.kind === 'paragraph' ? 'box' : 'point',
  };
  if (t.path) {
    // Type on a path: Photoshop records it as a box spanning the path (its frame holds the path).
    const f = flattenTextPath(t.path.subpath);
    if (f) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < f.xs.length; i++) { x0 = Math.min(x0, f.xs[i]); x1 = Math.max(x1, f.xs[i]); y0 = Math.min(y0, f.ys[i]); y1 = Math.max(y1, f.ys[i]); }
      out.shapeType = 'box';
      out.boxBounds = [x0, y0, x1, y1];
    }
  } else if (t.kind === 'paragraph' && t.box) out.boxBounds = [t.box.x, t.box.y, t.box.x + t.box.w, t.box.y + t.box.h];
  else delete out.boxBounds;
  if (t.warp) out.warp = t.warp as Ag.Warp;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Vector
// ---------------------------------------------------------------------------------------------
export function pathFromPsd(paths: Ag.BezierPath[]): VectorPath {
  const subpaths: SubPath[] = paths.map((p) => ({ closed: !p.open, op: (p.operation ?? 'combine') as SubPath['op'], knots: p.knots.map((k) => knotFromPsd(k.points, k.linked)) }));
  return { subpaths, fillRule: paths[0]?.fillRule === 'even-odd' ? 'evenodd' : 'nonzero' };
}

export function pathToPsd(path: VectorPath): Ag.BezierPath[] {
  return path.subpaths.map((s) => ({ open: !s.closed, operation: s.op, knots: s.knots.map(knotToPsd), fillRule: path.fillRule === 'evenodd' ? 'even-odd' : 'non-zero' }));
}

export function paintFromPsd(v: Ag.VectorContent | undefined): Paint {
  if (!v) return { type: 'none' };
  if (v.type === 'color') return { type: 'solid', color: colorFromPsd(v.color) };
  if (v.type === 'solid' || v.type === 'noise') {
    const g = v as Ag.EffectSolidGradient & Ag.ExtraGradientInfo;
    return { type: 'gradient', gradient: gradientFromPsd(g, g.interpolationMethod), style: gradientType(g.style), angle: g.angle ?? 0, scale: (g.scale ?? 1) * 100, reverse: !!g.reverse, dither: !!g.dither };
  }
  if (v.type === 'pattern') return { type: 'pattern', patternId: v.id, scale: 100 };
  return { type: 'none' };
}

export function paintToPsd(p: Paint): Ag.VectorContent | undefined {
  switch (p.type) {
    case 'solid': return { type: 'color', color: colorToPsd(p.color) };
    case 'gradient': return { ...gradientToPsd(p.gradient), style: p.style, angle: p.angle, scale: p.scale / 100, reverse: p.reverse, dither: p.dither, interpolationMethod: p.gradient.interpolation };
    case 'pattern': return { type: 'pattern', name: p.patternId, id: p.patternId };
    default: return undefined;
  }
}
