/** Crop and Perspective Crop tools. */
import type { Tool, ToolHost, ToolPointer } from './tool';
import { opts, toast } from './helpers';
import { crop, transformDocument } from '../app/ops/imageOps';
import { recordStateChange } from '../history/history';
import { invertH, Quad, rectToQuad, multiplyH, Homography } from '../image-engine/matrix';
import { ui } from '../app/store';
import { hasRaster } from '../document/types';
import { warpLayerRaster } from '../app/ops/imageOps';
import { createPixelLayer } from '../document/layerFactory';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number; // degrees
}

type Drag = { mode: 'new' | 'move' | 'rotate' | 'handle'; handle?: number; start: ToolPointer; box: Box };

function ratio(docW: number, docH: number): number | null {
  const o = opts().crop;
  switch (o.ratio) {
    case '1:1': return 1;
    case '4:3': return 4 / 3;
    case '16:9': return 16 / 9;
    case '3:2': return 3 / 2;
    case 'original': return docW / docH;
    case 'custom': return o.customW / Math.max(1e-6, o.customH);
    default: return null;
  }
}

function corners(b: Box): { x: number; y: number }[] {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const a = (b.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const dx = (u * b.w) / 2, dy = (v * b.h) / 2;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  });
}

export class CropTool implements Tool {
  id = 'crop' as const;
  private box: Box | null = null;
  private drag: Drag | null = null;

  activate(h: ToolHost) {
    const d = h.session.doc;
    this.box = { x: 0, y: 0, w: d.width, h: d.height, angle: 0 };
    h.session.mode = { kind: 'crop' };
    h.redraw();
  }
  deactivate(h: ToolHost) {
    this.box = null;
    if (h.session.mode.kind === 'crop') h.session.mode = { kind: 'none' };
  }
  busy() {
    return !!this.drag;
  }
  cursor(h: ToolHost, p: ToolPointer | null) {
    if (!p || !this.box) return 'crosshair';
    const hit = this.hit(h, p);
    return hit === 'move' ? 'move' : hit === 'rotate' ? 'alias' : typeof hit === 'number' ? 'nwse-resize' : 'crosshair';
  }
  private hit(h: ToolHost, p: ToolPointer): number | 'move' | 'rotate' | null {
    if (!this.box) return null;
    const v = h.session.view;
    const cs = corners(this.box).map((c) => v.docToScreen(c.x, c.y));
    const mids = cs.map((c, i) => ({ x: (c.x + cs[(i + 1) % 4].x) / 2, y: (c.y + cs[(i + 1) % 4].y) / 2 }));
    for (let i = 0; i < 4; i++) if (Math.hypot(cs[i].x - p.sx, cs[i].y - p.sy) < 9) return i;
    for (let i = 0; i < 4; i++) if (Math.hypot(mids[i].x - p.sx, mids[i].y - p.sy) < 9) return 4 + i;
    // Inside?
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) if (cs[i].y > p.sy !== cs[j].y > p.sy && p.sx < ((cs[j].x - cs[i].x) * (p.sy - cs[i].y)) / (cs[j].y - cs[i].y) + cs[i].x) inside = !inside;
    if (inside) return 'move';
    return 'rotate';
  }
  down(h: ToolHost, p: ToolPointer) {
    if (!this.box) this.activate(h);
    const hit = this.hit(h, p);
    const box = { ...this.box! };
    if (hit === 'move') this.drag = { mode: 'move', start: p, box };
    else if (hit === 'rotate') this.drag = { mode: 'rotate', start: p, box };
    else if (typeof hit === 'number') this.drag = { mode: 'handle', handle: hit, start: p, box };
    else this.drag = { mode: 'new', start: p, box };
  }
  move(h: ToolHost, p: ToolPointer) {
    const d = this.drag;
    if (!d || !this.box) return;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const r = ratio(h.session.doc.width, h.session.doc.height);
    if (d.mode === 'move') this.box = { ...d.box, x: d.box.x + dx, y: d.box.y + dy };
    else if (d.mode === 'rotate') {
      const cx = d.box.x + d.box.w / 2, cy = d.box.y + d.box.h / 2;
      const a0 = Math.atan2(d.start.y - cy, d.start.x - cx), a1 = Math.atan2(p.y - cy, p.x - cx);
      let ang = d.box.angle + ((a1 - a0) * 180) / Math.PI;
      if (p.shift) ang = Math.round(ang / 15) * 15;
      this.box = { ...d.box, angle: ang };
    } else if (d.mode === 'new') {
      let w = p.x - d.start.x, hh = p.y - d.start.y;
      if (r) hh = Math.sign(hh || 1) * Math.abs(w) / r;
      this.box = { x: Math.min(d.start.x, d.start.x + w), y: Math.min(d.start.y, d.start.y + hh), w: Math.abs(w), h: Math.abs(hh), angle: 0 };
    } else if (d.mode === 'handle' && d.handle !== undefined) {
      // Handles operate in the box's rotated frame.
      const a = (-d.box.angle * Math.PI) / 180;
      const ldx = dx * Math.cos(a) - dy * Math.sin(a), ldy = dx * Math.sin(a) + dy * Math.cos(a);
      let { x, y, w, h: bh } = d.box;
      const hd = d.handle;
      const left = hd === 0 || hd === 3 || hd === 7, right = hd === 1 || hd === 2 || hd === 5, top = hd === 0 || hd === 1 || hd === 4, bottom = hd === 2 || hd === 3 || hd === 6;
      if (left) { x += ldx; w -= ldx; }
      if (right) w += ldx;
      if (top) { y += ldy; bh -= ldy; }
      if (bottom) bh += ldy;
      if (r || p.shift) {
        const rr = r ?? d.box.w / d.box.h;
        if (hd >= 4 && (hd === 4 || hd === 6)) w = bh * rr;
        else bh = w / rr;
        if (top) y = d.box.y + d.box.h - bh;
      }
      this.box = { x: Math.min(x, x + w), y: Math.min(y, y + bh), w: Math.max(1, Math.abs(w)), h: Math.max(1, Math.abs(bh)), angle: d.box.angle };
    }
    h.redraw();
  }
  up() {
    this.drag = null;
  }
  commit(h: ToolHost) {
    if (!this.box) return;
    const b = this.box;
    const o = opts().crop;
    const size = o.fixedPx && o.ratio === 'custom' ? { w: o.customW, h: o.customH } : null;
    crop({ x: b.x, y: b.y, w: b.w, h: b.h }, o.deletePixels, b.angle);
    if (size && (Math.round(b.w) !== size.w || Math.round(b.h) !== size.h)) {
      import('../app/ops/imageOps').then(({ imageSize }) => imageSize(size.w, size.h, h.session.doc.canvas.resolution, 'bicubic', true));
    }
    const d = h.session.doc;
    this.box = { x: 0, y: 0, w: d.width, h: d.height, angle: 0 };
    h.redraw();
  }
  cancel(h: ToolHost) {
    const d = h.session.doc;
    this.box = { x: 0, y: 0, w: d.width, h: d.height, angle: 0 };
    this.drag = null;
    h.redraw();
  }
  doubleClick(h: ToolHost) {
    this.commit(h);
  }
  keyDown(h: ToolHost, e: KeyboardEvent): boolean {
    if (e.key === 'Enter') { this.commit(h); return true; }
    if (e.key === 'Escape') { this.cancel(h); return true; }
    return false;
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    if (!this.box) return;
    const v = h.session.view;
    const cs = corners(this.box).map((c) => v.docToScreen(c.x, c.y));
    const { w, h: vh } = h.viewportSize();
    g.save();
    // Darken outside.
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.beginPath();
    g.rect(0, 0, w, vh);
    g.moveTo(cs[0].x, cs[0].y);
    for (let i = 3; i >= 0; i--) g.lineTo(cs[i].x, cs[i].y);
    g.closePath();
    g.fill('evenodd');
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.beginPath();
    cs.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y)));
    g.closePath();
    g.stroke();
    const overlay = opts().crop.overlay;
    if (overlay !== 'none') {
      g.strokeStyle = 'rgba(255,255,255,0.45)';
      const n = overlay === 'thirds' ? 3 : 6;
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const a = { x: cs[0].x + (cs[1].x - cs[0].x) * t, y: cs[0].y + (cs[1].y - cs[0].y) * t }, b = { x: cs[3].x + (cs[2].x - cs[3].x) * t, y: cs[3].y + (cs[2].y - cs[3].y) * t };
        const c = { x: cs[0].x + (cs[3].x - cs[0].x) * t, y: cs[0].y + (cs[3].y - cs[0].y) * t }, d = { x: cs[1].x + (cs[2].x - cs[1].x) * t, y: cs[1].y + (cs[2].y - cs[1].y) * t };
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.moveTo(c.x, c.y); g.lineTo(d.x, d.y); g.stroke();
      }
    }
    g.fillStyle = '#fff';
    const mids = cs.map((c, i) => ({ x: (c.x + cs[(i + 1) % 4].x) / 2, y: (c.y + cs[(i + 1) % 4].y) / 2 }));
    for (const c of [...cs, ...mids]) g.fillRect(c.x - 4, c.y - 4, 8, 8);
    g.fillStyle = 'rgba(20,20,24,0.85)';
    g.fillRect(cs[2].x + 8, cs[2].y + 8, 124, 18);
    g.fillStyle = '#eee';
    g.font = '11px system-ui, sans-serif';
    g.fillText(`${Math.round(this.box.w)} × ${Math.round(this.box.h)} px${this.box.angle ? `  ${this.box.angle.toFixed(1)}°` : ''}`, cs[2].x + 12, cs[2].y + 21);
    g.restore();
  }
}

export class PerspectiveCropTool implements Tool {
  id = 'perspectiveCrop' as const;
  private quad: Quad | null = null;
  private dragIdx = -1;
  private newStart: { x: number; y: number } | null = null;
  cursor() {
    return 'crosshair';
  }
  busy() {
    return this.dragIdx >= 0 || !!this.newStart;
  }
  down(h: ToolHost, p: ToolPointer) {
    if (this.quad) {
      const v = h.session.view;
      this.dragIdx = this.quad.findIndex((q) => { const s = v.docToScreen(q.x, q.y); return Math.hypot(s.x - p.sx, s.y - p.sy) < 10; });
      if (this.dragIdx >= 0) return;
    }
    this.newStart = { x: p.x, y: p.y };
    this.quad = [{ x: p.x, y: p.y }, { x: p.x, y: p.y }, { x: p.x, y: p.y }, { x: p.x, y: p.y }];
  }
  move(h: ToolHost, p: ToolPointer) {
    if (this.dragIdx >= 0 && this.quad) this.quad[this.dragIdx] = { x: p.x, y: p.y };
    else if (this.newStart) {
      const a = this.newStart;
      this.quad = [{ x: a.x, y: a.y }, { x: p.x, y: a.y }, { x: p.x, y: p.y }, { x: a.x, y: p.y }];
    }
    h.redraw();
  }
  up() {
    this.dragIdx = -1;
    this.newStart = null;
  }
  commit(h: ToolHost) {
    const q = this.quad;
    if (!q) return;
    const s = h.session;
    const d = s.doc;
    const W = Math.round((Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2);
    const H = Math.round((Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y) + Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y)) / 2);
    if (W < 2 || H < 2) return toast('The perspective crop area is too small.');
    // Mapping old document → new rectangle is the inverse of rect→quad.
    const toNew: Homography = invertH(multiplyH(rectToQuad(W, H, q), [1, 0, 0, 0, 1, 0, 0, 0, 1]));
    const parametric = d.allLayers().filter((l) => l.kind === 'text' || l.kind === 'shape' || l.kind === 'smartObject');
    if (parametric.length) toast(`${parametric.length} text/shape/smart object layer(s) were rasterized by the perspective crop.`);
    recordStateChange(d, s.history, 'Perspective Crop', () => {
      // Perspective cannot be represented parametrically for these layers: rasterize them first.
      for (const l of parametric) {
        if (!hasRaster(l) || !l.parent) continue;
        const px = createPixelLayer(l.name, d.canvas.bitDepth, l.raster);
        Object.assign(px, { x: l.x, y: l.y, opacity: l.opacity, fillOpacity: l.fillOpacity, blendMode: l.blendMode, visible: l.visible, clipping: l.clipping, mask: l.mask, effects: l.effects, locks: l.locks });
        const parent = l.parent;
        parent.children[parent.children.indexOf(l)] = px;
        px.parent = parent;
      }
      for (const l of d.walk()) {
        if (hasRaster(l)) {
          const r = warpLayerRaster(l.raster, l.x, l.y, toNew, 'bicubic', { x: 0, y: 0, w: W, h: H });
          l.raster = r.raster; l.x = r.x; l.y = r.y;
        }
        if (l.mask) {
          const r = warpLayerRaster(l.mask.raster, l.mask.x, l.mask.y, toNew, 'bilinear', { x: 0, y: 0, w: W, h: H });
          l.mask = { ...l.mask, raster: r.raster, x: r.x, y: r.y };
        }
      }
      transformDocument(d, [1, 0, 0, 1, 0, 0], W, H, 'nearest', null);
      d.selection.clear();
    });
    this.quad = null;
    ui.bump('viewRev');
    h.redraw();
  }
  cancel(h: ToolHost) {
    this.quad = null;
    h.redraw();
  }
  keyDown(h: ToolHost, e: KeyboardEvent): boolean {
    if (e.key === 'Enter') { this.commit(h); return true; }
    if (e.key === 'Escape') { this.cancel(h); return true; }
    return false;
  }
  doubleClick(h: ToolHost) {
    this.commit(h);
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    if (!this.quad) return;
    const v = h.session.view;
    const cs = this.quad.map((c) => v.docToScreen(c.x, c.y));
    g.save();
    g.strokeStyle = '#fff';
    g.beginPath();
    cs.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y)));
    g.closePath();
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    for (let i = 1; i < 4; i++) {
      const t = i / 4;
      const lerp = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      const a = lerp(cs[0], cs[1]), b = lerp(cs[3], cs[2]), c = lerp(cs[0], cs[3]), d = lerp(cs[1], cs[2]);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.moveTo(c.x, c.y); g.lineTo(d.x, d.y); g.stroke();
    }
    g.fillStyle = '#fff';
    for (const c of cs) g.fillRect(c.x - 4, c.y - 4, 8, 8);
    g.restore();
  }
}
