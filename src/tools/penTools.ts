/**
 * Pen tool family: Pen, Freeform Pen, Add/Delete Anchor, Convert Point, Path Selection,
 * Direct Selection. Edits target (in order): the active shape layer's path, the active
 * vector mask (when the active layer has one and no shape), the path selected in the Paths
 * panel, or the work path.
 */
import type { Tool, ToolHost, ToolPointer } from './tool';
import { opts, toast } from './helpers';
import type { DocumentSession } from '../app/session';
import type { PathKnot, VectorPath } from '../vector/types';
import { clonePath, knot } from '../vector/types';
import { LambdaCommand, ReplaceLayerCommand, CreateLayerCommand } from '../commands/layerCommands';
import { cloneLayer } from '../document/clone';
import { renderShapeLayer } from '../layers/appearance';
import { fitSmooth, nearestSegment, splitSegment, bezierPoint } from '../vector/shapes';
import { simplify } from '../selection/ops';
import { newId } from '../document/ids';
import { createShapeLayer } from '../document/layerFactory';
import { insertionPoint, nextLayerName } from '../app/ops/common';
import { useApp } from '../app/store';
import type { Layer } from '../document/types';

type PathTarget =
  | { kind: 'shape'; layerId: string }
  | { kind: 'vectorMask'; layerId: string }
  | { kind: 'path'; pathId: string };

function getTarget(s: DocumentSession, create: boolean): PathTarget | null {
  const l = s.activeLayer();
  if (l?.kind === 'shape') return { kind: 'shape', layerId: l.id };
  if (l?.vectorMask && !s.activePathId) return { kind: 'vectorMask', layerId: l.id };
  const byId = s.activePathId ? s.doc.paths.find((p) => p.id === s.activePathId) : null;
  if (byId) return { kind: 'path', pathId: byId.id };
  const work = s.doc.paths.find((p) => p.kind === 'work');
  if (work) return { kind: 'path', pathId: work.id };
  if (!create) return null;
  const id = newId('path');
  s.doc.paths.unshift({ id, name: 'Work Path', kind: 'work', path: { subpaths: [], fillRule: 'nonzero' } });
  s.activePathId = id;
  s.doc.emit({ type: 'paths' });
  return { kind: 'path', pathId: id };
}

function livePath(s: DocumentSession, t: PathTarget): VectorPath | null {
  if (t.kind === 'path') return s.doc.paths.find((p) => p.id === t.pathId)?.path ?? null;
  const l = s.doc.getLayer(t.layerId);
  if (!l) return null;
  if (t.kind === 'shape' && l.kind === 'shape') return l.path;
  return l.vectorMask?.path ?? null;
}

/** Captures the target before an edit and records an undoable command after. */
class PathEdit {
  private before: VectorPath | Layer;
  constructor(private s: DocumentSession, readonly t: PathTarget, private label: string) {
    if (t.kind === 'path') this.before = clonePath(livePath(s, t)!);
    else this.before = cloneLayer(s.doc.getLayer(t.layerId)!);
  }
  path(): VectorPath {
    return livePath(this.s, this.t)!;
  }
  changed(): void {
    const t = this.t;
    if (t.kind === 'shape') {
      const l = this.s.doc.getLayer(t.layerId);
      if (l?.kind === 'shape') {
        l.origin = l.origin ? { ...l.origin, kind: 'custom' } : null;
        renderShapeLayer(this.s.doc, l);
        this.s.doc.emit({ type: 'layer', layerId: l.id });
      }
    } else if (t.kind === 'vectorMask') this.s.doc.emit({ type: 'mask', layerId: t.layerId, rect: null });
    else this.s.doc.emit({ type: 'paths' });
  }
  commit(): void {
    const s = this.s, t = this.t;
    if (t.kind === 'path') {
      const before = this.before as VectorPath;
      const after = clonePath(this.path());
      const id = t.pathId;
      s.push(new LambdaCommand(this.label, (d) => { const p = d.paths.find((x) => x.id === id); if (p) p.path = clonePath(after); d.emit({ type: 'paths' }); }, (d) => { const p = d.paths.find((x) => x.id === id); if (p) p.path = clonePath(before); d.emit({ type: 'paths' }); }), true);
      return;
    }
    const live = s.doc.getLayer(t.layerId);
    if (!live) return;
    s.push(new ReplaceLayerCommand(this.label, this.before as Layer, cloneLayer(live)), true);
  }
}

function hitKnot(h: ToolHost, path: VectorPath, p: ToolPointer): { sp: number; i: number; part: 'anchor' | 'in' | 'out' } | null {
  const v = h.session.view;
  let best: { sp: number; i: number; part: 'anchor' | 'in' | 'out'; d: number } | null = null;
  path.subpaths.forEach((s, sp) =>
    s.knots.forEach((k, i) => {
      for (const [part, x, y] of [['anchor', k.x, k.y], ['in', k.inX, k.inY], ['out', k.outX, k.outY]] as const) {
        const q = v.docToScreen(x, y);
        const d = Math.hypot(q.x - p.sx, q.y - p.sy);
        if (d < 7 && (!best || d < best.d || (part === 'anchor' && best.part !== 'anchor' && d < best.d + 2))) best = { sp, i, part, d };
      }
    }),
  );
  return best;
}

function drawPath(h: ToolHost, g: CanvasRenderingContext2D, path: VectorPath | null, selected: Set<string>, showHandles: boolean) {
  if (!path) return;
  const v = h.session.view;
  g.save();
  g.strokeStyle = '#2f8bff';
  g.lineWidth = 1;
  for (const s of path.subpaths) {
    if (!s.knots.length) continue;
    g.beginPath();
    const k0 = v.docToScreen(s.knots[0].x, s.knots[0].y);
    g.moveTo(k0.x, k0.y);
    const n = s.closed ? s.knots.length : s.knots.length - 1;
    for (let i = 0; i < n; i++) {
      const a = s.knots[i], b = s.knots[(i + 1) % s.knots.length];
      const c1 = v.docToScreen(a.outX, a.outY), c2 = v.docToScreen(b.inX, b.inY), e = v.docToScreen(b.x, b.y);
      g.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y);
    }
    if (s.closed) g.closePath();
    g.stroke();
  }
  path.subpaths.forEach((s, sp) =>
    s.knots.forEach((k, i) => {
      const a = v.docToScreen(k.x, k.y);
      const sel = selected.has(`${sp}:${i}`);
      if (showHandles || sel) {
        for (const [hx, hy] of [[k.inX, k.inY], [k.outX, k.outY]]) {
          if (hx === k.x && hy === k.y) continue;
          const q = v.docToScreen(hx, hy);
          g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(q.x, q.y); g.stroke();
          g.beginPath(); g.arc(q.x, q.y, 3, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); g.stroke();
        }
      }
      g.fillStyle = sel ? '#2f8bff' : '#fff';
      g.fillRect(a.x - 3.5, a.y - 3.5, 7, 7);
      g.strokeRect(a.x - 3.5, a.y - 3.5, 7, 7);
    }),
  );
  g.restore();
}

// ---------------------------------------------------------------------------------------------
// Pen
// ---------------------------------------------------------------------------------------------
export class PenTool implements Tool {
  id = 'pen' as const;
  private edit: PathEdit | null = null;
  private spIndex = -1;
  private dragging: PathKnot | null = null;
  private hoverPt: { x: number; y: number } | null = null;
  private shapeMode = false;
  cursor() {
    return 'crosshair';
  }
  busy() {
    return !!this.dragging;
  }
  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    if (!this.edit) {
      this.shapeMode = opts().pen.mode === 'shape' && s.activeLayer()?.kind !== 'shape';
      if (this.shapeMode) {
        const layer = createShapeLayer(nextLayerName(s, 'Shape'), { subpaths: [], fillRule: 'nonzero' }, null, s.doc.canvas.bitDepth);
        layer.fill = { type: 'solid', color: { ...useApp.getState().fg } };
        const { parentId, index } = insertionPoint(s);
        const cmd = new CreateLayerCommand('Pen Shape', layer, parentId, index);
        cmd.do(s.doc);
        s.push(cmd, true);
        s.setActive(layer.id);
      }
      const t = getTarget(s, true);
      if (!t) return;
      this.edit = new PathEdit(s, t, 'Pen');
      this.spIndex = -1;
    }
    const path = this.edit.path();
    // Close on the first knot of the current sub-path.
    if (this.spIndex >= 0) {
      const sp = path.subpaths[this.spIndex];
      const f = h.session.view.docToScreen(sp.knots[0].x, sp.knots[0].y);
      if (sp.knots.length > 1 && Math.hypot(f.x - p.sx, f.y - p.sy) < 8) {
        sp.closed = true;
        this.edit.changed();
        this.finish();
        return;
      }
    }
    if (this.spIndex < 0) {
      path.subpaths.push({ knots: [], closed: false, op: 'combine' });
      this.spIndex = path.subpaths.length - 1;
    }
    const k = knot(p.x, p.y);
    path.subpaths[this.spIndex].knots.push(k);
    this.dragging = k;
    this.edit.changed();
    h.redraw();
  }
  move(h: ToolHost, p: ToolPointer) {
    if (this.dragging) {
      const k = this.dragging;
      k.outX = p.x; k.outY = p.y;
      if (!p.alt) { k.inX = 2 * k.x - p.x; k.inY = 2 * k.y - p.y; }
      k.smooth = !p.alt;
      this.edit?.changed();
    }
    this.hoverPt = { x: p.x, y: p.y };
    h.redraw();
  }
  hover(h: ToolHost, p: ToolPointer) {
    this.hoverPt = { x: p.x, y: p.y };
    h.redraw();
  }
  up() {
    this.dragging = null;
  }
  keyDown(h: ToolHost, e: KeyboardEvent): boolean {
    if (!this.edit) return false;
    if (e.key === 'Enter' || e.key === 'Escape') {
      this.finish();
      h.redraw();
      return true;
    }
    return false;
  }
  private finish() {
    if (this.edit) {
      const path = this.edit.path();
      path.subpaths = path.subpaths.filter((sp) => sp.knots.length > 1 || sp.closed);
      this.edit.changed();
      this.edit.commit();
    }
    this.edit = null;
    this.spIndex = -1;
    this.dragging = null;
  }
  deactivate() {
    this.finish();
  }
  cancel() {
    this.finish();
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    const s = h.session;
    const t = this.edit?.t ?? getTarget(s, false);
    const path = t ? livePath(s, t) : null;
    drawPath(h, g, path, new Set(), true);
    if (this.edit && this.spIndex >= 0 && this.hoverPt && !this.dragging && path) {
      const sp = path.subpaths[this.spIndex];
      const last = sp?.knots[sp.knots.length - 1];
      if (last) {
        const v = s.view;
        const a = v.docToScreen(last.x, last.y), c = v.docToScreen(last.outX, last.outY), b = v.docToScreen(this.hoverPt.x, this.hoverPt.y);
        g.save();
        g.strokeStyle = 'rgba(47,139,255,0.6)';
        g.beginPath(); g.moveTo(a.x, a.y); g.bezierCurveTo(c.x, c.y, b.x, b.y, b.x, b.y); g.stroke();
        g.restore();
      }
    }
  }
}

export class FreeformPenTool implements Tool {
  id = 'freeformPen' as const;
  private pts: { x: number; y: number }[] = [];
  private active = false;
  cursor() {
    return 'crosshair';
  }
  busy() {
    return this.active;
  }
  down(_h: ToolHost, p: ToolPointer) {
    this.active = true;
    this.pts = [{ x: p.x, y: p.y }];
  }
  move(h: ToolHost, p: ToolPointer) {
    if (!this.active) return;
    this.pts.push({ x: p.x, y: p.y });
    h.redraw();
  }
  up(h: ToolHost) {
    this.active = false;
    if (this.pts.length < 3) return;
    const flat: number[] = [];
    for (const q of this.pts) flat.push(q.x, q.y);
    const simp = simplify(flat, 2 / h.session.view.zoom);
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < simp.length; i += 2) pts.push({ x: simp[i], y: simp[i + 1] });
    const first = pts[0], last = pts[pts.length - 1];
    const closed = Math.hypot(first.x - last.x, first.y - last.y) * h.session.view.zoom < 10;
    if (closed) pts.pop();
    const t = getTarget(h.session, true);
    if (!t) return;
    const edit = new PathEdit(h.session, t, 'Freeform Pen');
    edit.path().subpaths.push(fitSmooth(pts, closed));
    edit.changed();
    edit.commit();
    this.pts = [];
    h.redraw();
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    if (this.pts.length < 2) return;
    const v = h.session.view;
    g.save();
    g.strokeStyle = '#2f8bff';
    g.beginPath();
    this.pts.forEach((q, i) => { const s = v.docToScreen(q.x, q.y); if (i) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y); });
    g.stroke();
    g.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// Anchor editing and selection
// ---------------------------------------------------------------------------------------------
export class AnchorTool implements Tool {
  constructor(readonly id: 'addAnchor' | 'deleteAnchor' | 'convertPoint') {}
  private drag: { edit: PathEdit; k: PathKnot } | null = null;
  cursor() {
    return 'crosshair';
  }
  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    const t = getTarget(s, false);
    if (!t) return toast('There is no path to edit. Draw one with the Pen tool.');
    const edit = new PathEdit(s, t, this.id === 'addAnchor' ? 'Add Anchor Point' : this.id === 'deleteAnchor' ? 'Delete Anchor Point' : 'Convert Point');
    const path = edit.path();
    if (this.id === 'addAnchor') {
      const near = nearestSegment(path, p.x, p.y);
      if (!near || near.d * s.view.zoom > 8) return;
      const sp = path.subpaths[near.sp];
      const a = sp.knots[near.i], b = sp.knots[(near.i + 1) % sp.knots.length];
      sp.knots.splice(near.i + 1, 0, splitSegment(a, b, near.t));
    } else {
      const hk = hitKnot(h, path, p);
      if (!hk || hk.part !== 'anchor') return;
      const sp = path.subpaths[hk.sp];
      const k = sp.knots[hk.i];
      if (this.id === 'deleteAnchor') {
        sp.knots.splice(hk.i, 1);
        if (sp.knots.length < 2) path.subpaths.splice(hk.sp, 1);
      } else if (k.smooth || k.inX !== k.x || k.outX !== k.x || k.inY !== k.y || k.outY !== k.y) {
        k.inX = k.outX = k.x; k.inY = k.outY = k.y; k.smooth = false;
      } else {
        this.drag = { edit, k };
        k.smooth = true;
        return;
      }
    }
    edit.changed();
    edit.commit();
    h.redraw();
  }
  move(h: ToolHost, p: ToolPointer) {
    if (!this.drag) return;
    const k = this.drag.k;
    k.outX = p.x; k.outY = p.y; k.inX = 2 * k.x - p.x; k.inY = 2 * k.y - p.y;
    this.drag.edit.changed();
    h.redraw();
  }
  up() {
    if (this.drag) this.drag.edit.commit();
    this.drag = null;
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    const t = getTarget(h.session, false);
    drawPath(h, g, t ? livePath(h.session, t) : null, new Set(), true);
  }
}

export class PathSelectTool implements Tool {
  private selected = new Set<string>();
  private drag: { edit: PathEdit; start: ToolPointer; orig: VectorPath; part: 'anchor' | 'in' | 'out' | 'whole'; sp: number; i: number } | null = null;
  constructor(readonly id: 'pathSelect' | 'directSelect') {}
  cursor() {
    return 'default';
  }
  busy() {
    return !!this.drag;
  }
  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    const t = getTarget(s, false);
    if (!t) return;
    const edit = new PathEdit(s, t, this.id === 'pathSelect' ? 'Path Selection' : 'Direct Selection');
    const path = edit.path();
    if (this.id === 'directSelect') {
      const hk = hitKnot(h, path, p);
      if (hk) {
        const key = `${hk.sp}:${hk.i}`;
        if (!p.shift && !this.selected.has(key)) this.selected.clear();
        this.selected.add(key);
        this.drag = { edit, start: p, orig: clonePath(path), part: hk.part, sp: hk.sp, i: hk.i };
        h.redraw();
        return;
      }
    }
    const near = nearestSegment(path, p.x, p.y);
    if (near && near.d * s.view.zoom < 10) {
      if (!p.shift) this.selected.clear();
      path.subpaths[near.sp].knots.forEach((_, i) => this.selected.add(`${near.sp}:${i}`));
      this.drag = { edit, start: p, orig: clonePath(path), part: 'whole', sp: near.sp, i: 0 };
    } else this.selected.clear();
    h.redraw();
  }
  move(h: ToolHost, p: ToolPointer) {
    const d = this.drag;
    if (!d) return;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const path = d.edit.path();
    const orig = d.orig;
    const moveKnot = (sp: number, i: number) => {
      const o = orig.subpaths[sp].knots[i], k = path.subpaths[sp].knots[i];
      k.x = o.x + dx; k.y = o.y + dy; k.inX = o.inX + dx; k.inY = o.inY + dy; k.outX = o.outX + dx; k.outY = o.outY + dy;
    };
    if (d.part === 'whole' || d.part === 'anchor') {
      for (const key of this.selected) {
        const [sp, i] = key.split(':').map(Number);
        if (path.subpaths[sp]?.knots[i]) moveKnot(sp, i);
      }
    } else {
      const o = orig.subpaths[d.sp].knots[d.i], k = path.subpaths[d.sp].knots[d.i];
      if (d.part === 'in') {
        k.inX = o.inX + dx; k.inY = o.inY + dy;
        if (k.smooth && !p.alt) {
          const len = Math.hypot(o.outX - o.x, o.outY - o.y), a = Math.atan2(k.y - k.inY, k.x - k.inX);
          k.outX = k.x + Math.cos(a) * len; k.outY = k.y + Math.sin(a) * len;
        }
      } else {
        k.outX = o.outX + dx; k.outY = o.outY + dy;
        if (k.smooth && !p.alt) {
          const len = Math.hypot(o.inX - o.x, o.inY - o.y), a = Math.atan2(k.y - k.outY, k.x - k.outX);
          k.inX = k.x + Math.cos(a) * len; k.inY = k.y + Math.sin(a) * len;
        }
      }
      if (p.alt) k.smooth = false;
    }
    d.edit.changed();
    h.redraw();
  }
  up() {
    if (this.drag) {
      const moved = JSON.stringify(this.drag.orig) !== JSON.stringify(this.drag.edit.path());
      if (moved) this.drag.edit.commit();
    }
    this.drag = null;
  }
  keyDown(h: ToolHost, e: KeyboardEvent): boolean {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected.size) {
      const t = getTarget(h.session, false);
      if (!t) return false;
      const edit = new PathEdit(h.session, t, 'Delete Anchor Points');
      const path = edit.path();
      const bySub = new Map<number, number[]>();
      for (const key of this.selected) { const [sp, i] = key.split(':').map(Number); bySub.set(sp, [...(bySub.get(sp) ?? []), i]); }
      for (const [sp, idxs] of [...bySub.entries()].sort((a, b) => b[0] - a[0])) {
        const knots = path.subpaths[sp]?.knots;
        if (!knots) continue;
        for (const i of idxs.sort((a, b) => b - a)) knots.splice(i, 1);
        if (knots.length < 2) path.subpaths.splice(sp, 1);
      }
      this.selected.clear();
      edit.changed();
      edit.commit();
      h.redraw();
      return true;
    }
    return false;
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    const t = getTarget(h.session, false);
    drawPath(h, g, t ? livePath(h.session, t) : null, this.selected, this.id === 'directSelect');
  }
}

export { bezierPoint };
