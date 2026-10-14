/**
 * CelenneDocument — the editable document model. Mutated only through commands (see /commands),
 * which emit DocumentChange events consumed by the render engine and the UI.
 */
import type { Rect } from '../image-engine/rect';
import { Selection } from '../selection/selection';
import { newId } from './ids';
import type {
  AlphaChannel,
  CanvasInfo,
  ColorProfileRef,
  CompatibilityIssue,
  DocumentMetadata,
  GridSettings,
  GroupLayer,
  Guide,
  Layer,
  LayerId,
  PatternDef,
  PsdDocumentPreservation,
  RulerUnit,
  SavedPath,
  SliceDef,
  SmartObjectSource,
} from './types';
import { createGroupLayer } from './layerFactory';

export type DocumentChange =
  | { type: 'pixels'; layerId: LayerId; rect?: Rect | null }
  | { type: 'mask'; layerId: LayerId; rect?: Rect | null }
  | { type: 'layer'; layerId: LayerId }
  | { type: 'structure' }
  | { type: 'selection' }
  | { type: 'canvas' }
  | { type: 'guides' }
  | { type: 'channels' }
  | { type: 'paths' }
  | { type: 'meta' };

export type DocumentListener = (changes: DocumentChange[]) => void;

export class CelenneDocument {
  readonly id = newId('doc');
  name: string;
  filePath: string | null = null;
  /** Format the document was loaded from / last saved as ("psd", "png", ...). */
  fileFormat: string | null = null;
  canvas: CanvasInfo;
  profile: ColorProfileRef = { name: 'sRGB IEC61966-2.1', builtin: 'srgb' };
  root: GroupLayer;
  guides: Guide[] = [];
  /** User slices (Slice tool). */
  slices: SliceDef[] = [];
  rulerOrigin = { x: 0, y: 0 };
  rulerUnit: RulerUnit = 'px';
  grid: GridSettings = { spacing: 64, unit: 'px', subdivisions: 4, color: { r: 0.45, g: 0.6, b: 1, a: 0.5 }, style: 'lines' };
  channels: AlphaChannel[] = [];
  paths: SavedPath[] = [];
  smartSources = new Map<string, SmartObjectSource>();
  patterns = new Map<string, PatternDef>();
  selection = new Selection();
  metadata: DocumentMetadata = {};
  psd: PsdDocumentPreservation = {};
  compatibility: CompatibilityIssue[] = [];
  globalLight = { angle: 120, altitude: 30 };
  /** Structural revision (layer tree / properties) for UI subscriptions. */
  rev = 0;

  private listeners = new Set<DocumentListener>();
  private pending: DocumentChange[] = [];
  private batchDepth = 0;

  constructor(name: string, canvas: CanvasInfo) {
    this.name = name;
    this.canvas = { ...canvas };
    this.root = createGroupLayer('Root');
    this.root.id = 'root';
    this.root.blendMode = 'passThrough';
  }

  get width(): number {
    return this.canvas.width;
  }
  get height(): number {
    return this.canvas.height;
  }
  get bounds(): Rect {
    return { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
  }

  // -------------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------------
  on(l: DocumentListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(...changes: DocumentChange[]): void {
    this.rev++;
    this.pending.push(...changes);
    if (this.batchDepth === 0) this.flush();
  }

  /** Coalesces change notifications emitted inside `fn`. */
  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) this.flush();
    }
  }

  private flush() {
    if (!this.pending.length) return;
    const changes = this.pending;
    this.pending = [];
    for (const l of this.listeners) l(changes);
  }

  // -------------------------------------------------------------------------------------------
  // Layer tree
  // -------------------------------------------------------------------------------------------
  /** Depth-first, bottom → top, groups before their children. */
  *walk(group: GroupLayer = this.root): Generator<Layer> {
    for (const l of group.children) {
      yield l;
      if (l.kind === 'group') yield* this.walk(l);
    }
  }

  allLayers(): Layer[] {
    return [...this.walk()];
  }

  /** id → layer index, rebuilt lazily. Every hit is re-validated (still attached under root). */
  private idIndex = new Map<LayerId, Layer>();

  getLayer(id: LayerId | null | undefined): Layer | null {
    if (!id) return null;
    if (id === 'root') return this.root;
    const hit = this.idIndex.get(id);
    if (hit && hit.id === id && this.isAttached(hit)) return hit;
    this.idIndex.clear();
    let found: Layer | null = null;
    for (const l of this.walk()) {
      this.idIndex.set(l.id, l);
      if (l.id === id) found = l;
    }
    return found;
  }

  private isAttached(l: Layer): boolean {
    let c: Layer = l;
    while (c.parent) {
      if (!c.parent.children.includes(c)) return false;
      c = c.parent;
    }
    return c === this.root;
  }

  layerCount(): number {
    let n = 0;
    for (const _ of this.walk()) n++;
    return n;
  }

  indexInParent(layer: Layer): number {
    return layer.parent ? layer.parent.children.indexOf(layer) : -1;
  }

  /** Inserts `layer` in `parent` at `index` (0 = bottom). */
  insertLayer(layer: Layer, parent: GroupLayer = this.root, index = parent.children.length): void {
    const i = Math.max(0, Math.min(index, parent.children.length));
    parent.children.splice(i, 0, layer);
    layer.parent = parent;
  }

  removeLayer(layer: Layer): { parent: GroupLayer; index: number } {
    const parent = layer.parent ?? this.root;
    const index = parent.children.indexOf(layer);
    if (index >= 0) parent.children.splice(index, 1);
    layer.parent = null;
    return { parent, index };
  }

  isAncestor(maybeAncestor: Layer, layer: Layer): boolean {
    let p = layer.parent;
    while (p) {
      if (p === maybeAncestor) return true;
      p = p.parent;
    }
    return false;
  }

  /** Top-most visible layers first (panel order). */
  layersTopDown(group: GroupLayer = this.root): Layer[] {
    return [...group.children].reverse();
  }

  /** The base layer a clipped layer is clipped to (first non-clipped layer beneath it). */
  clipBase(layer: Layer): Layer | null {
    const parent = layer.parent;
    if (!parent || !layer.clipping) return null;
    let i = parent.children.indexOf(layer) - 1;
    while (i >= 0 && parent.children[i].clipping) i--;
    return i >= 0 ? parent.children[i] : null;
  }

  /** Resolves pass-through/visibility chain. */
  isEffectivelyVisible(layer: Layer): boolean {
    let l: Layer | null = layer;
    while (l && l !== this.root) {
      if (!l.visible) return false;
      l = l.parent;
    }
    return true;
  }

  guideById(id: string): Guide | undefined {
    return this.guides.find((g) => g.id === id);
  }
}
