/**
 * Slice tool: drag to create a slice; click a slice to select it; drag inside to move it or
 * drag its corners/edges to resize (Shift keeps the drag square when creating). Delete removes
 * the selected slice; double-click edits its options.
 */
import type { Tool, ToolHost, ToolPointer } from './tool';
import { ui } from '../app/store';
import type { SliceDef } from '../document/types';
import type { Rect } from '../image-engine/rect';
import { addSlice, deleteSlice, updateSlice } from '../app/ops/sliceOps';

type Grip = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

let selectedId: string | null = null;

export function selectedSliceId(): string | null {
  return selectedId;
}

export function selectSlice(id: string | null): void {
  selectedId = id;
  ui.bump('viewRev');
}

function normRect(ax: number, ay: number, bx: number, by: number): Rect {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

export class SliceTool implements Tool {
  id = 'slice' as const;
  private drag: { kind: 'new'; start: ToolPointer; cur: ToolPointer } | { kind: 'edit'; slice: SliceDef; grip: Grip; start: ToolPointer; rect: Rect } | null = null;

  busy() {
    return !!this.drag;
  }

  private hit(h: ToolHost, p: ToolPointer): { slice: SliceDef; grip: Grip } | null {
    const v = h.session.view;
    const list = [...h.session.doc.slices].reverse();
    for (const sl of list) {
      const a = v.docToScreen(sl.rect.x, sl.rect.y), b = v.docToScreen(sl.rect.x + sl.rect.w, sl.rect.y + sl.rect.h);
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const near = (u: number, t: number) => Math.abs(u - t) < 6;
      if (sl.id === selectedId) {
        const nx = near(p.sx, x0) ? 'w' : near(p.sx, x1) ? 'e' : '', ny = near(p.sy, y0) ? 'n' : near(p.sy, y1) ? 's' : '';
        const inX = p.sx > x0 - 6 && p.sx < x1 + 6, inY = p.sy > y0 - 6 && p.sy < y1 + 6;
        if ((nx && inY) || (ny && inX)) return { slice: sl, grip: (ny + nx) as Grip };
      }
      if (p.sx >= x0 && p.sx <= x1 && p.sy >= y0 && p.sy <= y1) return { slice: sl, grip: 'move' };
    }
    return null;
  }

  cursor(h: ToolHost, p: ToolPointer | null): string {
    if (!p) return 'crosshair';
    const hit = this.hit(h, p);
    if (!hit) return 'crosshair';
    if (hit.grip === 'move') return hit.slice.id === selectedId ? 'move' : 'pointer';
    return { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' }[hit.grip];
  }

  down(h: ToolHost, p: ToolPointer) {
    const hit = this.hit(h, p);
    if (hit) {
      selectSlice(hit.slice.id);
      this.drag = { kind: 'edit', slice: hit.slice, grip: hit.grip, start: p, rect: { ...hit.slice.rect } };
      return;
    }
    selectSlice(null);
    this.drag = { kind: 'new', start: p, cur: p };
  }

  private liveRect(p: ToolPointer): Rect | null {
    const d = this.drag;
    if (!d) return null;
    if (d.kind === 'new') {
      let ex = p.x, ey = p.y;
      if (p.shift) { const m = Math.max(Math.abs(ex - d.start.x), Math.abs(ey - d.start.y)); ex = d.start.x + Math.sign(ex - d.start.x || 1) * m; ey = d.start.y + Math.sign(ey - d.start.y || 1) * m; }
      const r = normRect(Math.round(d.start.x), Math.round(d.start.y), Math.round(ex), Math.round(ey));
      return r;
    }
    const dx = Math.round(p.x - d.start.x), dy = Math.round(p.y - d.start.y);
    const r = { ...d.rect };
    if (d.grip === 'move') return { ...r, x: r.x + dx, y: r.y + dy };
    let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
    if (d.grip.includes('w')) x0 += dx;
    if (d.grip.includes('e')) x1 += dx;
    if (d.grip.includes('n')) y0 += dy;
    if (d.grip.includes('s')) y1 += dy;
    return normRect(x0, y0, x1, y1);
  }

  move(h: ToolHost, p: ToolPointer) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'new') d.cur = p;
    else (d as { cur?: ToolPointer }).cur = p;
    h.redraw();
  }

  up(h: ToolHost, p: ToolPointer) {
    const d = this.drag;
    const r = this.liveRect(p);
    this.drag = null;
    if (!d || !r) return;
    if (d.kind === 'new') {
      const sl = addSlice(r);
      if (sl) selectSlice(sl.id);
    } else if (r.x !== d.rect.x || r.y !== d.rect.y || r.w !== d.rect.w || r.h !== d.rect.h) {
      if (r.w >= 2 && r.h >= 2) updateSlice(d.slice.id, { rect: r }, d.grip === 'move' ? 'Move Slice' : 'Resize Slice');
    }
    h.redraw();
  }

  doubleClick(h: ToolHost, p: ToolPointer) {
    const hit = this.hit(h, p);
    if (hit) ui.openDialog('sliceOptions', { id: hit.slice.id });
  }

  keyDown(_h: ToolHost, e: KeyboardEvent): boolean {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      deleteSlice(selectedId);
      selectSlice(null);
      return true;
    }
    return false;
  }

  cancel() {
    this.drag = null;
  }

  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    const v = h.session.view;
    const d = this.drag;
    const cur = d ? (d as { cur?: ToolPointer }).cur : undefined;
    const live = d && cur ? this.liveRect(cur) : null;
    g.save();
    g.font = '10px system-ui, sans-serif';
    h.session.doc.slices.forEach((sl, i) => {
      const r = live && d?.kind === 'edit' && d.slice.id === sl.id ? live : sl.rect;
      drawSlice(g, v, r, String(i + 1).padStart(2, '0'), sl.id === selectedId);
    });
    if (live && d?.kind === 'new') drawSlice(g, v, live, String(h.session.doc.slices.length + 1).padStart(2, '0'), true);
    g.restore();
  }
}

function drawSlice(g: CanvasRenderingContext2D, v: { docToScreen(x: number, y: number): { x: number; y: number } }, r: Rect, label: string, selected: boolean) {
  const a = v.docToScreen(r.x, r.y), b = v.docToScreen(r.x + r.w, r.y + r.h);
  const x = Math.round(Math.min(a.x, b.x)) + 0.5, y = Math.round(Math.min(a.y, b.y)) + 0.5, w = Math.abs(b.x - a.x), hh = Math.abs(b.y - a.y);
  g.strokeStyle = selected ? '#ffb000' : '#3d8bfd';
  g.lineWidth = 1;
  g.strokeRect(x, y, w, hh);
  g.fillStyle = selected ? '#ffb000' : '#3d8bfd';
  const tw = g.measureText(label).width + 8;
  g.fillRect(x, y, tw, 14);
  g.fillStyle = '#fff';
  g.fillText(label, x + 4, y + 10.5);
  if (selected) {
    g.fillStyle = '#fff';
    for (const [px, py] of [[x, y], [x + w, y], [x, y + hh], [x + w, y + hh], [x + w / 2, y], [x + w / 2, y + hh], [x, y + hh / 2], [x + w, y + hh / 2]]) {
      g.fillRect(px - 3, py - 3, 6, 6);
      g.strokeRect(px - 3, py - 3, 6, 6);
    }
  }
}
