/**
 * History manager (per document).
 *
 *  - Command pattern: every state change is a Command with do/undo.
 *  - Raster commands hold tile snapshots (references to immutable tiles), so a brush stroke on a
 *    16K layer only retains the handful of tiles it touched.
 *  - Consecutive compatible commands (e.g. dragging an opacity slider) are merged.
 *  - Named snapshots capture a full document state lazily (copy-on-write).
 *  - Old states beyond the configured limit are disposed; memory is tracked for the Info panel.
 */
import type { CelenneDocument } from '../document/document';
import { captureState, DocumentState, restoreState } from '../document/clone';
import { newId } from '../document/ids';

export interface RecordedOp {
  /** Action id from the action registry (used by Actions/macros and scripting). */
  action: string;
  args?: Record<string, unknown>;
}

export interface Command {
  readonly label: string;
  /** Applies the change (also used for redo). */
  do(doc: CelenneDocument): void;
  undo(doc: CelenneDocument): void;
  /** Absorbs a following command of the same kind; return true when merged. */
  mergeWith?(next: Command): boolean;
  memoryBytes?(): number;
  dispose?(): void;
  /** Serializable description for macro recording. */
  record?: RecordedOp;
}

export interface HistoryEntry {
  id: string;
  label: string;
  time: number;
  command: Command | null;
}

export interface HistorySnapshot {
  id: string;
  name: string;
  time: number;
  state: DocumentState;
}

export type HistoryListener = () => void;

export class History {
  entries: HistoryEntry[];
  /** Index of the current state in `entries`. */
  index = 0;
  snapshots: HistorySnapshot[] = [];
  maxStates = 100;
  private listeners = new Set<HistoryListener>();
  private lastPushTime = 0;
  /** Commands recorded while an action recording is active. */
  recorder: ((op: RecordedOp, label: string) => void) | null = null;

  constructor(
    private doc: CelenneDocument,
    initialLabel = 'Open',
  ) {
    this.entries = [{ id: newId('h'), label: initialLabel, time: Date.now(), command: null }];
  }

  on(l: HistoryListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  get canUndo(): boolean {
    return this.index > 0;
  }
  get canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }
  get current(): HistoryEntry {
    return this.entries[this.index];
  }

  /**
   * Adds a command. When `alreadyApplied` is false the command is executed first.
   * Redo branch is discarded (standard linear history).
   */
  push(cmd: Command, alreadyApplied = false): void {
    if (!alreadyApplied) this.doc.batch(() => cmd.do(this.doc));
    // Discard redo branch.
    for (const e of this.entries.splice(this.index + 1)) e.command?.dispose?.();
    const now = Date.now();
    const top = this.entries[this.index];
    if (top.command && top.command.mergeWith && now - this.lastPushTime < 1500 && top.command.mergeWith(cmd)) {
      top.time = now;
      this.lastPushTime = now;
      this.notify();
      return;
    }
    this.entries.push({ id: newId('h'), label: cmd.label, time: now, command: cmd });
    this.index = this.entries.length - 1;
    this.lastPushTime = now;
    if (cmd.record && this.recorder) this.recorder(cmd.record, cmd.label);
    this.trim();
    this.notify();
  }

  /** Prevents the next push from merging into the current top (e.g. slider released). */
  seal(): void {
    this.lastPushTime = 0;
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    const e = this.entries[this.index];
    this.doc.batch(() => e.command!.undo(this.doc));
    this.index--;
    this.lastPushTime = 0;
    this.notify();
    return true;
  }

  /** Reverts and discards the newest step (a step the document's mode does not allow). */
  rejectLast(): void {
    if (!this.canUndo || this.index !== this.entries.length - 1) return;
    const e = this.entries[this.index];
    this.doc.batch(() => e.command!.undo(this.doc));
    this.entries.pop();
    this.index--;
    e.command?.dispose?.();
    this.lastPushTime = 0;
    this.notify();
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    const e = this.entries[this.index + 1];
    this.doc.batch(() => e.command!.do(this.doc));
    this.index++;
    this.lastPushTime = 0;
    this.notify();
    return true;
  }

  /** Jumps to a history state (history panel click). */
  goto(index: number): void {
    if (index < 0 || index >= this.entries.length || index === this.index) return;
    this.doc.batch(() => {
      while (this.index > index) {
        this.entries[this.index].command!.undo(this.doc);
        this.index--;
      }
      while (this.index < index) {
        this.index++;
        this.entries[this.index].command!.do(this.doc);
      }
    });
    this.lastPushTime = 0;
    this.notify();
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------------------------
  createSnapshot(name?: string): HistorySnapshot {
    const s: HistorySnapshot = { id: newId('snap'), name: name ?? `Snapshot ${this.snapshots.length + 1}`, time: Date.now(), state: captureState(this.doc) };
    this.snapshots.push(s);
    this.notify();
    return s;
  }

  /** Restores a snapshot as an undoable step. */
  restoreSnapshot(id: string): void {
    const s = this.snapshots.find((x) => x.id === id);
    if (!s) return;
    this.push(new DocumentStateCommand(`Snapshot: ${s.name}`, captureState(this.doc), s.state));
  }

  deleteSnapshot(id: string): void {
    this.snapshots = this.snapshots.filter((s) => s.id !== id);
    this.notify();
  }

  renameSnapshot(id: string, name: string): void {
    const s = this.snapshots.find((x) => x.id === id);
    if (s) s.name = name;
    this.notify();
  }

  renameEntry(id: string, label: string): void {
    const e = this.entries.find((x) => x.id === id);
    if (e) e.label = label;
    this.notify();
  }

  clear(label = 'Open'): void {
    for (const e of this.entries) e.command?.dispose?.();
    this.entries = [{ id: newId('h'), label, time: Date.now(), command: null }];
    this.index = 0;
    this.notify();
  }

  memoryBytes(): number {
    let n = 0;
    for (const e of this.entries) n += e.command?.memoryBytes?.() ?? 0;
    return n;
  }

  private trim() {
    while (this.entries.length - 1 > this.maxStates && this.index > 1) {
      // Drop the oldest command; the initial state label becomes the oldest remaining state.
      const [first, second] = this.entries;
      second.command?.dispose?.();
      this.entries.splice(1, 1);
      first.label = `${second.label} (merged)`;
      first.command = null;
      this.index--;
    }
  }
}

/** Generic command that swaps whole-document states (used for flatten, crop, resize, mode changes...). */
export class DocumentStateCommand implements Command {
  constructor(
    readonly label: string,
    private before: DocumentState,
    private after: DocumentState,
    readonly record?: RecordedOp,
  ) {}
  do(doc: CelenneDocument): void {
    restoreState(doc, this.after);
    doc.emit({ type: 'canvas' }, { type: 'structure' }, { type: 'selection' }, { type: 'channels' }, { type: 'paths' }, { type: 'guides' });
  }
  undo(doc: CelenneDocument): void {
    restoreState(doc, this.before);
    doc.emit({ type: 'canvas' }, { type: 'structure' }, { type: 'selection' }, { type: 'channels' }, { type: 'paths' }, { type: 'guides' });
  }
}

/** Runs `mutate` and records it as a DocumentStateCommand. */
export function recordStateChange(doc: CelenneDocument, history: History, label: string, mutate: () => void, record?: RecordedOp): void {
  const before = captureState(doc);
  doc.batch(mutate);
  const after = captureState(doc);
  history.push(new DocumentStateCommand(label, before, after, record), true);
  doc.emit({ type: 'canvas' }, { type: 'structure' });
}
