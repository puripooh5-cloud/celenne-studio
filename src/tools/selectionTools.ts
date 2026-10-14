/** Selection tools. Each produces a coverage raster combined with the selection (undoable). */
import type { Tool, ToolHost, ToolPointer } from './tool';
import { opts, selectionOp, strokeDocPath, screenRect, toast } from './helpers';
import { changeSelection } from '../app/ops/selectOps';
import { TiledRaster } from '../image-engine/tiledRaster';
import type { Rect } from '../image-engine/rect';
import { intersect, isEmpty, roundOut, expand } from '../image-engine/rect';
import { rasterizeLasso, rasterizePolygons } from '../vector/rasterize';
import { combineRaster, feather, floodRegion, LazyImage } from '../selection/ops';
import { Selection } from '../selection/selection';
import type { SelectionOp } from '../selection/selection';
import { samplingImage } from '../app/ops/common';
import { aiProvider } from '../ai/provider';
import { ui } from '../app/store';

function commitCoverage(h: ToolHost, r: Rect, cov: Float32Array, op: SelectionOp, label: string): void {
  const s = h.session;
  const clip = intersect(r, s.doc.bounds);
  const m = new TiledRaster(1, 8, 0);
  if (!isEmpty(clip)) {
    if (clip.w === r.w && clip.h === r.h) m.writeFloat(r, cov);
    else {
      const sub = new Float32Array(clip.w * clip.h);
      for (let y = 0; y < clip.h; y++) sub.set(cov.subarray((y + clip.y - r.y) * r.w + (clip.x - r.x), (y + clip.y - r.y) * r.w + (clip.x - r.x) + clip.w), y * clip.w);
      m.writeFloat(clip, sub);
    }
  }
  const f = opts().selection.feather;
  changeSelection(s, label, () => {
    if (f > 0) {
      // Feather the new shape only.
      const tmp = new Selection();
      combineRaster(tmp, m, 'replace', s.doc.bounds);
      feather(tmp, s.doc.bounds, f);
      combineRaster(s.doc.selection, tmp.mask, op, s.doc.bounds);
    } else combineRaster(s.doc.selection, m, op, s.doc.bounds);
  });
}

function ellipsePolygon(x: number, y: number, w: number, h: number): number[] {
  const n = Math.max(32, Math.min(720, Math.round((w + h) * 0.8)));
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(x + w / 2 + (Math.cos(a) * w) / 2, y + h / 2 + (Math.sin(a) * h) / 2);
  }
  return pts;
}

// ---------------------------------------------------------------------------------------------
// Marquee
// ---------------------------------------------------------------------------------------------
export class MarqueeTool implements Tool {
  private start: ToolPointer | null = null;
  private cur: { x: number; y: number } | null = null;
  constructor(readonly id: 'marqueeRect' | 'marqueeEllipse' | 'marqueeRow' | 'marqueeColumn') {}
  cursor() {
    return 'crosshair';
  }
  busy() {
    return !!this.start;
  }
  private rect(p: ToolPointer | null): Rect | null {
    if (!this.start || !this.cur) return null;
    const o = opts().selection;
    let x0 = this.start.x, y0 = this.start.y;
    let w = this.cur.x - x0, h = this.cur.y - y0;
    if (o.style === 'fixedSize') { w = Math.sign(w || 1) * o.fixedW; h = Math.sign(h || 1) * o.fixedH; }
    else if (o.style === 'fixedRatio') h = Math.sign(h || 1) * Math.abs(w) * (o.ratioH / o.ratioW);
    if (p?.shift && !this.start.shift && o.style === 'normal') { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
    if (p?.alt && !this.start.alt) { x0 -= w; y0 -= h; w *= 2; h *= 2; }
    const antialias = this.id === 'marqueeEllipse';
    const r = antialias ? { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), w: Math.abs(w), h: Math.abs(h) } : roundOut(Math.round(Math.min(x0, x0 + w)), Math.round(Math.min(y0, y0 + h)), Math.round(Math.max(x0, x0 + w)), Math.round(Math.max(y0, y0 + h)));
    return r;
  }
  down(h: ToolHost, p: ToolPointer) {
    if (this.id === 'marqueeRow' || this.id === 'marqueeColumn') {
      const r = this.id === 'marqueeRow' ? { x: 0, y: Math.floor(p.y), w: h.session.doc.width, h: 1 } : { x: Math.floor(p.x), y: 0, w: 1, h: h.session.doc.height };
      commitCoverage(h, r, new Float32Array(r.w * r.h).fill(1), selectionOp(p, opts().selection.op), this.id === 'marqueeRow' ? 'Single Row Marquee' : 'Single Column Marquee');
      return;
    }
    this.start = p;
    this.cur = { x: p.x, y: p.y };
  }
  move(h: ToolHost, p: ToolPointer) {
    if (!this.start) return;
    this.cur = { x: p.x, y: p.y };
    h.redraw();
  }
  up(h: ToolHost, p: ToolPointer) {
    if (!this.start) return;
    const r = this.rect(p);
    const op = selectionOp(this.start, opts().selection.op);
    const moved = Math.hypot(p.sx - this.start.sx, p.sy - this.start.sy) > 2;
    this.start = null;
    this.cur = null;
    h.redraw();
    if (!moved || !r || r.w < 0.5 || r.h < 0.5) {
      // A click without dragging deselects (replace mode).
      if (op === 'replace' && !h.session.doc.selection.isEmpty()) changeSelection(h.session, 'Deselect', () => h.session.doc.selection.clear());
      return;
    }
    const area = roundOut(r.x, r.y, r.x + r.w, r.y + r.h);
    let cov: Float32Array;
    if (this.id === 'marqueeEllipse') {
      cov = rasterizePolygons([ellipsePolygon(r.x, r.y, r.w, r.h)], area);
      if (!opts().selection.antiAlias) for (let i = 0; i < cov.length; i++) cov[i] = cov[i] >= 0.5 ? 1 : 0;
    } else cov = new Float32Array(area.w * area.h).fill(1);
    commitCoverage(h, area, cov, op, this.id === 'marqueeEllipse' ? 'Elliptical Marquee' : 'Rectangular Marquee');
  }
  cancel(h: ToolHost) {
    this.start = null;
    this.cur = null;
    h.redraw();
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    const r = this.rect(null);
    if (!r) return;
    if (this.id === 'marqueeEllipse') {
      const pts: { x: number; y: number }[] = [];
      const poly = ellipsePolygon(r.x, r.y, r.w, r.h);
      for (let i = 0; i < poly.length; i += 2) pts.push({ x: poly[i], y: poly[i + 1] });
      strokeDocPath(h, g, pts, true);
    } else strokeDocPath(h, g, [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }], true);
    const [sx, sy] = screenRect(h, r.x, r.y, r.x + r.w, r.y + r.h);
    g.save();
    g.fillStyle = 'rgba(20,20,24,0.8)';
    g.fillRect(sx + 4, sy - 22, 110, 18);
    g.fillStyle = '#ddd';
    g.font = '11px system-ui, sans-serif';
    g.fillText(`W: ${Math.round(r.w)}  H: ${Math.round(r.h)} px`, sx + 8, sy - 9);
    g.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// Lasso family
// ---------------------------------------------------------------------------------------------
export class LassoTool implements Tool {
  id = 'lasso' as const;
  private pts: { x: number; y: number }[] = [];
  private startP: ToolPointer | null = null;
  cursor() {
    return 'crosshair';
  }
  busy() {
    return !!this.startP;
  }
  down(_h: ToolHost, p: ToolPointer) {
    this.startP = p;
    this.pts = [{ x: p.x, y: p.y }];
  }
  move(h: ToolHost, p: ToolPointer) {
    if (!this.startP) return;
    const last = this.pts[this.pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) * h.session.view.zoom > 1.5) this.pts.push({ x: p.x, y: p.y });
    h.redraw();
  }
  up(h: ToolHost) {
    const sp = this.startP;
    this.startP = null;
    const pts = this.pts;
    this.pts = [];
    h.redraw();
    if (!sp || pts.length < 3) {
      if (sp && selectionOp(sp, opts().selection.op) === 'replace') changeSelection(h.session, 'Deselect', () => h.session.doc.selection.clear());
      return;
    }
    finishPolygon(h, pts, selectionOp(sp, opts().selection.op), 'Lasso');
  }
  cancel(h: ToolHost) {
    this.startP = null;
    this.pts = [];
    h.redraw();
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    if (this.pts.length > 1) strokeDocPath(h, g, this.pts, false);
  }
}

function finishPolygon(h: ToolHost, pts: { x: number; y: number }[], op: SelectionOp, label: string) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const r = roundOut(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
  if (r.w < 1 || r.h < 1) return;
  const cov = rasterizeLasso(pts, r, opts().selection.antiAlias);
  commitCoverage(h, r, cov, op, label);
}

export class PolyLassoTool implements Tool {
  private pts: { x: number; y: number }[] = [];
  private hoverPt: { x: number; y: number } | null = null;
  private op: SelectionOp = 'replace';
  private lastEdgeCheck = 0;
  constructor(readonly id: 'polyLasso' | 'magneticLasso' = 'polyLasso') {}
  cursor() {
    return 'crosshair';
  }
  busy() {
    return this.pts.length > 0;
  }
  private edgeImage: LazyImage | null = null;

  down(h: ToolHost, p: ToolPointer) {
    if (!this.pts.length) {
      this.op = selectionOp(p, opts().selection.op);
      this.edgeImage = this.id === 'magneticLasso' ? samplingImage(h.session, true) : null;
    }
    let pt = { x: p.x, y: p.y };
    if (p.shift && this.pts.length) pt = constrain45(this.pts[this.pts.length - 1], pt);
    if (this.pts.length > 2) {
      const f = h.session.view.docToScreen(this.pts[0].x, this.pts[0].y);
      if (Math.hypot(f.x - p.sx, f.y - p.sy) < 8) return this.commit(h);
    }
    this.pts.push(this.id === 'magneticLasso' ? this.snapEdge(pt) : pt);
    h.redraw();
  }
  hover(h: ToolHost, p: ToolPointer) {
    if (!this.pts.length) return;
    let pt = { x: p.x, y: p.y };
    if (p.shift) pt = constrain45(this.pts[this.pts.length - 1], pt);
    this.hoverPt = pt;
    if (this.id === 'magneticLasso') {
      const last = this.pts[this.pts.length - 1];
      const spacing = Math.max(4, 120 - opts().selection.frequency) / 2;
      const now = performance.now();
      if (Math.hypot(pt.x - last.x, pt.y - last.y) > spacing && now - this.lastEdgeCheck > 8) {
        this.lastEdgeCheck = now;
        this.pts.push(this.snapEdge(pt));
      }
    }
    h.redraw();
  }
  move(h: ToolHost, p: ToolPointer) {
    this.hover(h, p);
  }
  doubleClick(h: ToolHost) {
    this.commit(h);
  }
  keyDown(h: ToolHost, e: KeyboardEvent): boolean {
    if (!this.pts.length) return false;
    if (e.key === 'Enter') { this.commit(h); return true; }
    if (e.key === 'Escape') { this.cancel(h); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { this.pts.pop(); h.redraw(); return true; }
    return false;
  }
  commit(h: ToolHost) {
    const pts = this.pts;
    this.pts = [];
    this.hoverPt = null;
    h.redraw();
    if (pts.length >= 3) finishPolygon(h, pts, this.op, this.id === 'magneticLasso' ? 'Magnetic Lasso' : 'Polygonal Lasso');
  }
  cancel(h: ToolHost) {
    this.pts = [];
    this.hoverPt = null;
    h.redraw();
  }
  /** Moves a point to the strongest edge within the detection width. */
  private snapEdge(pt: { x: number; y: number }): { x: number; y: number } {
    const img = this.edgeImage;
    if (!img) return pt;
    const w = Math.max(1, Math.round(opts().selection.width));
    const contrast = opts().selection.contrast / 100;
    const px = new Float32Array(4);
    const lum = (x: number, y: number) => (img.get(x, y, px) ? 0.3 * px[0] + 0.59 * px[1] + 0.11 * px[2] : 0);
    let best = pt, bestG = contrast * 0.25;
    for (let dy = -w; dy <= w; dy++)
      for (let dx = -w; dx <= w; dx++) {
        if (dx * dx + dy * dy > w * w) continue;
        const x = Math.round(pt.x) + dx, y = Math.round(pt.y) + dy;
        const gx = lum(x + 1, y) - lum(x - 1, y), gy = lum(x, y + 1) - lum(x, y - 1);
        const gm = Math.hypot(gx, gy) - Math.hypot(dx, dy) * 0.002;
        if (gm > bestG) { bestG = gm; best = { x: x + 0.5, y: y + 0.5 }; }
      }
    return best;
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    if (!this.pts.length) return;
    strokeDocPath(h, g, this.hoverPt ? [...this.pts, this.hoverPt] : this.pts, false);
    const v = h.session.view;
    g.save();
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    for (const p of this.pts) {
      const s = v.docToScreen(p.x, p.y);
      g.fillRect(s.x - 2, s.y - 2, 4, 4);
      g.strokeRect(s.x - 2, s.y - 2, 4, 4);
    }
    g.restore();
  }
}

function constrain45(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

// ---------------------------------------------------------------------------------------------
// Magic wand / quick selection / object selection
// ---------------------------------------------------------------------------------------------
export class MagicWandTool implements Tool {
  id = 'magicWand' as const;
  cursor() {
    return 'crosshair';
  }
  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    if (p.x < 0 || p.y < 0 || p.x >= s.doc.width || p.y >= s.doc.height) return;
    const o = opts().selection;
    const img = samplingImage(s, o.sampleAllLayers);
    const m = floodRegion(img, p.x, p.y, o.tolerance, o.contiguous, o.antiAlias);
    const op = selectionOp(p, o.op);
    changeSelection(s, 'Magic Wand', () => combineRaster(s.doc.selection, m, op, s.doc.bounds));
  }
}

export class QuickSelectTool implements Tool {
  id = 'quickSelect' as const;
  private active = false;
  private op: SelectionOp = 'add';
  private img: LazyImage | null = null;
  private acc: TiledRaster | null = null;
  private samples: number[][] = [];
  private lastScreen: { x: number; y: number } | null = null;
  private before: import('../image-engine/tiledRaster').RasterSnapshot | null = null;
  cursor(h: ToolHost) {
    void h;
    return 'crosshair';
  }
  busy() {
    return this.active;
  }
  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    this.active = true;
    this.op = p.alt ? 'subtract' : s.doc.selection.isEmpty() && !p.shift ? 'replace' : 'add';
    this.img = samplingImage(s, opts().selection.sampleAllLayers);
    this.acc = new TiledRaster(1, 8, 0);
    this.samples = [];
    this.before = s.doc.selection.snapshot();
    this.grow(h, p);
  }
  move(h: ToolHost, p: ToolPointer) {
    if (!this.active) return;
    if (this.lastScreen && Math.hypot(p.sx - this.lastScreen.x, p.sy - this.lastScreen.y) < 3) return;
    this.grow(h, p);
  }
  private grow(h: ToolHost, p: ToolPointer) {
    this.lastScreen = { x: p.sx, y: p.sy };
    const img = this.img!;
    const r = opts().selection.brushSize / 2;
    const px = new Float32Array(4);
    // Sample colors under the brush.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2, rr = (i % 2 ? 0.5 : 0.1) * r;
      if (img.get(Math.round(p.x + Math.cos(a) * rr), Math.round(p.y + Math.sin(a) * rr), px)) this.samples.push([px[0], px[1], px[2]]);
    }
    if (this.samples.length > 400) this.samples.splice(0, this.samples.length - 400);
    // Region grow within a local window, stopping at colors far from the samples.
    const win = intersect(expand({ x: Math.floor(p.x), y: Math.floor(p.y), w: 1, h: 1 }, Math.ceil(r * 3)), h.session.doc.bounds);
    if (isEmpty(win)) return;
    const reg = img.region(win);
    const tol = 0.1 + opts().selection.tolerance / 600;
    const close = (i: number) => {
      const c = [reg[i * 4], reg[i * 4 + 1], reg[i * 4 + 2]];
      let best = Infinity;
      for (const s of this.samples) best = Math.min(best, Math.abs(c[0] - s[0]) + Math.abs(c[1] - s[1]) + Math.abs(c[2] - s[2]));
      return best < tol * 3;
    };
    const cov = this.acc!.readFloat(win);
    const seen = new Uint8Array(win.w * win.h);
    const stack: number[] = [];
    for (let dy = -Math.ceil(r); dy <= r; dy++) for (let dx = -Math.ceil(r); dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = Math.floor(p.x) + dx - win.x, y = Math.floor(p.y) + dy - win.y;
      if (x >= 0 && y >= 0 && x < win.w && y < win.h) stack.push(y * win.w + x);
    }
    while (stack.length) {
      const i = stack.pop()!;
      if (seen[i]) continue;
      seen[i] = 1;
      if (!close(i)) continue;
      cov[i] = 1;
      const x = i % win.w, y = Math.floor(i / win.w);
      if (x > 0) stack.push(i - 1);
      if (x < win.w - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - win.w);
      if (y < win.h - 1) stack.push(i + win.w);
    }
    this.acc!.writeFloat(win, cov);
    // Live update of the selection.
    const s = h.session;
    s.doc.selection.restore(this.before!);
    combineRaster(s.doc.selection, this.acc!, this.op, s.doc.bounds);
    s.doc.emit({ type: 'selection' });
    h.redraw();
  }
  up(h: ToolHost) {
    if (!this.active) return;
    this.active = false;
    const s = h.session;
    const after = s.doc.selection.snapshot();
    s.doc.selection.restore(this.before!);
    changeSelection(s, 'Quick Selection', () => s.doc.selection.restore(after));
    this.acc = null;
  }
  cancel(h: ToolHost) {
    if (this.active && this.before) {
      h.session.doc.selection.restore(this.before);
      h.session.doc.emit({ type: 'selection' });
    }
    this.active = false;
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    void h;
    void g;
  }
}

export class ObjectSelectTool implements Tool {
  id = 'objectSelect' as const;
  private start: ToolPointer | null = null;
  private cur: { x: number; y: number } | null = null;
  cursor() {
    return 'crosshair';
  }
  busy() {
    return !!this.start;
  }
  down(_h: ToolHost, p: ToolPointer) {
    this.start = p;
    this.cur = { x: p.x, y: p.y };
  }
  move(h: ToolHost, p: ToolPointer) {
    if (!this.start) return;
    this.cur = { x: p.x, y: p.y };
    h.redraw();
  }
  async up(h: ToolHost) {
    const st = this.start, c = this.cur;
    this.start = null;
    this.cur = null;
    h.redraw();
    if (!st || !c) return;
    const r = roundOut(Math.min(st.x, c.x), Math.min(st.y, c.y), Math.max(st.x, c.x), Math.max(st.y, c.y));
    if (r.w < 4 || r.h < 4) {
      toast('Drag a rectangle around the object to select it.');
      return;
    }
    const s = h.session;
    const p = ui.progress('Selecting object…');
    try {
      const m = await aiProvider().selectSubject(s, r);
      changeSelection(s, 'Object Selection', () => combineRaster(s.doc.selection, m, selectionOp(st, opts().selection.op), s.doc.bounds));
    } finally {
      p.done();
    }
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    if (!this.start || !this.cur) return;
    strokeDocPath(h, g, [{ x: this.start.x, y: this.start.y }, { x: this.cur.x, y: this.start.y }, { x: this.cur.x, y: this.cur.y }, { x: this.start.x, y: this.cur.y }], true);
  }
}
