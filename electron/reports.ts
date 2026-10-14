/**
 * Opt-in error and crash reports.
 *
 * Errors in the main process and the editor, and crashes of the editor, GPU and helper processes,
 * become scrubbed reports (reportFormat.ts) saved in <userData>/Reports. Nothing leaves the
 * computer unless the user chose "Always send" or approved a report when asked, and the build has
 * a report destination. Native crash dumps (which can contain memory, and therefore document
 * data) are written to the local crash-dump folder only and are never uploaded.
 */
import { app, crashReporter, ipcMain, net, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILD } from './buildConfig';
import { makeReport, parseDsn, reportText, sentryEnvelope, type ErrorReport, type ReportContext } from './reportFormat';

export type ReportMode = 'ask' | 'always' | 'never';

export interface ReportsStatus {
  mode: ReportMode;
  /** Host name reports are sent to, or null when this build has no destination. */
  destination: string | null;
  unsent: number;
}

export interface ReportSummary {
  id: string;
  created: string;
  kind: ErrorReport['kind'];
  process: string;
  type: string;
  message: string;
  count: number;
  sent?: string;
}

interface Options {
  window: () => BrowserWindow | null;
  getMode: () => ReportMode;
  setMode: (m: ReportMode) => void;
  log: (line: string) => void;
}

const MAX_FILES = 30;
const MAX_PER_SESSION = 25;
const MAX_SENDS_PER_SESSION = 10;

/** Must run before the app is ready. Dumps stay local (uploadToServer: false). */
export function startCrashDumps() {
  crashReporter.start({ uploadToServer: false, compress: true });
}

export function initReports(o: Options) {
  const dir = path.join(app.getPath('userData'), 'Reports');
  fs.mkdirSync(dir, { recursive: true });
  const dsn = BUILD.reportDsn ? parseDsn(BUILD.reportDsn, BUILD.allowLocalUpdates) : null;
  const names = [safe(() => os.userInfo().username), safe(() => os.hostname())].filter((n): n is string => !!n);
  let rendererInfo: Pick<ReportContext, 'renderer' | 'document'> = {};
  const session = new Map<string, string>(); // fingerprint → report id
  let sends = 0;
  let notifyTimer: NodeJS.Timeout | null = null;

  const file = (id: string) => path.join(dir, `${id}.json`);
  const read = (id: string): ErrorReport | null => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } };
  const write = (r: ErrorReport) => fs.writeFileSync(file(r.id), JSON.stringify(r, null, 1));
  const all = (): ErrorReport[] => fs.readdirSync(dir).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => read(f.slice(0, -5))).filter((r): r is ErrorReport => !!r).sort((a, b) => b.created.localeCompare(a.created));
  const prune = () => { for (const r of all().slice(MAX_FILES)) fs.rmSync(file(r.id), { force: true }); };
  const context = (): ReportContext => ({
    appVersion: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux', osVersion: os.release(), arch: process.arch,
    ...rendererInfo,
  });
  const status = (): ReportsStatus => ({ mode: o.getMode(), destination: dsn ? new URL(dsn.envelopeUrl).host : null, unsent: all().filter((r) => !r.sent).length });
  const summary = (r: ErrorReport): ReportSummary => ({ id: r.id, created: r.created, kind: r.kind, process: r.process, type: r.type, message: r.message, count: r.count, sent: r.sent });

  async function send(ids: string[] | 'unsent'): Promise<{ sent: number; failed: number; error?: string }> {
    if (!dsn) return { sent: 0, failed: 0, error: 'This build has no report destination.' };
    const list = (ids === 'unsent' ? all().filter((r) => !r.sent) : ids.map(read).filter((r): r is ErrorReport => !!r && !r.sent));
    let sent = 0, failed = 0, error: string | undefined;
    for (const r of list) {
      if (sends >= MAX_SENDS_PER_SESSION) { failed++; error = 'Report limit for this session reached.'; continue; }
      sends++;
      try {
        const env = sentryEnvelope(r, dsn);
        const res = await net.fetch(env.url, { method: 'POST', headers: env.headers, body: env.body, cache: 'no-store', credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        r.sent = new Date().toISOString();
        write(r);
        sent++;
      } catch (e) {
        failed++;
        error = `Could not send: ${(e as Error).message}`;
      }
    }
    if (sent || failed) o.log(`reports: sent ${sent}, failed ${failed}${error ? ` (${error})` : ''}`);
    return { sent, failed, error };
  }

  const notify = () => {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      const mode = o.getMode();
      if (dsn && mode === 'always') void send('unsent');
      else if (dsn && mode === 'ask') { const w = o.window(); if (w && !w.isDestroyed()) w.webContents.send('reports:new', status()); }
    }, 3000);
  };

  function record(input: Parameters<typeof makeReport>[0]) {
    try {
      const r = makeReport(input, context(), { names });
      const existing = session.get(r.fingerprint);
      if (existing) {
        const prev = read(existing);
        if (prev && !prev.sent) { prev.count++; write(prev); return; }
      }
      if (session.size >= MAX_PER_SESSION) return;
      session.set(r.fingerprint, r.id);
      write(r);
      prune();
      o.log(`reports: recorded ${r.kind} in ${r.process}: ${r.type}`);
      notify();
    } catch (e) {
      o.log(`reports: could not record: ${(e as Error).message}`);
    }
  }

  process.on('uncaughtException', (e) => { o.log(`main uncaught: ${e.stack ?? e}`); record({ kind: 'error', process: 'main', type: e.name, message: e.message, stack: e.stack }); });
  process.on('unhandledRejection', (e) => { const err = e instanceof Error ? e : new Error(String(e)); record({ kind: 'error', process: 'main', type: err.name, message: err.message, stack: err.stack }); });
  app.on('render-process-gone', (_e, _wc, d) => { if (d.reason !== 'clean-exit' && d.reason !== 'killed') record({ kind: 'crash', process: 'editor', reason: d.reason, exitCode: d.exitCode }); });
  app.on('child-process-gone', (_e, d) => { if (d.reason !== 'clean-exit' && d.reason !== 'killed') record({ kind: 'crash', process: (d.type === 'GPU' ? 'gpu' : d.name ?? d.type).toLowerCase().slice(0, 32), reason: d.reason, exitCode: d.exitCode }); });

  ipcMain.on('reports:error', (_e, err: { type?: string; message?: string; stack?: string }) => {
    if (!err || typeof err !== 'object') return;
    record({ kind: 'error', process: 'editor', type: String(err.type ?? 'Error').slice(0, 80), message: String(err.message ?? '').slice(0, 2000), stack: String(err.stack ?? '').slice(0, 20000) });
  });
  ipcMain.on('reports:context', (_e, c: Pick<ReportContext, 'renderer' | 'document'>) => { if (c && typeof c === 'object') rendererInfo = { renderer: c.renderer, document: c.document }; });
  ipcMain.handle('reports:status', () => status());
  ipcMain.handle('reports:list', () => all().map(summary));
  ipcMain.handle('reports:view', (_e, id: string) => { const r = /^[0-9a-f]{32}$/.test(id) ? read(id) : null; return r ? reportText(r) : null; });
  ipcMain.handle('reports:send', (_e, ids: string[] | 'unsent') => send(ids === 'unsent' ? 'unsent' : Array.isArray(ids) ? ids.filter((i) => /^[0-9a-f]{32}$/.test(i)) : []));
  ipcMain.handle('reports:discard', (_e, ids: string[] | 'all') => {
    for (const r of all()) if (ids === 'all' || (Array.isArray(ids) && ids.includes(r.id))) fs.rmSync(file(r.id), { force: true });
    return status();
  });
  ipcMain.handle('reports:set-mode', (_e, m: ReportMode) => {
    if (m !== 'ask' && m !== 'always' && m !== 'never') return status();
    o.setMode(m);
    if (m === 'always') void send('unsent');
    return status();
  });
  ipcMain.handle('reports:open-folder', (_e, which: 'reports' | 'dumps') => shell.openPath(which === 'dumps' ? app.getPath('crashDumps') : dir));

  return { record, send, list: () => all().map(summary), text: (id: string) => { const r = read(id); return r ? reportText(r) : null; } };
}

function safe<T>(f: () => T): T | undefined { try { return f(); } catch { return undefined; } }
