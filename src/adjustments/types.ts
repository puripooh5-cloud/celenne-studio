/** Non-destructive adjustment definitions. Parameters mirror the conventional UI ranges. */
import type { Gradient, RGB } from '../color/types';

export interface LevelsChannel {
  inBlack: number; // 0..253
  inWhite: number; // 2..255
  gamma: number; // 0.01..9.99
  outBlack: number; // 0..255
  outWhite: number; // 0..255
}

export interface CurvePoint {
  x: number; // 0..255 input
  y: number; // 0..255 output
}

export interface HueSatValues {
  hue: number; // -180..180
  saturation: number; // -100..100
  lightness: number; // -100..100
}

export interface HueSatRange extends HueSatValues {
  /** Range limits in degrees [falloffStart, start, end, falloffEnd] (may wrap). */
  range: [number, number, number, number];
}

export type ColorBalanceTriple = [number, number, number]; // cyan-red, magenta-green, yellow-blue (-100..100)

export type SelectiveColorKey = 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas' | 'whites' | 'neutrals' | 'blacks';
export interface CMYKPercent {
  c: number;
  m: number;
  y: number;
  k: number;
}

export interface Lut3D {
  size: number;
  /** RGB float triplets, red index fastest. */
  data: Float32Array;
}

export type Adjustment =
  | { type: 'brightnessContrast'; brightness: number; contrast: number; useLegacy: boolean }
  /**
   * Levels / Curves channels: `rgb` is the composite; `red`, `green`, `blue` are the first three
   * channels of the document (C, M, Y in CMYK; a and b in Lab, where `rgb` is Lightness);
   * `black` is the K channel of CMYK documents.
   */
  | { type: 'levels'; rgb: LevelsChannel; red: LevelsChannel; green: LevelsChannel; blue: LevelsChannel; black?: LevelsChannel }
  | { type: 'curves'; rgb: CurvePoint[]; red: CurvePoint[]; green: CurvePoint[]; blue: CurvePoint[]; black?: CurvePoint[] }
  | { type: 'exposure'; exposure: number; offset: number; gamma: number }
  | { type: 'vibrance'; vibrance: number; saturation: number }
  | { type: 'hueSaturation'; colorize: boolean; master: HueSatValues; ranges: HueSatRange[] }
  | { type: 'colorBalance'; shadows: ColorBalanceTriple; midtones: ColorBalanceTriple; highlights: ColorBalanceTriple; preserveLuminosity: boolean }
  | {
      type: 'blackWhite';
      reds: number;
      yellows: number;
      greens: number;
      cyans: number;
      blues: number;
      magentas: number;
      tint: boolean;
      tintColor: RGB;
    }
  | { type: 'photoFilter'; color: RGB; density: number; preserveLuminosity: boolean }
  | {
      type: 'channelMixer';
      monochrome: boolean;
      red: [number, number, number, number];
      green: [number, number, number, number];
      blue: [number, number, number, number];
      gray: [number, number, number, number];
    }
  | { type: 'colorLookup'; name: string; lut: Lut3D | null; lutFileName?: string; preserved?: unknown }
  | { type: 'invert' }
  | { type: 'posterize'; levels: number }
  | { type: 'threshold'; level: number }
  | { type: 'gradientMap'; gradient: Gradient; reverse: boolean; dither: boolean }
  | { type: 'selectiveColor'; mode: 'relative' | 'absolute'; colors: Record<SelectiveColorKey, CMYKPercent> };

export type AdjustmentType = Adjustment['type'];

export const ADJUSTMENT_LABELS: Record<AdjustmentType, string> = {
  brightnessContrast: 'Brightness/Contrast',
  levels: 'Levels',
  curves: 'Curves',
  exposure: 'Exposure',
  vibrance: 'Vibrance',
  hueSaturation: 'Hue/Saturation',
  colorBalance: 'Color Balance',
  blackWhite: 'Black & White',
  photoFilter: 'Photo Filter',
  channelMixer: 'Channel Mixer',
  colorLookup: 'Color Lookup',
  invert: 'Invert',
  posterize: 'Posterize',
  threshold: 'Threshold',
  gradientMap: 'Gradient Map',
  selectiveColor: 'Selective Color',
};

const lv = (): LevelsChannel => ({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
const curve = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 255, y: 255 }];

export const HUE_RANGES_DEFAULT: [number, number, number, number][] = [
  [315, 345, 15, 45], // reds
  [15, 45, 75, 105], // yellows
  [75, 105, 135, 165], // greens
  [135, 165, 195, 225], // cyans
  [195, 225, 255, 285], // blues
  [255, 285, 315, 345], // magentas
];

export function defaultAdjustment(type: AdjustmentType): Adjustment {
  switch (type) {
    case 'brightnessContrast':
      return { type, brightness: 0, contrast: 0, useLegacy: false };
    case 'levels':
      return { type, rgb: lv(), red: lv(), green: lv(), blue: lv() };
    case 'curves':
      return { type, rgb: curve(), red: curve(), green: curve(), blue: curve() };
    case 'exposure':
      return { type, exposure: 0, offset: 0, gamma: 1 };
    case 'vibrance':
      return { type, vibrance: 0, saturation: 0 };
    case 'hueSaturation':
      return {
        type,
        colorize: false,
        master: { hue: 0, saturation: 0, lightness: 0 },
        ranges: HUE_RANGES_DEFAULT.map((range) => ({ hue: 0, saturation: 0, lightness: 0, range: [...range] as [number, number, number, number] })),
      };
    case 'colorBalance':
      return { type, shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true };
    case 'blackWhite':
      return { type, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintColor: { r: 0.88, g: 0.77, b: 0.6 } };
    case 'photoFilter':
      return { type, color: { r: 0.925, g: 0.541, b: 0 }, density: 25, preserveLuminosity: true };
    case 'channelMixer':
      return { type, monochrome: false, red: [100, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0], gray: [40, 40, 20, 0] };
    case 'colorLookup':
      return { type, name: '', lut: null };
    case 'invert':
      return { type };
    case 'posterize':
      return { type, levels: 4 };
    case 'threshold':
      return { type, level: 128 };
    case 'gradientMap':
      return {
        type,
        reverse: false,
        dither: false,
        gradient: {
          name: 'Black, White',
          colorStops: [
            { location: 0, color: { r: 0, g: 0, b: 0 }, midpoint: 0.5 },
            { location: 1, color: { r: 1, g: 1, b: 1 }, midpoint: 0.5 },
          ],
          alphaStops: [
            { location: 0, opacity: 1, midpoint: 0.5 },
            { location: 1, opacity: 1, midpoint: 0.5 },
          ],
          smoothness: 1,
        },
      };
    case 'selectiveColor': {
      const z = (): CMYKPercent => ({ c: 0, m: 0, y: 0, k: 0 });
      return { type, mode: 'relative', colors: { reds: z(), yellows: z(), greens: z(), cyans: z(), blues: z(), magentas: z(), whites: z(), neutrals: z(), blacks: z() } };
    }
  }
}
