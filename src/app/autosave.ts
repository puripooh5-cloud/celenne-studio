/**
 * Auto-save & crash recovery.
 *
 *  - Every N minutes (Preferences › General) each modified document whose content changed since
 *    its last recovery snapshot is serialized as PSD/PSB into the recovery store (Electron: the
 *    app's recovery folder, written atomically; browser: IndexedDB). Snapshots never overwrite the
 *    user's own file.
 *  - A "running" marker is set at startup and cleared on a clean exit. If the marker is still set
 *    at the next launch, the previous session ended abnormally and the Recovered Documents dialog
 *    opens automatically.
 *  - Saving or closing a document removes its recovery snapshot (fileOps.clearRecovery).
 *  - Memory pressure: caches are purged when free memory is low.
 */
import { editor } from './editor';
import { ui } from './store';
import { platform } from './platform/platform';
import { exportPsd } from '../psd/export';

const RUNNING_KEY = 'celenne.running.v1';
const lastSaved = new Map<string, string>();
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

function fingerprint(sessionId: string): string {
  const s = editor.session(sessionId);
  return s ? `${s.history.current.id}:${s.doc.rev}` : '';
}

export async function autosaveNow(): Promise<number> {
  if (busy) return 0;
  busy = true;
  let n = 0;
  try {
    for (const s of editor.sessions) {
      if (!s.modified) continue;
      const fp = fingerprint(s.id);
      if (lastSaved.get(s.id) === fp) continue;
      // Yield between documents so the UI stays responsive.
      await new Promise((r) => setTimeout(r, 0));
      try {
        const psb = s.doc.width > 30000 || s.doc.height > 30000;
        const bytes = exportPsd(s.doc, { psb, maximizeCompatibility: true, selectedLayerIds: s.selectedLayers().map((l) => l.id) });
        await platform().recovery.save({ id: s.id, name: s.doc.name, originalPath: s.doc.filePath, savedAt: Date.now(), byteSize: bytes.length }, bytes);
        lastSaved.set(s.id, fp);
        n++;
      } catch (e) {
        console.warn(`[autosave] ${s.doc.name}: ${(e as Error).message}`);
      }
    }
  } finally {
    busy = false;
  }
  return n;
}

// Serializing a large document takes seconds on the main thread, so auto-save only runs once the
// user has paused (no pointer, keyboard or wheel input for IDLE_MS), never in the middle of work.
const IDLE_MS = 3000;
let lastInput = Date.now();
let due = false;
if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel']) window.addEventListener(ev, () => { lastInput = Date.now(); }, { capture: true, passive: true });
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = null;
  const minutes = editor.prefs.general.autosaveMinutes;
  if (minutes <= 0) return;
  let lastSave = Date.now();
  timer = setInterval(() => {
    if (Date.now() - lastSave >= minutes * 60 * 1000) due = true;
    if (!due) return;
    // Wait for a pause in input, and skip while a long operation is running.
    if (Date.now() - lastInput < IDLE_MS || ui.get().progress.length || editor.currentTool?.busy?.()) return;
    due = false;
    lastSave = Date.now();
    void autosaveNow();
  }, 1000);
}

let memTimer: ReturnType<typeof setInterval> | null = null;
let warned = false;
async function checkMemory() {
  const m = await platform().memory().catch(() => null);
  if (!m) return;
  const lowFraction = m.freeBytes / m.totalBytes;
  if (lowFraction < 0.08) {
    for (const s of editor.sessions) {
      s.engine.purge();
      for (const l of s.doc.allLayers()) if ('raster' in l && l.raster) (l.raster as { purgeMips?: () => void }).purgeMips?.();
    }
    if (!warned) {
      warned = true;
      ui.toast('warning', 'Memory is running low', 'Display caches were released. Close unused documents or use Edit ▸ Purge ▸ History to free more memory.', 9000);
    }
  } else if (lowFraction > 0.2) warned = false;
}

/** Starts auto-save; returns true when the previous session did not exit cleanly. */
export function startAutosave(): boolean {
  let crashed = false;
  try {
    crashed = localStorage.getItem(RUNNING_KEY) === '1';
    localStorage.setItem(RUNNING_KEY, '1');
  } catch {
    /* storage unavailable */
  }
  schedule();
  let lastMinutes = editor.prefs.general.autosaveMinutes;
  // Re-arm when the preference changes.
  setInterval(() => {
    if (editor.prefs.general.autosaveMinutes !== lastMinutes) {
      lastMinutes = editor.prefs.general.autosaveMinutes;
      schedule();
    }
  }, 5000);
  memTimer ??= setInterval(checkMemory, 30000);
  window.addEventListener('pagehide', markCleanExit);
  return crashed;
}

export function markCleanExit(): void {
  try {
    localStorage.setItem(RUNNING_KEY, '0');
  } catch {
    /* ignore */
  }
}

export function forgetAutosave(sessionId: string): void {
  lastSaved.delete(sessionId);
}
