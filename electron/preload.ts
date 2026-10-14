/**
 * Preload bridge: exposes a minimal, typed API (window.celenne) to the sandboxed renderer.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { CelenneBridge, ReportsStatus, UpdateState } from '../src/app/platform/bridge';

const listeners = {
  close: [] as (() => void)[],
  open: [] as ((p: string) => void)[],
  changed: [] as ((p: string) => void)[],
  update: [] as ((s: UpdateState) => void)[],
  reports: [] as ((s: ReportsStatus) => void)[],
};
ipcRenderer.on('updates:state', (_e, s: UpdateState) => listeners.update.forEach((cb) => cb(s)));
ipcRenderer.on('reports:new', (_e, s: ReportsStatus) => listeners.reports.forEach((cb) => cb(s)));
ipcRenderer.on('app:close-requested', () => listeners.close.forEach((cb) => cb()));
ipcRenderer.on('app:open-file', (_e, p: string) => listeners.open.forEach((cb) => cb(p)));
ipcRenderer.on('fs:changed', (_e, p: string) => listeners.changed.forEach((cb) => cb(p)));

const bridge: CelenneBridge = {
  kind: 'electron',
  os: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  showOpenDialog: (o) => ipcRenderer.invoke('dialog:open', o),
  showSaveDialog: (o) => ipcRenderer.invoke('dialog:save', o),
  showMessageBox: (o) => ipcRenderer.invoke('dialog:message', o),
  readFile: (p) => ipcRenderer.invoke('fs:read', p),
  writeFile: (p, d) => ipcRenderer.invoke('fs:write', p, d),
  deleteFile: (p) => ipcRenderer.invoke('fs:delete', p),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  listDir: (p) => ipcRenderer.invoke('fs:list', p),
  ensureDir: (p) => ipcRenderer.invoke('fs:mkdir', p),
  getPathForFile: (file) => {
    const p = webUtils.getPathForFile(file);
    if (p) ipcRenderer.send('fs:grant-dropped', p);
    return p;
  },
  grantRecent: (list) => ipcRenderer.send('fs:grant-recent', list),
  getAppPaths: () => ipcRenderer.invoke('app:paths'),
  setScratchDir: (p) => ipcRenderer.invoke('app:set-scratch', p),
  getSystemMemory: () => ipcRenderer.invoke('app:memory'),
  setTitle: (t) => ipcRenderer.send('app:set-title', t),
  setDocumentEdited: (v) => ipcRenderer.send('app:set-edited', v),
  onCloseRequested: (cb) => { listeners.close.push(cb); },
  confirmClose: () => ipcRenderer.send('app:confirm-close'),
  onOpenFile: (cb) => { listeners.open.push(cb); },
  getLaunchFiles: () => ipcRenderer.invoke('app:launch-files'),
  watchFile: (p) => ipcRenderer.invoke('fs:watch', p),
  unwatchFile: (p) => ipcRenderer.invoke('fs:unwatch', p),
  onFileChanged: (cb) => { listeners.changed.push(cb); },
  openExternal: (u) => ipcRenderer.invoke('app:open-external', u),
  toggleFullScreen: () => ipcRenderer.send('app:fullscreen'),
  toggleDevTools: () => ipcRenderer.send('app:devtools'),
  scratchWrite: (k, d) => ipcRenderer.invoke('scratch:write', k, d),
  scratchReadSync: (k) => ipcRenderer.sendSync('scratch:read-sync', k) as Uint8Array | null,
  scratchRemove: (k) => ipcRenderer.send('scratch:remove', k),
  updates: {
    state: () => ipcRenderer.invoke('updates:state'),
    check: () => ipcRenderer.invoke('updates:check'),
    setAutoCheck: (v) => ipcRenderer.invoke('updates:set-auto', v),
    installNow: () => ipcRenderer.send('updates:install-now'),
    onState: (cb) => { listeners.update.push(cb); },
  },
  reports: {
    status: () => ipcRenderer.invoke('reports:status'),
    list: () => ipcRenderer.invoke('reports:list'),
    view: (id) => ipcRenderer.invoke('reports:view', id),
    send: (ids) => ipcRenderer.invoke('reports:send', ids),
    discard: (ids) => ipcRenderer.invoke('reports:discard', ids),
    setMode: (m) => ipcRenderer.invoke('reports:set-mode', m),
    openFolder: (which) => ipcRenderer.invoke('reports:open-folder', which),
    error: (e) => ipcRenderer.send('reports:error', e),
    setContext: (c) => ipcRenderer.send('reports:context', c),
    onNew: (cb) => { listeners.reports.push(cb); },
  },
};

contextBridge.exposeInMainWorld('celenne', bridge);
