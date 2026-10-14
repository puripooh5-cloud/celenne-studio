/** Painting and retouching tools built on the brush engine and stroke operations. */
import type { Tool, ToolHost, ToolPointer } from './tool';
import type { ToolId, BrushSettings } from './toolTypes';
import { opts, toast } from './helpers';
import { ui, useApp } from '../app/store';
import { DabEmitter, dabBounds, dabCoverage, InputSample, makeTipSampler, TipSampler, Dab } from '../brush/engine';
import {
  BackgroundEraseOp, CloneOp, ColorReplaceOp, FocusOp, MaskAccumulateOp, MixerOp, PaintOp, PatternStampOp, SmudgeOp, StrokeOp, ToneOp, healColors, type StrokeContext,
} from '../brush/paintOps';
import { RasterEditCommand } from '../commands/rasterCommands';
import { emitTargetChange, RasterTarget, resolveTarget } from '../commands/rasterTarget';
import type { RasterSnapshot } from '../image-engine/tiledRaster';
import { TiledRaster } from '../image-engine/tiledRaster';
import { expand, intersect, isEmpty, Rect, union, roundOut } from '../image-engine/rect';
import { compositeStraight, compositeStraightPlate, samplingImage } from '../app/ops/common';
import { ensureCompanion, isCmykDoc, isLabDoc, labRgbView, labToRgbUnclamped, labViewColor, plateColor } from '../color/plates';
import { platePatterns } from '../rendering/platePatterns';
import type { DocumentSession } from '../app/session';
import type { ResolvedTarget } from '../commands/rasterTarget';
import type { Layer } from '../document/types';
import type { RGB } from '../color/types';
import { inpaintRegion } from '../app/ops/editOps';
import { floodRegion } from '../selection/ops';
import { editRaster } from '../commands/rasterCommands';
import { hasRaster } from '../document/types';
import { dilateMask } from '../image-engine/blur';
import { rasterizeLasso } from '../vector/rasterize';
import { strokeDocPath } from './helpers';

type Kind = 'brush' | 'pencil' | 'eraser' | 'bgEraser' | 'colorReplace' | 'cloneStamp' | 'patternStamp' | 'healing' | 'blur' | 'sharpen' | 'smudge' | 'dodge' | 'burn' | 'sponge' | 'spotHealing' | 'remove' | 'mixerBrush';

const cloneSource = new Map<string, { x: number; y: number; sessionId: string }>();
/** Mixer Brush paint carried between strokes when "Load the brush after each stroke" is off. */
const mixerReservoir: { color: { r: number; g: number; b: number } | null } = { color: null };

export class PaintTool implements Tool {
  private emitter: DabEmitter | null = null;
  private op: StrokeOp | null = null;
  /** One operation per plate (CMYK: C'M'Y' and K'). */
  private ops: StrokeOp[] = [];
  private target: RasterTarget | null = null;
  private before: RasterSnapshot | null = null;
  private brush: BrushSettings | null = null;
  private tip: TipSampler | null = null;
  private lastPoint: { x: number; y: number } | null = null;
  private airTimer: ReturnType<typeof setInterval> | null = null;
  private hoverPos: { sx: number; sy: number } | null = null;
  private strokeDirty: Rect | null = null;
  private cloneOffset: { dx: number; dy: number } | null = null;
  private pending: Rect | null = null;
  private raf = 0;
  private hostRef: ToolHost | null = null;

  constructor(readonly id: ToolId, private kind: Kind) {}

  busy() {
    return !!this.op;
  }

  cursor(_h: ToolHost, p: ToolPointer | null) {
    if (p?.alt && (this.kind === 'cloneStamp' || this.kind === 'healing')) return 'crosshair';
    return 'none';
  }

  private settings(): BrushSettings {
    const b = { ...useApp.getState().brush };
    if (this.kind === 'pencil') { b.hardness = 1; b.aliased = true; }
    if (this.kind === 'eraser') {
      const m = opts().eraser.mode;
      if (m === 'pencil') { b.hardness = 1; b.aliased = true; }
      if (m === 'block') { b.hardness = 1; b.aliased = true; b.roundness = 1; b.tip = 'round'; }
    }
    if (['blur', 'sharpen', 'smudge', 'dodge', 'burn', 'sponge'].includes(this.kind)) { b.opacity = 1; b.spacing = Math.max(b.spacing, 0.15); }
    if (this.kind === 'spotHealing' || this.kind === 'remove') { b.opacity = 1; b.flow = 1; b.hardness = Math.max(0.5, b.hardness); }
    return b;
  }

  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    const qm = useApp.getState().quickMask;
    if ((this.kind === 'cloneStamp' || this.kind === 'healing') && p.alt) {
      cloneSource.set(this.kind, { x: p.x, y: p.y, sessionId: s.id });
      this.cloneOffset = null;
      toast('Clone source set.');
      return;
    }
    const target = s.paintTarget(qm);
    const reason = s.paintBlockReason(qm);
    if (!target || reason) {
      toast(reason ?? 'Cannot paint here.');
      return;
    }
    const res = resolveTarget(s.doc, target);
    if (!res) return;
    if (['cloneStamp', 'healing', 'colorReplace', 'bgEraser', 'dodge', 'burn', 'sponge', 'patternStamp', 'smudge', 'mixerBrush'].includes(this.kind) && res.channels !== 4 && this.kind !== 'patternStamp') {
      toast('This tool works on layer pixels, not masks or channels.');
      return;
    }
    const layer = s.activeLayer();
    const lockAlpha = target.kind === 'layer' && !!layer?.locks.transparency;
    const st = useApp.getState();
    this.brush = this.settings();
    this.tip = makeTipSampler(this.brush);
    this.target = target;
    this.before = res.raster.snapshot();
    const original = res.raster.clone();
    const selection = target.kind === 'selection' ? null : s.doc.selection.isEmpty() ? null : s.doc.selection;
    // CMYK layers paint both plates (C'M'Y' and K') with the same dabs; Lab layers paint through an
    // exact RGB view of their L a b values.
    const cmyk = res.channels === 4 && isCmykDoc(s.doc);
    const lab = res.channels === 4 && isLabDoc(s.doc);
    if (cmyk) ensureCompanion(res.raster);
    if (cmyk && !original.companion) original.companion = res.raster.companion!.clone();
    const plates = cmyk ? 2 : 1;
    this.ops = [];
    for (let plate = 0; plate < plates; plate++) {
      const raster = plate === 1 ? res.raster.companion! : lab ? labRgbView(res.raster) : res.raster;
      const orig = plate === 1 ? original.companion! : lab ? labRgbView(original) : original;
      const ctx = { target: { ...res, raster }, original: orig, selection, canvas: s.doc.bounds, lockAlpha };
      const col = (c: RGB): RGB => (cmyk ? plateColor(s.doc, c, plate) : lab ? labViewColor(c) : c);
      const composite = (r: Rect) => {
        if (!cmyk && !lab) return compositeStraight(s, r);
        const v = compositeStraightPlate(s, r, plate);
        if (lab) labToRgbUnclamped(v);
        return v;
      };
      const op = this.buildOp(s, p, ctx, orig, res, layer, col(st.fg), col(st.bg), composite, plate);
      if (!op) { this.reset(); return; }
      this.ops.push(op);
    }
    this.op = this.ops[0];
    this.emitter = new DabEmitter(this.brush);
    this.strokeDirty = null;
    this.hostRef = h;
    const sample = this.sample(p);
    let dabs: Dab[];
    if (p.shift && this.lastPoint) {
      // Shift-click: straight line from the previous stroke end.
      this.emitter.begin({ ...sample, x: this.lastPoint.x, y: this.lastPoint.y });
      dabs = this.emitter.move(sample);
    } else dabs = this.emitter.begin(sample);
    this.applyDabs(h, dabs);
    if (this.brush.airbrush && this.kind === 'brush') this.airTimer = setInterval(() => this.emitter && this.applyDabs(h, this.emitter.repeat()), 40);
  }

  /** Creates the stroke operation for one plate (null when the stroke cannot start). */
  private buildOp(s: DocumentSession, p: ToolPointer, ctx: StrokeContext, original: TiledRaster, res: ResolvedTarget, layer: Layer | null, fg: RGB, bg: RGB, composite: (r: Rect) => Float32Array, plate: number): StrokeOp | null {
    switch (this.kind) {
      case 'brush':
      case 'pencil':
        return new PaintOp(ctx, fg, this.brush!.blendMode, false, bg);
      case 'eraser':
        // On masks / channels / quick mask the eraser paints with the background color.
        return new PaintOp(ctx, bg, 'normal', true, bg);
      case 'bgEraser': {
        const e = opts().eraser;
        return new BackgroundEraseOp(ctx, e.tolerance, e.sampling, bg, e.protectForeground ? fg : null);
      }
      case 'colorReplace':
        return new ColorReplaceOp(ctx, fg, opts().eraser.tolerance);
      case 'cloneStamp':
      case 'healing': {
        const src = cloneSource.get(this.kind);
        if (!src || src.sessionId !== s.id) {
          toast('Alt+click to define a source point first.');
          return null;
        }
        const aligned = opts().clone.aligned;
        if (plate === 0 && (!this.cloneOffset || !aligned)) this.cloneOffset = { dx: src.x - p.x, dy: src.y - p.y };
        const sampleAll = opts().clone.sampleAllLayers;
        const sampler = (r: Rect) => (sampleAll || !layer || !hasRaster(layer) ? composite(r) : original.readFloat({ x: r.x - res.x, y: r.y - res.y, w: r.w, h: r.h }));
        return new CloneOp(ctx, sampler, this.cloneOffset!.dx, this.cloneOffset!.dy, this.kind === 'healing');
      }
      case 'patternStamp': {
        const pat = [...platePatterns(s.doc, plate).values()][0];
        if (!pat) {
          toast('Define a pattern first (Edit › Define Pattern).');
          return null;
        }
        return new PatternStampOp(ctx, pat);
      }
      case 'blur':
      case 'sharpen':
        return new FocusOp(ctx, this.kind === 'sharpen', opts().retouch.strength);
      case 'smudge':
        return new SmudgeOp(ctx, opts().retouch.strength, p.alt ? fg : null);
      case 'mixerBrush': {
        const m = opts().mixer;
        // "Load after stroke" refills with the foreground color; "clean" starts with an empty brush.
        if (plate === 0 && (m.loadAfterStroke || !mixerReservoir.color)) mixerReservoir.color = m.cleanAfterStroke ? null : { ...useApp.getState().fg };
        const sampler = m.sampleAllLayers ? composite : null;
        const reservoir = mixerReservoir.color ? (isCmykDoc(s.doc) ? plateColor(s.doc, mixerReservoir.color, plate) : isLabDoc(s.doc) ? labViewColor(mixerReservoir.color) : mixerReservoir.color) : null;
        return new MixerOp(ctx, reservoir, m.wet, m.load, m.mix, this.brush!.flow, sampler);
      }
      case 'dodge':
      case 'burn':
      case 'sponge': {
        const r = opts().retouch;
        return new ToneOp(ctx, this.kind, r.range, this.kind === 'sponge' ? r.strength : r.exposure, r.spongeMode);
      }
      case 'spotHealing':
      case 'remove':
        if (plate > 0) return new MaskAccumulateOp(ctx);
        if (res.channels !== 4 || !layer || !hasRaster(layer)) {
          toast('Spot healing works on pixel layers.');
          return null;
        }
        return new MaskAccumulateOp(ctx);
    }
    return null;
  }

  private sample(p: ToolPointer): InputSample {
    const pressure = p.pointerType === 'mouse' ? 1 : p.pressure || 0.5;
    return { x: p.x, y: p.y, pressure, tiltX: p.tiltX, tiltY: p.tiltY, twist: p.twist, time: p.time };
  }

  private applyDabs(h: ToolHost, dabs: Dab[]) {
    if (!this.op || !this.brush) return;
    for (const d of dabs) {
      const r = dabBounds(d);
      const cov = dabCoverage(d, r, this.brush, this.tip);
      // Each op may scale its coverage copy by the selection.
      for (let k = this.ops.length - 1; k >= 0; k--) this.ops[k].apply(d, k ? cov.slice() : cov, r);
      this.pending = union(this.pending, r);
      this.strokeDirty = union(this.strokeDirty, r);
    }
    this.flush(h);
  }

  /** Batches change notifications to one per animation frame. */
  private flush(h: ToolHost) {
    if (this.raf) return;
    const run = () => {
      this.raf = 0;
      if (!this.pending || !this.target) return;
      const r = this.pending;
      this.pending = null;
      if (this.kind === 'spotHealing' || this.kind === 'remove') { h.redraw(); return; }
      emitTargetChange(h.session.doc, this.target, r);
    };
    this.raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
  }

  move(h: ToolHost, p: ToolPointer) {
    this.hoverPos = { sx: p.sx, sy: p.sy };
    if (!this.emitter) return h.redraw();
    this.applyDabs(h, this.emitter.move(this.sample(p)));
    this.lastPoint = { x: p.x, y: p.y };
    h.redraw();
  }

  hover(h: ToolHost, p: ToolPointer) {
    this.hoverPos = { sx: p.sx, sy: p.sy };
    h.redraw();
  }

  async up(h: ToolHost, p: ToolPointer) {
    if (!this.op || !this.target || !this.before) return this.reset();
    this.applyDabs(h, this.emitter?.end(this.sample(p)) ?? []);
    if (this.airTimer) clearInterval(this.airTimer);
    this.airTimer = null;
    this.lastPoint = { x: p.x, y: p.y };
    const s = h.session;
    const res = resolveTarget(s.doc, this.target);
    if (this.op instanceof MaskAccumulateOp) {
      const mask = this.op.mask;
      this.reset();
      h.redraw();
      await inpaintRegion(s, mask, this.kind === 'remove' ? 'Remove' : 'Spot Healing Brush', opts().retouch.sampleAllLayers);
      return;
    }
    if (res) {
      if (this.target.kind === 'layer' && (this.kind === 'eraser' || this.kind === 'bgEraser')) res.raster.compact();
      const after = res.raster.snapshot();
      const bps = res.raster.depth === 8 ? 1 : res.raster.depth === 16 ? 2 : 4;
      const label = LABELS[this.kind];
      s.push(new RasterEditCommand(label, this.target, this.before, after, this.strokeDirty, undefined, 256 * 256 * res.channels * bps), true);
      emitTargetChange(s.doc, this.target, this.strokeDirty);
    }
    this.reset();
  }

  cancel(h: ToolHost) {
    if (this.op && this.target && this.before) {
      const res = resolveTarget(h.session.doc, this.target);
      res?.raster.restore(this.before);
      emitTargetChange(h.session.doc, this.target, this.strokeDirty);
    }
    this.reset();
  }

  private reset() {
    if (this.airTimer) clearInterval(this.airTimer);
    this.airTimer = null;
    this.emitter = null;
    this.op = null;
    this.ops = [];
    this.target = null;
    this.before = null;
  }

  keyDown(_h: ToolHost, e: KeyboardEvent): boolean {
    const b = useApp.getState().brush;
    if (e.key === ']' || e.key === '[') {
      if (e.shiftKey) ui.setBrush({ hardness: Math.max(0, Math.min(1, b.hardness + (e.key === ']' ? 0.25 : -0.25))) });
      else {
        const step = b.size < 10 ? 1 : b.size < 50 ? 5 : b.size < 100 ? 10 : b.size < 300 ? 25 : 50;
        ui.setBrush({ size: Math.max(1, Math.min(5000, b.size + (e.key === ']' ? step : -step))) });
      }
      return true;
    }
    // Number keys set opacity (1 = 10% … 0 = 100%).
    if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
      const v = e.key === '0' ? 1 : Number(e.key) / 10;
      if (this.kind === 'brush' || this.kind === 'pencil' || this.kind === 'eraser' || this.kind === 'cloneStamp') ui.setBrush({ opacity: v });
      return true;
    }
    return false;
  }

  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    if (this.op instanceof MaskAccumulateOp) {
      // Show the area that will be healed.
      const b = this.op.mask.contentBounds();
      if (b) {
        const v = h.session.view;
        g.save();
        g.fillStyle = 'rgba(255,40,80,0.35)';
        const step = Math.max(1, Math.round(2 / v.zoom));
        const m = this.op.mask.readFloat(b);
        for (let y = 0; y < b.h; y += step) for (let x = 0; x < b.w; x += step) if (m[y * b.w + x] > 0.5) { const s = v.docToScreen(b.x + x, b.y + y); g.fillRect(s.x, s.y, Math.max(1, v.zoom * step), Math.max(1, v.zoom * step)); }
        g.restore();
      }
    }
    if (!this.hoverPos) return;
    const b = useApp.getState().brush;
    const z = h.session.view.zoom;
    const r = (b.size / 2) * z;
    const { sx, sy } = this.hoverPos;
    g.save();
    g.translate(sx, sy);
    g.rotate((b.angle * Math.PI) / 180 * -1 + h.session.view.rotation);
    g.scale(1, b.roundness);
    if (r < 3) {
      g.strokeStyle = '#fff';
      g.beginPath(); g.moveTo(-5, 0); g.lineTo(5, 0); g.moveTo(0, -5); g.lineTo(0, 5); g.stroke();
    } else {
      g.lineWidth = 1 / Math.max(0.2, b.roundness);
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.beginPath(); g.arc(0, 0, r + 0.5, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.beginPath(); g.arc(0, 0, r - 0.5, 0, Math.PI * 2); g.stroke();
    }
    g.restore();
    const src = cloneSource.get(this.kind);
    if (src && src.sessionId === h.session.id && (this.kind === 'cloneStamp' || this.kind === 'healing')) {
      const off = this.cloneOffset;
      const docHover = h.session.view.screenToDoc(sx, sy);
      const pt = off ? { x: docHover.x + off.dx, y: docHover.y + off.dy } : src;
      const s2 = h.session.view.docToScreen(pt.x, pt.y);
      g.save();
      g.strokeStyle = '#fff';
      g.beginPath(); g.moveTo(s2.x - 6, s2.y); g.lineTo(s2.x + 6, s2.y); g.moveTo(s2.x, s2.y - 6); g.lineTo(s2.x, s2.y + 6); g.stroke();
      g.restore();
    }
  }
}

const LABELS: Record<Kind, string> = {
  brush: 'Brush Tool', pencil: 'Pencil', eraser: 'Eraser', bgEraser: 'Background Eraser', colorReplace: 'Color Replacement', cloneStamp: 'Clone Stamp', patternStamp: 'Pattern Stamp', healing: 'Healing Brush',
  blur: 'Blur Tool', sharpen: 'Sharpen Tool', smudge: 'Smudge Tool', dodge: 'Dodge Tool', burn: 'Burn Tool', sponge: 'Sponge Tool', spotHealing: 'Spot Healing Brush', remove: 'Remove Tool', mixerBrush: 'Mixer Brush',
};

// ---------------------------------------------------------------------------------------------
// Click tools
// ---------------------------------------------------------------------------------------------
export class MagicEraserTool implements Tool {
  id = 'magicEraser' as const;
  cursor() {
    return 'crosshair';
  }
  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    const l = s.activeLayer();
    if (!l || l.kind !== 'pixel') return toast('Magic Eraser works on pixel layers.');
    if (l.locks.pixels || l.locks.all) return toast(`"${l.name}" is locked.`);
    const e = opts().eraser;
    const region = floodRegion(samplingImage(s, e.sampleAllLayers), p.x, p.y, e.tolerance, e.contiguous, true);
    const b = region.contentBounds();
    if (!b) return;
    const cmd = editRaster(s.doc, { kind: 'layer', layerId: l.id }, 'Magic Eraser', (raster, ox, oy) => {
      const lr = { x: b.x - ox, y: b.y - oy, w: b.w, h: b.h };
      const px = raster.readFloat(lr);
      const m = region.readFloat(b);
      const op = useApp.getState().brush.opacity;
      for (let i = 0; i < b.w * b.h; i++) px[i * 4 + 3] *= 1 - m[i] * op;
      raster.writeFloat(lr, px);
      raster.compact();
      return b;
    });
    if (cmd) s.push(cmd, true);
  }
}

export class RedEyeTool implements Tool {
  id = 'redEye' as const;
  cursor() {
    return 'crosshair';
  }
  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    const l = s.activeLayer();
    if (!l || l.kind !== 'pixel') return toast('Red Eye works on pixel layers.');
    const radius = Math.max(8, useApp.getState().brush.size / 2);
    const r = intersect(roundOut(p.x - radius, p.y - radius, p.x + radius, p.y + radius), s.doc.bounds);
    if (isEmpty(r)) return;
    const darken = opts().retouch.strength;
    const cmd = editRaster(s.doc, { kind: 'layer', layerId: l.id }, 'Red Eye', (raster, ox, oy) => {
      const lr = { x: r.x - ox, y: r.y - oy, w: r.w, h: r.h };
      const px = raster.readFloat(lr);
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const d = Math.hypot(r.x + x + 0.5 - p.x, r.y + y + 0.5 - p.y) / radius;
          if (d > 1) continue;
          const i = (y * r.w + x) * 4;
          const R = px[i], G = px[i + 1], B = px[i + 2];
          const redness = R - Math.max(G, B);
          if (R < 0.25 || redness < 0.08) continue;
          const k = Math.min(1, redness * 4) * (1 - Math.max(0, d - 0.7) / 0.3);
          const target = ((G + B) / 2) * (1 - darken * 0.6);
          px[i] = R + (target - R) * k;
          px[i + 1] = G * (1 - k * darken * 0.3);
          px[i + 2] = B * (1 - k * darken * 0.3);
        }
      raster.writeFloat(lr, px);
      return r;
    });
    if (cmd) s.push(cmd, true);
  }
}

/** Patch tool: select an area (or use the selection) and drag it onto a source area. */
export class PatchTool implements Tool {
  id = 'patch' as const;
  private lasso: { x: number; y: number }[] | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private offset = { dx: 0, dy: 0 };
  cursor() {
    return 'crosshair';
  }
  busy() {
    return !!this.lasso || !!this.dragStart;
  }
  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    if (!s.doc.selection.isEmpty() && s.doc.selection.coverageAt(p.x, p.y) > 0.5) {
      this.dragStart = { x: p.x, y: p.y };
      this.offset = { dx: 0, dy: 0 };
      return;
    }
    this.lasso = [{ x: p.x, y: p.y }];
  }
  move(h: ToolHost, p: ToolPointer) {
    if (this.lasso) this.lasso.push({ x: p.x, y: p.y });
    if (this.dragStart) this.offset = { dx: p.x - this.dragStart.x, dy: p.y - this.dragStart.y };
    h.redraw();
  }
  async up(h: ToolHost) {
    const s = h.session;
    if (this.lasso) {
      const pts = this.lasso;
      this.lasso = null;
      h.redraw();
      if (pts.length < 3) return;
      const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
      const r = roundOut(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
      const cov = rasterizeLasso(pts, r, true);
      const { changeSelection } = await import('../app/ops/selectOps');
      const m = new TiledRaster(1, 8, 0);
      m.writeFloat(r, cov);
      changeSelection(s, 'Patch Selection', () => s.doc.selection.restore(m.snapshot()));
      return;
    }
    if (!this.dragStart) return;
    this.dragStart = null;
    const { dx, dy } = { dx: Math.round(this.offset.dx), dy: Math.round(this.offset.dy) };
    h.redraw();
    if (!dx && !dy) return;
    const l = s.activeLayer();
    if (!l || l.kind !== 'pixel') return toast('Patch works on pixel layers.');
    const sel = s.doc.selection;
    const b = sel.bounds(s.doc.bounds);
    if (!b) return toast('The selection is outside the canvas.');
    const destination = opts().retouch.patchMode === 'destination';
    const pad = 8;
    const work = expand(b, pad);
    const cmd = editRaster(s.doc, { kind: 'layer', layerId: l.id }, 'Patch', (raster, ox, oy) => {
      const dst = destination ? { ...work, x: work.x + dx, y: work.y + dy } : work;
      const src = destination ? work : { ...work, x: work.x + dx, y: work.y + dy };
      const cur = raster.readFloat({ x: dst.x - ox, y: dst.y - oy, w: dst.w, h: dst.h });
      const sp = raster.readFloat({ x: src.x - ox, y: src.y - oy, w: src.w, h: src.h });
      const healed = healColors(sp, cur, work.w, work.h, Math.max(3, Math.min(work.w, work.h) / 8));
      const covR = sel.read(work);
      const cov = dilateMask(covR, work.w, work.h, 1);
      for (let i = 0; i < work.w * work.h; i++) {
        const k = cov[i];
        if (k <= 0) continue;
        for (let c = 0; c < 4; c++) cur[i * 4 + c] += (healed[i * 4 + c] - cur[i * 4 + c]) * k;
      }
      raster.writeFloat({ x: dst.x - ox, y: dst.y - oy, w: dst.w, h: dst.h }, cur);
      return dst;
    });
    if (cmd) s.push(cmd, true);
  }
  cancel(h: ToolHost) {
    this.lasso = null;
    this.dragStart = null;
    h.redraw();
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    if (this.lasso && this.lasso.length > 1) strokeDocPath(h, g, this.lasso, false);
    if (this.dragStart) {
      const b = h.session.doc.selection.bounds(h.session.doc.bounds);
      if (b) strokeDocPath(h, g, [{ x: b.x + this.offset.dx, y: b.y + this.offset.dy }, { x: b.x + b.w + this.offset.dx, y: b.y + this.offset.dy }, { x: b.x + b.w + this.offset.dx, y: b.y + b.h + this.offset.dy }, { x: b.x + this.offset.dx, y: b.y + b.h + this.offset.dy }], true);
    }
  }
}
