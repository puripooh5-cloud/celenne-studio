/**
 * Document model types.
 *
 * Document
 * ├── Canvas (width, height, resolution, color mode, bit depth)
 * ├── Color profile
 * ├── Guides / Rulers / Grid
 * ├── Channels (alpha + spot)
 * ├── Paths (work path, saved paths)
 * ├── Layer tree (root group; children ordered bottom → top)
 * ├── Smart object sources, patterns
 * ├── Selection
 * └── PSD preservation data
 *
 * Layers never hold references to React state; pixel data lives in TiledRasters.
 */
import type { TiledRaster } from '../image-engine/tiledRaster';
import type { BlendMode } from '../image-engine/blend';
import type { Affine, Point, Quad } from '../image-engine/matrix';
import type { BitDepth } from '../image-engine/pixels';
import type { Adjustment } from '../adjustments/types';
import type { LayerEffects } from '../effects/types';
import type { TextData } from '../typography/types';
import type { LineCap, LineJoin, ShapeOrigin, StrokeAlignment, VectorPath } from '../vector/types';
import type { Gradient, GradientType, RGB, RGBA } from '../color/types';

export type LayerId = string;

export type LayerKind = 'pixel' | 'group' | 'text' | 'shape' | 'adjustment' | 'fill' | 'smartObject' | 'video';

export type ColorMode = 'rgb' | 'grayscale' | 'cmyk' | 'lab' | 'bitmap' | 'indexed' | 'multichannel' | 'duotone';

export type LayerColorTag = 'none' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'gray';

export interface LayerLocks {
  transparency: boolean;
  pixels: boolean;
  position: boolean;
  artboard: boolean;
  all: boolean;
}

export interface LayerMask {
  /** Single-channel raster; `fill` is the default color outside painted area (0 = black/hide, 1 = white/reveal). */
  raster: TiledRaster;
  x: number;
  y: number;
  enabled: boolean;
  /** Moves with the layer when true. */
  linked: boolean;
  /** 0..1 — at 0 the mask has no effect. */
  density: number;
  /** Non-destructive feather radius (px). */
  feather: number;
}

export interface VectorMask {
  path: VectorPath;
  enabled: boolean;
  invert: boolean;
  linked: boolean;
  density: number;
  feather: number;
}

export interface AdvancedBlending {
  knockout: 'none' | 'shallow' | 'deep';
  blendClippedAsGroup: boolean;
  blendInteriorAsGroup: boolean;
  transparencyShapesLayer: boolean;
  layerMaskHidesEffects: boolean;
  vectorMaskHidesEffects: boolean;
  /** Channels participating in blending (R, G, B). */
  channels: [boolean, boolean, boolean];
  /** Blend If ranges (absent = everything blends). */
  blendIf?: BlendIf;
}

/** [black low, black high, white low, white high] on 0..255; pixels outside fade out between low and high. */
export type BlendIfRange = [number, number, number, number];

export interface BlendIfChannel {
  thisLayer: BlendIfRange;
  underlying: BlendIfRange;
}

export interface BlendIf {
  gray: BlendIfChannel;
  red: BlendIfChannel;
  green: BlendIfChannel;
  blue: BlendIfChannel;
}

export const DEFAULT_BLEND_IF_RANGE: BlendIfRange = [0, 0, 255, 255];

/** Raw PSD information retained for lossless round-trips of features we don't model. */
export interface PsdLayerPreservation {
  /** ag-psd layer object as read, with bitmaps removed (keeps all parsed-but-unmodelled fields). */
  source?: Record<string, unknown>;
  /** Additional-info blocks ag-psd cannot parse, captured byte-exact by the container parser. */
  rawBlocks?: { key: string; data: Uint8Array }[];
  /** PSD layer id (lyid). */
  psdId?: number;
  /** Text layers: the text model as opened (JSON), to tell edited layers from unchanged ones on save. */
  textAtOpen?: string;
}

export interface LayerMetadata {
  psd?: PsdLayerPreservation;
  /** Human-readable features present on this layer that are rendered/preserved but not editable. */
  unsupported: string[];
  /** Arbitrary key/value metadata (plugins, provenance, AI generation info...). */
  custom?: Record<string, unknown>;
}

export interface LayerBase {
  id: LayerId;
  name: string;
  kind: LayerKind;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  /** 0..1 — affects layer content but not layer effects. */
  fillOpacity: number;
  blendMode: BlendMode;
  locks: LayerLocks;
  /** Clipped to the layer below (clipping mask). */
  clipping: boolean;
  /** Integer pixel offset of the layer raster (and of linked masks). */
  x: number;
  y: number;
  mask: LayerMask | null;
  vectorMask: VectorMask | null;
  effects: LayerEffects | null;
  advanced: AdvancedBlending;
  colorTag: LayerColorTag;
  metadata: LayerMetadata;
  /** Runtime parent pointer maintained by tree operations (not serialized). */
  parent: GroupLayer | null;
  /** Increments whenever anything visible about the layer changes (thumbnail/cache key). */
  rev: number;
}

export interface PixelLayer extends LayerBase {
  kind: 'pixel';
  raster: TiledRaster;
}

export interface GroupLayer extends LayerBase {
  kind: 'group';
  children: Layer[];
  expanded: boolean;
}

export interface TextLayer extends LayerBase {
  kind: 'text';
  text: TextData;
  /** Rendered appearance (also holds the PSD-provided pixels until re-rendered). */
  raster: TiledRaster;
  /** True while the raster contains PSD-provided pixels that have not been re-rendered by us. */
  usingPreservedPixels: boolean;
  missingFonts: string[];
  /** Photoshop text on a path whose path geometry Celenne does not read (editing lays it out as point text). */
  psdPathText?: boolean;
  /** Drawn by the browser's text renderer while Celenne's engine (or one of its fonts) was loading. */
  browserRendered?: boolean;
}

export interface ShapeStroke {
  enabled: boolean;
  paint: Paint;
  width: number;
  alignment: StrokeAlignment;
  cap: LineCap;
  join: LineJoin;
  miterLimit: number;
  dash: number[];
  dashOffset: number;
  opacity: number;
}

export type Paint =
  | { type: 'none' }
  | { type: 'solid'; color: RGB }
  | { type: 'gradient'; gradient: Gradient; style: GradientType; angle: number; scale: number; reverse: boolean; dither: boolean }
  | { type: 'pattern'; patternId: string; scale: number };

export interface ShapeLayer extends LayerBase {
  kind: 'shape';
  path: VectorPath;
  origin: ShapeOrigin | null;
  fill: Paint;
  stroke: ShapeStroke;
  raster: TiledRaster;
  usingPreservedPixels: boolean;
}

export interface AdjustmentLayer extends LayerBase {
  kind: 'adjustment';
  adjustment: Adjustment;
}

export type FillContent =
  | { type: 'solid'; color: RGB }
  | { type: 'gradient'; gradient: Gradient; style: GradientType; angle: number; scale: number; reverse: boolean; dither: boolean; alignWithLayer: boolean; offsetX: number; offsetY: number }
  | { type: 'pattern'; patternId: string; scale: number; phaseX: number; phaseY: number };

export interface FillLayer extends LayerBase {
  kind: 'fill';
  fill: FillContent;
}

export interface SmartFilter {
  id: string;
  filterId: string;
  name: string;
  params: Record<string, unknown>;
  enabled: boolean;
  opacity: number;
  blendMode: BlendMode;
}

export interface SmartObjectLayer extends LayerBase {
  kind: 'smartObject';
  /** Key into Document.smartSources (several layers may share one source, like instances). */
  sourceId: string;
  /** Source content size in pixels. */
  sourceWidth: number;
  sourceHeight: number;
  /** Where the source rectangle is placed on the canvas (TL, TR, BR, BL). */
  quad: Quad;
  /**
   * Warp envelope in source pixel space (4×4 Bézier control points, row-major), applied before
   * the quad. Absent = no warp.
   */
  warp?: Point[];
  smartFilters: SmartFilter[];
  smartFiltersEnabled: boolean;
  /** Rendered appearance. */
  raster: TiledRaster;
  /** True while showing PSD-provided pixels (exact Photoshop rendering). */
  usingPreservedPixels: boolean;
}

export interface VideoLayer extends LayerBase {
  kind: 'video';
  raster: TiledRaster;
  /** Architecture placeholder: frames are preserved, playback is not implemented. */
  source?: unknown;
}

export type Layer = PixelLayer | GroupLayer | TextLayer | ShapeLayer | AdjustmentLayer | FillLayer | SmartObjectLayer | VideoLayer;

export type RasterBackedLayer = PixelLayer | TextLayer | ShapeLayer | SmartObjectLayer | VideoLayer;

export function hasRaster(l: Layer): l is RasterBackedLayer {
  return l.kind === 'pixel' || l.kind === 'text' || l.kind === 'shape' || l.kind === 'smartObject' || l.kind === 'video';
}

export interface Guide {
  id: string;
  orientation: 'horizontal' | 'vertical';
  /** Position in document pixels. */
  position: number;
}

/** A user slice (Slice tool): a named rectangle exported as its own image. */
export interface SliceDef {
  id: string;
  name: string;
  rect: { x: number; y: number; w: number; h: number };
  url?: string;
  target?: string;
  altTag?: string;
  message?: string;
  /** Photoshop slice id and the raw record read from a PSD (kept for the round trip). */
  psdId?: number;
  preserved?: Record<string, unknown>;
}

export type RulerUnit = 'px' | 'in' | 'cm' | 'mm' | 'pt' | 'pica' | 'percent';

export interface GridSettings {
  spacing: number;
  unit: RulerUnit;
  subdivisions: number;
  color: RGBA;
  style: 'lines' | 'dashed' | 'dots';
}

export interface AlphaChannel {
  id: string;
  name: string;
  kind: 'alpha' | 'spot';
  raster: TiledRaster;
  visible: boolean;
  /** Overlay color used when displayed (and ink color for spot channels). */
  color: RGB;
  opacity: number;
  /** Photoshop "color indicates": masked areas (false) or selected areas (true). */
  indicatesSelected: boolean;
  /** Spot channel solidity 0..1 (architecture). */
  solidity?: number;
}

export interface SavedPath {
  id: string;
  name: string;
  kind: 'work' | 'saved' | 'clipping';
  path: VectorPath;
}

export interface SmartObjectSource {
  id: string;
  kind: 'embedded' | 'linked';
  name: string;
  /** File type hint: 'psd' | 'png' | 'jpg' | 'tif' | 'ai' | 'pdf' | ... */
  fileType: string;
  data?: Uint8Array;
  linkedPath?: string;
  /** Decoded pixels (lazy). */
  /** Decoded contents; `space` is their colour space (RGB sRGB when absent). CMYK contents keep a K companion. */
  decoded?: { width: number; height: number; raster: TiledRaster; space?: { mode: ColorMode; profile: ColorProfileRef } };
  decodeError?: string;
  /** Raw ag-psd linked-file record for lossless round trip. */
  preserved?: Record<string, unknown>;
}

export interface PatternDef {
  id: string;
  name: string;
  width: number;
  height: number;
  raster: TiledRaster;
  preserved?: Record<string, unknown>;
}

export interface ColorProfileRef {
  /** Human readable description, e.g. "sRGB IEC61966-2.1". */
  name: string;
  /** Built-in profile id when known. */
  builtin?: import('../color/icc').BuiltinProfileId;
  /** ICC bytes (embedded profile). */
  icc?: Uint8Array;
  /** The file had no profile ("Don't color manage"); it is displayed as the working space and saved untagged. */
  untagged?: boolean;
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  description?: string;
  keywords?: string[];
  copyright?: string;
  copyrighted?: boolean;
  url?: string;
  xmp?: string;
  created?: string;
  modified?: string;
}

export interface CompatibilityIssue {
  feature: string;
  status: 'editable' | 'partial' | 'rendered' | 'preserved' | 'converted' | 'dropped';
  layerId?: LayerId;
  layerName?: string;
  message: string;
}

export interface PsdDocumentPreservation {
  /** Top-level ag-psd object without layers / bitmaps. */
  source?: Record<string, unknown>;
  /** Image resource blocks not handled by ag-psd (id, name, data). */
  rawResources?: { id: number; name: string; data: Uint8Array }[];
  /** Global additional info blocks not handled by ag-psd. */
  rawGlobalBlocks?: { key: string; data: Uint8Array }[];
  originalColorMode?: ColorMode;
  /** Embedded profile of the original file when it no longer describes the pixels (CMYK). */
  originalProfile?: Uint8Array;
  originalBitDepth?: number;
  isPsb?: boolean;
  /** 32-bit files: Photoshop's HDR toning settings ('hdrt' / 'hdra'), stored as colour-mode data. */
  hdrColorModeData?: Uint8Array;
}

export interface CanvasInfo {
  width: number;
  height: number;
  /** Pixels per inch. */
  resolution: number;
  colorMode: ColorMode;
  bitDepth: BitDepth;
  /** Indexed Color: the colour table, flat RGB 0..255 (≤ 256 entries). Never mutated in place. */
  colorTable?: number[];
  /** Indexed Color: transparent pixels use an extra table slot (index = table length). */
  colorTableTransparent?: boolean;
  /**
   * Duotone (mono-, duo-, tri-, quadtone): the document stays Grayscale data — as in Photoshop —
   * and is shown and printed with these inks. Never mutated in place.
   */
  duotone?: import('../color/inks').DuotoneSpec;
}
