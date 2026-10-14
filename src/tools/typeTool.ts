/** Horizontal and Vertical Type tools and text editing session management. */
import type { Tool, ToolHost, ToolPointer } from './tool';
import { opts } from './helpers';
import { editor } from '../app/editor';
import { ui, useApp } from '../app/store';
import type { DocumentSession } from '../app/session';
import type { Layer, TextLayer } from '../document/types';
import { createTextLayer } from '../document/layerFactory';
import { cloneLayer } from '../document/clone';
import { CreateLayerCommand, ReplaceLayerCommand, editLayer } from '../commands/layerCommands';
import { renderTextLayer } from '../layers/appearance';
import type { CharacterStyle, ParagraphStyle, StyleRun, TextData } from '../typography/types';
import { defaultParagraphStyle } from '../typography/types';
import { layerContentBounds } from '../rendering/bounds';
import { insertionPoint } from '../app/ops/common';
import { measureTextBox } from '../typography/render';
import { apply as applyM, invert as invertM } from '../image-engine/matrix';
import { endMarker } from '../typography/pathText';
import { flattenTextPath, nearestDistance, pointAtDistance, TextPath } from '../typography/pathText';
import type { SubPath } from '../vector/types';

interface EditState {
  sessionId: string;
  layerId: string;
  isNew: boolean;
  before: Layer | null;
}

let editing: EditState | null = null;
const listeners = new Set<() => void>();

export function textEditState(): EditState | null {
  return editing;
}
export function onTextEdit(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
function notify() {
  for (const l of listeners) l();
  ui.bump('viewRev');
}

/** Replaces the text while keeping style runs aligned with unchanged characters. */
export function setTextKeepingStyles(t: TextData, next: string): void {
  const prev = t.text;
  if (prev === next) return;
  let p = 0;
  while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
  let s = 0;
  while (s < prev.length - p && s < next.length - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  const removedEnd = prev.length - s;
  const inserted = next.length - p - s;
  // Expand runs into per-character styles, splice, and re-run-length encode.
  const styles: CharacterStyle[] = [];
  for (const r of t.runs) for (let i = 0; i < r.length; i++) styles.push(r.style);
  while (styles.length < prev.length) styles.push(t.runs[t.runs.length - 1]?.style);
  const insertStyle = styles[Math.max(0, p - 1)] ?? styles[p] ?? t.runs[0]?.style;
  styles.splice(p, removedEnd - p, ...new Array(inserted).fill(insertStyle));
  const runs: StyleRun<CharacterStyle>[] = [];
  for (const st of styles) {
    const last = runs[runs.length - 1];
    if (last && last.style === st) last.length++;
    else runs.push({ length: 1, style: st });
  }
  if (!runs.length) runs.push({ length: 0, style: insertStyle ?? t.runs[0].style });
  t.runs = runs;
  t.text = next;
  // Paragraph runs: one per line, reusing existing paragraph styles.
  const lines = next.split('\n');
  const paraStyles: ParagraphStyle[] = [];
  for (const pr of t.paragraphs) paraStyles.push(pr.style);
  t.paragraphs = lines.map((ln, i) => ({ length: ln.length + (i < lines.length - 1 ? 1 : 0), style: paraStyles[Math.min(i, paraStyles.length - 1)] ?? defaultParagraphStyle() }));
}

export function startTextEdit(s: DocumentSession, layerId: string, isNew: boolean): void {
  if (editing) commitTextEdit();
  const l = s.doc.getLayer(layerId);
  if (!l || l.kind !== 'text') return;
  if (l.psdPathText && !l.text.path) ui.toast('info', 'This is Photoshop text on a path.', "Celenne could not read this layer's path, so an edit lays the text out as point text. Press Cancel to keep the original, or attach it to a path with the Type tool.");
  editing = { sessionId: s.id, layerId, isNew, before: isNew ? null : cloneLayer(l) };
  s.mode = { kind: 'text', layerId, isNew };
  s.setActive(layerId);
  notify();
}

export function updateEditingText(value: string): void {
  const e = editing;
  if (!e) return;
  const s = editor.session(e.sessionId);
  const l = s?.doc.getLayer(e.layerId);
  if (!s || !l || l.kind !== 'text') return;
  setTextKeepingStyles(l.text, value);
  renderTextLayer(s.doc, l);
  if (e.isNew) l.name = value.split('\n')[0].slice(0, 40) || 'Text';
  s.doc.emit({ type: 'layer', layerId: l.id });
}

/** Applies a style change to the whole editing/active text layer. */
export function applyTextStyle(s: DocumentSession, layerId: string, patch: Partial<CharacterStyle>, para?: Partial<ParagraphStyle>): void {
  const l = s.doc.getLayer(layerId);
  if (!l || l.kind !== 'text') return;
  const mutate = (t: TextLayer) => {
    t.text.runs = t.text.runs.map((r) => ({ length: r.length, style: { ...r.style, ...patch } }));
    if (para) t.text.paragraphs = t.text.paragraphs.map((p) => ({ length: p.length, style: { ...p.style, ...para } }));
    renderTextLayer(s.doc, t);
  };
  if (editing && editing.layerId === layerId) {
    mutate(l);
    s.doc.emit({ type: 'layer', layerId });
    return;
  }
  const cmd = editLayer(s.doc, layerId, 'Character Style', (x) => mutate(x as TextLayer));
  if (cmd) s.push(cmd, true);
}

export function commitTextEdit(): void {
  const e = editing;
  if (!e) return;
  editing = null;
  const s = editor.session(e.sessionId);
  if (!s) return notify();
  s.mode = { kind: 'none' };
  const l = s.doc.getLayer(e.layerId);
  if (!l || l.kind !== 'text') return notify();
  if (!l.text.text.trim()) {
    // Empty text: remove a new layer, restore an existing one.
    if (e.isNew) {
      s.doc.removeLayer(l);
      s.doc.emit({ type: 'structure' });
    } else if (e.before && l.parent) {
      const parent = l.parent;
      const restored = cloneLayer(e.before);
      restored.parent = parent;
      parent.children[parent.children.indexOf(l)] = restored;
      s.doc.emit({ type: 'structure' });
    }
    return notify();
  }
  if (e.isNew) {
    const parent = l.parent ?? s.doc.root;
    const cmd = new CreateLayerCommand('Type Tool', l, parent.id, parent.children.indexOf(l), { action: 'type.create', args: { text: structuredClone(l.text) } });
    s.push(cmd, true);
  } else if (e.before) {
    const after = cloneLayer(l);
    if (JSON.stringify((e.before as TextLayer).text) !== JSON.stringify(after.text)) s.push(new ReplaceLayerCommand('Edit Type Layer', e.before, after), true);
  }
  notify();
}

export function cancelTextEdit(): void {
  const e = editing;
  if (!e) return;
  editing = null;
  const s = editor.session(e.sessionId);
  if (s) {
    s.mode = { kind: 'none' };
    const l = s.doc.getLayer(e.layerId);
    if (l) {
      if (e.isNew) s.doc.removeLayer(l);
      else if (e.before && l.parent) {
        const parent = l.parent;
        const restored = cloneLayer(e.before);
        restored.parent = parent;
        parent.children[parent.children.indexOf(l)] = restored;
      }
      s.doc.emit({ type: 'structure' });
    }
  }
  notify();
}

export async function convertTextKind(kind: 'point' | 'paragraph'): Promise<void> {
  const s = editor.active;
  const l = s?.activeLayer();
  if (!s || !l || l.kind !== 'text' || l.text.kind === kind) return;
  const cmd = editLayer(s.doc, l.id, kind === 'paragraph' ? 'Convert to Paragraph Text' : 'Convert to Point Text', (x) => {
    const t = x as TextLayer;
    if (kind === 'paragraph') {
      const b = measureTextBox(t.text) ?? { x: 0, y: -t.text.runs[0].style.fontSize, w: 200, h: t.text.runs[0].style.fontSize * 1.4 };
      t.text.box = { x: b.x, y: b.y, w: Math.ceil(b.w) + 4, h: Math.ceil(b.h) + 4 };
      // Paragraph text is positioned from the box top-left.
      t.text.kind = 'paragraph';
    } else {
      t.text.kind = 'point';
      t.text.box = null;
    }
    renderTextLayer(s.doc, t);
  });
  if (cmd) s.push(cmd, true);
}

/** Type ▸ Vertical Orientation: switches the active text layer between horizontal and vertical. */
export function toggleTextOrientation(): void {
  const s = editor.active;
  const l = s?.activeLayer();
  if (!s || !l || l.kind !== 'text') return;
  const next = l.text.orientation === 'vertical' ? 'horizontal' : 'vertical';
  const cmd = editLayer(s.doc, l.id, next === 'vertical' ? 'Vertical Orientation' : 'Horizontal Orientation', (x) => {
    const t = x as TextLayer;
    t.text.orientation = next;
    renderTextLayer(s.doc, t);
  });
  if (cmd) s.push(cmd, true);
}

/** Type ▸ Fit Text to Frame: scales the paragraph text's sizes so it fills its box. */
export async function fitTextToFrame(): Promise<void> {
  const s = editor.active;
  const l = s?.activeLayer();
  if (!s || !l || l.kind !== 'text') return;
  if (l.text.kind !== 'paragraph' || !l.text.box) { ui.toast('info', 'Fit Text to Frame works on paragraph (box) text.'); return; }
  const [{ fitScale, scaledText }, { layoutEngine }, { appFaces, engineFontsReady }] = await Promise.all([import('../typography/fitFrame'), import('../typography/engine/layout'), import('../typography/engine/appFonts')]);
  if (!engineFontsReady()) { ui.toast('info', 'The fonts are still loading. Try again in a moment.'); return; }
  const k = fitScale(l.text, (t) => layoutEngine(t, appFaces, { ignoreStoredBreaks: true }));
  if (!k) { ui.toast('info', 'The text does not fit the frame even at the smallest size.'); return; }
  // Sizes to a tenth of a pixel, rounded down so the text still fits.
  const size0 = l.text.runs[0].style.fontSize;
  const k2 = Math.floor(size0 * k * 10) / 10 / size0;
  if (Math.abs(k2 - 1) < 1e-4) return;
  const cmd = editLayer(s.doc, l.id, 'Fit Text to Frame', (x) => {
    const t = x as TextLayer;
    t.text = scaledText(t.text, k2);
    renderTextLayer(s.doc, t);
  });
  if (cmd) s.push(cmd, true);
}

/** Type ▸ Warp Text: sets (or with null, removes) the warp of a text layer. */
export function setTextWarp(layerId: string, warp: TextData['warp'] | null, label = 'Warp Text'): void {
  const s = editor.active;
  const l = s?.doc.getLayer(layerId);
  if (!s || !l || l.kind !== 'text') return;
  const cmd = editLayer(s.doc, l.id, label, (x) => {
    const t = x as TextLayer;
    t.text.warp = warp ?? undefined;
    renderTextLayer(s.doc, t);
  });
  if (cmd) s.push(cmd, true);
}

/** Type on a path: changes the start point / side of the active path text layer (null detaches it). */
export function setTextPath(layerId: string, patch: Partial<TextPath> | null, label = 'Type on Path'): void {
  const s = editor.active;
  const l = s?.doc.getLayer(layerId);
  if (!s || !l || l.kind !== 'text' || !l.text.path) return;
  const apply = (t: TextLayer) => {
    if (!t.text.path) return;
    if (patch) t.text.path = { ...t.text.path, ...patch };
    else {
      // Detach: keep the text where its start point was, as point text.
      const f = flattenTextPath(t.text.path.subpath);
      const k = t.text.path.subpath.knots[0];
      const at = f ? pointAtDistance(f, Math.max(0, Math.min(f.length, t.text.path.start))) : null;
      const x = at?.x ?? k?.x ?? 0, y = at?.y ?? k?.y ?? 0;
      const m = t.text.transform;
      t.text.transform = [m[0], m[1], m[2], m[3], m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
      t.text.path = undefined;
    }
    renderTextLayer(s.doc, t);
  };
  if (editing && editing.layerId === layerId) {
    apply(l);
    s.doc.emit({ type: 'layer', layerId });
    return;
  }
  const cmd = editLayer(s.doc, l.id, label, (x) => apply(x as TextLayer));
  if (cmd) s.push(cmd, true);
}

/** The path under the pointer that text can be placed on: the active (or work) path, or the active shape layer's path. */
function pathUnder(h: ToolHost, p: ToolPointer): { subpath: SubPath; start: number } | null {
  const s = h.session;
  const cands: SubPath[] = [];
  const active = s.activePathId ? s.doc.paths.find((x) => x.id === s.activePathId) : s.doc.paths.find((x) => x.kind === 'work');
  if (active) cands.push(...active.path.subpaths);
  const al = s.activeLayer();
  if (al?.kind === 'shape') cands.push(...al.path.subpaths);
  const tol = 6 / Math.max(1e-6, s.view.zoom);
  let best: { subpath: SubPath; start: number; dist: number } | null = null;
  for (const sp of cands) {
    if (sp.knots.length < 2 && !(sp.closed && sp.knots.length >= 1)) continue;
    const f = flattenTextPath(sp);
    if (!f) continue;
    const n = nearestDistance(f, p.x, p.y);
    if (n.dist <= tol && (!best || n.dist < best.dist)) best = { subpath: sp, start: n.d, dist: n.dist };
  }
  return best ? { subpath: structuredClone(best.subpath), start: best.start } : null;
}

export class TypeTool implements Tool {
  readonly id: 'type' | 'typeVertical';
  constructor(private readonly vertical = false) {
    this.id = vertical ? 'typeVertical' : 'type';
  }
  private start: ToolPointer | null = null;
  private cur: { x: number; y: number } | null = null;
  private onPath: { subpath: SubPath; start: number } | null = null;
  private marker: { layerId: string; which: 'start' | 'end'; before: Layer } | null = null;

  /** The start / end marker of the active path-text layer under the pointer. */
  private markerUnder(h: ToolHost, p: ToolPointer): { layer: TextLayer; which: 'start' | 'end' } | null {
    const l = h.session.activeLayer();
    if (!l || l.kind !== 'text' || !l.text.path) return null;
    const f = flattenTextPath(l.text.path.subpath);
    if (!f) return null;
    const v = h.session.view;
    for (const which of ['start', 'end'] as const) {
      const d = which === 'start' ? l.text.path.start : endMarker(l.text.path, f.length);
      const pt = pointAtDistance(f, Math.min(f.length, d));
      if (!pt) continue;
      const q = applyM(l.text.transform, pt.x, pt.y);
      const sp = v.docToScreen(q.x, q.y);
      if (Math.hypot(sp.x - p.sx, sp.y - p.sy) <= 8) return { layer: l, which };
    }
    return null;
  }

  cursor(h: ToolHost, p: ToolPointer | null) {
    if (p && !this.vertical && this.markerUnder(h, p)) return 'ew-resize';
    if (p && !editing && !this.vertical && pathUnder(h, p)) return 'crosshair';
    return this.vertical ? 'vertical-text' : 'text';
  }

  busy() {
    return !!this.start;
  }

  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    // Dragging the start / end marker of path text.
    const mk = this.vertical ? null : this.markerUnder(h, p);
    if (mk) {
      if (editing) commitTextEdit();
      this.marker = { layerId: mk.layer.id, which: mk.which, before: cloneLayer(mk.layer) };
      return;
    }
    // Clicking another text layer (or outside) while editing commits first.
    const hit = this.hitText(h, p);
    if (editing) {
      if (hit && hit.id === editing.layerId) return;
      commitTextEdit();
    }
    if (hit) {
      startTextEdit(s, hit.id, false);
      return;
    }
    this.onPath = this.vertical ? null : pathUnder(h, p);
    this.start = p;
    this.cur = { x: p.x, y: p.y };
  }

  move(h: ToolHost, p: ToolPointer) {
    if (this.marker) {
      const l = h.session.doc.getLayer(this.marker.layerId);
      if (!l || l.kind !== 'text' || !l.text.path) return;
      const f = flattenTextPath(l.text.path.subpath);
      if (!f) return;
      const q = applyM(invertM(l.text.transform), p.x, p.y);
      const d = nearestDistance(f, q.x, q.y).d;
      l.text.path = this.marker.which === 'start' ? { ...l.text.path, start: d } : { ...l.text.path, end: d };
      renderTextLayer(h.session.doc, l);
      h.session.doc.emit({ type: 'layer', layerId: l.id });
      h.redraw();
      return;
    }
    if (!this.start) return;
    this.cur = { x: p.x, y: p.y };
    h.redraw();
  }

  up(h: ToolHost, p: ToolPointer) {
    if (this.marker) {
      const m = this.marker;
      this.marker = null;
      const l = h.session.doc.getLayer(m.layerId);
      if (l && JSON.stringify((m.before as TextLayer).text.path) !== JSON.stringify((l as TextLayer).text.path)) {
        h.session.push(new ReplaceLayerCommand(m.which === 'start' ? 'Move Path Text Start' : 'Move Path Text End', m.before, cloneLayer(l)), true);
      }
      return;
    }
    const st = this.start;
    this.start = null;
    this.cur = null;
    if (!st) return;
    const s = h.session;
    const o = opts().type;
    const onPath = this.onPath;
    this.onPath = null;
    const dragged = !onPath && Math.hypot(p.sx - st.sx, p.sy - st.sy) > 6;
    const fg = useApp.getState().fg;
    // Font size in document px from points at the document resolution.
    const px = (o.fontSize * s.doc.canvas.resolution) / 72;
    const baselineY = dragged ? Math.min(st.y, p.y) : st.y;
    const layer = createTextLayer('', s.doc.canvas.bitDepth, dragged ? Math.min(st.x, p.x) : st.x, baselineY);
    const style = layer.text.runs[0].style;
    Object.assign(style, { fontFamily: o.fontFamily, fontStyleName: o.fontStyleName, fontWeight: o.fontWeight, italic: o.italic, fontSize: px, color: { ...fg, a: 1 } });
    layer.text.paragraphs[0].style.align = o.align;
    layer.text.antiAlias = o.antiAlias;
    if (this.vertical) layer.text.orientation = 'vertical';
    if (onPath) {
      layer.text.transform = [1, 0, 0, 1, 0, 0];
      layer.text.path = { subpath: onPath.subpath, start: onPath.start, flip: false };
    }
    if (dragged) {
      layer.text.kind = 'paragraph';
      layer.text.box = { x: 0, y: 0, w: Math.abs(p.x - st.x), h: Math.abs(p.y - st.y) };
      layer.text.transform = [1, 0, 0, 1, Math.min(st.x, p.x), Math.min(st.y, p.y)];
    }
    const { parentId, index } = insertionPoint(s);
    const parent = s.doc.getLayer(parentId);
    s.doc.insertLayer(layer, parent && parent.kind === 'group' ? parent : s.doc.root, index);
    s.doc.emit({ type: 'structure' });
    startTextEdit(s, layer.id, true);
    h.redraw();
  }

  private hitText(h: ToolHost, p: ToolPointer): TextLayer | null {
    const doc = h.session.doc;
    for (const l of doc.allLayers().reverse()) {
      if (l.kind !== 'text' || !doc.isEffectivelyVisible(l)) continue;
      const b = layerContentBounds(l);
      if (b && p.x >= b.x - 4 && p.x <= b.x + b.w + 4 && p.y >= b.y - 4 && p.y <= b.y + b.h + 4) return l;
    }
    return null;
  }

  keyDown(_h: ToolHost, e: KeyboardEvent): boolean {
    if (!editing) return false;
    if (e.key === 'Escape') { commitTextEdit(); return true; }
    return false;
  }

  deactivate() {
    commitTextEdit();
  }

  cancel() {
    this.start = null;
  }

  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    this.drawPathMarkers(h, g);
    if (!this.start || !this.cur) return;
    const v = h.session.view;
    const a = v.docToScreen(this.start.x, this.start.y), b = v.docToScreen(this.cur.x, this.cur.y);
    g.save();
    g.setLineDash([4, 3]);
    g.strokeStyle = '#fff';
    g.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    g.restore();
  }

  /** The path of the active path-text layer with its start (filled) and end (hollow) markers. */
  private drawPathMarkers(h: ToolHost, g: CanvasRenderingContext2D) {
    const l = h.session.activeLayer();
    if (!l || l.kind !== 'text' || !l.text.path) return;
    const f = flattenTextPath(l.text.path.subpath);
    if (!f) return;
    const v = h.session.view;
    const m = l.text.transform;
    const scr = (x: number, y: number) => { const q = applyM(m, x, y); return v.docToScreen(q.x, q.y); };
    g.save();
    g.strokeStyle = 'rgba(61,139,253,0.9)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < f.xs.length; i++) { const s = scr(f.xs[i], f.ys[i]); if (i) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y); }
    if (f.closed) g.closePath();
    g.stroke();
    for (const which of ['start', 'end'] as const) {
      const d = which === 'start' ? l.text.path.start : endMarker(l.text.path, f.length);
      const pt = pointAtDistance(f, Math.min(f.length, d));
      if (!pt) continue;
      const s = scr(pt.x, pt.y);
      g.beginPath();
      g.arc(s.x, s.y, 4, 0, Math.PI * 2);
      g.fillStyle = which === 'start' ? '#3d8bfd' : '#fff';
      g.fill();
      g.strokeStyle = '#1b4f9c';
      g.stroke();
    }
    g.restore();
  }
}
