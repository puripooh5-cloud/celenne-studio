/**
 * Move tool: moves selected layers (snapping to guides, document and layer edges), auto-selects
 * layers under the cursor, Alt-drag duplicates, and moves selected pixels as a floating selection.
 */
import type { Tool, ToolHost, ToolPointer } from './tool';
import { drawSnapLines, opts, snapRectDelta, snapTargets, toast } from './helpers';
import { translateLayerDeep, TranslateLayersCommand, CompositeCommand, CreateLayerCommand } from '../commands/layerCommands';
import type { Layer } from '../document/types';
import { hasRaster } from '../document/types';
import { layerContentBounds, layerVisualBounds } from '../rendering/bounds';
import { Rect, union, expand, intersect, isEmpty } from '../image-engine/rect';
import { RasterEditCommand } from '../commands/rasterCommands';
import type { RasterSnapshot } from '../image-engine/tiledRaster';
import { TiledRaster, TILE_SIZE, tileRange } from '../image-engine/tiledRaster';
import { maxValue, type PixelArray } from '../image-engine/pixels';
import { cloneLayer } from '../document/clone';
import { beginTransform } from './transformTool';
import { ui } from '../app/store';
import { editor } from '../app/editor';

interface LayerDrag {
  kind: 'layers';
  ids: string[];
  /** Lift state: 'pending' until the first movement decides whether to lift. */
  lift: 'pending' | 'on' | 'off';
  start: { x: number; y: number };
  applied: { dx: number; dy: number };
  bounds: Rect | null;
  targets: { xs: number[]; ys: number[] };
  guides: { xs: number[]; ys: number[] };
}

interface FloatDrag {
  kind: 'float';
  layerId: string;
  start: { x: number; y: number };
  /** The layer and selection before this drag (its undo step). */
  before: RasterSnapshot;
  selBefore: RasterSnapshot;
  /** The float: the lifted pixels, their selection coverage, and the layer without them. */
  float: FloatPixels;
  floatCov: Float32Array;
  cutState: RasterSnapshot;
  /** Where the float was lifted from, and its offset from there when this drag started. */
  rect: Rect;
  ox: number;
  oy: number;
  /** The selection mask version the float was lifted with (the outline moves with the pixels). */
  baseSelVersion: number;
  dx: number;
  dy: number;
  lastDirty: Rect;
}

/**
 * Pixels moved with the Move tool stay floating, as in Photoshop: dragging them again moves the
 * same pixels and shows what was under them before. Any other change to the layer or the
 * selection (painting, undo, a new selection, ...) drops the float and the next drag lifts afresh.
 */
interface Floating {
  layerId: string;
  raster: object;
  rasterVersion: number;
  selVersion: number;
  float: FloatPixels;
  floatCov: Float32Array;
  cutState: RasterSnapshot;
  rect: Rect;
  ox: number;
  oy: number;
  baseSelVersion: number;
}

/** Lifted pixels at the layer's own depth: straight colour, and alpha with the selection applied. */
interface FloatPixels {
  px: PixelArray;
  alpha: Float32Array;
  w: number;
  h: number;
}

/**
 * Draws the float over `raster` at a layer-local position, straight into the tiles: opaque pixels
 * are copied, transparent ones skipped, and only partly covered pixels (soft edges) blended. This
 * runs on every pointer move, so it avoids converting the whole region to floats and back.
 */
function stampFloat(raster: TiledRaster, x0: number, y0: number, f: FloatPixels): void {
  const max = maxValue(raster.depth), round = raster.depth !== 32;
  const r = { x: x0, y: y0, w: f.w, h: f.h };
  const { tx0, ty0, tx1, ty1 } = tileRange(r);
  const TS = TILE_SIZE;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const bx = tx * TS, by = ty * TS;
      const ix0 = Math.max(r.x, bx), iy0 = Math.max(r.y, by), ix1 = Math.min(r.x + r.w, bx + TS), iy1 = Math.min(r.y + r.h, by + TS);
      if (ix1 <= ix0 || iy1 <= iy0) continue;
      // Only tiles the float covers somewhere are touched.
      let any = false;
      for (let y = iy0; y < iy1 && !any; y++) { const o = (y - r.y) * f.w - r.x; for (let x = ix0; x < ix1; x++) if (f.alpha[o + x] > 0) { any = true; break; } }
      if (!any) continue;
      const d = raster.writableTile(tx, ty).data;
      for (let y = iy0; y < iy1; y++) {
        const so = (y - r.y) * f.w - r.x;
        const to = (y - by) * TS - bx;
        for (let x = ix0; x < ix1; x++) {
          const sa = f.alpha[so + x];
          if (sa <= 0) continue;
          const si = (so + x) * 4, di = (to + x) * 4;
          if (sa >= 1) {
            d[di] = f.px[si]; d[di + 1] = f.px[si + 1]; d[di + 2] = f.px[si + 2]; d[di + 3] = max;
            continue;
          }
          const da = d[di + 3] / max;
          const oa = sa + da * (1 - sa);
          const kd = (da * (1 - sa)) / oa, ks = sa / oa;
          for (let c = 0; c < 3; c++) { const v = f.px[si + c] * ks + d[di + c] * kd; d[di + c] = round ? Math.round(v) : v; }
          d[di + 3] = round ? Math.round(oa * max) : oa;
        }
      }
    }
  }
}

/** Top-most visible layer with opaque pixels under a document point. */
export function pickLayer(h: ToolHost, x: number, y: number, group: boolean): Layer | null {
  const doc = h.session.doc;
  const all = doc.allLayers().reverse();
  for (const l of all) {
    if (!doc.isEffectivelyVisible(l) || !hasRaster(l)) continue;
    const a = l.raster.readFloat({ x: Math.floor(x) - l.x, y: Math.floor(y) - l.y, w: 1, h: 1 })[3];
    if (a > 0.05) {
      if (!group) return l;
      let top: Layer = l;
      while (top.parent && top.parent !== doc.root) top = top.parent;
      return top;
    }
  }
  return null;
}

export class MoveTool implements Tool {
  id = 'move' as const;
  private drag: LayerDrag | FloatDrag | null = null;
  private floating: Floating | null = null;

  cursor() {
    return 'move';
  }

  busy() {
    return !!this.drag;
  }

  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    const o = opts().move;
    if (o.autoSelect || p.mod) {
      const picked = pickLayer(h, p.x, p.y, o.autoSelectTarget === 'group');
      if (picked && picked.id !== s.activeLayerId) s.setActive(picked.id, p.shift);
    }
    // Transform handles of the bounding box start Free Transform.
    if (o.showTransformControls && this.hitHandle(h, p)) {
      beginTransform();
      return;
    }
    const active = s.activeLayer();
    if (!active) return;
    const sel = s.doc.selection;
    if (!sel.isEmpty() && active.kind === 'pixel' && sel.coverageAt(p.x, p.y) > 0.5) {
      this.beginFloat(h, p, active);
      return;
    }
    let layers = s.selectedLayers().filter((l) => !l.locks.position && !l.locks.all);
    if (!layers.length) {
      toast(`"${active.name}" is locked.`);
      return;
    }
    // Remove descendants of selected groups (they move with the group).
    layers = layers.filter((l) => !layers.some((g) => g !== l && g.kind === 'group' && s.doc.isAncestor(g, l)));
    if (p.alt) {
      // Alt-drag: duplicate first, then move the copies.
      const cmds: CreateLayerCommand[] = [];
      const copies: Layer[] = [];
      for (const l of layers) {
        const c = cloneLayer(l, true);
        c.name = `${l.name} copy`;
        const parent = l.parent ?? s.doc.root;
        const cmd = new CreateLayerCommand('Duplicate', c, parent.id, parent.children.indexOf(l) + 1);
        cmd.do(s.doc);
        cmds.push(cmd);
        copies.push(c);
      }
      s.push(new CompositeCommand('Duplicate Layer', cmds), true);
      s.setActive(copies[0].id);
      copies.slice(1).forEach((c) => s.selectedIds.add(c.id));
      layers = copies;
    }
    let bounds: Rect | null = null;
    for (const l of layers) bounds = union(bounds, layerContentBounds(l) ?? undefined);
    const ids = layers.map((l) => l.id);
    const drag: LayerDrag = { kind: 'layers', ids, lift: 'pending', start: { x: p.x, y: p.y }, applied: { dx: 0, dy: 0 }, bounds, targets: snapTargets(s, new Set(ids)), guides: { xs: [], ys: [] } };
    this.drag = drag;
    editor.beginInteraction();
    // Prepare the lift now so its tiles render in spare frame time before the pointer moves.
    this.startLift(h, drag);
  }

  /** Lifts large layers onto their own GPU tile set so dragging needs no re-compositing. */
  private startLift(h: ToolHost, d: LayerDrag) {
    const s = h.session;
    // Prepared while the pointer hovered these layers: the drag starts at full speed.
    if (s.engine.preparedLift(d.ids, s.view.level(s.engine.maxLevel()))) { d.lift = 'on'; return; }
    d.lift = this.prepareLift(h, d.ids) ? 'on' : 'off';
  }

  private prepareLift(h: ToolHost, ids: string[]): boolean {
    const s = h.session;
    let vb: Rect | null = null;
    for (const id of ids) { const l = s.doc.getLayer(id); if (l) vb = union(vb, layerVisualBounds(l) ?? undefined); }
    const tilePx = 256 * (1 << s.view.level(s.engine.maxLevel()));
    // Small layers re-render in a few milliseconds; lifting only pays off for larger ones.
    const tiles = vb ? Math.ceil(vb.w / tilePx + 1) * Math.ceil(vb.h / tilePx + 1) : Infinity;
    return tiles >= 6 && s.engine.beginLift(ids, vb);
  }

  /** The layers a drag starting at `p` would move (no side effects); null = not a plain layer drag. */
  private dragTargets(h: ToolHost, p: ToolPointer): string[] | null {
    const s = h.session;
    const o = opts().move;
    if (p.alt) return null; // Alt-drag duplicates first
    let layers = s.selectedLayers();
    if (o.autoSelect || p.mod) {
      const picked = pickLayer(h, p.x, p.y, o.autoSelectTarget === 'group');
      if (picked && picked.id !== s.activeLayerId) layers = p.shift ? [...layers, picked] : [picked];
    }
    const active = layers[layers.length - 1];
    if (!active) return null;
    const sel = s.doc.selection;
    if (!sel.isEmpty() && active.kind === 'pixel' && sel.coverageAt(p.x, p.y) > 0.5) return null;
    layers = layers.filter((l) => !l.locks.position && !l.locks.all);
    layers = layers.filter((l) => !layers.some((g) => g !== l && g.kind === 'group' && s.doc.isAncestor(g, l)));
    return layers.length ? layers.map((l) => l.id) : null;
  }

  private lastHover = 0;

  /** While hovering, prepares the lift for the layers a drag would move (in spare frame time). */
  hover(h: ToolHost, p: ToolPointer) {
    const now = performance.now();
    if (now - this.lastHover < 100) return;
    this.lastHover = now;
    const s = h.session;
    const ids = this.dragTargets(h, p);
    if (!ids) return;
    if (s.engine.preparedLift(ids, s.view.level(s.engine.maxLevel()))) return;
    s.engine.dropPreparedLift();
    if (!s.engine.lift) this.prepareLift(h, ids);
  }

  deactivate(h: ToolHost) {
    h.session.engine.dropPreparedLift();
  }

  private beginFloat(h: ToolHost, p: ToolPointer, layer: Layer) {
    const s = h.session;
    if (!hasRaster(layer)) return;
    if (layer.locks.pixels || layer.locks.all || layer.locks.position) {
      toast(`"${layer.name}" is locked.`);
      return;
    }
    const sel = s.doc.selection;
    const before = layer.raster.snapshot();
    const selBefore = sel.snapshot();
    // Still floating from the last drag: move the same pixels again (Alt-drag stamps a copy instead).
    const f = this.floating;
    if (f && !p.alt && f.layerId === layer.id && f.raster === layer.raster && f.rasterVersion === layer.raster.version && f.selVersion === sel.version) {
      const at = { x: f.rect.x + f.ox, y: f.rect.y + f.oy, w: f.rect.w, h: f.rect.h };
      this.drag = { kind: 'float', layerId: layer.id, start: { x: p.x, y: p.y }, before, selBefore, float: f.float, floatCov: f.floatCov, cutState: f.cutState, rect: f.rect, ox: f.ox, oy: f.oy, baseSelVersion: f.baseSelVersion, dx: 0, dy: 0, lastDirty: at };
      return;
    }
    this.floating = null;
    const rect = sel.bounds(s.doc.bounds);
    if (!rect) return;
    const lr = { x: rect.x - layer.x, y: rect.y - layer.y, w: rect.w, h: rect.h };
    const px = layer.raster.readFloat(lr);
    const cov = sel.read(rect);
    const native = layer.raster.readPixels(lr);
    const max = maxValue(layer.raster.depth);
    const alpha = new Float32Array(rect.w * rect.h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = (native[i * 4 + 3] / max) * cov[i];
    const float: FloatPixels = { px: native, alpha, w: rect.w, h: rect.h };
    if (!p.alt) {
      for (let i = 0; i < rect.w * rect.h; i++) px[i * 4 + 3] *= 1 - cov[i];
      layer.raster.writeFloat(lr, px);
    }
    const cutState = layer.raster.snapshot();
    // (Put back at once: the hole appears with the first movement.)
    layer.raster.restore(before);
    this.drag = { kind: 'float', layerId: layer.id, start: { x: p.x, y: p.y }, before, selBefore, float, floatCov: cov, cutState, rect, ox: 0, oy: 0, baseSelVersion: sel.version, dx: 0, dy: 0, lastDirty: rect };
  }

  /** The float's selection outline at offset (dx, dy) from where it was lifted. */
  private floatSelection(d: FloatDrag, dx: number, dy: number): RasterSnapshot {
    const m = new TiledRaster(1, 8, 0);
    m.writeFloat({ x: d.rect.x + dx, y: d.rect.y + dy, w: d.rect.w, h: d.rect.h }, d.floatCov);
    return m.snapshot();
  }

  move(h: ToolHost, p: ToolPointer) {
    const d = this.drag;
    if (!d) return;
    const s = h.session;
    let dx = Math.round(p.x - d.start.x), dy = Math.round(p.y - d.start.y);
    if (p.shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    if (d.kind === 'layers') {
      if (d.bounds && opts().move.snap) {
        const snapped = snapRectDelta(h, d.bounds, dx, dy, d.targets);
        dx = Math.round(snapped.dx);
        dy = Math.round(snapped.dy);
        d.guides = { xs: snapped.guidesX, ys: snapped.guidesY };
      }
      const ddx = dx - d.applied.dx, ddy = dy - d.applied.dy;
      if (!ddx && !ddy) return;
      if (d.lift === 'on' && s.engine.lift && !s.engine.lift.wantActive) s.engine.activateLift();
      else if (d.lift === 'on' && !s.engine.lift) d.lift = 'off'; // prepared lift was discarded
      let dirty: Rect | null = null;
      for (const id of d.ids) {
        const l = s.doc.getLayer(id);
        if (!l) continue;
        const before = layerVisualBounds(l);
        translateLayerDeep(l, ddx, ddy);
        const after = layerVisualBounds(l);
        dirty = union(dirty, union(before, after) ?? undefined);
      }
      d.applied = { dx, dy };
      s.doc.emit(...d.ids.map((id) => ({ type: 'pixels' as const, layerId: id, rect: dirty })));
      if (d.lift === 'on') s.engine.setLiftOffset(dx, dy);
      h.redraw();
      return;
    }
    // Floating pixels (offset from where they were lifted).
    const layer = s.doc.getLayer(d.layerId);
    if (!layer || !hasRaster(layer)) return;
    if (dx === d.dx && dy === d.dy) return;
    const moved0 = !d.dx && !d.dy;
    d.dx = dx;
    d.dy = dy;
    dx += d.ox;
    dy += d.oy;
    layer.raster.restore(d.cutState);
    const dest = { x: d.rect.x + dx, y: d.rect.y + dy, w: d.rect.w, h: d.rect.h };
    stampFloat(layer.raster, dest.x - layer.x, dest.y - layer.y, d.float);
    // Redraw only where the float was and where it is (and, the first time, the hole it leaves),
    // not the box spanning them, which grows with the distance dragged.
    const rects = [d.lastDirty, dest];
    if (moved0 && !d.ox && !d.oy) rects.push(d.rect);
    d.lastDirty = dest;
    // The outline follows as an offset; the selection mask itself is written when the drag ends.
    const sel = s.doc.selection;
    sel.moved = { version: sel.version, baseVersion: d.baseSelVersion, dx, dy, mdx: d.ox, mdy: d.oy };
    s.doc.emit(...rects.map((rect) => ({ type: 'pixels' as const, layerId: layer.id, rect })));
    h.redraw();
  }

  up(h: ToolHost) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const s = h.session;
    if (d.kind === 'layers') {
      // A click without movement keeps the prepared lift for the next drag.
      if (d.lift === 'on' && s.engine.lift && !s.engine.lift.wantActive) { /* still prepared */ }
      else if (d.lift === 'on') {
        let fb: Rect | null = null;
        for (const id of d.ids) { const l = s.doc.getLayer(id); if (l) fb = union(fb, layerVisualBounds(l) ?? undefined); }
        s.engine.endLift(fb);
      }
      editor.endInteraction();
      if (d.applied.dx || d.applied.dy) s.push(new TranslateLayersCommand(d.ids, d.applied.dx, d.applied.dy, { action: 'layer.translate', args: { dx: d.applied.dx, dy: d.applied.dy } }), true);
      h.redraw();
      return;
    }
    const layer = s.doc.getLayer(d.layerId);
    if (!layer || !hasRaster(layer)) return;
    const sel = s.doc.selection;
    if (!d.dx && !d.dy) {
      // No movement: nothing changed (a float stays floating).
      if (this.floating) { this.floating.rasterVersion = layer.raster.version; this.floating.selVersion = sel.version; }
      return;
    }
    const ox = d.ox + d.dx, oy = d.oy + d.dy;
    sel.restore(this.floatSelection(d, ox, oy));
    sel.moved = { version: sel.version, baseVersion: d.baseSelVersion, dx: ox, dy: oy, mdx: ox, mdy: oy };
    s.doc.emit({ type: 'selection' });
    const after = layer.raster.snapshot();
    const selAfter = sel.snapshot();
    const from = { ...d.rect, x: d.rect.x + d.ox, y: d.rect.y + d.oy }, to = { ...d.rect, x: d.rect.x + ox, y: d.rect.y + oy };
    const dirty = expand(union(union(from, to)!, d.rect)!, 1);
    s.push(new CompositeCommand('Move', [new RasterEditCommand('Move', { kind: 'layer', layerId: layer.id }, d.before, after, dirty), new RasterEditCommand('Move', { kind: 'selection' }, d.selBefore, selAfter, dirty)]), true);
    this.floating = { layerId: layer.id, raster: layer.raster, rasterVersion: layer.raster.version, selVersion: sel.version, float: d.float, floatCov: d.floatCov, cutState: d.cutState, rect: d.rect, ox, oy, baseSelVersion: d.baseSelVersion };
  }

  cancel(h: ToolHost) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const s = h.session;
    if (d.kind === 'layers') {
      for (const id of d.ids) {
        const l = s.doc.getLayer(id);
        if (l) translateLayerDeep(l, -d.applied.dx, -d.applied.dy);
      }
      editor.endInteraction();
      // A structural change also discards any lift and re-renders exactly.
      s.doc.emit({ type: 'structure' });
    } else {
      const layer = s.doc.getLayer(d.layerId);
      if (layer && hasRaster(layer)) layer.raster.restore(d.before);
      s.doc.selection.restore(d.selBefore);
      s.doc.emit({ type: 'structure' }, { type: 'selection' });
      // (Back where this drag started: an earlier float is still valid.)
      if (this.floating && layer && hasRaster(layer)) { this.floating.rasterVersion = layer.raster.version; this.floating.selVersion = s.doc.selection.version; }
    }
  }

  keyDown(h: ToolHost, e: KeyboardEvent): boolean {
    const step = e.shiftKey ? 10 : 1;
    const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = map[e.key];
    if (!m) return false;
    const s = h.session;
    const ids = s.selectedLayers().filter((l) => !l.locks.position && !l.locks.all).map((l) => l.id);
    if (!ids.length) return true;
    s.push(new TranslateLayersCommand(ids, m[0], m[1], { action: 'layer.translate', args: { dx: m[0], dy: m[1] } }));
    return true;
  }

  private bbox(h: ToolHost): Rect | null {
    const l = h.session.activeLayer();
    return l ? layerContentBounds(l) : null;
  }

  private hitHandle(h: ToolHost, p: ToolPointer): boolean {
    const b = this.bbox(h);
    if (!b) return false;
    const v = h.session.view;
    const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h], [b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2], [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2]];
    return pts.some(([x, y]) => {
      const sp = v.docToScreen(x, y);
      return Math.abs(sp.x - p.sx) < 6 && Math.abs(sp.y - p.sy) < 6;
    });
  }

  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    if (this.drag?.kind === 'layers') drawSnapLines(h, g, this.drag.guides.xs, this.drag.guides.ys);
    if (!opts().move.showTransformControls) return;
    const b = this.bbox(h);
    if (!b) return;
    const v = h.session.view;
    const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => v.docToScreen(x, y));
    g.save();
    g.strokeStyle = '#3d8bfd';
    g.lineWidth = 1;
    g.beginPath();
    corners.forEach((c, i) => (i ? g.lineTo(c.x + 0.5, c.y + 0.5) : g.moveTo(c.x + 0.5, c.y + 0.5)));
    g.closePath();
    g.stroke();
    const mids = [[b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2], [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2]].map(([x, y]) => v.docToScreen(x, y));
    g.fillStyle = '#fff';
    for (const c of [...corners, ...mids]) { g.fillRect(c.x - 3.5, c.y - 3.5, 7, 7); g.strokeRect(c.x - 3.5, c.y - 3.5, 7, 7); }
    g.restore();
  }
}

export { intersect, isEmpty, ui };
