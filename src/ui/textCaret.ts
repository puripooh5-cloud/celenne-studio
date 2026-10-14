/**
 * The caret and selection of the text being edited on the canvas. Typing goes to a hidden text
 * field (so IME input, clipboard and undo-in-field work as usual); the caret and selection are
 * drawn from Celenne's text engine layout, and the moves that depend on the layout (up / down,
 * Home / End, clicks and drags) are computed from it. Text the engine does not draw (vertical,
 * on a path, warped, or before the fonts are ready) keeps the field's own caret.
 */
import type { TextLayer } from '../document/types';
import type { ViewTransform as Viewport } from '../rendering/viewport';
import { apply, invert } from '../image-engine/matrix';
import { appFaces, engineFontsReady } from '../typography/engine/appFonts';
import { layoutEngine, type EngineLayout } from '../typography/engine/layout';
import { engineHandles } from '../typography/engineRender';
import { caretAt, indexAtPoint, lineEnds, selectionRects, verticalMove } from '../typography/caret';

interface CaretState { upstream: boolean; goalX: number | null; anchor: number; dragging: boolean; lastMove: number }
const st: CaretState = { upstream: false, goalX: null, anchor: 0, dragging: false, lastMove: 0 };

let cache: { text: TextLayer['text']; key: string; layout: EngineLayout } | null = null;

/** The engine layout of the edited text, or null when the field's own caret is used. */
export function caretLayout(l: TextLayer): EngineLayout | null {
  const t = l.text;
  if (!engineHandles(t) || t.warp || t.path || t.orientation !== 'horizontal' || !engineFontsReady()) return null;
  const key = JSON.stringify([t.text, t.runs, t.paragraphs, t.box, t.kind, t.psBreaks?.length ?? 0, appFaces.size]);
  if (cache && cache.text === t && cache.key === key) return cache.layout;
  const layout = layoutEngine(t, appFaces);
  if (layout.missing) return null;
  cache = { text: t, key, layout };
  return layout;
}

const focusOf = (ta: HTMLTextAreaElement) => (ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd);

function select(ta: HTMLTextAreaElement, anchor: number, focus: number) {
  ta.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus), focus < anchor ? 'backward' : 'forward');
  st.lastMove = performance.now();
}

/** The field's selection changed by itself (typing, left / right, paste): forget layout-only state. */
export function caretChanged(): void {
  if (!st.dragging) { st.upstream = false; st.goalX = null; }
  st.lastMove = performance.now();
}

/** Handles the keys whose meaning depends on the layout; true when handled. */
export function caretKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; preventDefault(): void }, ta: HTMLTextAreaElement, l: TextLayer): boolean {
  if (e.altKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return false;
  if ((e.ctrlKey || e.metaKey) && e.key.startsWith('Arrow')) return false;
  const L = caretLayout(l);
  if (!L) return false;
  const t = l.text;
  const focus = focusOf(ta);
  const anchor = e.shiftKey ? (ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart) : focus;
  let to: number, upstream = false;
  if (e.ctrlKey || e.metaKey) to = e.key === 'Home' ? 0 : t.text.length; // whole text
  else if (e.key === 'Home' || e.key === 'End') {
    const ends = lineEnds(L, focus, st.upstream);
    to = e.key === 'Home' ? ends.start : ends.end;
    upstream = e.key === 'End' && ends.softEnd;
    st.goalX = null;
  } else {
    if (st.goalX === null) st.goalX = caretAt(L, t, focus, st.upstream)?.x ?? 0;
    const m = verticalMove(L, t, focus, e.key === 'ArrowUp' ? -1 : 1, st.goalX, st.upstream);
    to = m.pos; upstream = m.upstream;
  }
  e.preventDefault();
  const goal = st.goalX;
  select(ta, e.shiftKey ? anchor : to, to);
  st.upstream = upstream;
  st.goalX = e.key.startsWith('Arrow') ? goal : null;
  return true;
}

/** Text-space point under a viewport-relative screen point. */
function textPoint(l: TextLayer, view: Viewport, sx: number, sy: number) {
  const d = view.screenToDoc(sx, sy);
  return apply(invert(l.text.transform), d.x, d.y);
}

/** Pointer down / move on the field (viewport-relative coordinates); true when handled. */
export function caretPointer(phase: 'down' | 'move' | 'up', e: { shiftKey: boolean; buttons: number }, sx: number, sy: number, ta: HTMLTextAreaElement, l: TextLayer, view: Viewport): boolean {
  const L = caretLayout(l);
  if (!L) return false;
  if (phase === 'up') { st.dragging = false; return true; }
  if (phase === 'move' && !(st.dragging && e.buttons & 1)) return false;
  const p = textPoint(l, view, sx, sy);
  const hit = indexAtPoint(L, l.text, p.x, p.y);
  if (phase === 'down') {
    st.dragging = true;
    st.anchor = e.shiftKey ? (ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart) : hit.pos;
  }
  select(ta, st.anchor, hit.pos);
  st.upstream = hit.upstream;
  st.goalX = null;
  return true;
}

/** Draws the caret (blinking) and selection; returns false when the field's own caret is used. */
export function drawCaret(g: CanvasRenderingContext2D, ta: HTMLTextAreaElement | null, l: TextLayer, view: Viewport, time: number): boolean {
  const L = caretLayout(l);
  if (!L || !ta) return false;
  const m = l.text.transform;
  const toScreen = (x: number, y: number) => { const d = apply(m, x, y); return view.docToScreen(d.x, d.y); };
  const { selectionStart: a, selectionEnd: b } = ta;
  g.save();
  if (a !== b) {
    g.fillStyle = 'rgba(61, 139, 253, 0.35)';
    for (const r of selectionRects(L, l.text, a, b)) {
      const p = [toScreen(r.x, r.y), toScreen(r.x + r.w, r.y), toScreen(r.x + r.w, r.y + r.h), toScreen(r.x, r.y + r.h)];
      g.beginPath();
      p.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
      g.closePath();
      g.fill();
    }
  } else if (document.activeElement === ta && Math.floor((time - st.lastMove) / 530) % 2 === 0) {
    const c = caretAt(L, l.text, focusOf(ta), st.upstream);
    if (c) {
      const p = toScreen(c.x, c.top), q = toScreen(c.x, c.bottom);
      g.strokeStyle = '#3d8bfd';
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
    }
  }
  g.restore();
  return true;
}
