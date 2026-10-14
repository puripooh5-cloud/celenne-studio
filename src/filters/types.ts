/** Filter framework types. */
export interface FloatImage {
  w: number;
  h: number;
  /** 4 = RGBA, 1 = single channel (masks / channels). */
  ch: 1 | 4;
  data: Float32Array;
}

export type ParamDef =
  | { type: 'number'; id: string; label: string; min: number; max: number; step?: number; default: number; unit?: string; slider?: 'linear' | 'log' }
  | { type: 'angle'; id: string; label: string; default: number }
  | { type: 'select'; id: string; label: string; options: { value: string; label: string }[]; default: string }
  | { type: 'boolean'; id: string; label: string; default: boolean }
  | { type: 'seed'; id: string; label: string; default: number };

export type FilterParams = Record<string, number | string | boolean>;

export interface FilterContext {
  /** Pyramid scale of the buffer relative to document pixels (px parameters are multiplied). */
  scale: number;
  /** Position of the buffer's origin in (scaled) document coordinates. */
  originX: number;
  originY: number;
  /** Reference bounds (scaled) for position-dependent filters (e.g. the layer / selection box). */
  bounds: { x: number; y: number; w: number; h: number };
  foreground: [number, number, number];
  background: [number, number, number];
  cancelled(): boolean;
  progress(f: number): void;
}

export interface FilterDef {
  id: string;
  name: string;
  category: 'Blur' | 'Sharpen' | 'Distort' | 'Noise' | 'Stylize' | 'Other' | 'Render' | 'Artistic' | 'Brush Strokes' | 'Sketch' | 'Texture';
  params: ParamDef[];
  /** Processing space: blurs use premultiplied colors to avoid fringes. */
  space: 'premultiplied' | 'straight';
  /** Extra pixels (document px) needed around the output region. */
  padding(p: FilterParams): number;
  /** Requires the whole reference area (point-mapped distortions, center-based effects). */
  global?: boolean;
  /** Applies to `img` and returns the result (may reuse `img`). */
  apply(img: FloatImage, p: FilterParams, ctx: FilterContext): FloatImage;
  /** Photoshop smart-filter type name for PSD metadata mapping. */
  psdName?: string;
  comingSoon?: boolean;
  /** Listed in the Filter Gallery (and stackable there). */
  gallery?: boolean;
  /** Asynchronous implementation (sandboxed plugin filters). Such filters have no live preview and cannot be smart filters. */
  runAsync?(img: FloatImage, p: FilterParams, progress: (f: number) => void): Promise<FloatImage>;
}

export function defaults(def: FilterDef): FilterParams {
  const p: FilterParams = {};
  for (const d of def.params) p[d.id] = d.default;
  return p;
}

export function num(p: FilterParams, id: string, fallback = 0): number {
  const v = p[id];
  return typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) || fallback : fallback;
}
