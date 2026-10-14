/**
 * Editor — the application core (framework-agnostic). Owns document sessions, the active tool,
 * clipboard and services; UI components call into it and subscribe to store revisions.
 */
import { configureScratch } from '../history/scratch';
import { DocumentSession } from './session';
import { ui, useApp } from './store';
import type { CelenneDocument } from '../document/document';
import type { Tool, ToolHost } from '../tools/tool';
import type { ToolId } from '../tools/toolTypes';
import { toolInfo } from '../tools/toolTypes';
import { loadPreferences, Preferences, savePreferences } from './settings';
import { setSpotDotGain } from '../color/inks';
import type { Layer } from '../document/types';
import type { TiledRaster } from '../image-engine/tiledRaster';
import type { LayerEffects } from '../effects/types';
import type { VectorPath } from '../vector/types';
import type { RGB } from '../color/types';

export type ClipboardContent =
  | { kind: 'pixels'; raster: TiledRaster; bounds: { x: number; y: number; w: number; h: number }; depth: number; sourceDocId: string; space?: import('../color/convertDocument').ColorSpaceRef }
  | { kind: 'layers'; layers: Layer[]; sourceDocId: string; space?: import('../color/convertDocument').ColorSpaceRef }
  | { kind: 'mask'; raster: TiledRaster; x: number; y: number }
  | { kind: 'style'; effects: LayerEffects | null; blend?: { opacity: number; fillOpacity: number; blendMode: Layer['blendMode'] } }
  | { kind: 'path'; path: VectorPath }
  | { kind: 'text'; text: string };

type ToolFactory = () => Tool;

export class Editor {
  sessions: DocumentSession[] = [];
  activeId: string | null = null;
  prefs: Preferences = loadPreferences();
  clipboard: ClipboardContent | null = null;
  private toolFactories = new Map<ToolId, ToolFactory>();
  private toolInstances = new Map<ToolId, Tool>();
  /** The canvas view registers itself as the tool host provider. */
  hostFactory: (() => ToolHost | null) | null = null;
  private unsubs = new Map<string, () => void>();
  private rafPending = false;
  private pendingKinds = new Set<'docRev' | 'historyRev' | 'viewRev' | 'selectionRev'>();
  /** Temporary tool override (space → hand, alt → eyedropper...). */
  springTool: ToolId | null = null;

  // -------------------------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------------------------
  get active(): DocumentSession | null {
    return this.sessions.find((s) => s.id === this.activeId) ?? null;
  }

  session(id: string): DocumentSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** Called for every document added (opened, created, duplicated). */
  readonly documentAdded = new Set<(s: DocumentSession) => void>();

  addDocument(doc: CelenneDocument, label = 'Open'): DocumentSession {
    const s = new DocumentSession(doc, label);
    for (const h of this.documentAdded) h(s);
    s.history.maxStates = this.prefs.performance.historyStates;
    s.engine.maxBytes = this.prefs.performance.tileCacheMB * 1024 * 1024;
    this.sessions.push(s);
    const offDoc = doc.on((changes) => {
      if (this.deferDocRev()) return;
      this.schedule('docRev');
      if (changes.some((c) => c.type === 'selection')) this.schedule('selectionRev');
    });
    const offHist = s.history.on(() => {
      this.schedule('historyRev');
      this.syncSessions();
    });
    const offSess = s.on(() => { if (!this.deferDocRev()) this.schedule('docRev'); });
    this.unsubs.set(s.id, () => {
      offDoc();
      offHist();
      offSess();
    });
    this.activate(s.id);
    return s;
  }

  activate(id: string): void {
    if (this.activeId === id) return;
    this.cancelTool();
    this.activeId = id;
    this.syncSessions();
    ui.bump('docRev');
    ui.bump('historyRev');
    ui.bump('viewRev');
    this.updateTitle();
  }

  removeSession(id: string): void {
    const s = this.session(id);
    if (!s) return;
    if (this.activeId === id) this.cancelTool();
    this.unsubs.get(id)?.();
    this.unsubs.delete(id);
    s.dispose();
    const idx = this.sessions.indexOf(s);
    this.sessions.splice(idx, 1);
    if (this.activeId === id) this.activeId = this.sessions[Math.min(idx, this.sessions.length - 1)]?.id ?? null;
    this.syncSessions();
    ui.bump('docRev');
    ui.bump('historyRev');
    ui.bump('viewRev');
    this.updateTitle();
  }

  moveSession(id: string, toIndex: number): void {
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [s] = this.sessions.splice(i, 1);
    this.sessions.splice(Math.max(0, Math.min(toIndex, this.sessions.length)), 0, s);
    this.syncSessions();
  }

  syncSessions(): void {
    ui.set({
      sessions: this.sessions.map((s) => ({ id: s.id, name: s.doc.name, modified: s.modified, path: s.doc.filePath })),
      activeSessionId: this.activeId,
    });
    this.updateTitle();
  }

  updateTitle(): void {
    const s = this.active;
    const title = s ? `${s.doc.name}${s.modified ? ' *' : ''} @ ${Math.round(s.view.zoom * 1000) / 10}% — Celenne Studio` : 'Celenne Studio';
    import('./platform/platform').then(({ platform }) => {
      platform().setTitle(title);
      platform().setEdited(this.sessions.some((x) => x.modified));
    });
  }

  /** Coalesces store notifications to one per animation frame. */
  // -------------------------------------------------------------------------------------------
  // Interactions (drags): panels are not refreshed for every pointer move, only once at the end.
  // -------------------------------------------------------------------------------------------
  private interactions = 0;
  private docRevDeferred = false;

  beginInteraction(): void {
    this.interactions++;
  }

  endInteraction(): void {
    this.interactions = Math.max(0, this.interactions - 1);
    if (!this.interactions && this.docRevDeferred) {
      this.docRevDeferred = false;
      this.schedule('docRev');
    }
  }

  private deferDocRev(): boolean {
    if (!this.interactions) return false;
    this.docRevDeferred = true;
    return true;
  }

  schedule(kind: 'docRev' | 'historyRev' | 'viewRev' | 'selectionRev'): void {
    this.pendingKinds.add(kind);
    if (this.rafPending) return;
    this.rafPending = true;
    const run = () => {
      this.rafPending = false;
      const kinds = [...this.pendingKinds];
      this.pendingKinds.clear();
      const s = useApp.getState();
      const patch: Record<string, number> = {};
      for (const k of kinds) patch[k] = s[k] + 1;
      ui.set(patch);
    };
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  // -------------------------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------------------------
  registerTool(id: ToolId, f: ToolFactory): void {
    this.toolFactories.set(id, f);
  }

  tool(id: ToolId): Tool | null {
    let t = this.toolInstances.get(id);
    if (!t) {
      const f = this.toolFactories.get(id);
      if (!f) return null;
      t = f();
      this.toolInstances.set(id, t);
    }
    return t;
  }

  get currentToolId(): ToolId {
    return this.springTool ?? useApp.getState().tool;
  }

  /** The tool receiving input: a session mode's controller (e.g. Free Transform) wins over the selected tool. */
  get currentTool(): Tool | null {
    const m = this.active?.mode.kind;
    const c = m && m !== 'none' ? this.modeControllers.get(m) : undefined;
    return c ?? this.tool(this.currentToolId);
  }

  private modeControllers = new Map<string, Tool>();

  /** Registers the controller that handles input while a session is in `kind` mode. */
  registerModeController(kind: string, controller: Tool): void {
    this.modeControllers.set(kind, controller);
  }

  setTool(id: ToolId): void {
    const info = toolInfo(id);
    if (info.comingSoon) {
      ui.toast('info', `${info.label} is coming soon.`, 'The tool slot is reserved; functionality is not implemented yet.');
      return;
    }
    const prev = useApp.getState().tool;
    if (prev === id) return;
    this.cancelTool();
    const host = this.hostFactory?.();
    if (host) this.tool(prev)?.deactivate?.(host);
    ui.set((s) => ({ tool: id, groupTool: { ...s.groupTool, [info.group]: id } }));
    if (host) this.tool(id)?.activate?.(host);
    host?.redraw();
  }

  /** Cancels the in-progress interaction of the current tool. */
  cancelTool(): void {
    const host = this.hostFactory?.();
    if (host) this.currentTool?.cancel?.(host);
  }

  // -------------------------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------------------------
  setPrefs(p: Preferences): void {
    this.prefs = p;
    savePreferences(p);
    applyScratchPrefs(p);
    const gainChanged = setSpotDotGain(p.color.spotDotGain);
    for (const s of this.sessions) {
      if (gainChanged && (s.doc.canvas.duotone || s.doc.canvas.colorMode === 'multichannel')) s.engine.invalidateAll();
      s.history.maxStates = p.performance.historyStates;
      s.engine.maxBytes = p.performance.tileCacheMB * 1024 * 1024;
    }
    ui.bump('viewRev');
  }

  // -------------------------------------------------------------------------------------------
  // Colors
  // -------------------------------------------------------------------------------------------
  setForeground(c: RGB): void {
    ui.set({ fg: c });
    ui.addRecentColor(c);
  }
  setBackground(c: RGB): void {
    ui.set({ bg: c });
  }
}

export const editor = new Editor();
(globalThis as unknown as { __celenneEditor?: Editor }).__celenneEditor = editor;

/** Pushes the scratch-disk preferences to the history pager. */
export function applyScratchPrefs(p: Preferences): void {
  setSpotDotGain(p.color.spotDotGain);
  configureScratch({ enabled: p.performance.historyToScratch, budgetBytes: p.performance.historyMemoryMB * 1024 * 1024, maxScratchBytes: p.scratch.maxMB * 1024 * 1024 });
}
