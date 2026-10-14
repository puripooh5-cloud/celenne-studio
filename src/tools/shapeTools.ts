/** Rectangle, Ellipse, Polygon, Line and Custom Shape tools. */
import { editColor } from '../color/plates';
import type { Tool, ToolHost, ToolPointer } from './tool';
import { opts, toast, strokeDocPath } from './helpers';
import { ui, useApp } from '../app/store';
import { createShapeLayer } from '../document/layerFactory';
import { CreateLayerCommand, LambdaCommand } from '../commands/layerCommands';
import { renderShapeLayer } from '../layers/appearance';
import { customShapePath, ellipsePath, linePath, polygonPath, rectPath } from '../vector/shapes';
import type { ShapeOrigin, VectorPath } from '../vector/types';
import { clonePath } from '../vector/types';
import { insertionPoint, nextLayerName } from '../app/ops/common';
import { editRaster } from '../commands/rasterCommands';
import { pathBounds, rasterizePath } from '../vector/rasterize';
import { intersect, isEmpty } from '../image-engine/rect';
import { blendStraightPixel } from '../image-engine/blend';
import { newId } from '../document/ids';
import type { DocumentSession } from '../app/session';
import { flattenSubPath } from '../vector/rasterize';

type ShapeId = 'rectangle' | 'ellipse' | 'polygon' | 'line' | 'customShape';

export function setWorkPath(s: DocumentSession, path: VectorPath, label: string): void {
  const before = s.doc.paths.find((p) => p.kind === 'work');
  const prev = before ? clonePath(before.path) : null;
  const id = before?.id ?? newId('path');
  s.push(new LambdaCommand(label, (d) => {
    const w = d.paths.find((p) => p.kind === 'work');
    if (w) w.path = clonePath(path);
    else d.paths.unshift({ id, name: 'Work Path', kind: 'work', path: clonePath(path) });
    d.emit({ type: 'paths' });
  }, (d) => {
    const w = d.paths.find((p) => p.kind === 'work');
    if (prev && w) w.path = clonePath(prev);
    else d.paths = d.paths.filter((p) => p.id !== id);
    d.emit({ type: 'paths' });
  }));
  s.activePathId = id;
}

export class ShapeTool implements Tool {
  private start: ToolPointer | null = null;
  private cur: ToolPointer | null = null;
  constructor(readonly id: ShapeId) {}
  cursor() {
    return 'crosshair';
  }
  busy() {
    return !!this.start;
  }
  private geometry(): { path: VectorPath; origin: ShapeOrigin } | null {
    const a = this.start, b = this.cur;
    if (!a || !b) return null;
    const o = opts().shape;
    let x0 = a.x, y0 = a.y, w = b.x - a.x, h = b.y - a.y;
    if (this.id === 'line') {
      let x1 = b.x, y1 = b.y;
      if (b.shift) {
        const ang = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(x1 - x0, y1 - y0);
        x1 = x0 + Math.cos(ang) * len;
        y1 = y0 + Math.sin(ang) * len;
      }
      return { path: linePath(x0, y0, x1, y1, o.lineWeight), origin: { kind: 'line', x: x0, y: y0, w: x1 - x0, h: y1 - y0, lineWidth: o.lineWeight } };
    }
    if (b.shift) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
    if (b.alt) { x0 -= w; y0 -= h; w *= 2; h *= 2; }
    const x = Math.min(x0, x0 + w), y = Math.min(y0, y0 + h), W = Math.abs(w), H = Math.abs(h);
    switch (this.id) {
      case 'rectangle': {
        const r = o.radius;
        const radii: [number, number, number, number] = [r, r, r, r];
        return { path: rectPath(x, y, W, H, radii), origin: { kind: r > 0 ? 'roundedRectangle' : 'rectangle', x, y, w: W, h: H, radii } };
      }
      case 'ellipse':
        return { path: ellipsePath(x, y, W, H), origin: { kind: 'ellipse', x, y, w: W, h: H } };
      case 'polygon':
        return { path: polygonPath(x + W / 2, y + H / 2, Math.min(W, H) / 2, o.sides, o.star ? o.starRatio : null), origin: { kind: o.star ? 'star' : 'polygon', x, y, w: W, h: H, sides: o.sides, starRatio: o.starRatio } };
      default:
        return { path: customShapePath(o.customShape, x, y, W, H), origin: { kind: 'custom', x, y, w: W, h: H } };
    }
  }
  down(_h: ToolHost, p: ToolPointer) {
    this.start = p;
    this.cur = p;
  }
  move(h: ToolHost, p: ToolPointer) {
    if (!this.start) return;
    this.cur = p;
    h.redraw();
  }
  up(h: ToolHost, p: ToolPointer) {
    this.cur = p;
    const g = this.geometry();
    const moved = this.start && Math.hypot(p.sx - this.start.sx, p.sy - this.start.sy) > 3;
    this.start = this.cur = null;
    h.redraw();
    if (!g || !moved) return;
    const s = h.session;
    const o = opts().shape;
    const { fg, bg } = useApp.getState();
    if (o.mode === 'path') {
      setWorkPath(s, g.path, 'New Work Path');
      return;
    }
    if (o.mode === 'pixels') {
      const l = s.activeLayer();
      if (!l || l.kind !== 'pixel') return toast('Pixel mode draws on a pixel layer — select one first.');
      const pb = pathBounds(g.path);
      if (!pb) return;
      const r = intersect(pb, { x: -1e6, y: -1e6, w: 2e6, h: 2e6 });
      const cmd = editRaster(s.doc, { kind: 'layer', layerId: l.id }, 'Shape (Pixels)', (raster, ox, oy, plate) => {
        if (isEmpty(r)) return null;
        const cov = rasterizePath(g.path, r);
        const lr = { x: r.x - ox, y: r.y - oy, w: r.w, h: r.h };
        const cur = raster.readFloat(lr);
        const c = editColor(s.doc, fg, plate);
        for (let i = 0; i < cov.length; i++) if (cov[i] > 0) blendStraightPixel('normal', cur, i * 4, c.r, c.g, c.b, cov[i], l.locks.transparency);
        raster.writeFloat(lr, cur);
        return r;
      });
      if (cmd) s.push(cmd, true);
      return;
    }
    const names: Record<ShapeId, string> = { rectangle: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', line: 'Line', customShape: 'Shape' };
    const layer = createShapeLayer(nextLayerName(s, names[this.id]), g.path, g.origin, s.doc.canvas.bitDepth);
    layer.fill = { type: 'solid', color: { ...fg } };
    if (o.strokeWidth > 0) layer.stroke = { ...layer.stroke, enabled: true, width: o.strokeWidth, paint: { type: 'solid', color: { ...bg } } };
    renderShapeLayer(s.doc, layer);
    const { parentId, index } = insertionPoint(s);
    s.push(new CreateLayerCommand(`${names[this.id]} Tool`, layer, parentId, index, { action: 'shape.create', args: { name: layer.name, path: structuredClone(layer.path), origin: layer.origin ? structuredClone(layer.origin) : null, fill: structuredClone(layer.fill), stroke: structuredClone(layer.stroke) } }));
    s.setActive(layer.id);
    ui.bump('docRev');
  }
  cancel(h: ToolHost) {
    this.start = this.cur = null;
    h.redraw();
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    const geo = this.geometry();
    if (!geo) return;
    for (const sp of geo.path.subpaths) {
      const poly = flattenSubPath(sp, 1, 0.5);
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < poly.length; i += 2) pts.push({ x: poly[i], y: poly[i + 1] });
      strokeDocPath(h, g, pts, sp.closed, 'solid');
    }
  }
}
