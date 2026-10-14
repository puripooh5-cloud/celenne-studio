/** Shared tool helpers: options, snapping, selection modifiers, overlay drawing. */
import { useApp } from '../app/store';
import type { ToolHost, ToolPointer } from './tool';
import type { SelectionOp } from '../selection/selection';
import type { DocumentSession } from '../app/session';
import { layerContentBounds } from '../rendering/bounds';
import type { Rect } from '../image-engine/rect';

export function opts() {
  return useApp.getState().toolOptions;
}

export function selectionOp(p: ToolPointer, base: SelectionOp): SelectionOp {
  if (p.shift && p.alt) return 'intersect';
  if (p.shift) return 'add';
  if (p.alt) return 'subtract';
  return base;
}

export interface SnapResult {
  x: number;
  y: number;
  guidesX: number[];
  guidesY: number[];
}

/** Candidate snap lines in document px. */
export function snapTargets(s: DocumentSession, excludeIds: Set<string> = new Set()): { xs: number[]; ys: number[] } {
  const v = useApp.getState().view;
  const xs: number[] = [], ys: number[] = [];
  if (!v.snap) return { xs, ys };
  if (v.snapToDocument) { xs.push(0, s.doc.width / 2, s.doc.width); ys.push(0, s.doc.height / 2, s.doc.height); }
  if (v.snapToGuides && v.guides) for (const g of s.doc.guides) (g.orientation === 'vertical' ? xs : ys).push(g.position);
  if (v.snapToLayers) {
    for (const l of s.doc.walk()) {
      if (excludeIds.has(l.id) || !l.visible || l.kind === 'group') continue;
      const b = layerContentBounds(l);
      if (!b) continue;
      xs.push(b.x, b.x + b.w / 2, b.x + b.w);
      ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
  }
  if (v.snapToGrid && v.grid) {
    const sp = s.doc.grid.spacing;
    for (let x = 0; x <= s.doc.width; x += sp) xs.push(x);
    for (let y = 0; y <= s.doc.height; y += sp) ys.push(y);
  }
  return { xs, ys };
}

/** Snaps a point (document px) within `tolerancePx` screen pixels. */
export function snapPoint(h: ToolHost, x: number, y: number, targets = snapTargets(h.session)): SnapResult {
  const tol = 6 / h.session.view.zoom;
  let bx = x, by = y, dx = tol, dy = tol;
  const gx: number[] = [], gy: number[] = [];
  for (const t of targets.xs) if (Math.abs(t - x) < dx) { dx = Math.abs(t - x); bx = t; }
  for (const t of targets.ys) if (Math.abs(t - y) < dy) { dy = Math.abs(t - y); by = t; }
  if (bx !== x) gx.push(bx);
  if (by !== y) gy.push(by);
  return { x: bx, y: by, guidesX: gx, guidesY: gy };
}

/** Snaps a moving rectangle's edges/center to targets; returns the adjusted delta. */
export function snapRectDelta(h: ToolHost, r: Rect, dx: number, dy: number, targets: { xs: number[]; ys: number[] }): { dx: number; dy: number; guidesX: number[]; guidesY: number[] } {
  const tol = 6 / h.session.view.zoom;
  const cands = (a: number, len: number) => [a, a + len / 2, a + len];
  let bestX = { d: tol, adj: 0, line: NaN }, bestY = { d: tol, adj: 0, line: NaN };
  for (const c of cands(r.x + dx, r.w)) for (const t of targets.xs) { const d = Math.abs(t - c); if (d < bestX.d) bestX = { d, adj: t - c, line: t }; }
  for (const c of cands(r.y + dy, r.h)) for (const t of targets.ys) { const d = Math.abs(t - c); if (d < bestY.d) bestY = { d, adj: t - c, line: t }; }
  return { dx: dx + bestX.adj, dy: dy + bestY.adj, guidesX: isNaN(bestX.line) ? [] : [bestX.line], guidesY: isNaN(bestY.line) ? [] : [bestY.line] };
}

/** Draws snap guide lines (screen overlay). */
export function drawSnapLines(h: ToolHost, g: CanvasRenderingContext2D, xs: number[], ys: number[]): void {
  const v = h.session.view;
  const { w, hh } = { w: h.viewportSize().w, hh: h.viewportSize().h };
  g.save();
  g.strokeStyle = '#ff2fa0';
  g.lineWidth = 1;
  for (const x of xs) {
    const a = v.docToScreen(x, 0), b = v.docToScreen(x, h.session.doc.height);
    g.beginPath(); g.moveTo(a.x + 0.5, Math.max(0, Math.min(a.y, b.y) - 2000)); g.lineTo(b.x + 0.5, Math.min(hh, Math.max(a.y, b.y) + 2000)); g.stroke();
  }
  for (const y of ys) {
    const a = v.docToScreen(0, y), b = v.docToScreen(h.session.doc.width, y);
    g.beginPath(); g.moveTo(Math.max(0, Math.min(a.x, b.x) - 2000), a.y + 0.5); g.lineTo(Math.min(w, Math.max(a.x, b.x) + 2000), b.y + 0.5); g.stroke();
  }
  g.restore();
}

export function screenRect(h: ToolHost, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  const a = h.session.view.docToScreen(x0, y0), b = h.session.view.docToScreen(x1, y1);
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)];
}

/** Draws a polyline given in document coordinates. */
export function strokeDocPath(h: ToolHost, g: CanvasRenderingContext2D, pts: { x: number; y: number }[], close: boolean, style: 'ants' | 'solid' = 'ants'): void {
  if (pts.length < 2) return;
  const v = h.session.view;
  g.save();
  g.beginPath();
  pts.forEach((p, i) => {
    const s = v.docToScreen(p.x, p.y);
    if (i) g.lineTo(s.x, s.y);
    else g.moveTo(s.x, s.y);
  });
  if (close) g.closePath();
  g.lineWidth = 1;
  if (style === 'ants') {
    g.strokeStyle = '#000';
    g.stroke();
    g.setLineDash([4, 4]);
    g.lineDashOffset = -((performance.now() / 60) % 8);
    g.strokeStyle = '#fff';
    g.stroke();
  } else {
    g.strokeStyle = '#1e90ff';
    g.stroke();
  }
  g.restore();
}

export function toast(message: string, detail?: string) {
  import('../app/store').then(({ ui }) => ui.toast('info', message, detail, 3500));
}
