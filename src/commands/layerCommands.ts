/**
 * Layer structure and property commands.
 * Commands address layers by id so they stay valid across undo/redo cycles.
 */
import type { Command, RecordedOp } from '../history/history';
import type { CelenneDocument } from '../document/document';
import type { GroupLayer, Layer, LayerId, LayerMask, VectorMask } from '../document/types';
import type { BlendMode } from '../image-engine/blend';
import type { Adjustment } from '../adjustments/types';
import type { LayerEffects } from '../effects/types';
import { cloneLayer } from '../document/clone';

function groupOf(doc: CelenneDocument, id: LayerId | null): GroupLayer {
  const g = id ? doc.getLayer(id) : doc.root;
  return g && g.kind === 'group' ? g : doc.root;
}

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------

/** Inserts a (new or restored) layer. Also used for adjustment/fill/text/shape creation. */
export class CreateLayerCommand implements Command {
  constructor(
    readonly label: string,
    private layer: Layer,
    private parentId: LayerId | null,
    private index: number,
    readonly record?: RecordedOp,
  ) {}
  do(doc: CelenneDocument): void {
    // Never insert a layer id twice.
    if (doc.getLayer(this.layer.id)) return;
    doc.insertLayer(this.layer, groupOf(doc, this.parentId), this.index);
    doc.emit({ type: 'structure' });
  }
  undo(doc: CelenneDocument): void {
    // Resolve by id: whole-document steps (crop, canvas size, profile conversion…) restore the tree
    // from snapshots, so the live layer may be a copy of the object this command inserted.
    const current = doc.getLayer(this.layer.id);
    if (!current) return;
    this.layer = current;
    doc.removeLayer(current);
    doc.emit({ type: 'structure' });
  }
  get layerId(): LayerId {
    return this.layer.id;
  }
}

export class CreateAdjustmentLayerCommand extends CreateLayerCommand {}

export class DeleteLayerCommand implements Command {
  private removed: { layer: Layer; parentId: LayerId; index: number }[] = [];
  readonly label: string;
  constructor(
    private ids: LayerId[],
    readonly record?: RecordedOp,
  ) {
    this.label = ids.length > 1 ? 'Delete Layers' : 'Delete Layer';
  }
  do(doc: CelenneDocument): void {
    this.removed = [];
    for (const id of this.ids) {
      const l = doc.getLayer(id);
      if (!l || l === doc.root) continue;
      const { parent, index } = doc.removeLayer(l);
      this.removed.push({ layer: l, parentId: parent.id, index });
    }
    doc.emit({ type: 'structure' });
  }
  undo(doc: CelenneDocument): void {
    for (let i = this.removed.length - 1; i >= 0; i--) {
      const r = this.removed[i];
      if (doc.getLayer(r.layer.id)) continue; // never insert an id twice
      doc.insertLayer(r.layer, groupOf(doc, r.parentId), r.index);
    }
    doc.emit({ type: 'structure' });
  }
}

/** Moves a layer to another parent / index (reorder, move into or out of a group). */
export class MoveLayerCommand implements Command {
  private from: { parentId: LayerId; index: number } | null = null;
  constructor(
    readonly label: string,
    private id: LayerId,
    private toParentId: LayerId,
    private toIndex: number,
    readonly record?: RecordedOp,
  ) {}
  do(doc: CelenneDocument): void {
    const l = doc.getLayer(this.id);
    const target = groupOf(doc, this.toParentId);
    if (!l || l === target || (l.kind === 'group' && doc.isAncestor(l, target))) return;
    const { parent, index } = doc.removeLayer(l);
    this.from = { parentId: parent.id, index };
    let idx = this.toIndex;
    if (parent === target && index < idx) idx--;
    doc.insertLayer(l, target, idx);
    doc.emit({ type: 'structure' });
  }
  undo(doc: CelenneDocument): void {
    const l = doc.getLayer(this.id);
    if (!l || !this.from) return;
    doc.removeLayer(l);
    doc.insertLayer(l, groupOf(doc, this.from.parentId), this.from.index);
    doc.emit({ type: 'structure' });
  }
}

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

type PropPatch = Partial<Pick<Layer, 'name' | 'visible' | 'opacity' | 'fillOpacity' | 'blendMode' | 'clipping' | 'x' | 'y' | 'colorTag' | 'locks' | 'advanced'>> & Record<string, unknown>;

/** Sets arbitrary layer properties; consecutive edits of the same properties merge. */
export class SetLayerPropsCommand implements Command {
  constructor(
    readonly label: string,
    protected id: LayerId,
    protected before: PropPatch,
    protected after: PropPatch,
    readonly record?: RecordedOp,
    private mergeable = false,
  ) {}
  private apply(doc: CelenneDocument, patch: PropPatch) {
    const l = doc.getLayer(this.id);
    if (!l) return;
    const moved = 'x' in patch || 'y' in patch;
    const oldX = l.x, oldY = l.y;
    Object.assign(l, structuredClone(patch));
    if (moved && l.mask && l.mask.linked) {
      l.mask.x += l.x - oldX;
      l.mask.y += l.y - oldY;
    }
    l.rev++;
    doc.emit({ type: 'layer', layerId: l.id });
  }
  do(doc: CelenneDocument): void {
    this.apply(doc, this.after);
  }
  undo(doc: CelenneDocument): void {
    this.apply(doc, this.before);
  }
  mergeWith(next: Command): boolean {
    if (!this.mergeable || !(next instanceof SetLayerPropsCommand) || next.id !== this.id || next.label !== this.label) return false;
    const keysA = Object.keys(this.after).sort().join(','), keysB = Object.keys(next.after).sort().join(',');
    if (keysA !== keysB) return false;
    this.after = next.after;
    return true;
  }
}

export class ChangeOpacityCommand extends SetLayerPropsCommand {
  constructor(id: LayerId, before: number, after: number, fill = false) {
    super(fill ? 'Fill Opacity' : 'Opacity', id, fill ? { fillOpacity: before } : { opacity: before }, fill ? { fillOpacity: after } : { opacity: after }, { action: fill ? 'layer.setFillOpacity' : 'layer.setOpacity', args: { value: after } }, true);
  }
}

export class ChangeBlendModeCommand extends SetLayerPropsCommand {
  constructor(id: LayerId, before: BlendMode, after: BlendMode) {
    super('Blending Change', id, { blendMode: before }, { blendMode: after }, { action: 'layer.setBlendMode', args: { mode: after } });
  }
}

export class RenameLayerCommand extends SetLayerPropsCommand {
  constructor(id: LayerId, before: string, after: string) {
    super('Rename Layer', id, { name: before }, { name: after });
  }
}

/** Integer translation of one or more layers (Move tool, nudge). */
export class TranslateLayersCommand implements Command {
  readonly label = 'Move';
  constructor(
    private ids: LayerId[],
    private dx: number,
    private dy: number,
    readonly record?: RecordedOp,
  ) {}
  private shift(doc: CelenneDocument, dx: number, dy: number) {
    for (const id of this.ids) {
      const l = doc.getLayer(id);
      if (!l) continue;
      translateLayerDeep(l, dx, dy);
      doc.emit({ type: 'layer', layerId: id });
    }
  }
  do(doc: CelenneDocument): void {
    this.shift(doc, this.dx, this.dy);
  }
  undo(doc: CelenneDocument): void {
    this.shift(doc, -this.dx, -this.dy);
  }
  mergeWith(next: Command): boolean {
    if (!(next instanceof TranslateLayersCommand) || next.ids.join() !== this.ids.join()) return false;
    this.dx += next.dx;
    this.dy += next.dy;
    return true;
  }
}

import { translateLayerDeep } from '../document/translate';
export { translateLayerDeep };

/** Replaces a structured layer field (adjustment params, effects, text, fill, shape...). */
export class SetLayerFieldCommand<T> implements Command {
  constructor(
    readonly label: string,
    protected id: LayerId,
    protected field: string,
    protected before: T,
    protected after: T,
    readonly record?: RecordedOp,
    private mergeable = true,
  ) {}
  private apply(doc: CelenneDocument, v: T) {
    const l = doc.getLayer(this.id) as unknown as Record<string, unknown> | null;
    if (!l) return;
    l[this.field] = v === undefined || v === null ? v : structuredClone(v);
    (l as unknown as Layer).rev++;
    doc.emit({ type: 'layer', layerId: this.id });
  }
  do(doc: CelenneDocument): void {
    this.apply(doc, this.after);
  }
  undo(doc: CelenneDocument): void {
    this.apply(doc, this.before);
  }
  mergeWith(next: Command): boolean {
    if (!this.mergeable || !(next instanceof SetLayerFieldCommand) || next.id !== this.id || next.field !== this.field || next.label !== this.label) return false;
    this.after = next.after as T;
    return true;
  }
}

export class ModifyAdjustmentCommand extends SetLayerFieldCommand<Adjustment> {
  constructor(id: LayerId, before: Adjustment, after: Adjustment) {
    super('Modify Adjustment', id, 'adjustment', before, after);
  }
}

export class SetEffectsCommand extends SetLayerFieldCommand<LayerEffects | null> {
  constructor(id: LayerId, before: LayerEffects | null, after: LayerEffects | null, label = 'Layer Style') {
    super(label, id, 'effects', before, after);
  }
}

// ---------------------------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------------------------

export class SetMaskCommand implements Command {
  constructor(
    readonly label: string,
    private id: LayerId,
    private before: LayerMask | null,
    private after: LayerMask | null,
    readonly record?: RecordedOp,
  ) {}
  private apply(doc: CelenneDocument, m: LayerMask | null) {
    const l = doc.getLayer(this.id);
    if (!l) return;
    l.mask = m ? { ...m, raster: m.raster.clone() } : null;
    l.rev++;
    doc.emit({ type: 'mask', layerId: this.id, rect: null });
  }
  do(doc: CelenneDocument): void {
    this.apply(doc, this.after);
  }
  undo(doc: CelenneDocument): void {
    this.apply(doc, this.before);
  }
}

export class CreateMaskCommand extends SetMaskCommand {}

export class SetVectorMaskCommand implements Command {
  constructor(
    readonly label: string,
    private id: LayerId,
    private before: VectorMask | null,
    private after: VectorMask | null,
  ) {}
  private apply(doc: CelenneDocument, m: VectorMask | null) {
    const l = doc.getLayer(this.id);
    if (!l) return;
    l.vectorMask = m ? structuredClone(m) : null;
    l.rev++;
    doc.emit({ type: 'mask', layerId: this.id, rect: null });
  }
  do(doc: CelenneDocument): void {
    this.apply(doc, this.after);
  }
  undo(doc: CelenneDocument): void {
    this.apply(doc, this.before);
  }
}

// ---------------------------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------------------------

export class CompositeCommand implements Command {
  constructor(
    readonly label: string,
    private commands: Command[],
    readonly record?: RecordedOp,
  ) {}
  do(doc: CelenneDocument): void {
    doc.batch(() => this.commands.forEach((c) => c.do(doc)));
  }
  undo(doc: CelenneDocument): void {
    doc.batch(() => [...this.commands].reverse().forEach((c) => c.undo(doc)));
  }
  memoryBytes(): number {
    return this.commands.reduce((n, c) => n + (c.memoryBytes?.() ?? 0), 0);
  }
  dispose(): void {
    this.commands.forEach((c) => c.dispose?.());
  }
}

/**
 * Swaps a whole layer object (cheap: rasters are copy-on-write clones). Used for transforms,
 * rasterize / convert, text and shape edits, smart-object operations.
 */
export class ReplaceLayerCommand implements Command {
  constructor(
    readonly label: string,
    private before: Layer,
    private after: Layer,
    readonly record?: RecordedOp,
  ) {}
  private swap(doc: CelenneDocument, from: Layer, to: Layer) {
    const current = doc.getLayer(from.id);
    if (!current || !current.parent) return;
    const parent = current.parent;
    const idx = parent.children.indexOf(current);
    const fresh = cloneLayer(to);
    fresh.rev = current.rev + 1;
    parent.children[idx] = fresh;
    fresh.parent = parent;
    doc.emit({ type: 'structure' }, { type: 'layer', layerId: fresh.id });
  }
  do(doc: CelenneDocument): void {
    this.swap(doc, this.before, this.after);
  }
  undo(doc: CelenneDocument): void {
    this.swap(doc, this.after, this.before);
  }
}

export class TransformLayerCommand extends ReplaceLayerCommand {}

/** Captures a layer, runs `mutate` on the live layer and returns a ReplaceLayerCommand (not yet pushed). */
export function editLayer(
  doc: CelenneDocument,
  id: LayerId,
  label: string,
  mutate: (l: Layer) => void,
  record?: RecordedOp,
  Ctor: typeof ReplaceLayerCommand = ReplaceLayerCommand,
): ReplaceLayerCommand | null {
  const l = doc.getLayer(id);
  if (!l) return null;
  const before = cloneLayer(l);
  mutate(l);
  l.rev++;
  const after = cloneLayer(l);
  doc.emit({ type: 'layer', layerId: id }, { type: 'structure' });
  return new Ctor(label, before, after, record);
}

/** Generic reversible closure pair for small document edits (guides, channels, paths). */
export class LambdaCommand implements Command {
  constructor(
    readonly label: string,
    private doFn: (doc: CelenneDocument) => void,
    private undoFn: (doc: CelenneDocument) => void,
    readonly record?: RecordedOp,
  ) {}
  do(doc: CelenneDocument): void {
    this.doFn(doc);
  }
  undo(doc: CelenneDocument): void {
    this.undoFn(doc);
  }
}
