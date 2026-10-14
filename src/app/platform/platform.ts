/**
 * Platform services used by the application layer. Two implementations:
 *  - Electron: real file system via the preload bridge (window.celenne).
 *  - Browser: file pickers, downloads and IndexedDB (development & automated UI tests).
 */
import type { FileFilter, CelenneBridge } from './bridge';

export interface OpenedFile {
  name: string;
  path: string | null;
  data: Uint8Array;
}

export interface Platform {
  readonly kind: 'electron' | 'browser';
  readonly canWriteInPlace: boolean;
  openFiles(filters: FileFilter[], multi: boolean): Promise<OpenedFile[]>;
  readPath(path: string): Promise<OpenedFile>;
  /** Save to a known path (Electron) or trigger a download (browser). */
  writePath(path: string, data: Uint8Array): Promise<void>;
  /** Asks for a destination. Returns a path (Electron) or the chosen file name (browser). */
  chooseSavePath(defaultName: string, filters: FileFilter[]): Promise<string | null>;
  fileFromDrop(file: File): Promise<OpenedFile>;
  /** Key/value storage for recovery snapshots. */
  recovery: RecoveryStore;
  scratch: ScratchStore;
  confirm(message: string, detail?: string, buttons?: string[]): Promise<number>;
  setTitle(title: string): void;
  setEdited(edited: boolean): void;
  onCloseRequested(cb: () => void): void;
  confirmClose(): void;
  onOpenFile(cb: (path: string) => void): void;
  launchFiles(): Promise<string[]>;
  memory(): Promise<{ totalBytes: number; freeBytes: number } | null>;
  bridge: CelenneBridge | null;
}

export interface RecoveryEntry {
  id: string;
  name: string;
  originalPath: string | null;
  savedAt: number;
  byteSize: number;
}

export interface RecoveryStore {
  list(): Promise<RecoveryEntry[]>;
  save(entry: RecoveryEntry, data: Uint8Array): Promise<void>;
  load(id: string): Promise<Uint8Array | null>;
  remove(id: string): Promise<void>;
}

/** Disk-backed blob store for swapped-out history tiles and caches. */
export interface ScratchStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  location(): Promise<string>;
}

// ---------------------------------------------------------------------------------------------
// Electron
// ---------------------------------------------------------------------------------------------
function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

class ElectronPlatform implements Platform {
  readonly kind = 'electron' as const;
  readonly canWriteInPlace = true;
  recovery: RecoveryStore;
  scratch: ScratchStore;
  constructor(readonly bridge: CelenneBridge) {
    const paths = bridge.getAppPaths();
    const join = (a: string, b: string) => `${a.replace(/[\\/]+$/, '')}\\${b}`;
    this.recovery = {
      list: async () => {
        const { recovery } = await paths;
        const files = await bridge.listDir(recovery);
        const out: RecoveryEntry[] = [];
        for (const f of files.filter((f) => f.endsWith('.json'))) {
          try {
            const meta = JSON.parse(new TextDecoder().decode(await bridge.readFile(join(recovery, f))));
            out.push(meta);
          } catch {
            /* ignore broken recovery metadata */
          }
        }
        return out.sort((a, b) => b.savedAt - a.savedAt);
      },
      save: async (entry, data) => {
        const { recovery } = await paths;
        await bridge.writeFile(join(recovery, `${entry.id}.psd`), data);
        await bridge.writeFile(join(recovery, `${entry.id}.json`), new TextEncoder().encode(JSON.stringify(entry)));
      },
      load: async (id) => {
        const { recovery } = await paths;
        try {
          return await bridge.readFile(join(recovery, `${id}.psd`));
        } catch {
          return null;
        }
      },
      remove: async (id) => {
        const { recovery } = await paths;
        await bridge.deleteFile(join(recovery, `${id}.psd`)).catch(() => {});
        await bridge.deleteFile(join(recovery, `${id}.json`)).catch(() => {});
      },
    };
    this.scratch = {
      put: async (k, d) => bridge.writeFile(join((await bridge.getAppPaths()).scratch, `${k}.bin`), d),
      get: async (k) => {
        try {
          return await bridge.readFile(join((await bridge.getAppPaths()).scratch, `${k}.bin`));
        } catch {
          return null;
        }
      },
      remove: async (k) => bridge.deleteFile(join((await bridge.getAppPaths()).scratch, `${k}.bin`)).catch(() => {}),
      clear: async () => {
        const dir = (await bridge.getAppPaths()).scratch;
        for (const f of await bridge.listDir(dir)) await bridge.deleteFile(join(dir, f)).catch(() => {});
      },
      location: async () => (await bridge.getAppPaths()).scratch,
    };
  }
  async openFiles(filters: FileFilter[], multi: boolean): Promise<OpenedFile[]> {
    const paths = await this.bridge.showOpenDialog({ filters, multiSelections: multi, title: 'Open' });
    if (!paths) return [];
    return Promise.all(paths.map((p) => this.readPath(p)));
  }
  async readPath(path: string): Promise<OpenedFile> {
    return { name: basename(path), path, data: await this.bridge.readFile(path) };
  }
  writePath(path: string, data: Uint8Array): Promise<void> {
    return this.bridge.writeFile(path, data);
  }
  chooseSavePath(defaultName: string, filters: FileFilter[]): Promise<string | null> {
    return this.bridge.showSaveDialog({ defaultPath: defaultName, filters, title: 'Save As' });
  }
  async fileFromDrop(file: File): Promise<OpenedFile> {
    const path = this.bridge.getPathForFile(file) || null;
    return { name: file.name, path, data: new Uint8Array(await file.arrayBuffer()) };
  }
  confirm(message: string, detail?: string, buttons = ['OK', 'Cancel']): Promise<number> {
    return this.bridge.showMessageBox({ type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
  }
  setTitle(t: string) {
    this.bridge.setTitle(t);
  }
  setEdited(e: boolean) {
    this.bridge.setDocumentEdited(e);
  }
  onCloseRequested(cb: () => void) {
    this.bridge.onCloseRequested(cb);
  }
  confirmClose() {
    this.bridge.confirmClose();
  }
  onOpenFile(cb: (p: string) => void) {
    this.bridge.onOpenFile(cb);
  }
  launchFiles() {
    return this.bridge.getLaunchFiles();
  }
  memory() {
    return this.bridge.getSystemMemory();
  }
}

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('celenne-studio', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('recovery');
      req.result.createObjectStore('scratch');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbOp<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class BrowserPlatform implements Platform {
  readonly kind = 'browser' as const;
  readonly canWriteInPlace = false;
  readonly bridge = null;
  recovery: RecoveryStore = {
    list: async () => {
      try {
        const all = (await idbOp('recovery', 'readonly', (s) => s.getAll())) as { entry: RecoveryEntry }[];
        return all.map((a) => a.entry).sort((a, b) => b.savedAt - a.savedAt);
      } catch {
        return [];
      }
    },
    save: async (entry, data) => {
      await idbOp('recovery', 'readwrite', (s) => s.put({ entry, data }, entry.id));
    },
    load: async (id) => {
      const v = (await idbOp('recovery', 'readonly', (s) => s.get(id))) as { data: Uint8Array } | undefined;
      return v?.data ?? null;
    },
    remove: async (id) => {
      await idbOp('recovery', 'readwrite', (s) => s.delete(id));
    },
  };
  scratch: ScratchStore = {
    put: async (k, d) => { await idbOp('scratch', 'readwrite', (s) => s.put(d, k)); },
    get: async (k) => ((await idbOp('scratch', 'readonly', (s) => s.get(k))) as Uint8Array | undefined) ?? null,
    remove: async (k) => { await idbOp('scratch', 'readwrite', (s) => s.delete(k)); },
    clear: async () => { await idbOp('scratch', 'readwrite', (s) => s.clear()); },
    location: async () => 'Browser storage (IndexedDB)',
  };

  openFiles(filters: FileFilter[], multi: boolean): Promise<OpenedFile[]> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = multi;
      input.accept = filters.flatMap((f) => f.extensions.map((e) => (e === '*' ? '*' : `.${e}`))).join(',');
      input.onchange = async () => {
        const files = [...(input.files ?? [])];
        resolve(await Promise.all(files.map((f) => this.fileFromDrop(f))));
      };
      input.oncancel = () => resolve([]);
      input.click();
    });
  }
  async readPath(path: string): Promise<OpenedFile> {
    throw new Error(`Cannot read "${path}" in browser mode`);
  }
  async writePath(path: string, data: Uint8Array): Promise<void> {
    const blob = new Blob([data as BlobPart]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = path.split(/[\\/]/).pop() ?? 'untitled';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  async chooseSavePath(defaultName: string): Promise<string | null> {
    return defaultName;
  }
  async fileFromDrop(file: File): Promise<OpenedFile> {
    return { name: file.name, path: null, data: new Uint8Array(await file.arrayBuffer()) };
  }
  async confirm(message: string, detail?: string, buttons = ['OK', 'Cancel']): Promise<number> {
    // Browser mode uses the in-app modal when available (see ui/dialogs/ConfirmHost).
    const host = (window as unknown as { __celenneConfirm?: (m: string, d: string | undefined, b: string[]) => Promise<number> }).__celenneConfirm;
    if (host) return host(message, detail, buttons);
    return window.confirm(`${message}\n\n${detail ?? ''}`) ? 0 : buttons.length - 1;
  }
  setTitle(t: string) {
    document.title = t;
  }
  setEdited() {}
  onCloseRequested(cb: () => void) {
    window.addEventListener('beforeunload', (e) => {
      const dirty = (window as unknown as { __celenneHasUnsaved?: () => boolean }).__celenneHasUnsaved?.();
      if (dirty) {
        e.preventDefault();
        cb();
      }
    });
  }
  confirmClose() {}
  onOpenFile() {}
  async launchFiles() {
    return [];
  }
  async memory() {
    const m = (performance as unknown as { memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number } }).memory;
    return m ? { totalBytes: m.jsHeapSizeLimit, freeBytes: m.jsHeapSizeLimit - m.usedJSHeapSize } : null;
  }
}

let instance: Platform | null = null;
export function platform(): Platform {
  if (!instance) instance = typeof window !== 'undefined' && window.celenne ? new ElectronPlatform(window.celenne) : new BrowserPlatform();
  return instance;
}
