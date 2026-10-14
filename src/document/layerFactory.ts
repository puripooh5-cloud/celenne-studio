/** Layer constructors with consistent defaults. */
import { TiledRaster } from '../image-engine/tiledRaster';
import type { BitDepth } from '../image-engine/pixels';
import { identity, quadFromRect } from '../image-engine/matrix';
import { newId } from './ids';
import type {
  AdjustmentLayer,
  AdvancedBlending,
  FillContent,
  FillLayer,
  GroupLayer,
  LayerBase,
  LayerKind,
  LayerLocks,
  LayerMask,
  PixelLayer,
  ShapeLayer,
  ShapeStroke,
  SmartObjectLayer,
  TextLayer,
} from './types';
import type { Adjustment } from '../adjustments/types';
import { ADJUSTMENT_LABELS } from '../adjustments/types';
import type { TextData } from '../typography/types';
import { defaultCharacterStyle, defaultParagraphStyle } from '../typography/types';
import type { ShapeOrigin, VectorPath } from '../vector/types';

export function defaultLocks(): LayerLocks {
  return { transparency: false, pixels: false, position: false, artboard: false, all: false };
}

export function defaultAdvanced(): AdvancedBlending {
  return {
    knockout: 'none',
    blendClippedAsGroup: true,
    blendInteriorAsGroup: false,
    transparencyShapesLayer: true,
    layerMaskHidesEffects: false,
    vectorMaskHidesEffects: false,
    channels: [true, true, true],
  };
}

function base<K extends LayerKind>(kind: K, name: string): LayerBase & { kind: K } {
  return {
    id: newId('layer'),
    name,
    kind,
    visible: true,
    opacity: 1,
    fillOpacity: 1,
    blendMode: 'normal',
    locks: defaultLocks(),
    clipping: false,
    x: 0,
    y: 0,
    mask: null,
    vectorMask: null,
    effects: null,
    advanced: defaultAdvanced(),
    colorTag: 'none',
    metadata: { unsupported: [] },
    parent: null,
    rev: 0,
  };
}

export function createPixelLayer(name: string, depth: BitDepth, raster?: TiledRaster): PixelLayer {
  return { ...base('pixel', name), raster: raster ?? new TiledRaster(4, depth) };
}

export function createGroupLayer(name: string): GroupLayer {
  const g: GroupLayer = { ...base('group', name), children: [], expanded: true };
  g.blendMode = 'passThrough';
  return g;
}

export function createAdjustmentLayer(adjustment: Adjustment, name?: string): AdjustmentLayer {
  return { ...base('adjustment', name ?? ADJUSTMENT_LABELS[adjustment.type]), adjustment };
}

export function createFillLayer(fill: FillContent, name?: string): FillLayer {
  const label = fill.type === 'solid' ? 'Color Fill' : fill.type === 'gradient' ? 'Gradient Fill' : 'Pattern Fill';
  return { ...base('fill', name ?? label), fill };
}

export function createTextLayer(text: string, depth: BitDepth, x: number, y: number, partial?: Partial<TextData>): TextLayer {
  const style = defaultCharacterStyle();
  const data: TextData = {
    text,
    runs: [{ length: text.length, style }],
    paragraphs: [{ length: text.length, style: defaultParagraphStyle() }],
    kind: 'point',
    box: null,
    orientation: 'horizontal',
    transform: [1, 0, 0, 1, x, y],
    antiAlias: 'smooth',
    ...partial,
  };
  return {
    ...base('text', text.split('\n')[0].slice(0, 40) || 'Text'),
    text: data,
    raster: new TiledRaster(4, depth),
    usingPreservedPixels: false,
    missingFonts: [],
  };
}

export function defaultStroke(): ShapeStroke {
  return {
    enabled: false,
    paint: { type: 'solid', color: { r: 0, g: 0, b: 0 } },
    width: 3,
    alignment: 'inside',
    cap: 'butt',
    join: 'miter',
    miterLimit: 100,
    dash: [],
    dashOffset: 0,
    opacity: 1,
  };
}

export function createShapeLayer(name: string, path: VectorPath, origin: ShapeOrigin | null, depth: BitDepth): ShapeLayer {
  return {
    ...base('shape', name),
    path,
    origin,
    fill: { type: 'solid', color: { r: 0.3, g: 0.45, b: 0.9 } },
    stroke: defaultStroke(),
    raster: new TiledRaster(4, depth),
    usingPreservedPixels: false,
  };
}

export function createSmartObjectLayer(name: string, sourceId: string, w: number, h: number, depth: BitDepth, x = 0, y = 0): SmartObjectLayer {
  return {
    ...base('smartObject', name),
    sourceId,
    sourceWidth: w,
    sourceHeight: h,
    quad: quadFromRect(x, y, w, h),
    smartFilters: [],
    smartFiltersEnabled: true,
    raster: new TiledRaster(4, depth),
    usingPreservedPixels: false,
  };
}

export function createMask(fillWhite: boolean): LayerMask {
  return { raster: new TiledRaster(1, 8, fillWhite ? 1 : 0), x: 0, y: 0, enabled: true, linked: true, density: 1, feather: 0 };
}

export { identity };
