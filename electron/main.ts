/**
 * Celenne Studio — Electron main process.
 *
 * Responsibilities: window lifecycle, the privileged `app://` protocol that serves the renderer,
 * file-system access (restricted to user-granted paths), dialogs, crash handling and
 * single-instance file opening. No image processing happens here.
 */
import { app, BrowserWindow, dialog, ipcMain, protocol, net, session, shell, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { initReports, startCrashDumps, type ReportMode } from './reports';
import { initUpdater } from './updater';

const isDev = !!process.env.CELENNE_DEV_SERVER_URL;
const DIST = path.join(__dirname, '../dist');

startCrashDumps();

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// ---------------------------------------------------------------------------------------------
// Path allowlist. The renderer may only read/write files the user explicitly chose (dialogs,
// drag & drop, command line, recent files) plus the app's own recovery / scratch directories.
// A malicious document therefore cannot cause arbitrary file writes.
// ---------------------------------------------------------------------------------------------
const granted = new Set<string>();
const grantedDirs = new Set<string>();
const norm = (p: string) => path.resolve(p).toLowerCase();
function grant(p: string) { granted.add(norm(p)); }
function grantDir(p: string) { grantedDirs.add(norm(p)); }
function isAllowed(p: string): boolean {
  const n = norm(p);
  if (granted.has(n)) return true;
  for (const d of grantedDirs) if (n === d || n.startsWith(d + path.sep)) return true;
  return false;
}
function assertAllowed(p: string) {
  if (typeof p !== 'string' || !p) throw new Error('Invalid path');
  if (!isAllowed(p)) throw new Error(`Access to "${p}" was not granted by the user`);
}

// ---------------------------------------------------------------------------------------------
// App directories
// ---------------------------------------------------------------------------------------------
const settingsFile = () => path.join(app.getPath('userData'), 'host-settings.json');
interface HostSettings { scratchDir?: string; recentFiles?: string[]; updates?: { autoCheck?: boolean }; reports?: { mode?: ReportMode } }
function readHostSettings(): HostSettings {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeHostSettings(s: HostSettings) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
function appPaths() {
  const userData = app.getPath('userData');
  const hs = readHostSettings();
  const recovery = path.join(userData, 'Recovery');
  const scratch = hs.scratchDir && fs.existsSync(hs.scratchDir) ? path.join(hs.scratchDir, 'CelenneScratch') : path.join(app.getPath('temp'), 'CelenneScratch');
  for (const d of [recovery, scratch]) { fs.mkdirSync(d, { recursive: true }); grantDir(d); }
  grantDir(path.join(userData, 'Presets'));
  fs.mkdirSync(path.join(userData, 'Presets'), { recursive: true });
  return { userData, temp: app.getPath('temp'), documents: app.getPath('documents'), recovery, scratch };
}

/** Local diagnostic log (<userData>/logs/main.log, rotated at 1 MB). Never uploaded. */
function log(line: string) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'main.log');
    try { if (fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, path.join(dir, 'main.old.log')); } catch { /* no log yet */ }
    fs.appendFileSync(f, `${new Date().toISOString()} ${line}
`);
  } catch { /* logging must never fail the app */ }
}

/**
 * The app was called "Lumen Studio" up to 0.1.0. On the first start under the new name, copy the
 * old app folder's recovery files, presets and host settings across (the old folder is kept).
 * Editor preferences lived in the old renderer origin's storage and start from defaults.
 */
function migrateFromFormerName() {
  const userData = app.getPath('userData');
  const former = path.join(path.dirname(userData), 'Lumen Studio');
  if (former === userData || !fs.existsSync(former) || fs.existsSync(settingsFile())) return;
  for (const name of ['Recovery', 'Presets', 'host-settings.json']) {
    const from = path.join(former, name);
    try { if (fs.existsSync(from)) fs.cpSync(from, path.join(userData, name), { recursive: true, errorOnExist: false, force: false }); } catch { /* best effort */ }
  }
  if (!fs.existsSync(settingsFile())) writeHostSettings({});
}

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------
let mainWindow: BrowserWindow | null = null;
let allowClose = false;
const launchFiles: string[] = [];
const watchers = new Map<string, fs.FSWatcher>();
let scratchTiles: string | null = null;

function filesFromArgv(argv: string[]): string[] {
  // Images and camera raw files (raw extensions as RAW_EXTENSIONS in src/formats/raster.ts).
  return argv.slice(1).filter((a) => !a.startsWith('-') && /\.(psd|psb|png|jpe?g|tiff?|bmp|gif|webp|svg|dng|cr2|cr3|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|srw|x3f|3fr|iiq|erf|kdc|dcr|mrw|rwl)$/i.test(a) && fs.existsSync(a));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1e1f22',
    title: 'Celenne Studio',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null); // the application menu is rendered by the UI (shared with browser mode)
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    mainWindow?.webContents.send('app:close-requested');
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    // Crash recovery: the renderer keeps recovery snapshots on disk; reloading lets it offer them.
    console.error('Renderer process gone:', details.reason);
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed() && process.env.CELENNE_SMOKE_REPORT !== '1') {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Celenne Studio',
        message: 'The editor stopped unexpectedly.',
        detail: 'Celenne Studio will restart the editor. Documents with auto-save recovery data will be offered in "Recovered Documents".',
      }).finally(() => mainWindow?.reload());
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowedPrefix = isDev ? process.env.CELENNE_DEV_SERVER_URL! : 'app://celenne/';
    if (!url.startsWith(allowedPrefix)) e.preventDefault();
  });
  if (process.env.CELENNE_SMOKE === '1') runSmokeTest(mainWindow);
  if (isDev) mainWindow.loadURL(process.env.CELENNE_DEV_SERVER_URL!);
  else mainWindow.loadURL('app://celenne/index.html');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runDragBenchmark(win: BrowserWindow, [docX, docY, dx, dy]: number[]): Promise<Record<string, unknown>> {
  const wc = win.webContents;
  win.show();
  win.focus();
  // Screen position of the document point (documents open fitted, centered, at most 100 %).
  const pos = await wc.executeJavaScript(`(() => {
    const vp = document.querySelector('.viewport').getBoundingClientRect();
    const m = /([0-9]+) × ([0-9]+) px/.exec(document.querySelector('.statusbar').textContent);
    const W = +m[1], H = +m[2];
    const z = Math.min((vp.width - 48) / W, (vp.height - 48) / H, 1);
    const ox = vp.left + (vp.width - W * z) / 2, oy = vp.top + (vp.height - H * z) / 2;
    window.__frames = []; window.__rec = true;
    window.__ev = { down: 0, move: 0, up: 0, keys: [] };
    addEventListener('pointerdown', (e) => { window.__ev.down++; window.__ev.btn = e.button + '/' + e.buttons + (e.ctrlKey ? '+ctrl' : ''); window.__ev.target = e.target.className; }, true);
    addEventListener('pointermove', (e) => { window.__ev.move++; if (e.buttons) window.__ev.moveBtn = (window.__ev.moveBtn || 0) + 1; }, true);
    addEventListener('pointerup', () => { window.__ev.up++; }, true);
    addEventListener('keydown', (e) => { window.__ev.keys.push(e.key); }, true);
    let last = performance.now();
    window.__pend = [];
    const f = (t) => { window.__frames.push(t - last); last = t; const e = window.__celenneEditor?.active?.engine; window.__pend.push(e && e.hasPendingWork() && !(e.lift && e.lift.active) ? 1 : 0); if (window.__rec) requestAnimationFrame(f); };
    requestAnimationFrame(f);
    return { x: ox + ${docX} * z, y: oy + ${docY} * z, z };
  })()`);
  const key = (k: string) => { wc.sendInputEvent({ type: 'keyDown', keyCode: k }); wc.sendInputEvent({ type: 'char', keyCode: k }); wc.sendInputEvent({ type: 'keyUp', keyCode: k }); };
  key('v'); // Move tool
  await sleep(200);
  const x0 = Math.round(pos.x), y0 = Math.round(pos.y);
  wc.sendInputEvent({ type: 'mouseMove', x: x0 - 2, y: y0 });
  await sleep(20);
  wc.sendInputEvent({ type: 'mouseMove', x: x0, y: y0 });
  // CELENNE_SMOKE_DRAG_HOVER: how long the pointer rests on the layer before the press (ms).
  await sleep(Number(process.env.CELENNE_SMOKE_DRAG_HOVER ?? 50));
  wc.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1, modifiers: ['control'] });
  await sleep(30);
  await wc.executeJavaScript('window.__frames = []; window.__pend = []');
  const steps = 60;
  const t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x0 + (dx * pos.z * i) / steps), y: Math.round(y0 + (dy * pos.z * i) / steps), button: 'left', modifiers: ['control', 'leftbuttondown'] });
    await sleep(16);
  }
  const dragMs = Date.now() - t0;
  const during: number[] = await wc.executeJavaScript('window.__frames.slice()');
  const pendingFrames: number = await wc.executeJavaScript('window.__pend.reduce((a, b) => a + b, 0)');
  if (process.env.CELENNE_SMOKE_SHOT_MID) fs.writeFileSync(process.env.CELENNE_SMOKE_SHOT_MID, (await wc.capturePage()).toPNG());
  wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x0 + dx * pos.z), y: Math.round(y0 + dy * pos.z), button: 'left', clickCount: 1, modifiers: ['control'] });
  await wc.executeJavaScript('window.__frames = []; window.__pend = []');
  const tDrop = Date.now();
  let settleMs = -1;
  while (Date.now() - tDrop < 3000) { if (!(await wc.executeJavaScript('!!window.__celenneEditor?.active?.engine.hasPendingWork()'))) { settleMs = Date.now() - tDrop; break; } await sleep(5); }
  await sleep(1000);
  const after: number[] = await wc.executeJavaScript('window.__rec = false; window.__frames.slice()');
  const stats = (a: number[]) => {
    const s = [...a].sort((p, q) => p - q);
    return { frames: a.length, avgMs: +(a.reduce((p, q) => p + q, 0) / Math.max(1, a.length)).toFixed(1), p95Ms: +(s[Math.floor(s.length * 0.95)] ?? 0).toFixed(1), maxMs: +(s[s.length - 1] ?? 0).toFixed(1) };
  };
  const state = await wc.executeJavaScript(`({
    status: document.querySelector('.statusbar')?.textContent?.trim().slice(0, 160),
    tool: document.querySelector('.optionsbar')?.textContent?.trim().slice(0, 40),
    events: window.__ev,
    toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim().slice(0, 120)),
    model: (() => { const e = window.__celenneEditor, s = e?.active; if (!s) return null; const l = s.activeLayer(); return { tool: e.currentToolId, busy: !!e.currentTool?.busy?.(), active: l && { name: l.name, x: l.x, y: l.y, locks: l.locks }, selected: s.selectedLayers().map((x) => x.name), history: s.history.entries.map((h) => h.label).slice(-4), lift: !!s.engine.lift }; })(),
    history: [...document.querySelectorAll('.list-item')].map((e) => e.textContent.trim()).filter(Boolean).slice(-3),
  })`);
  if (process.env.CELENNE_SMOKE_SHOT) fs.writeFileSync(process.env.CELENNE_SMOKE_SHOT, (await wc.capturePage()).toPNG());
  return { dragMs, pendingFrames, settleMs, duringDrag: stats(during), afterDrop1s: stats(after), fps: +(during.length / (dragMs / 1000)).toFixed(0), ...state };
}

/**
 * Packaging smoke test (CELENNE_SMOKE=1): loads the real renderer through the app:// protocol with
 * the production CSP, reports console errors and basic UI health on stdout, then exits.
 */
function runSmokeTest(win: BrowserWindow) {
  const errors: string[] = [];
  win.webContents.on('console-message', (e) => {
    const { level, message } = e as unknown as { level: string | number; message: string };
    if (level === 'error' || level === 3) errors.push(message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => errors.push(`did-fail-load ${code} ${desc} ${url}`));
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      let report: Record<string, unknown> = {};
      try {
        report = await win.webContents.executeJavaScript(`(() => ({
          title: document.title,
          menubar: !!document.querySelector('.menubar'),
          toolbar: document.querySelectorAll('.tool-btn').length,
          panels: document.querySelectorAll('.flexlayout__tab_button').length,
          welcome: !!document.querySelector('.welcome'),
          bridge: typeof window.celenne === 'object',
          nodeExposed: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
          webgl2: !!document.createElement('canvas').getContext('webgl2'),
          docTabs: [...document.querySelectorAll('.doc-tab')].map((t) => t.textContent.trim()),
          layerRows: document.querySelectorAll('.layer-row').length,
          toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim().slice(0, 160)),
          status: document.querySelector('.statusbar')?.textContent?.trim().slice(0, 200),
        }))()`);
      } catch (err) {
        errors.push(`executeJavaScript: ${(err as Error).message}`);
      }
      // Optional drag benchmark: CELENNE_SMOKE_DRAG="docX,docY,dx,dy" Ctrl-drags the layer under that
      // document point with real input events and reports frame times.
      if (process.env.CELENNE_SMOKE_DRAG && !errors.length) {
        try {
          report.drag = await runDragBenchmark(win, process.env.CELENNE_SMOKE_DRAG.split(',').map(Number));
        } catch (err) {
          errors.push(`drag benchmark: ${(err as Error).message}`);
        }
      }
      // Optional: CELENNE_SMOKE_EVAL (a file holding an async JS function body) runs in the editor; its result is reported.
      if (process.env.CELENNE_SMOKE_EVAL && !errors.length) {
        try {
          const body = fs.readFileSync(process.env.CELENNE_SMOKE_EVAL, 'utf8');
          report.eval = await win.webContents.executeJavaScript(`(async () => { ${body} })()`);
          if (process.env.CELENNE_SMOKE_SHOT) fs.writeFileSync(process.env.CELENNE_SMOKE_SHOT, (await win.webContents.capturePage()).toPNG());
        } catch (err) {
          errors.push(`eval: ${(err as Error).message}`);
        }
      }
      // Optional: CELENNE_SMOKE_MENU="Help>Check for Updates…" opens that menu item; CELENNE_SMOKE_SHOT saves a screenshot.
      if (process.env.CELENNE_SMOKE_MENU && !errors.length) {
        const [menu, item] = process.env.CELENNE_SMOKE_MENU.split('>');
        report.menu = await win.webContents.executeJavaScript(`(() => {
          const t = [...document.querySelectorAll('.menu-title')].find((e) => e.textContent.trim() === ${JSON.stringify(menu)});
          if (!t) return 'menu not found';
          t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          return new Promise((res) => setTimeout(() => {
            const i = [...document.querySelectorAll('.menu-item .label')].find((e) => e.textContent.trim() === ${JSON.stringify(item)});
            if (!i) return res('item not found');
            i.closest('.menu-item').click();
            setTimeout(() => res(document.querySelector('.modal')?.textContent?.trim().slice(0, 400) ?? 'no dialog'), 1500);
          }, 300));
        })()`);
        if (process.env.CELENNE_SMOKE_SHOT) fs.writeFileSync(process.env.CELENNE_SMOKE_SHOT, (await win.webContents.capturePage()).toPNG());
      }
      process.stdout.write(`CELENNE_SMOKE ${JSON.stringify({ ...report, errors })}\n`);
      allowClose = true;
      app.exit(errors.length || !report.menubar || report.nodeExposed ? 1 : 0);
    }, 4000);
  });
}

/**
 * Error-report self-test (CELENNE_SMOKE_REPORT=1): raises an editor error whose message holds a
 * layer name and a file path, crashes the editor process, sends the saved reports (to the build's
 * destination, normally a loopback test receiver) and prints them on stdout, then quits.
 */
function runReportSmoke(reports: ReturnType<typeof initReports>, quit: () => void) {
  const win = mainWindow!;
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const tabs: string[] = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.doc-tab')].map((t) => t.textContent.trim())`);
      const secret = path.join(os.homedir(), 'Desktop', 'Q3 salary review.psd');
      await win.webContents.executeJavaScript(`setTimeout(() => { throw new Error('Could not apply "Client logo" to ' + ${JSON.stringify(secret)}); }, 0); 1`);
      await sleep(2500);
      win.webContents.forcefullyCrashRenderer();
      await sleep(3000);
      const sent = await reports.send('unsent');
      const list = reports.list();
      process.stdout.write(`CELENNE_REPORT ${JSON.stringify({ tabs, sent, reports: list.map((r) => ({ ...r, text: reports.text(r.id) })) })}
`);
      quit();
    }, 6000);
  });
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data: https:",
  "frame-src 'self' blob:",
  "object-src 'none'",
].join('; ');

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    if (file.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
    if (file.endsWith('.js') || file.endsWith('.mjs')) headers.set('Content-Type', 'text/javascript');
    return new Response(res.body, { status: res.status, headers });
  });
}

// ---------------------------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('dialog:open', async (_e, opts: Electron.OpenDialogOptions & { multiSelections?: boolean; directory?: boolean }) => {
    const props: Electron.OpenDialogOptions['properties'] = [opts.directory ? 'openDirectory' : 'openFile'];
    if (opts.multiSelections) props.push('multiSelections');
    const r = await dialog.showOpenDialog(mainWindow!, { title: opts.title, filters: opts.filters, properties: props });
    if (r.canceled) return null;
    for (const f of r.filePaths) (opts.directory ? grantDir : grant)(f);
    return r.filePaths;
  });
  ipcMain.handle('dialog:save', async (_e, opts: Electron.SaveDialogOptions) => {
    const r = await dialog.showSaveDialog(mainWindow!, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
    if (r.canceled || !r.filePath) return null;
    grant(r.filePath);
    return r.filePath;
  });
  ipcMain.handle('dialog:message', async (_e, opts: Electron.MessageBoxOptions) => {
    const r = await dialog.showMessageBox(mainWindow!, opts);
    return r.response;
  });
  ipcMain.handle('fs:read', async (_e, p: string) => {
    assertAllowed(p);
    const buf = await fs.promises.readFile(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });
  ipcMain.handle('fs:write', async (_e, p: string, data: Uint8Array) => {
    assertAllowed(p);
    // Atomic replace: never leave a half-written document behind.
    const tmp = `${p}.celenne-tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, p);
  });
  ipcMain.handle('fs:delete', async (_e, p: string) => {
    assertAllowed(p);
    const n = norm(p);
    let inAppDir = false;
    for (const d of grantedDirs) if (n.startsWith(d + path.sep)) inAppDir = true;
    if (!inAppDir) throw new Error('Deleting is only allowed inside application directories');
    await fs.promises.rm(p, { force: true, recursive: true });
  });
  ipcMain.handle('fs:stat', async (_e, p: string) => {
    assertAllowed(p);
    try {
      const s = await fs.promises.stat(p);
      return { exists: true, size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
    } catch {
      return { exists: false, size: 0, mtimeMs: 0, isDirectory: false };
    }
  });
  ipcMain.handle('fs:list', async (_e, p: string) => {
    assertAllowed(p);
    try { return await fs.promises.readdir(p); } catch { return []; }
  });
  ipcMain.handle('fs:mkdir', async (_e, p: string) => {
    assertAllowed(p);
    await fs.promises.mkdir(p, { recursive: true });
  });
  ipcMain.on('fs:grant-dropped', (_e, p: string) => { if (typeof p === 'string' && p && fs.existsSync(p)) grant(p); });
  ipcMain.on('fs:grant-recent', (_e, list: string[]) => { if (Array.isArray(list)) for (const p of list) if (typeof p === 'string') grant(p); });
  ipcMain.handle('app:paths', () => appPaths());
  ipcMain.handle('app:set-scratch', (_e, dir: string) => {
    assertAllowed(dir);
    const hs = readHostSettings();
    hs.scratchDir = dir;
    writeHostSettings(hs);
    return appPaths();
  });
  ipcMain.handle('app:memory', () => ({ totalBytes: os.totalmem(), freeBytes: os.freemem() }));
  // Scratch disk tiles (history paging): one directory per running instance, validated keys only.
  const tileDir = () => {
    if (!scratchTiles) {
      const base = appPaths().scratch;
      scratchTiles = path.join(base, `tiles-${process.pid}`);
      // Remove directories left behind by instances that are no longer running.
      for (const d of fs.readdirSync(base)) {
        const m = /^tiles-(\d+)$/.exec(d);
        if (!m || Number(m[1]) === process.pid) continue;
        let alive = false;
        try { process.kill(Number(m[1]), 0); alive = true; } catch { /* not running */ }
        if (!alive) fs.rmSync(path.join(base, d), { recursive: true, force: true });
      }
      fs.mkdirSync(scratchTiles, { recursive: true });
    }
    return scratchTiles;
  };
  const tileFile = (k: unknown) => {
    if (typeof k !== 'string' || !/^[a-z0-9]{1,40}$/.test(k)) throw new Error('Invalid scratch key');
    return path.join(tileDir(), `${k}.tile`);
  };
  ipcMain.handle('scratch:write', async (_e, k: string, data: Uint8Array) => {
    if (!(data instanceof Uint8Array) || data.byteLength > 64 * 1024 * 1024) throw new Error('Invalid scratch data');
    await fs.promises.writeFile(tileFile(k), data);
  });
  ipcMain.on('scratch:read-sync', (e, k: string) => {
    try { const b = fs.readFileSync(tileFile(k)); e.returnValue = new Uint8Array(b.buffer, b.byteOffset, b.byteLength); } catch { e.returnValue = null; }
  });
  ipcMain.on('scratch:remove', (_e, k: string) => { try { fs.rmSync(tileFile(k), { force: true }); } catch { /* ignore */ } });
  ipcMain.handle('app:launch-files', () => { const f = launchFiles.splice(0); f.forEach(grant); return f; });
  ipcMain.on('app:set-title', (_e, t: string) => mainWindow?.setTitle(String(t)));
  ipcMain.on('app:set-edited', (_e, v: boolean) => mainWindow?.setDocumentEdited(!!v));
  ipcMain.on('app:confirm-close', () => { allowClose = true; mainWindow?.close(); });
  ipcMain.on('app:fullscreen', () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()));
  ipcMain.on('app:devtools', () => mainWindow?.webContents.toggleDevTools());
  ipcMain.handle('app:open-external', async (_e, url: string) => {
    if (/^https:\/\//.test(url)) await shell.openExternal(url);
  });
  ipcMain.handle('fs:watch', (_e, p: string) => {
    assertAllowed(p);
    if (watchers.has(p)) return;
    try {
      const w = fs.watch(p, { persistent: false }, () => mainWindow?.webContents.send('fs:changed', p));
      watchers.set(p, w);
    } catch { /* file may be on a volume that does not support watching */ }
  });
  ipcMain.handle('fs:unwatch', (_e, p: string) => { watchers.get(p)?.close(); watchers.delete(p); });
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------
// On laptops with two GPUs, render (WebGPU / WebGL) on the discrete one, as image editors do.
app.commandLine.appendSwitch('force_high_performance_gpu');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  launchFiles.push(...filesFromArgv(process.argv));
  app.on('second-instance', (_e, argv) => {
    for (const f of filesFromArgv(argv)) { grant(f); mainWindow?.webContents.send('app:open-file', f); }
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(() => {
    registerAppProtocol();
    registerIpc();
    migrateFromFormerName();
    appPaths();
    const quitNow = () => { allowClose = true; app.quit(); };
    const reports = initReports({
      window: () => mainWindow,
      getMode: () => readHostSettings().reports?.mode ?? 'ask',
      setMode: (mode) => { const hs = readHostSettings(); hs.reports = { ...hs.reports, mode }; writeHostSettings(hs); },
      log,
    });
    initUpdater({
      window: () => mainWindow,
      getAutoCheck: () => readHostSettings().updates?.autoCheck ?? true,
      setAutoCheck: (autoCheck) => { const hs = readHostSettings(); hs.updates = { ...hs.updates, autoCheck }; writeHostSettings(hs); },
      log,
      quitNow,
    });
    const recent = readHostSettings().recentFiles ?? [];
    recent.forEach(grant);
    // Local Font Access (for font menus / PSD font matching); everything else is denied.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb((permission as string) === 'local-fonts' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => (permission as string) === 'local-fonts' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
    createWindow();
    if (process.env.CELENNE_SMOKE_REPORT === '1') runReportSmoke(reports, quitNow);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { if (scratchTiles) try { fs.rmSync(scratchTiles, { recursive: true, force: true }); } catch { /* in use */ } });
}
