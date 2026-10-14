/**
 * Plugin Tool: runs a tool contributed by a sandboxed plugin. The stroke is collected on the
 * canvas; on release the plugin receives the path, the active layer's pixels under it and the
 * colors, and returns new pixels for that region, applied as one undoable step. Plugins never
 * touch the document directly.
 */
import { cmykFor, encodeLab, isCmykDoc, isLabDoc, labFor, platesToRgb, readPlates, rgbToPlates } from '../color/plates';
import type { CelenneDocument } from '../document/document';
import type { RGB } from '../color/types';
import type { Tool, ToolHost, ToolPointer } from './tool';
import { ui, useApp } from '../app/store';
import { plugins, PluginToolDef } from '../plugins/pluginHost';
import { editRaster } from '../commands/rasterCommands';
import { expand, intersect, isEmpty, roundOut } from '../image-engine/rect';
import type { FilterParams } from '../filters/types';
import { defaults } from '../filters/types';

let current: string | null = null;
const paramsById = new Map<string, FilterParams>();

export function pluginToolList(): PluginToolDef[] {
  return plugins.tools();
}

export function currentPluginTool(): PluginToolDef | null {
  const list = pluginToolList();
  return list.find((t) => t.fullId === current) ?? list[0] ?? null;
}

export function setCurrentPluginTool(id: string): void {
  current = id;
  ui.bump('viewRev');
}

export function pluginToolParams(t: PluginToolDef): FilterParams {
  let p = paramsById.get(t.fullId);
  if (!p) { p = defaults({ params: t.params } as never); paramsById.set(t.fullId, p); }
  return p;
}

export function setPluginToolParams(t: PluginToolDef, p: FilterParams): void {
  paramsById.set(t.fullId, p);
  ui.bump('viewRev');
}

export class PluginTool implements Tool {
  id = 'pluginTool' as const;
  private points: { x: number; y: number; pressure: number; sx: number; sy: number }[] = [];
  private running = false;

  busy() {
    return this.points.length > 0;
  }

  cursor() {
    return 'crosshair';
  }

  down(_h: ToolHost, p: ToolPointer) {
    if (this.running) return;
    if (!currentPluginTool()) {
      ui.toast('info', 'No plugin tools are installed.', 'Install a plugin that contributes tools in Plugins ▸ Manage Plugins.');
      return;
    }
    this.points = [{ x: p.x, y: p.y, pressure: p.pointerType === 'mouse' ? 1 : p.pressure || 0.5, sx: p.sx, sy: p.sy }];
  }

  move(h: ToolHost, p: ToolPointer) {
    if (!this.points.length) return;
    this.points.push({ x: p.x, y: p.y, pressure: p.pointerType === 'mouse' ? 1 : p.pressure || 0.5, sx: p.sx, sy: p.sy });
    h.redraw();
  }

  async up(h: ToolHost) {
    const pts = this.points;
    this.points = [];
    h.redraw();
    const t = currentPluginTool();
    if (!pts.length || !t) return;
    const s = h.session;
    const target = s.paintTarget(false);
    const layer = s.activeLayer();
    if (!target || target.kind !== 'layer' || !layer || layer.kind !== 'pixel') {
      ui.toast('info', 'Plugin tools work on pixel layers.');
      return;
    }
    if (layer.locks.pixels || layer.locks.all) {
      ui.toast('info', `"${layer.name}" is locked.`);
      return;
    }
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    const region = intersect(expand(roundOut(Math.min(...xs), Math.min(...ys), Math.max(...xs) + 1, Math.max(...ys) + 1), t.padding), s.doc.bounds);
    if (isEmpty(region) || region.w * region.h > 64e6) return;
    const lr = { x: region.x - layer.x, y: region.y - layer.y, w: region.w, h: region.h };
    const n = region.w * region.h;
    const doc = s.doc;
    const native = isCmykDoc(doc) || isLabDoc(doc);
    const plates = readPlates(doc, layer.raster, lr);
    const mode = !native ? 'rgb' : !t.nativeColor ? 'rgb' : isCmykDoc(doc) ? 'cmyk' : 'lab';
    const st = useApp.getState();
    const io = toolIO(doc, mode, plates, n);
    this.running = true;
    const prog = ui.progress(`${t.name}…`);
    try {
      const out = await plugins.runTool(t.fullId, {
        points: pts.map((q) => ({ x: q.x - region.x, y: q.y - region.y, pressure: q.pressure })),
        region,
        data: io.data.slice(),
        colorMode: mode,
        channels: io.channels,
        foreground: io.color(st.fg),
        background: io.color(st.bg),
        params: { ...pluginToolParams(t) },
      });
      // Respect the selection like built-in tools do.
      const sel = s.doc.selection.isEmpty() ? null : s.doc.selection.read(region);
      const outPlates = io.back(out);
      const cmd = editRaster(s.doc, target, t.name, (raster, ox, oy, plate) => {
        const r = { x: region.x - ox, y: region.y - oy, w: region.w, h: region.h };
        const cur = raster.readFloat(r);
        const res = outPlates[plate] ?? out;
        for (let i = 0; i < region.w * region.h; i++) {
          const k = sel ? sel[i] : 1;
          if (k <= 0) continue;
          for (let c = 0; c < 4; c++) cur[i * 4 + c] += (res[i * 4 + c] - cur[i * 4 + c]) * k;
        }
        raster.writeFloat(r, cur);
        return region;
      }, undefined, { labRaw: true });
      if (cmd) s.push(cmd, true);
    } catch (e) {
      ui.toast('error', `${t.name} failed`, (e as Error).message);
    } finally {
      this.running = false;
      prog.done();
    }
  }

  cancel() {
    this.points = [];
  }

  drawOverlay(_h: ToolHost, g: CanvasRenderingContext2D) {
    if (this.points.length < 2) return;
    g.save();
    g.strokeStyle = '#3d8bfd';
    g.lineWidth = 1.5;
    g.beginPath();
    this.points.forEach((q, i) => (i ? g.lineTo(q.sx, q.sy) : g.moveTo(q.sx, q.sy)));
    g.stroke();
    g.restore();
  }
}

/**
 * What a plugin tool sees of the layer and how its answer becomes plates again. RGB-only tools on
 * CMYK / Lab layers get the appearance; pixels they leave unchanged keep their exact stored values
 * (only the pixels the tool changed are separated by the document profile). Native tools exchange
 * ink amounts (C M Y K A) or encoded L a b A directly.
 */
function toolIO(doc: CelenneDocument, mode: 'rgb' | 'cmyk' | 'lab', plates: Float32Array[], n: number) {
  const native = isCmykDoc(doc) || isLabDoc(doc);
  if (!native) return { data: plates[0], channels: 4, color: (c: RGB) => [c.r, c.g, c.b], back: (o: Float32Array) => [o] };
  if (mode === 'cmyk') {
    const [p0, p1] = plates;
    const data = new Float32Array(n * 5);
    for (let i = 0; i < n; i++) {
      data[i * 5] = 1 - p0[i * 4]; data[i * 5 + 1] = 1 - p0[i * 4 + 1]; data[i * 5 + 2] = 1 - p0[i * 4 + 2];
      data[i * 5 + 3] = 1 - p1[i * 4]; data[i * 5 + 4] = p0[i * 4 + 3];
    }
    return {
      data, channels: 5, color: (c: RGB) => [...cmykFor(doc, c)],
      back: (o: Float32Array) => {
        const a = new Float32Array(n * 4), b = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          a[i * 4] = 1 - o[i * 5]; a[i * 4 + 1] = 1 - o[i * 5 + 1]; a[i * 4 + 2] = 1 - o[i * 5 + 2];
          b[i * 4] = b[i * 4 + 1] = b[i * 4 + 2] = 1 - o[i * 5 + 3];
          a[i * 4 + 3] = b[i * 4 + 3] = o[i * 5 + 4];
        }
        return [a, b];
      },
    };
  }
  if (mode === 'lab') return { data: plates[0], channels: 4, color: (c: RGB) => [...encodeLab(labFor(c))], back: (o: Float32Array) => [o] };
  // RGB-only tool on a CMYK / Lab layer.
  const view = platesToRgb(doc, plates, n);
  return {
    data: view, channels: 4, color: (c: RGB) => [c.r, c.g, c.b],
    back: (o: Float32Array) => {
      const sep = rgbToPlates(doc, o, n);
      for (let i = 0; i < n; i++) {
        let same = true;
        for (let c = 0; c < 4 && same; c++) same = Math.abs(o[i * 4 + c] - view[i * 4 + c]) < 1 / 2048;
        if (same) for (let k = 0; k < sep.length; k++) sep[k].set(plates[k].subarray(i * 4, i * 4 + 4), i * 4);
      }
      return sep;
    },
  };
}
