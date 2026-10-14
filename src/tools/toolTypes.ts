/** Tool identifiers, grouping (toolbar flyouts) and per-tool option types. */
import type { BlendMode } from '../image-engine/blend';
import type { SelectionOp } from '../selection/selection';
import type { GradientType } from '../color/types';

export type ToolId =
  | 'move'
  | 'marqueeRect'
  | 'marqueeEllipse'
  | 'marqueeRow'
  | 'marqueeColumn'
  | 'lasso'
  | 'polyLasso'
  | 'magneticLasso'
  | 'objectSelect'
  | 'quickSelect'
  | 'magicWand'
  | 'crop'
  | 'perspectiveCrop'
  | 'slice'
  | 'eyedropper'
  | 'colorSampler'
  | 'ruler'
  | 'spotHealing'
  | 'remove'
  | 'healing'
  | 'patch'
  | 'redEye'
  | 'brush'
  | 'pencil'
  | 'colorReplace'
  | 'mixerBrush'
  | 'cloneStamp'
  | 'patternStamp'
  | 'eraser'
  | 'bgEraser'
  | 'magicEraser'
  | 'gradient'
  | 'paintBucket'
  | 'blur'
  | 'sharpen'
  | 'smudge'
  | 'dodge'
  | 'burn'
  | 'sponge'
  | 'pen'
  | 'freeformPen'
  | 'addAnchor'
  | 'deleteAnchor'
  | 'convertPoint'
  | 'pathSelect'
  | 'directSelect'
  | 'type'
  | 'typeVertical'
  | 'rectangle'
  | 'ellipse'
  | 'polygon'
  | 'line'
  | 'customShape'
  | 'pluginTool'
  | 'hand'
  | 'rotateView'
  | 'zoom';

export interface ToolInfo {
  id: ToolId;
  label: string;
  shortcut?: string;
  /** Flyout group id; tools sharing a group share one toolbar slot. */
  group: string;
  comingSoon?: boolean;
}

export const TOOLS: ToolInfo[] = [
  { id: 'move', label: 'Move Tool', shortcut: 'V', group: 'move' },
  { id: 'marqueeRect', label: 'Rectangular Marquee Tool', shortcut: 'M', group: 'marquee' },
  { id: 'marqueeEllipse', label: 'Elliptical Marquee Tool', shortcut: 'M', group: 'marquee' },
  { id: 'marqueeRow', label: 'Single Row Marquee Tool', group: 'marquee' },
  { id: 'marqueeColumn', label: 'Single Column Marquee Tool', group: 'marquee' },
  { id: 'lasso', label: 'Lasso Tool', shortcut: 'L', group: 'lasso' },
  { id: 'polyLasso', label: 'Polygonal Lasso Tool', shortcut: 'L', group: 'lasso' },
  { id: 'magneticLasso', label: 'Magnetic Lasso Tool', shortcut: 'L', group: 'lasso' },
  { id: 'objectSelect', label: 'Object Selection Tool', shortcut: 'W', group: 'wand' },
  { id: 'quickSelect', label: 'Quick Selection Tool', shortcut: 'W', group: 'wand' },
  { id: 'magicWand', label: 'Magic Wand Tool', shortcut: 'W', group: 'wand' },
  { id: 'crop', label: 'Crop Tool', shortcut: 'C', group: 'crop' },
  { id: 'perspectiveCrop', label: 'Perspective Crop Tool', shortcut: 'C', group: 'crop' },
  { id: 'slice', label: 'Slice Tool', shortcut: 'C', group: 'crop' },
  { id: 'eyedropper', label: 'Eyedropper Tool', shortcut: 'I', group: 'eyedropper' },
  { id: 'colorSampler', label: 'Color Sampler Tool', shortcut: 'I', group: 'eyedropper' },
  { id: 'ruler', label: 'Ruler Tool', shortcut: 'I', group: 'eyedropper' },
  { id: 'spotHealing', label: 'Spot Healing Brush Tool', shortcut: 'J', group: 'heal' },
  { id: 'remove', label: 'Remove Tool', shortcut: 'J', group: 'heal' },
  { id: 'healing', label: 'Healing Brush Tool', shortcut: 'J', group: 'heal' },
  { id: 'patch', label: 'Patch Tool', shortcut: 'J', group: 'heal' },
  { id: 'redEye', label: 'Red Eye Tool', shortcut: 'J', group: 'heal' },
  { id: 'brush', label: 'Brush Tool', shortcut: 'B', group: 'brush' },
  { id: 'pencil', label: 'Pencil Tool', shortcut: 'B', group: 'brush' },
  { id: 'colorReplace', label: 'Color Replacement Tool', shortcut: 'B', group: 'brush' },
  { id: 'mixerBrush', label: 'Mixer Brush Tool', shortcut: 'B', group: 'brush' },
  { id: 'cloneStamp', label: 'Clone Stamp Tool', shortcut: 'S', group: 'stamp' },
  { id: 'patternStamp', label: 'Pattern Stamp Tool', shortcut: 'S', group: 'stamp' },
  { id: 'eraser', label: 'Eraser Tool', shortcut: 'E', group: 'eraser' },
  { id: 'bgEraser', label: 'Background Eraser Tool', shortcut: 'E', group: 'eraser' },
  { id: 'magicEraser', label: 'Magic Eraser Tool', shortcut: 'E', group: 'eraser' },
  { id: 'gradient', label: 'Gradient Tool', shortcut: 'G', group: 'gradient' },
  { id: 'paintBucket', label: 'Paint Bucket Tool', shortcut: 'G', group: 'gradient' },
  { id: 'blur', label: 'Blur Tool', group: 'blur' },
  { id: 'sharpen', label: 'Sharpen Tool', group: 'blur' },
  { id: 'smudge', label: 'Smudge Tool', group: 'blur' },
  { id: 'dodge', label: 'Dodge Tool', shortcut: 'O', group: 'dodge' },
  { id: 'burn', label: 'Burn Tool', shortcut: 'O', group: 'dodge' },
  { id: 'sponge', label: 'Sponge Tool', shortcut: 'O', group: 'dodge' },
  { id: 'pen', label: 'Pen Tool', shortcut: 'P', group: 'pen' },
  { id: 'freeformPen', label: 'Freeform Pen Tool', shortcut: 'P', group: 'pen' },
  { id: 'addAnchor', label: 'Add Anchor Point Tool', group: 'pen' },
  { id: 'deleteAnchor', label: 'Delete Anchor Point Tool', group: 'pen' },
  { id: 'convertPoint', label: 'Convert Point Tool', group: 'pen' },
  { id: 'type', label: 'Horizontal Type Tool', shortcut: 'T', group: 'type' },
  { id: 'typeVertical', label: 'Vertical Type Tool', shortcut: 'T', group: 'type' },
  { id: 'pathSelect', label: 'Path Selection Tool', shortcut: 'A', group: 'pathSelect' },
  { id: 'directSelect', label: 'Direct Selection Tool', shortcut: 'A', group: 'pathSelect' },
  { id: 'rectangle', label: 'Rectangle Tool', shortcut: 'U', group: 'shape' },
  { id: 'ellipse', label: 'Ellipse Tool', shortcut: 'U', group: 'shape' },
  { id: 'polygon', label: 'Polygon Tool', shortcut: 'U', group: 'shape' },
  { id: 'line', label: 'Line Tool', shortcut: 'U', group: 'shape' },
  { id: 'customShape', label: 'Custom Shape Tool', shortcut: 'U', group: 'shape' },
  { id: 'hand', label: 'Hand Tool', shortcut: 'H', group: 'hand' },
  { id: 'rotateView', label: 'Rotate View Tool', shortcut: 'R', group: 'hand' },
  { id: 'zoom', label: 'Zoom Tool', shortcut: 'Z', group: 'zoom' },
  { id: 'pluginTool', label: 'Plugin Tool', group: 'plugin' },
];

export const TOOL_GROUP_ORDER = ['move', 'marquee', 'lasso', 'wand', 'crop', 'eyedropper', 'heal', 'brush', 'stamp', 'eraser', 'gradient', 'blur', 'dodge', 'pen', 'type', 'pathSelect', 'shape', 'hand', 'zoom', 'plugin'];

export function toolInfo(id: ToolId): ToolInfo {
  return TOOLS.find((t) => t.id === id)!;
}

// ---------------------------------------------------------------------------------------------
// Brush settings
// ---------------------------------------------------------------------------------------------
export type BrushTip = 'round' | 'sampled';
export type BrushTexture = 'none' | 'noise' | 'canvas' | 'chalk' | 'charcoal' | 'ink';

export interface BrushDynamics {
  sizePressure: boolean;
  opacityPressure: boolean;
  flowPressure: boolean;
  minSize: number; // 0..1
  sizeJitter: number; // 0..1
  angleJitter: number; // 0..1
  opacityJitter: number;
  flowJitter: number;
  angleControl: 'none' | 'direction' | 'tilt' | 'rotation';
  roundnessFromTilt: boolean;
  sizeFromVelocity: number; // -1..1
}

export interface BrushSettings {
  name: string;
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
  spacing: number; // fraction of diameter
  angle: number;
  roundness: number;
  smoothing: number;
  scatter: number; // fraction of diameter
  count: number;
  tip: BrushTip;
  /** Custom sampled tip (grayscale coverage) for "sampled" brushes. */
  tipImage?: { width: number; height: number; data: number[] };
  texture: BrushTexture;
  textureScale: number;
  textureDepth: number;
  dynamics: BrushDynamics;
  airbrush: boolean;
  blendMode: BlendMode;
  aliased: boolean;
}

export function defaultDynamics(): BrushDynamics {
  return { sizePressure: true, opacityPressure: false, flowPressure: false, minSize: 0, sizeJitter: 0, angleJitter: 0, opacityJitter: 0, flowJitter: 0, angleControl: 'none', roundnessFromTilt: false, sizeFromVelocity: 0 };
}

export function defaultBrush(): BrushSettings {
  return {
    name: 'Soft Round',
    size: 40,
    hardness: 0,
    opacity: 1,
    flow: 1,
    spacing: 0.1,
    angle: 0,
    roundness: 1,
    smoothing: 0.1,
    scatter: 0,
    count: 1,
    tip: 'round',
    texture: 'none',
    textureScale: 1,
    textureDepth: 0.5,
    dynamics: defaultDynamics(),
    airbrush: false,
    blendMode: 'normal',
    aliased: false,
  };
}

export const BRUSH_PRESETS: BrushSettings[] = [
  { ...defaultBrush(), name: 'Soft Round', hardness: 0, size: 60 },
  { ...defaultBrush(), name: 'Hard Round', hardness: 1, size: 30 },
  { ...defaultBrush(), name: 'Pencil', hardness: 1, size: 3, aliased: true, spacing: 0.05 },
  { ...defaultBrush(), name: 'Airbrush', hardness: 0, size: 80, flow: 0.08, airbrush: true },
  { ...defaultBrush(), name: 'Chalk', hardness: 0.7, size: 40, texture: 'chalk', textureDepth: 0.8, spacing: 0.15, dynamics: { ...defaultDynamics(), sizeJitter: 0.1, angleJitter: 0.3 } },
  { ...defaultBrush(), name: 'Charcoal', hardness: 0.5, size: 36, texture: 'charcoal', textureDepth: 0.9, roundness: 0.6, spacing: 0.12, dynamics: { ...defaultDynamics(), angleJitter: 0.5, opacityJitter: 0.3 } },
  { ...defaultBrush(), name: 'Ink', hardness: 0.95, size: 12, spacing: 0.03, smoothing: 0.5, dynamics: { ...defaultDynamics(), sizePressure: true, minSize: 0.15, sizeFromVelocity: -0.4 } },
  { ...defaultBrush(), name: 'Texture Spray', hardness: 0.3, size: 90, texture: 'noise', textureDepth: 1, scatter: 0.8, count: 3, spacing: 0.3, dynamics: { ...defaultDynamics(), sizeJitter: 0.6, opacityJitter: 0.5 } },
  { ...defaultBrush(), name: 'Calligraphy', hardness: 1, size: 24, roundness: 0.2, angle: 45, spacing: 0.04 },
  { ...defaultBrush(), name: 'Soft Mask Brush', hardness: 0.2, size: 120, flow: 0.4 },
];

// ---------------------------------------------------------------------------------------------
// Tool options
// ---------------------------------------------------------------------------------------------
export interface SelectionToolOptions {
  op: SelectionOp;
  feather: number;
  antiAlias: boolean;
  style: 'normal' | 'fixedRatio' | 'fixedSize';
  ratioW: number;
  ratioH: number;
  fixedW: number;
  fixedH: number;
  tolerance: number;
  contiguous: boolean;
  sampleAllLayers: boolean;
  width: number; // magnetic lasso width
  contrast: number;
  frequency: number;
  brushSize: number; // quick select
}

export interface ToolOptions {
  selection: SelectionToolOptions;
  move: { autoSelect: boolean; autoSelectTarget: 'layer' | 'group'; showTransformControls: boolean; snap: boolean };
  crop: { ratio: 'free' | 'original' | '1:1' | '4:3' | '16:9' | '3:2' | 'custom'; customW: number; customH: number; fixedPx: boolean; deletePixels: boolean; overlay: 'thirds' | 'grid' | 'none' };
  eyedropper: { sampleSize: 1 | 3 | 5 | 11 | 31; sampleAllLayers: boolean };
  gradient: { type: GradientType; reverse: boolean; dither: boolean; transparency: boolean; opacity: number; blendMode: BlendMode; presetIndex: number };
  bucket: { tolerance: number; contiguous: boolean; antiAlias: boolean; sampleAllLayers: boolean; fill: 'foreground' | 'pattern'; opacity: number; blendMode: BlendMode };
  eraser: { mode: 'brush' | 'pencil' | 'block'; tolerance: number; contiguous: boolean; sampleAllLayers: boolean; protectForeground: boolean; sampling: 'continuous' | 'once' | 'background' };
  clone: { aligned: boolean; sampleAllLayers: boolean };
  retouch: { strength: number; range: 'shadows' | 'midtones' | 'highlights'; exposure: number; spongeMode: 'saturate' | 'desaturate'; sampleAllLayers: boolean; healMode: 'contentAware' | 'proximity' | 'texture'; patchMode: 'source' | 'destination' };
  shape: { mode: 'shape' | 'path' | 'pixels'; radius: number; sides: number; star: boolean; starRatio: number; lineWeight: number; customShape: string; strokeWidth: number };
  pen: { mode: 'shape' | 'path'; rubberBand: boolean };
  type: { fontFamily: string; fontStyleName: string; fontWeight: number; italic: boolean; fontSize: number; align: 'left' | 'center' | 'right'; antiAlias: 'none' | 'sharp' | 'crisp' | 'strong' | 'smooth' };
  zoom: { scrubby: boolean };
  mixer: { wet: number; load: number; mix: number; loadAfterStroke: boolean; cleanAfterStroke: boolean; sampleAllLayers: boolean };
}

export function defaultToolOptions(): ToolOptions {
  return {
    selection: { op: 'replace', feather: 0, antiAlias: true, style: 'normal', ratioW: 1, ratioH: 1, fixedW: 64, fixedH: 64, tolerance: 32, contiguous: true, sampleAllLayers: false, width: 10, contrast: 10, frequency: 57, brushSize: 30 },
    move: { autoSelect: false, autoSelectTarget: 'layer', showTransformControls: false, snap: true },
    crop: { ratio: 'free', customW: 1, customH: 1, fixedPx: false, deletePixels: false, overlay: 'thirds' },
    eyedropper: { sampleSize: 1, sampleAllLayers: true },
    gradient: { type: 'linear', reverse: false, dither: true, transparency: true, opacity: 1, blendMode: 'normal', presetIndex: 0 },
    bucket: { tolerance: 32, contiguous: true, antiAlias: true, sampleAllLayers: false, fill: 'foreground', opacity: 1, blendMode: 'normal' },
    eraser: { mode: 'brush', tolerance: 50, contiguous: true, sampleAllLayers: false, protectForeground: false, sampling: 'continuous' },
    clone: { aligned: true, sampleAllLayers: false },
    retouch: { strength: 0.5, range: 'midtones', exposure: 0.5, spongeMode: 'desaturate', sampleAllLayers: false, healMode: 'contentAware', patchMode: 'source' },
    shape: { mode: 'shape', radius: 12, sides: 5, star: false, starRatio: 0.5, lineWeight: 3, customShape: 'arrow', strokeWidth: 0 },
    pen: { mode: 'path', rubberBand: false },
    type: { fontFamily: 'Arial', fontStyleName: 'Regular', fontWeight: 400, italic: false, fontSize: 48, align: 'left', antiAlias: 'smooth' },
    zoom: { scrubby: true },
    mixer: { wet: 0.5, load: 0.5, mix: 0.5, loadAfterStroke: true, cleanAfterStroke: false, sampleAllLayers: false },
  };
}
