/**
 * UI state store. Holds only lightweight, serializable UI state. Documents, pixel buffers and
 * history live in the Editor / DocumentSession objects; components subscribe to revision
 * counters (docRev, historyRev, viewRev) and read models directly, which keeps React re-renders
 * narrow and prevents large buffers from ever entering React state.
 */
import { create } from 'zustand';
import type { RGB } from '../color/types';
import { BRUSH_PRESETS, BrushSettings, defaultBrush, defaultToolOptions, ToolId, ToolOptions } from '../tools/toolTypes';
import { loadJSON, saveJSON } from './settings';

export interface SessionInfo {
  id: string;
  name: string;
  modified: boolean;
  path: string | null;
}

export interface DialogRequest {
  id: number;
  type: string;
  props?: Record<string, unknown>;
}

export interface ProgressState {
  id: number;
  label: string;
  fraction: number | null;
  cancel?: () => void;
}

export interface Toast {
  id: number;
  kind: 'info' | 'warning' | 'error' | 'success';
  message: string;
  detail?: string;
}

export interface ViewFlags {
  rulers: boolean;
  grid: boolean;
  guides: boolean;
  extras: boolean;
  pixelGrid: boolean;
  snap: boolean;
  snapToGuides: boolean;
  snapToGrid: boolean;
  snapToLayers: boolean;
  snapToDocument: boolean;
  smartGuides: boolean;
  proofColors: boolean;
  gamutWarning: boolean;
  showSelectionEdges: boolean;
}

export interface AppState {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  docRev: number;
  historyRev: number;
  viewRev: number;
  selectionRev: number;
  tool: ToolId;
  /** Last-used tool per toolbar group (flyout memory). */
  groupTool: Record<string, ToolId>;
  toolOptions: ToolOptions;
  brush: BrushSettings;
  brushPresets: BrushSettings[];
  fg: RGB;
  bg: RGB;
  swatches: RGB[];
  recentColors: RGB[];
  dialogs: DialogRequest[];
  progress: ProgressState[];
  toasts: Toast[];
  view: ViewFlags;
  quickMask: boolean;
  recordingAction: string | null;
  screenMode: 'standard' | 'full';
  recentFiles: string[];
  cursor: { x: number; y: number; inside: boolean };
  samplers: { x: number; y: number }[];
  measure: { x0: number; y0: number; x1: number; y1: number } | null;
}

const DEFAULT_SWATCHES: RGB[] = [
  '000000', 'ffffff', '808080', 'c0c0c0', 'ff0000', 'ff8000', 'ffff00', '80ff00', '00ff00', '00ff80', '00ffff', '0080ff', '0000ff', '8000ff', 'ff00ff', 'ff0080',
  '800000', '804000', '808000', '408000', '008000', '008040', '008080', '004080', '000080', '400080', '800080', '800040', 'f2d0b6', 'd9a07c', 'a0674a', '5c3a28',
].map((h) => ({ r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 }));

const persisted = loadJSON<Partial<AppState>>('celenne.ui.v1', {});

export const useApp = create<AppState>(() => ({
  sessions: [],
  activeSessionId: null,
  docRev: 0,
  historyRev: 0,
  viewRev: 0,
  selectionRev: 0,
  tool: 'brush',
  groupTool: persisted.groupTool ?? {},
  toolOptions: { ...defaultToolOptions(), ...(persisted.toolOptions ?? {}) },
  brush: persisted.brush ?? defaultBrush(),
  brushPresets: persisted.brushPresets ?? BRUSH_PRESETS,
  fg: { r: 0, g: 0, b: 0 },
  bg: { r: 1, g: 1, b: 1 },
  swatches: persisted.swatches ?? DEFAULT_SWATCHES,
  recentColors: [],
  dialogs: [],
  progress: [],
  toasts: [],
  view: {
    rulers: true,
    grid: false,
    guides: true,
    extras: true,
    pixelGrid: true,
    snap: true,
    snapToGuides: true,
    snapToGrid: false,
    snapToLayers: true,
    snapToDocument: true,
    smartGuides: true,
    proofColors: false,
    gamutWarning: false,
    showSelectionEdges: true,
    ...(persisted.view ?? {}),
  },
  quickMask: false,
  recordingAction: null,
  screenMode: 'standard',
  recentFiles: persisted.recentFiles ?? [],
  cursor: { x: 0, y: 0, inside: false },
  samplers: [],
  measure: null,
}));

// Persist a subset of UI state.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useApp.subscribe((s) => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveJSON('celenne.ui.v1', { toolOptions: s.toolOptions, brush: s.brush, brushPresets: s.brushPresets, swatches: s.swatches, view: s.view, recentFiles: s.recentFiles, groupTool: s.groupTool });
  }, 400);
});

let seq = 1;

export const ui = {
  set: useApp.setState,
  get: useApp.getState,
  openDialog(type: string, props?: Record<string, unknown>): number {
    const id = seq++;
    useApp.setState((s) => ({ dialogs: [...s.dialogs, { id, type, props }] }));
    return id;
  },
  closeDialog(id: number): void {
    useApp.setState((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== id) }));
  },
  toast(kind: Toast['kind'], message: string, detail?: string, ms = 5000): void {
    const id = seq++;
    useApp.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message, detail }] }));
    if (ms > 0) setTimeout(() => useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
  },
  dismissToast(id: number): void {
    useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  /** Starts a progress indicator; returns an updater. */
  progress(label: string, cancel?: () => void): { update: (f: number | null, label?: string) => void; done: () => void } {
    const id = seq++;
    useApp.setState((s) => ({ progress: [...s.progress, { id, label, fraction: null, cancel }] }));
    return {
      update: (f, l) => useApp.setState((s) => ({ progress: s.progress.map((p) => (p.id === id ? { ...p, fraction: f, label: l ?? p.label } : p)) })),
      done: () => useApp.setState((s) => ({ progress: s.progress.filter((p) => p.id !== id) })),
    };
  },
  bump(key: 'docRev' | 'historyRev' | 'viewRev' | 'selectionRev'): void {
    useApp.setState((s) => ({ [key]: s[key] + 1 }) as Partial<AppState>);
  },
  setToolOptions<K extends keyof ToolOptions>(key: K, patch: Partial<ToolOptions[K]>): void {
    useApp.setState((s) => ({ toolOptions: { ...s.toolOptions, [key]: { ...s.toolOptions[key], ...patch } } }));
  },
  setBrush(patch: Partial<BrushSettings>): void {
    useApp.setState((s) => ({ brush: { ...s.brush, ...patch } }));
  },
  addRecentColor(c: RGB): void {
    useApp.setState((s) => ({ recentColors: [c, ...s.recentColors.filter((x) => x.r !== c.r || x.g !== c.g || x.b !== c.b)].slice(0, 12) }));
  },
};
