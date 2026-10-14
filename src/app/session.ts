/**
 * DocumentSession — one open document: model + history + renderer + view + editing state.
 */
import { maybeOffload, scratchAvailable } from '../history/scratch';
import { CelenneDocument } from '../document/document';
import { newId } from '../document/ids';
import type { Layer, LayerId } from '../document/types';
import { hasRaster } from '../document/types';
import { Command, History } from '../history/history';
import { RenderEngine } from '../rendering/renderEngine';
import { ViewTransform } from '../rendering/viewport';
import type { RasterTarget } from '../commands/rasterTarget';

export type SessionMode =
  | { kind: 'none' }
  | { kind: 'transform'; layerIds: LayerId[] }
  | { kind: 'crop' }
  | { kind: 'text'; layerId: LayerId; isNew: boolean };

const historyHooks: ((s: DocumentSession) => void)[] = [];

/** Runs after every history change (push, undo, redo) of every session. */
export function addHistoryHook(h: (s: DocumentSession) => void): void {
  historyHooks.push(h);
}

export class DocumentSession {
  readonly id = newId('sess');
  readonly history: History;
  readonly engine: RenderEngine;
  readonly view = new ViewTransform();
  activeLayerId: LayerId | null = null;
  selectedIds = new Set<LayerId>();
  /** Paint on the active layer's mask instead of its pixels. */
  editMask = false;
  /** Paint into an alpha channel (Channels panel selection). */
  activeChannelId: string | null = null;
  /** Path targeted by pen tools / Paths panel (null = work path or active shape layer). */
  activePathId: string | null = null;
  mode: SessionMode = { kind: 'none' };
  fitted = false;
  private savedEntryId: string;
  private listeners = new Set<() => void>();
  private unsub: (() => void)[] = [];

  constructor(
    readonly doc: CelenneDocument,
    initialLabel = 'Open',
  ) {
    this.history = new History(doc, initialLabel);
    this.engine = new RenderEngine(doc);
    this.savedEntryId = this.history.current.id;
    const top = doc.root.children[doc.root.children.length - 1];
    if (top) this.setActive(top.id);
    this.unsub.push(
      doc.on(() => {
        if (this.activeLayerId && !doc.getLayer(this.activeLayerId)) {
          const t = doc.root.children[doc.root.children.length - 1];
          this.setActive(t?.id ?? null);
        }
        for (const id of [...this.selectedIds]) if (!doc.getLayer(id)) this.selectedIds.delete(id);
        this.notify();
      }),
    );
    this.unsub.push(this.history.on(() => { for (const h of historyHooks) h(this); this.notify(); this.scheduleOffload(); }));
  }

  private offloadTimer: ReturnType<typeof setTimeout> | null = null;

  /** Pages old history tiles to the scratch disk once editing pauses (see history/scratch.ts). */
  private scheduleOffload(): void {
    if (!scratchAvailable()) return;
    if (this.offloadTimer) clearTimeout(this.offloadTimer);
    this.offloadTimer = setTimeout(() => { this.offloadTimer = null; maybeOffload(this.doc, this.history); }, 2000);
  }

  on(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  notify(): void {
    for (const l of this.listeners) l();
  }

  get name(): string {
    return this.doc.name;
  }

  get modified(): boolean {
    return this.history.current.id !== this.savedEntryId;
  }

  markSaved(): void {
    this.savedEntryId = this.history.current.id;
    this.notify();
  }

  /** Marks the document as having unsaved changes (e.g. recovered from auto-save). */
  markUnsaved(): void {
    this.savedEntryId = '';
    this.notify();
  }

  activeLayer(): Layer | null {
    return this.doc.getLayer(this.activeLayerId);
  }

  setActive(id: LayerId | null, additive = false): void {
    if (!additive) this.selectedIds.clear();
    this.activeLayerId = id;
    if (id) this.selectedIds.add(id);
    const l = id ? this.doc.getLayer(id) : null;
    if (!l?.mask) this.editMask = false;
    this.activeChannelId = null;
    this.notify();
  }

  toggleSelected(id: LayerId): void {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
      if (this.activeLayerId === id) this.activeLayerId = [...this.selectedIds].pop() ?? null;
    } else {
      this.selectedIds.add(id);
      this.activeLayerId = id;
    }
    this.notify();
  }

  selectedLayers(): Layer[] {
    const out: Layer[] = [];
    for (const l of this.doc.walk()) if (this.selectedIds.has(l.id)) out.push(l);
    if (!out.length) {
      const a = this.activeLayer();
      if (a) out.push(a);
    }
    return out;
  }

  /** Where painting tools write. Null when the target is not paintable. */
  paintTarget(quickMask: boolean): RasterTarget | null {
    if (quickMask) return { kind: 'selection' };
    if (this.activeChannelId) return { kind: 'channel', channelId: this.activeChannelId };
    const l = this.activeLayer();
    if (!l) return null;
    if (this.editMask && l.mask) return { kind: 'mask', layerId: l.id };
    if (l.kind === 'pixel') return { kind: 'layer', layerId: l.id };
    if (l.kind === 'adjustment' || l.kind === 'fill') return l.mask ? { kind: 'mask', layerId: l.id } : null;
    return null;
  }

  /** Why painting is not possible (for user-facing messages). */
  paintBlockReason(quickMask: boolean): string | null {
    if (quickMask || this.activeChannelId) return null;
    const l = this.activeLayer();
    if (!l) return 'Select a layer to paint on.';
    if (this.editMask && l.mask) return null;
    if (l.locks.all || l.locks.pixels) return `"${l.name}" is locked (pixels).`;
    if (!l.visible) return `"${l.name}" is hidden. Show the layer to paint on it.`;
    if (l.kind === 'text') return 'Text layers must be rasterized before painting (Layer › Rasterize › Type).';
    if (l.kind === 'shape') return 'Shape layers must be rasterized before painting (Layer › Rasterize › Shape).';
    if (l.kind === 'smartObject') return 'Smart objects must be rasterized or edited via Layer › Smart Objects › Edit Contents.';
    if (l.kind === 'group') return 'Cannot paint on a group. Select a pixel layer inside the group.';
    if ((l.kind === 'adjustment' || l.kind === 'fill') && !l.mask) return 'Add a layer mask to paint on this layer.';
    if (!hasRaster(l)) return 'This layer cannot be painted on.';
    return null;
  }

  push(cmd: Command, alreadyApplied = false): void {
    this.history.push(cmd, alreadyApplied);
  }

  dispose(): void {
    if (this.offloadTimer) clearTimeout(this.offloadTimer);
    this.unsub.forEach((u) => u());
    this.engine.dispose();
  }
}
