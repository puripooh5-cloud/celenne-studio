/**
 * Renderer side of auto-update and error reports (desktop app only). Keeps the latest update
 * state for the UI, announces a ready update, asks before sending error reports (when the user
 * chose "Ask"), and forwards editor errors plus a little non-identifying context to the main
 * process, which scrubs and stores them (electron/reports.ts).
 */
import { create } from 'zustand';
import { closeAll } from './fileOps';
import { markCleanExit } from './autosave';
import { editor } from './editor';
import { ui } from './store';
import type { ReportsStatus, UpdateState } from './platform/bridge';

export const useUpdates = create<{ state: UpdateState | null }>(() => ({ state: null }));

const bridge = () => (typeof window !== 'undefined' ? window.celenne : undefined);

let announced = '';
let askedThisSession = false;

export function installUpdateAndReportServices() {
  const b = bridge();
  if (!b?.updates) return;
  const onState = (s: UpdateState) => {
    useUpdates.setState({ state: s });
    if (s.status === 'ready' && announced !== s.version) {
      announced = s.version ?? '';
      ui.toast('success', `Celenne Studio ${s.version} is ready to install`, 'It installs when you quit. Help ▸ Check for Updates… to restart now.', 12000);
    }
    if (s.status === 'available' && s.portable && announced !== s.version) {
      announced = s.version ?? '';
      ui.toast('info', `Celenne Studio ${s.version} is available`, 'This portable copy cannot update itself. Help ▸ Check for Updates… to download it.', 12000);
    }
  };
  b.updates.onState(onState);
  void b.updates.state().then(onState).catch(() => {});

  b.reports.onNew((st: ReportsStatus) => {
    if (askedThisSession || st.mode !== 'ask' || !st.destination || !st.unsent) return;
    askedThisSession = true;
    ui.openDialog('reportPrompt', { status: st });
  });

  // Context for reports: never names or content, only what kind of file was being edited.
  let last = '';
  const pushContext = () => {
    const s = editor.active;
    const ext = s?.doc.filePath ? /\.([a-z0-9]{1,5})$/i.exec(s.doc.filePath)?.[1]?.toLowerCase() : undefined;
    const ctx = {
      renderer: (window as unknown as { __celenneRenderer?: string }).__celenneRenderer,
      document: s ? { format: ext ?? 'new', mode: s.doc.canvas.colorMode, depth: s.doc.canvas.bitDepth } : undefined,
    };
    const key = JSON.stringify(ctx);
    if (key !== last) { last = key; b.reports.setContext(ctx); }
  };
  setInterval(pushContext, 5000);
  pushContext();
}

/** Forwards an uncaught editor error (scrubbed in the main process before it is stored). */
export function reportEditorError(e: unknown) {
  const b = bridge();
  if (!b?.reports) return;
  const err = e instanceof Error ? e : new Error(typeof e === 'string' ? e : 'Unknown error');
  try { b.reports.error({ type: err.name, message: err.message, stack: err.stack }); } catch { /* bridge unavailable */ }
}

/** "Restart Now": closes the documents the usual way (asking about unsaved changes), then installs. */
export async function restartToUpdate() {
  const b = bridge();
  if (!b?.updates) return;
  if (!(await closeAll())) return;
  markCleanExit();
  b.updates.installNow();
}
