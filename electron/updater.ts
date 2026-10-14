/**
 * Auto-update (installed NSIS builds).
 *
 * electron-updater checks `<updateUrl>/latest.yml` and downloads the new installer in the
 * background. Before anything is installed, the installer's SHA-512 must match the release
 * manifest signed with the project's Ed25519 key (updateManifest.ts); when the app is
 * Authenticode-signed, electron-updater additionally requires the new installer to carry the
 * same publisher. A verified update is installed when the app quits (never while editing), or
 * at once with "Restart Now" after the editor has closed its documents.
 *
 * A portable copy (from an earlier local build; releases are setup-only) cannot replace itself: it
 * only checks and offers the setup download.
 * Microsoft Store copies are updated by the Store. Builds without an update address or release
 * key report updates as not set up.
 */
import { app, ipcMain, net, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD } from './buildConfig';
import { compareVersions, feedUrlProblem, fileMatchesManifest, joinUrl, MANIFEST_NAME, SIGNATURE_NAME, verifyManifest, type ReleaseManifest } from './updateManifest';

export interface UpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'verifying' | 'ready' | 'error';
  current: string;
  /** Why updates are off (status 'disabled'). */
  reason?: string;
  version?: string;
  notes?: string;
  percent?: number;
  error?: string;
  /** Portable copy: the setup version must be downloaded by hand from this address. */
  downloadUrl?: string;
  portable: boolean;
  autoCheck: boolean;
  lastChecked?: string;
}

interface Options {
  window: () => BrowserWindow | null;
  getAutoCheck: () => boolean;
  setAutoCheck: (v: boolean) => void;
  log: (line: string) => void;
  /** Closes the window without asking again and quits (the renderer already closed its documents). */
  quitNow: () => void;
}

const CHECK_DELAY_MS = 20_000;
const CHECK_EVERY_MS = 6 * 3600_000;
const MAX_MANIFEST_BYTES = 256 * 1024;

export function initUpdater(o: Options) {
  const portable = !!process.env.PORTABLE_EXECUTABLE_FILE;
  const state: UpdateState = { status: 'idle', current: app.getVersion(), portable, autoCheck: o.getAutoCheck() };
  const configFile = path.join(process.resourcesPath ?? '', 'app-update.yml');
  const disabledReason = (() => {
    if (process.windowsStore) return 'This copy is updated by the Microsoft Store.';
    if (!app.isPackaged && process.env.CELENNE_SMOKE_UPDATE !== '1') return 'Updates are checked only in installed builds, not when running from source.';
    if (!BUILD.updateUrl || !BUILD.updatePublicKey) return 'Updates are not set up for this build (it has no update address or release key).';
    const problem = feedUrlProblem(BUILD.updateUrl, BUILD.allowLocalUpdates);
    if (problem) return `Updates are off: ${problem.toLowerCase()}.`;
    if (!portable && !fs.existsSync(configFile)) return 'This build was not made with the release script, so it cannot update itself.';
    return null;
  })();
  if (disabledReason) Object.assign(state, { status: 'disabled', reason: disabledReason });

  let manifest: ReleaseManifest | null = null;
  let pendingInstall = false;
  let relaunchAfterInstall = false;
  let installing = false;

  const publish = () => {
    const w = o.window();
    if (w && !w.isDestroyed()) w.webContents.send('updates:state', { ...state });
    if (process.env.CELENNE_SMOKE_UPDATE === '1') {
      // Update self-test (release builds): report each step on stdout; quit (installing) when ready, or quit on a final state.
      process.stdout.write(`CELENNE_UPDATE ${JSON.stringify({ status: state.status, version: state.version, percent: state.percent, error: state.error, reason: state.reason })}\n`);
      if (['none', 'error', 'disabled'].includes(state.status)) setTimeout(o.quitNow, 500);
    }
  };
  const set = (patch: Partial<UpdateState>) => {
    for (const k of ['version', 'notes', 'percent', 'error', 'downloadUrl'] as const) if (!(k in patch) && patch.status) delete state[k];
    Object.assign(state, patch);
    publish();
  };
  const fail = (e: unknown) => {
    const msg = (e as Error)?.message ?? String(e);
    o.log(`update error: ${msg}`);
    set({ status: 'error', error: friendly(msg) });
  };

  async function fetchManifest(): Promise<ReleaseManifest> {
    const get = async (name: string) => {
      const res = await net.fetch(joinUrl(BUILD.updateUrl, name), { cache: 'no-store' });
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_MANIFEST_BYTES) throw new Error(`${name} is too large`);
      return buf;
    };
    const [bytes, sig] = await Promise.all([get(MANIFEST_NAME), get(SIGNATURE_NAME)]);
    return verifyManifest(bytes, Buffer.from(sig).toString('utf8'), BUILD.updatePublicKey);
  }

  if (!disabledReason) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.forceDevUpdateConfig = !app.isPackaged;
    autoUpdater.logger = { info: (m: unknown) => o.log(`updater: ${m}`), warn: (m: unknown) => o.log(`updater warn: ${m}`), error: (m: unknown) => o.log(`updater error: ${m}`), debug: () => {} };
    autoUpdater.setFeedURL({ provider: 'generic', url: BUILD.updateUrl });

    autoUpdater.on('update-not-available', () => set({ status: 'none', lastChecked: new Date().toISOString() }));
    autoUpdater.on('update-available', async (info) => {
      state.lastChecked = new Date().toISOString();
      try {
        manifest = await fetchManifest();
        if (manifest.version !== info.version) throw new Error(`The release files disagree about the version (${info.version} vs ${manifest.version})`);
        if (compareVersions(manifest.version, app.getVersion()) <= 0) { set({ status: 'none' }); return; }
        if (portable) {
          const file = manifest.files.find((f) => f.kind === 'setup');
          set({ status: 'available', version: manifest.version, notes: manifest.notes, downloadUrl: BUILD.downloadPage || (file ? joinUrl(BUILD.updateUrl, file.name) : undefined) });
          return;
        }
        set({ status: 'downloading', version: manifest.version, notes: manifest.notes, percent: 0 });
        await autoUpdater.downloadUpdate();
      } catch (e) {
        fail(e);
      }
    });
    autoUpdater.on('download-progress', (p) => { if (state.status === 'downloading') set({ status: 'downloading', version: state.version, notes: state.notes, percent: Math.round(p.percent) }); });
    autoUpdater.on('update-downloaded', async (ev) => {
      set({ status: 'verifying', version: state.version, notes: state.notes });
      try {
        if (!manifest || manifest.version !== ev.version || !(await fileMatchesManifest(ev.downloadedFile, manifest, 'setup'))) {
          try { fs.rmSync(ev.downloadedFile, { force: true }); } catch { /* ignore */ }
          throw new Error('The downloaded update does not match the signed release, so it was discarded.');
        }
        pendingInstall = true;
        set({ status: 'ready', version: manifest.version, notes: manifest.notes });
        if (process.env.CELENNE_SMOKE_UPDATE === '1') setTimeout(o.quitNow, 500);
      } catch (e) {
        fail(e);
      }
    });
    autoUpdater.on('error', (e) => { if (state.status !== 'ready') fail(e); });

    // Install a verified update when the app quits: silently, relaunching only after "Restart Now".
    app.on('will-quit', () => {
      if (!pendingInstall || installing) return;
      installing = true;
      o.log(`installing ${state.version} on quit (relaunch: ${relaunchAfterInstall})`);
      (autoUpdater as unknown as { install(silent: boolean, runAfter: boolean): boolean }).install(true, relaunchAfterInstall);
    });
  }

  const check = async (manual: boolean) => {
    if (state.status === 'disabled' || ['checking', 'downloading', 'verifying', 'ready'].includes(state.status)) return;
    if (!manual && !o.getAutoCheck()) return;
    set({ status: 'checking' });
    try {
      const r = await autoUpdater.checkForUpdates();
      if (!r) set({ status: 'none', lastChecked: new Date().toISOString() });
    } catch (e) {
      fail(e);
    }
  };

  if (!disabledReason) {
    setTimeout(() => void check(false), process.env.CELENNE_SMOKE_UPDATE === '1' ? 1500 : CHECK_DELAY_MS);
    setInterval(() => void check(false), CHECK_EVERY_MS).unref();
  } else if (process.env.CELENNE_SMOKE_UPDATE === '1') {
    setTimeout(publish, 1500);
  }

  ipcMain.handle('updates:state', () => ({ ...state }));
  ipcMain.handle('updates:check', () => check(true));
  ipcMain.handle('updates:set-auto', (_e, v: boolean) => { o.setAutoCheck(!!v); state.autoCheck = !!v; publish(); });
  ipcMain.on('updates:install-now', () => {
    if (!pendingInstall) return;
    relaunchAfterInstall = true;
    o.quitNow();
  });
}

function friendly(msg: string): string {
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ECONNREFUSED|ERR_CONNECTION/i.test(msg)) return 'Could not reach the update server. Check your internet connection and try again.';
  if (/HTTP 404|status 404/i.test(msg)) return 'The update server has no release information yet.';
  if (/not signed by the application owner/i.test(msg)) return 'The downloaded update is not signed by the publisher of this app, so it was not installed.';
  if (/signature|manifest|does not match|disagree/i.test(msg)) return `The update was rejected: ${msg.replace(/^Error: /, '')}`;
  return msg.split('\n')[0].slice(0, 200);
}
