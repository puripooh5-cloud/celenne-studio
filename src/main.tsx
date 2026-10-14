/** Renderer entry point. */
import { createRoot } from 'react-dom/client';
import './ui/styles.css';
import './app/actions';
import { App } from './ui/App';
import { registerTools } from './tools/registry';
import { keymap } from './app/shortcuts';
import { applyScratchPrefs, editor } from './app/editor';
import { installScratch } from './history/scratch';
import { ui } from './app/store';
import { platform } from './app/platform/platform';
import { closeAll, openPath } from './app/fileOps';
import { fonts } from './typography/fonts';
import { installTextEngine } from './app/textEngine';
import { colorEngine } from './color/cms';
import { plugins } from './plugins/pluginHost';
import { markCleanExit, startAutosave } from './app/autosave';
import { installUpdateAndReportServices, reportEditorError } from './app/updates';

function applyUiScale() {
  const g = editor.prefs.general;
  document.documentElement.style.setProperty('--ui-scale', String(g.largeUI ? Math.max(g.uiScale, 1.25) : g.uiScale));
}

async function boot() {
  registerTools();
  // Scratch disk for history paging (desktop app only: needs synchronous read-back).
  const bridge = window.celenne;
  if (bridge?.scratchReadSync) installScratch({ write: (k, d) => bridge.scratchWrite(k, d), readSync: (k) => bridge.scratchReadSync(k), remove: (k) => bridge.scratchRemove(k) });
  applyScratchPrefs(editor.prefs);
  // Actions are registered at import time; rebuild so their default shortcuts are indexed.
  keymap.rebuild();
  applyUiScale();
  try {
    plugins.activateAll();
  } catch (e) {
    console.warn('[plugins]', e);
  }

  const root = createRoot(document.getElementById('root')!);
  root.render(<App />);

  // Non-blocking service initialization.
  installTextEngine();
  void fonts.load().catch(() => {});
  void colorEngine.init().then((ok) => {
    if (!ok) ui.toast('warning', 'Color management is unavailable', `${colorEngine.error ?? ''} Colors are shown without profile conversion.`, 8000);
    else ui.bump('viewRev');
  });

  const p = platform();
  (window as unknown as { __celenneHasUnsaved?: () => boolean }).__celenneHasUnsaved = () => editor.sessions.some((s) => s.modified);
  p.onCloseRequested(async () => {
    if (await closeAll()) {
      markCleanExit();
      p.confirmClose();
    }
  });
  p.onOpenFile((path) => void openPath(path));
  for (const f of await p.launchFiles().catch(() => [] as string[])) await openPath(f);

  installUpdateAndReportServices();

  const crashed = startAutosave();
  const pending = await p.recovery.list().catch(() => []);
  if (pending.length) {
    if (crashed) ui.openDialog('recovered');
    else ui.toast('info', `${pending.length} recovered document${pending.length === 1 ? ' is' : 's are'} available.`, 'File ▸ Recovered Documents…', 8000);
  }
}

window.addEventListener('error', (e) => {
  console.error(e.error ?? e.message);
  reportEditorError(e.error ?? e.message);
  ui.toast('error', 'An unexpected error occurred', String(e.error?.message ?? e.message), 8000);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  reportEditorError(e.reason);
  ui.toast('error', 'An unexpected error occurred', String((e.reason as Error)?.message ?? e.reason), 8000);
});

// Development / automated UI testing hook: exposes the app's own module instances (dev builds only).
if (import.meta.env.DEV) {
  void Promise.all([
    import('./app/actions'), import('./app/fileOps'), import('./app/store'), import('./app/ops/layerOps'), import('./app/ops/filterOps'),
    import('./app/ops/selectOps'), import('./app/ops/editOps'), import('./app/ops/imageOps'), import('./psd/import'), import('./psd/export'),
    import('./effects/types'), import('./rendering/compositor'), import('./app/macros'), import('./plugins/samplePlugin'),
  ]).then(([actions, fileOps, store, layerOps, filterOps, selectOps, editOps, imageOps, psdImport, psdExport, effects, compositor, macros, sample]) => {
    (window as unknown as { __celenneTest?: unknown }).__celenneTest = { editor, actions, fileOps, store, layerOps, filterOps, selectOps, editOps, imageOps, psdImport, psdExport, effects, compositor, macros: macros.macros, plugins, samplePlugin: sample.SAMPLE_PLUGIN };
  });
}

void boot();
