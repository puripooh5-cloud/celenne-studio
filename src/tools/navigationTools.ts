/** Hand, Zoom and Rotate View tools. */
import type { Tool, ToolHost, ToolPointer } from './tool';
import { ui, useApp } from '../app/store';
import { editor } from '../app/editor';

function bumpView(h: ToolHost) {
  editor.updateTitle();
  ui.bump('viewRev');
  h.redraw();
}

export class HandTool implements Tool {
  id = 'hand' as const;
  private last: { x: number; y: number } | null = null;
  cursor() {
    return this.last ? 'grabbing' : 'grab';
  }
  down(_h: ToolHost, p: ToolPointer) {
    this.last = { x: p.sx, y: p.sy };
  }
  move(h: ToolHost, p: ToolPointer) {
    if (!this.last) return;
    h.session.view.panX += p.sx - this.last.x;
    h.session.view.panY += p.sy - this.last.y;
    this.last = { x: p.sx, y: p.sy };
    bumpView(h);
  }
  up() {
    this.last = null;
  }
  doubleClick(h: ToolHost) {
    const { w, h: vh } = h.viewportSize();
    h.session.view.fit(h.session.doc.width, h.session.doc.height, w, vh);
    bumpView(h);
  }
  cancel() {
    this.last = null;
  }
  busy() {
    return !!this.last;
  }
}

export class ZoomTool implements Tool {
  id = 'zoom' as const;
  private start: { sx: number; sy: number; zoom: number; alt: boolean } | null = null;
  private moved = false;
  cursor(_h: ToolHost, p: ToolPointer | null) {
    return p?.alt ? 'zoom-out' : 'zoom-in';
  }
  down(h: ToolHost, p: ToolPointer) {
    this.start = { sx: p.sx, sy: p.sy, zoom: h.session.view.zoom, alt: p.alt };
    this.moved = false;
  }
  move(h: ToolHost, p: ToolPointer) {
    if (!this.start) return;
    const dx = p.sx - this.start.sx;
    if (Math.abs(dx) > 3) this.moved = true;
    if (this.moved && useApp.getState().toolOptions.zoom.scrubby) {
      const z = this.start.zoom * Math.pow(2, dx / 150);
      h.session.view.zoomAt(this.start.sx, this.start.sy, z);
      bumpView(h);
    }
  }
  up(h: ToolHost, p: ToolPointer) {
    if (this.start && !this.moved) {
      h.session.view.zoomStep(p.sx, p.sy, p.alt ? -1 : 1);
      bumpView(h);
    }
    this.start = null;
  }
  doubleClick(h: ToolHost) {
    const { w, h: vh } = h.viewportSize();
    h.session.view.setZoomCentered(1, w, vh);
    bumpView(h);
  }
  busy() {
    return !!this.start;
  }
}

export class RotateViewTool implements Tool {
  id = 'rotateView' as const;
  private start: { a: number; rot: number } | null = null;
  cursor() {
    return 'crosshair';
  }
  private angle(h: ToolHost, p: ToolPointer) {
    const { w, h: vh } = h.viewportSize();
    return Math.atan2(p.sy - vh / 2, p.sx - w / 2);
  }
  down(h: ToolHost, p: ToolPointer) {
    this.start = { a: this.angle(h, p), rot: h.session.view.rotation };
  }
  move(h: ToolHost, p: ToolPointer) {
    if (!this.start) return;
    let r = this.start.rot + this.angle(h, p) - this.start.a;
    if (p.shift) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
    const { w, h: vh } = h.viewportSize();
    h.session.view.rotateAround(w / 2, vh / 2, r);
    bumpView(h);
  }
  up() {
    this.start = null;
  }
  doubleClick(h: ToolHost) {
    const { w, h: vh } = h.viewportSize();
    h.session.view.rotateAround(w / 2, vh / 2, 0);
    bumpView(h);
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    if (!this.start) return;
    const { w, h: vh } = h.viewportSize();
    g.save();
    g.translate(w / 2, vh / 2);
    g.rotate(h.session.view.rotation);
    g.strokeStyle = '#ff4040';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -60); g.lineTo(0, 60); g.stroke();
    g.strokeStyle = '#fff';
    g.beginPath(); g.moveTo(-60, 0); g.lineTo(60, 0); g.stroke();
    g.restore();
  }
  busy() {
    return !!this.start;
  }
}
