/**
 * Contract between the renderer and the host (Electron main process or the browser fallback).
 * Everything the UI needs from the operating system goes through this interface, so the
 * renderer never touches Node APIs directly (contextIsolation + sandbox stay enabled).
 */
export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  filters?: FileFilter[];
  multiSelections?: boolean;
  directory?: boolean;
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
}

export interface FileStat {
  exists: boolean;
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

export interface AppPaths {
  userData: string;
  temp: string;
  documents: string;
  recovery: string;
  scratch: string;
}

export interface MessageBoxOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  title?: string;
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
}

export interface SystemMemory {
  totalBytes: number;
  freeBytes: number;
}

/** Auto-update state, as reported by the main process (electron/updater.ts). */
export interface UpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'verifying' | 'ready' | 'error';
  current: string;
  reason?: string;
  version?: string;
  notes?: string;
  percent?: number;
  error?: string;
  downloadUrl?: string;
  portable: boolean;
  autoCheck: boolean;
  lastChecked?: string;
}

export type ReportMode = 'ask' | 'always' | 'never';

export interface ReportsStatus {
  mode: ReportMode;
  /** Host reports are sent to, or null when this build has no destination. */
  destination: string | null;
  unsent: number;
}

export interface ReportSummary {
  id: string;
  created: string;
  kind: 'error' | 'crash';
  process: string;
  type: string;
  message: string;
  count: number;
  sent?: string;
}

export interface CelenneBridge {
  readonly kind: 'electron';
  readonly os: string;
  readonly versions: Record<string, string>;
  showOpenDialog(options: OpenDialogOptions): Promise<string[] | null>;
  showSaveDialog(options: SaveDialogOptions): Promise<string | null>;
  showMessageBox(options: MessageBoxOptions): Promise<number>;
  readFile(path: string): Promise<Uint8Array>;
  /** Atomic write: data goes to a temporary sibling file that replaces the target on success. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  deleteFile(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  listDir(path: string): Promise<string[]>;
  ensureDir(path: string): Promise<void>;
  getPathForFile(file: File): string;
  /** Re-grants access to files from the persisted recent-files list. */
  grantRecent(paths: string[]): void;
  getAppPaths(): Promise<AppPaths>;
  setScratchDir(path: string): Promise<AppPaths>;
  getSystemMemory(): Promise<SystemMemory>;
  setTitle(title: string): void;
  setDocumentEdited(edited: boolean): void;
  /** Main process asks before closing; renderer answers via confirmClose(). */
  onCloseRequested(cb: () => void): void;
  confirmClose(): void;
  onOpenFile(cb: (path: string) => void): void;
  getLaunchFiles(): Promise<string[]>;
  watchFile(path: string): Promise<void>;
  unwatchFile(path: string): Promise<void>;
  onFileChanged(cb: (path: string) => void): void;
  openExternal(url: string): Promise<void>;
  toggleFullScreen(): void;
  toggleDevTools(): void;
  /** Scratch disk tile store (keys are [a-z0-9]+; files live in the scratch directory). */
  scratchWrite(key: string, data: Uint8Array): Promise<void>;
  scratchReadSync(key: string): Uint8Array | null;
  scratchRemove(key: string): void;
  updates: {
    state(): Promise<UpdateState>;
    check(): Promise<void>;
    setAutoCheck(on: boolean): Promise<void>;
    /** Quits and installs the downloaded update; call only after the documents were closed. */
    installNow(): void;
    onState(cb: (s: UpdateState) => void): void;
  };
  reports: {
    status(): Promise<ReportsStatus>;
    list(): Promise<ReportSummary[]>;
    /** The report exactly as it would be sent (JSON text). */
    view(id: string): Promise<string | null>;
    send(ids: string[] | 'unsent'): Promise<{ sent: number; failed: number; error?: string }>;
    discard(ids: string[] | 'all'): Promise<ReportsStatus>;
    setMode(mode: ReportMode): Promise<ReportsStatus>;
    openFolder(which: 'reports' | 'dumps'): Promise<string>;
    /** Records an editor error (scrubbed in the main process). */
    error(e: { type?: string; message?: string; stack?: string }): void;
    /** Non-identifying context added to reports: renderer and the active document's format / mode / depth. */
    setContext(c: { renderer?: string; document?: { format?: string; mode?: string; depth?: number } }): void;
    onNew(cb: (s: ReportsStatus) => void): void;
  };
}

declare global {
  interface Window {
    celenne?: CelenneBridge;
  }
}
