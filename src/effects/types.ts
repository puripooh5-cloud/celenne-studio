/** Layer style (effects) model. Every effect is editable and individually toggleable. */
import type { BlendMode } from '../image-engine/blend';
import type { Gradient, GradientType, RGB } from '../color/types';
import type { CurvePoint } from '../adjustments/types';

export interface EffectBase {
  enabled: boolean;
  blendMode: BlendMode;
  /** 0..1 */
  opacity: number;
}

export interface ShadowEffect extends EffectBase {
  color: RGB;
  angle: number; // degrees
  useGlobalLight: boolean;
  distance: number; // px
  spread: number; // 0..100 %
  size: number; // px
  noise: number; // 0..100 %
  contour: CurvePoint[] | null;
  /** Drop shadow only: layer knocks out the shadow beneath its own pixels. */
  layerKnocksOut: boolean;
}

export interface GlowEffect extends EffectBase {
  color: RGB;
  gradient: Gradient | null;
  technique: 'softer' | 'precise';
  spread: number; // outer glow spread / inner glow choke (%)
  size: number;
  range: number; // %
  noise: number; // %
  contour: CurvePoint[] | null;
}

export interface InnerGlowEffect extends GlowEffect {
  source: 'edge' | 'center';
}

export type BevelStyle = 'innerBevel' | 'outerBevel' | 'emboss' | 'pillowEmboss' | 'strokeEmboss';

export interface BevelEffect {
  enabled: boolean;
  style: BevelStyle;
  technique: 'smooth' | 'chiselHard' | 'chiselSoft';
  depth: number; // 1..1000 %
  direction: 'up' | 'down';
  size: number;
  soften: number;
  angle: number;
  altitude: number;
  useGlobalLight: boolean;
  highlightMode: BlendMode;
  highlightColor: RGB;
  highlightOpacity: number;
  shadowMode: BlendMode;
  shadowColor: RGB;
  shadowOpacity: number;
  contour: CurvePoint[] | null;
}

export interface SatinEffect extends EffectBase {
  color: RGB;
  angle: number;
  distance: number;
  size: number;
  invert: boolean;
  contour: CurvePoint[] | null;
}

export interface ColorOverlayEffect extends EffectBase {
  color: RGB;
}

export interface GradientOverlayEffect extends EffectBase {
  gradient: Gradient;
  style: GradientType;
  angle: number;
  scale: number; // %
  reverse: boolean;
  dither: boolean;
  alignWithLayer: boolean;
  offsetX: number; // % of layer
  offsetY: number;
}

export interface PatternOverlayEffect extends EffectBase {
  patternId: string;
  patternName: string;
  scale: number; // %
  phaseX: number;
  phaseY: number;
}

export interface StrokeEffect extends EffectBase {
  size: number;
  position: 'inside' | 'center' | 'outside';
  fillType: 'color' | 'gradient' | 'pattern';
  color: RGB;
  gradient: Gradient | null;
  gradientStyle: GradientType;
  gradientAngle: number;
  patternId: string | null;
}

export interface LayerEffects {
  /** Master switch ("Layer Effects" visibility eye). */
  enabled: boolean;
  scale: number;
  dropShadow: ShadowEffect[];
  innerShadow: ShadowEffect[];
  outerGlow: GlowEffect | null;
  innerGlow: InnerGlowEffect | null;
  bevel: BevelEffect | null;
  satin: SatinEffect | null;
  colorOverlay: ColorOverlayEffect[];
  gradientOverlay: GradientOverlayEffect[];
  patternOverlay: PatternOverlayEffect | null;
  stroke: StrokeEffect[];
}

export type EffectKind = 'dropShadow' | 'innerShadow' | 'outerGlow' | 'innerGlow' | 'bevel' | 'satin' | 'colorOverlay' | 'gradientOverlay' | 'patternOverlay' | 'stroke';

export const EFFECT_LABELS: Record<EffectKind, string> = {
  bevel: 'Bevel & Emboss',
  stroke: 'Stroke',
  innerShadow: 'Inner Shadow',
  innerGlow: 'Inner Glow',
  satin: 'Satin',
  colorOverlay: 'Color Overlay',
  gradientOverlay: 'Gradient Overlay',
  patternOverlay: 'Pattern Overlay',
  outerGlow: 'Outer Glow',
  dropShadow: 'Drop Shadow',
};

export function emptyEffects(): LayerEffects {
  return {
    enabled: true,
    scale: 1,
    dropShadow: [],
    innerShadow: [],
    outerGlow: null,
    innerGlow: null,
    bevel: null,
    satin: null,
    colorOverlay: [],
    gradientOverlay: [],
    patternOverlay: null,
    stroke: [],
  };
}

export function defaultShadow(inner: boolean): ShadowEffect {
  return {
    enabled: true,
    blendMode: 'multiply',
    opacity: inner ? 0.75 : 0.75,
    color: { r: 0, g: 0, b: 0 },
    angle: 120,
    useGlobalLight: true,
    distance: 5,
    spread: 0,
    size: 5,
    noise: 0,
    contour: null,
    layerKnocksOut: true,
  };
}

export function defaultGlow(): GlowEffect {
  return {
    enabled: true,
    blendMode: 'screen',
    opacity: 0.75,
    color: { r: 1, g: 1, b: 0.745 },
    gradient: null,
    technique: 'softer',
    spread: 0,
    size: 5,
    range: 50,
    noise: 0,
    contour: null,
  };
}

export function defaultInnerGlow(): InnerGlowEffect {
  return { ...defaultGlow(), source: 'edge' };
}

export function defaultBevel(): BevelEffect {
  return {
    enabled: true,
    style: 'innerBevel',
    technique: 'smooth',
    depth: 100,
    direction: 'up',
    size: 5,
    soften: 0,
    angle: 120,
    altitude: 30,
    useGlobalLight: true,
    highlightMode: 'screen',
    highlightColor: { r: 1, g: 1, b: 1 },
    highlightOpacity: 0.75,
    shadowMode: 'multiply',
    shadowColor: { r: 0, g: 0, b: 0 },
    shadowOpacity: 0.75,
    contour: null,
  };
}

export function defaultSatin(): SatinEffect {
  return { enabled: true, blendMode: 'multiply', opacity: 0.5, color: { r: 0, g: 0, b: 0 }, angle: 19, distance: 11, size: 14, invert: true, contour: null };
}

export function defaultColorOverlay(): ColorOverlayEffect {
  return { enabled: true, blendMode: 'normal', opacity: 1, color: { r: 1, g: 0, b: 0 } };
}

export function defaultGradientOverlay(g: Gradient): GradientOverlayEffect {
  return { enabled: true, blendMode: 'normal', opacity: 1, gradient: g, style: 'linear', angle: 90, scale: 100, reverse: false, dither: false, alignWithLayer: true, offsetX: 0, offsetY: 0 };
}

export function defaultPatternOverlay(): PatternOverlayEffect {
  return { enabled: true, blendMode: 'normal', opacity: 1, patternId: '', patternName: '', scale: 100, phaseX: 0, phaseY: 0 };
}

export function defaultStroke(): StrokeEffect {
  return { enabled: true, blendMode: 'normal', opacity: 1, size: 3, position: 'outside', fillType: 'color', color: { r: 0, g: 0, b: 0 }, gradient: null, gradientStyle: 'linear', gradientAngle: 90, patternId: null };
}

export function hasAnyEffect(e: LayerEffects | null | undefined): boolean {
  if (!e) return false;
  return !!(
    e.dropShadow?.length ||
    e.innerShadow?.length ||
    e.outerGlow ||
    e.innerGlow ||
    e.bevel ||
    e.satin ||
    e.colorOverlay?.length ||
    e.gradientOverlay?.length ||
    e.patternOverlay ||
    e.stroke?.length
  );
}

export function hasEnabledEffect(e: LayerEffects | null | undefined): boolean {
  if (!e || !e.enabled) return false;
  const any = (l: { enabled: boolean }[] | undefined) => !!l?.some((x) => x.enabled);
  return !!(
    any(e.dropShadow) ||
    any(e.innerShadow) ||
    e.outerGlow?.enabled ||
    e.innerGlow?.enabled ||
    e.bevel?.enabled ||
    e.satin?.enabled ||
    any(e.colorOverlay) ||
    any(e.gradientOverlay) ||
    e.patternOverlay?.enabled ||
    any(e.stroke)
  );
}

/** Fills in missing fields of partial effect data (plugins, macros, older documents). */
export function normalizeEffects(e: Partial<LayerEffects> | null | undefined): LayerEffects | null {
  return e ? { ...emptyEffects(), ...e } : null;
}

export function cloneEffects(e: LayerEffects): LayerEffects {
  return structuredClone(e);
}
