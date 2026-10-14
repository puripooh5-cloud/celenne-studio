/** Application shell: menu bar, options bar, toolbar, dock workspace, status bar and hosts. */
import { useEffect, useState } from 'react';
import { MenuBar, ContextMenuHost } from './menu/Menu';
import { OptionsBar } from './OptionsBar';
import { Toolbar } from './Toolbar';
import { Workspace } from './Workspace';
import { DialogHost } from './dialogs/DialogHost';
import { useApp, ui } from '../app/store';
import { editor } from '../app/editor';
import { action, run } from '../app/actions';
import { chordFromEvent, cycleTool, keymap } from '../app/shortcuts';
import { toolInfo, ToolId } from '../tools/toolTypes';
import { useSession, useViewRev } from './hooks';
import { zoomTo } from '../app/ops/viewOps';
import { Icon } from './icons';

/** Tools whose size/hardness/opacity come from the shared brush settings. */
const BRUSH_TOOLS = new Set<ToolId>(['brush', 'pencil', 'eraser', 'bgEraser', 'cloneStamp', 'patternStamp', 'healing', 'spotHealing', 'remove', 'colorReplace', 'blur', 'sharpen', 'smudge', 'dodge', 'burn', 'sponge', 'quickSelect']);

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

let digitBuffer = '';
let digitTimer: ReturnType<typeof setTimeout> | null = null;

/** Number keys set opacity like Photoshop: 1 = 10%, 0 = 100%, two quick digits = exact value. */
function handleDigit(d: string, shift: boolean) {
  digitBuffer += d;
  if (digitTimer) clearTimeout(digitTimer);
  const apply = () => {
    const v = digitBuffer.length >= 2 ? Number(digitBuffer.slice(0, 2)) / 100 || 1 : digitBuffer === '0' ? 1 : Number(digitBuffer) / 10;
    digitBuffer = '';
    const t = editor.currentToolId;
    if (BRUSH_TOOLS.has(t)) {
      if (shift) ui.setBrush({ flow: v });
      else ui.setBrush({ opacity: v });
    } else {
      const l = editor.active?.activeLayer();
      if (l) run(shift ? 'layer.setFillOpacity' : 'layer.setOpacity', { value: v });
    }
  };
  if (digitBuffer.length >= 2) apply();
  else digitTimer = setTimeout(apply, 350);
}

function onGlobalKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || isTyping(e)) return;
  if (useApp.getState().dialogs.length) return;
  const host = editor.hostFactory?.();
  // The active tool gets first refusal (Enter/Esc commit/cancel, arrow nudges, Delete for paths…).
  if (host && editor.currentTool?.keyDown?.(host, e)) {
    e.preventDefault();
    return;
  }
  // No commands in the middle of a drag or stroke (e.g. Ctrl+Z while moving a layer would undo
  // underneath the tool, which then commits against a document state that no longer exists).
  if (editor.currentTool?.busy?.()) {
    if (e.key === 'Escape') editor.cancelTool(); // Esc still cancels the drag
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) e.preventDefault();
    return;
  }
  const chord = chordFromEvent(e);
  const bound = keymap.lookup(chord);
  if (bound) {
    e.preventDefault();
    if (bound.startsWith('tool:')) {
      const id = bound.slice(5) as ToolId;
      const info = toolInfo(id);
      const g = useApp.getState().groupTool[info.group] as ToolId | undefined;
      editor.setTool(g ?? id);
      return;
    }
    const a = action(bound);
    if (a?.comingSoon) { ui.toast('info', `${a.label.replace('…', '')} is coming soon.`); return; }
    if (a && (!a.enabled || a.enabled())) void run(bound);
    return;
  }
  // Shift + tool letter cycles through the tool's flyout group.
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && /^[a-z]$/i.test(e.key)) {
    const next = cycleTool(useApp.getState().tool, e.key);
    if (next) { e.preventDefault(); editor.setTool(next); return; }
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === 'd' || k === 'D') { editor.setForeground({ r: 0, g: 0, b: 0 }); editor.setBackground({ r: 1, g: 1, b: 1 }); return; }
  if (k === 'x' || k === 'X') { const { fg, bg } = useApp.getState(); editor.setForeground(bg); editor.setBackground(fg); return; }
  if (k === '[' || k === ']' || k === '{' || k === '}') {
    const b = useApp.getState().brush;
    if (e.shiftKey || k === '{' || k === '}') ui.setBrush({ hardness: Math.max(0, Math.min(1, b.hardness + (k === ']' || k === '}' ? 0.25 : -0.25))) });
    else {
      const step = b.size < 10 ? 1 : b.size < 50 ? 5 : b.size < 100 ? 10 : b.size < 300 ? 25 : 50;
      ui.setBrush({ size: Math.max(1, Math.min(5000, b.size + (k === ']' ? step : -step))) });
    }
    host?.redraw();
    e.preventDefault();
    return;
  }
  if (/^[0-9]$/.test(k) || (e.shiftKey && /^Digit[0-9]$/.test(e.code))) {
    handleDigit(/^[0-9]$/.test(k) ? k : e.code.slice(5), e.shiftKey);
    return;
  }
  if (k === 'Tab') {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('celenne:togglePanels'));
    return;
  }
  if (k === 'Escape') editor.cancelTool();
}

function onGlobalKeyUp(e: KeyboardEvent) {
  const host = editor.hostFactory?.();
  if (host) editor.currentTool?.keyUp?.(host, e);
}

export function App() {
  const screenMode = useApp((s) => s.screenMode);
  const [panelsHidden, setPanelsHidden] = useState(false);
  useEffect(() => {
    window.addEventListener('keydown', onGlobalKeyDown);
    window.addEventListener('keyup', onGlobalKeyUp);
    const toggle = () => setPanelsHidden((v) => !v);
    window.addEventListener('celenne:togglePanels', toggle);
    return () => {
      window.removeEventListener('keydown', onGlobalKeyDown);
      window.removeEventListener('keyup', onGlobalKeyUp);
      window.removeEventListener('celenne:togglePanels', toggle);
    };
  }, []);
  return (
    <div className={`app${screenMode === 'full' ? ' full-screen' : ''}${panelsHidden ? ' panels-hidden' : ''}`}>
      <MenuBar />
      {!panelsHidden && <OptionsBar />}
      <div className="main" style={panelsHidden ? { gridTemplateColumns: '1fr' } : undefined}>
        {!panelsHidden && <Toolbar />}
        <Workspace />
      </div>
      <StatusBar />
      <DialogHost />
      <ContextMenuHost />
      <ToastHost />
      <ProgressHost />
    </div>
  );
}

function StatusBar() {
  const s = useSession();
  useViewRev();
  useApp((st) => st.docRev);
  useApp((st) => st.historyRev);
  const cursor = useApp((st) => st.cursor);
  const [zoomText, setZoomText] = useState('');
  const [editing, setEditing] = useState(false);
  const zoomPct = s ? Math.round(s.view.zoom * 10000) / 100 : 0;
  const renderer = (window as unknown as { __celenneRenderer?: string }).__celenneRenderer;
  const onGpu = !!renderer && renderer !== 'canvas2d';
  const rendererLabel = renderer?.startsWith('webgpu') ? 'WebGPU' : renderer === 'webgl2' ? 'WebGL 2' : 'CPU renderer';
  if (!s) {
    return (
      <div className="statusbar" role="status">
        <span>No document</span>
        <span className="spacer" />
        {renderer && <span className={`gpu${onGpu ? '' : ' off'}`}>{onGpu ? 'GPU' : 'CPU'}</span>}
      </div>
    );
  }
  const c = s.doc.canvas;
  const memBytes = c.width * c.height * 4 * (c.bitDepth / 8);
  // Informational notes ("editable") are not warnings.
  const notEditable = s.doc.compatibility.filter((i) => i.status !== 'editable').length;
  return (
    <div className="statusbar" role="status">
      <input
        className="zoom"
        aria-label="Zoom level"
        value={editing ? zoomText : `${zoomPct}%`}
        onFocus={(e) => { setEditing(true); setZoomText(String(zoomPct)); requestAnimationFrame(() => e.target.select()); }}
        onChange={(e) => setZoomText(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            const v = parseFloat(zoomText.replace('%', ''));
            if (isFinite(v) && v > 0) zoomTo(Math.max(0.01, Math.min(64, v / 100)));
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
        }}
      />
      <span className="item">{c.width} × {c.height} px · {c.resolution} ppi</span>
      <span className="item">{c.duotone ? 'Duotone' : ({ rgb: 'RGB', grayscale: 'Gray', cmyk: 'CMYK', lab: 'Lab', indexed: 'Index', bitmap: 'Bitmap', multichannel: 'Multichannel' } as Record<string, string>)[c.colorMode] ?? c.colorMode.toUpperCase()}/{c.bitDepth}{c.bitDepth === 32 ? ' (float)' : ''}</span>
      <button className="link item" title="Assign or convert the document profile" onClick={() => run('edit.convertProfile')}>{s.doc.profile.name}</button>
      <span className="item">Doc: {(memBytes / 1048576).toFixed(1)} MB</span>
      {cursor.inside && <span className="item">X: {Math.floor(cursor.x)} Y: {Math.floor(cursor.y)}</span>}
      {notEditable > 0 && (
        <button className="link item" style={{ color: 'var(--warning)' }} title="Some features are preserved but not editable" onClick={() => ui.openDialog('compatibility')}>
          <Icon name="warning" /> {notEditable} compatibility note{notEditable === 1 ? '' : 's'}
        </button>
      )}
      <span className="spacer" />
      <span className="item">{s.modified ? 'Unsaved changes' : 'Saved'}</span>
      {renderer && <button className={`link gpu${onGpu ? '' : ' off'}`} title="GPU information" onClick={() => ui.openDialog('gpuInfo')}>{rendererLabel}</button>}
    </div>
  );
}

function ToastHost() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <div className="toast-head">
            <span className="msg">{t.message}</span>
            <button className="icon-x" aria-label="Dismiss" onClick={() => ui.dismissToast(t.id)}>×</button>
          </div>
          {t.detail && <div className="detail">{t.detail}</div>}
        </div>
      ))}
    </div>
  );
}

function ProgressHost() {
  const items = useApp((s) => s.progress);
  // Short operations do not flash a progress box.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!items.length) { setVisible(false); return; }
    const t = setTimeout(() => setVisible(true), 250);
    return () => clearTimeout(t);
  }, [items.length]);
  if (!visible || !items.length) return null;
  return (
    <div className="progress-host" aria-live="polite">
      {items.map((p) => (
        <div key={p.id} className="progress" role="progressbar" aria-valuenow={p.fraction === null ? undefined : Math.round(p.fraction * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={p.label}>
          <div className="row">
            <span className="label">{p.label}</span>
            {p.cancel && <button className="btn small" onClick={p.cancel}>Cancel</button>}
          </div>
          <div className={`bar${p.fraction === null ? ' indeterminate' : ''}`}><i style={{ width: `${Math.round((p.fraction ?? 0) * 100)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}
