/** Color value types. All components are normalized floats unless stated otherwise. */
export interface RGB {
  r: number;
  g: number;
  b: number;
  /**
   * Exact values chosen in another colour model (CMYK / Lab documents). Valid only while
   * `r, g, b` still equal the values stored with them (see color/plates.ts).
   */
  exact?: ExactColor;
}

export interface ExactColor {
  r: number;
  g: number;
  b: number;
  /** Ink 0..1. */
  cmyk?: [number, number, number, number];
  /** L 0..100, a / b −128..127. */
  lab?: [number, number, number];
}

export interface RGBA extends RGB {
  a: number;
}

export const BLACK: RGBA = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });
export const WHITE: RGBA = Object.freeze({ r: 1, g: 1, b: 1, a: 1 });

export function rgba(r: number, g: number, b: number, a = 1): RGBA {
  return { r, g, b, a };
}

export interface GradientColorStop {
  /** 0..1 along the gradient. */
  location: number;
  color: RGB;
  /** 0..1 position of the 50% blend point between the previous stop and this one (Photoshop's convention). */
  midpoint: number;
}

export interface GradientAlphaStop {
  location: number;
  opacity: number;
  midpoint: number;
}

export interface Gradient {
  name: string;
  colorStops: GradientColorStop[];
  alphaStops: GradientAlphaStop[];
  /** 0..1 — 1 gives smooth (eased) interpolation like a "Smoothness 100%" gradient. */
  smoothness: number;
  /** Photoshop's gradient method (2023+): undefined = Classic, as in older files. */
  interpolation?: 'classic' | 'linear' | 'perceptual' | 'smooth';
}

export type GradientType = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

export function simpleGradient(a: RGB, b: RGB, name = 'Custom'): Gradient {
  return {
    name,
    colorStops: [
      { location: 0, color: { ...a }, midpoint: 0.5 },
      { location: 1, color: { ...b }, midpoint: 0.5 },
    ],
    alphaStops: [
      { location: 0, opacity: 1, midpoint: 0.5 },
      { location: 1, opacity: 1, midpoint: 0.5 },
    ],
    smoothness: 1,
  };
}

export function transparentGradient(a: RGB, name = 'Foreground to Transparent'): Gradient {
  return {
    name,
    colorStops: [
      { location: 0, color: { ...a }, midpoint: 0.5 },
      { location: 1, color: { ...a }, midpoint: 0.5 },
    ],
    alphaStops: [
      { location: 0, opacity: 1, midpoint: 0.5 },
      { location: 1, opacity: 0, midpoint: 0.5 },
    ],
    smoothness: 1,
  };
}
