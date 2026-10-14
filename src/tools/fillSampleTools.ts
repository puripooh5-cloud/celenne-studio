/** Gradient, Paint Bucket, Eyedropper, Color Sampler and Ruler tools. */
import { decodeColor, isCmykDoc, isLabDoc, plateCount, readPlates } from '../color/plates';
import { compositeStraightPlate } from '../app/ops/common';
import type { RGB } from '../color/types';
import { editColor, editGradient, editPattern } from '../color/plates';
import type { Tool, ToolHost, ToolPointer } from './tool';
import { opts, toast } from './helpers';
import { ui, useApp } from '../app/store';
import { editRaster } from '../commands/rasterCommands';
import { buildGradientLUT, renderGradient } from '../color/gradient';
import { simpleGradient, transparentGradient, Gradient } from '../color/types';
import { blendStraightPixel } from '../image-engine/blend';
import { floodRegion } from '../selection/ops';
import { compositeStraight, samplingImage } from '../app/ops/common';
import { hasRaster } from '../document/types';
import { editor } from '../app/editor';

export function gradientPresets(): Gradient[] {
  const { fg, bg } = useApp.getState();
  return [
    simpleGradient(fg, bg, 'Foreground to Background'),
    transparentGradient(fg),
    simpleGradient({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }, 'Black, White'),
    {
      name: 'Spectrum',
      colorStops: [[1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 0, 0]].map((c, i, a) => ({ location: i / (a.length - 1), color: { r: c[0], g: c[1], b: c[2] }, midpoint: 0.5 })),
      alphaStops: [{ location: 0, opacity: 1, midpoint: 0.5 }, { location: 1, opacity: 1, midpoint: 0.5 }],
      smoothness: 1,
    },
    {
      name: 'Copper',
      colorStops: [{ location: 0, color: { r: 0.59, g: 0.24, b: 0.11 }, midpoint: 0.5 }, { location: 0.5, color: { r: 1, g: 0.84, b: 0.66 }, midpoint: 0.5 }, { location: 1, color: { r: 0.44, g: 0.2, b: 0.09 }, midpoint: 0.5 }],
      alphaStops: [{ location: 0, opacity: 1, midpoint: 0.5 }, { location: 1, opacity: 1, midpoint: 0.5 }],
      smoothness: 1,
    },
    {
      name: 'Chrome',
      colorStops: [{ location: 0, color: { r: 0.16, g: 0.24, b: 0.35 }, midpoint: 0.5 }, { location: 0.48, color: { r: 0.95, g: 0.97, b: 1 }, midpoint: 0.5 }, { location: 0.5, color: { r: 0.3, g: 0.22, b: 0.12 }, midpoint: 0.5 }, { location: 1, color: { r: 0.98, g: 0.92, b: 0.8 }, midpoint: 0.5 }],
      alphaStops: [{ location: 0, opacity: 1, midpoint: 0.5 }, { location: 1, opacity: 1, midpoint: 0.5 }],
      smoothness: 1,
    },
  ];
}

export let customGradient: Gradient | null = null;
export function setCustomGradient(g: Gradient | null) {
  customGradient = g;
  ui.bump('viewRev');
}

export function currentGradient(): Gradient {
  const o = opts().gradient;
  if (o.presetIndex < 0 && customGradient) return customGradient;
  const p = gradientPresets();
  return p[Math.max(0, Math.min(p.length - 1, o.presetIndex))];
}

export class GradientTool implements Tool {
  id = 'gradient' as const;
  private a: { x: number; y: number } | null = null;
  private b: { x: number; y: number } | null = null;
  cursor() {
    return 'crosshair';
  }
  busy() {
    return !!this.a;
  }
  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    const qm = useApp.getState().quickMask;
    if (!s.paintTarget(qm)) return toast(s.paintBlockReason(qm) ?? 'Cannot draw a gradient here.');
    this.a = { x: p.x, y: p.y };
    this.b = { x: p.x, y: p.y };
  }
  move(h: ToolHost, p: ToolPointer) {
    if (!this.a) return;
    let x = p.x, y = p.y;
    if (p.shift) {
      const ang = Math.round(Math.atan2(y - this.a.y, x - this.a.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(x - this.a.x, y - this.a.y);
      x = this.a.x + Math.cos(ang) * len;
      y = this.a.y + Math.sin(ang) * len;
    }
    this.b = { x, y };
    h.redraw();
  }
  up(h: ToolHost) {
    const a = this.a, b = this.b;
    this.a = this.b = null;
    h.redraw();
    if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) < 1) return;
    const s = h.session;
    const qm = useApp.getState().quickMask;
    const target = s.paintTarget(qm);
    if (!target) return;
    const o = opts().gradient;
    const lutFor = (plate: number) => {
      const lut = buildGradientLUT(editGradient(s.doc, currentGradient(), plate), o.reverse);
      if (!o.transparency) for (let i = 3; i < lut.length; i += 4) lut[i] = 1;
      return lut;
    };
    const sel = s.doc.selection;
    const useSel = !sel.isEmpty() && target.kind !== 'selection';
    const region = useSel ? sel.bounds(s.doc.bounds) : s.doc.bounds;
    if (!region) return toast('The selection is outside the canvas.');
    const layer = s.activeLayer();
    const lockA = target.kind === 'layer' && !!layer?.locks.transparency;
    const cmd = editRaster(s.doc, target, 'Gradient', (raster, ox, oy, plate) => {
      const lr = { x: region.x - ox, y: region.y - oy, w: region.w, h: region.h };
      const cur = raster.readFloat(lr);
      const grad = renderGradient({ type: o.type, x0: a.x, y0: a.y, x1: b.x, y1: b.y }, lutFor(raster.channels === 4 ? plate : 0), region, 1, o.dither);
      const cov = sel.isEmpty() || target.kind === 'selection' ? null : sel.read(region);
      for (let i = 0; i < region.w * region.h; i++) {
        const k = (cov ? cov[i] : 1) * o.opacity;
        if (k <= 0) continue;
        if (raster.channels === 4) blendStraightPixel(o.blendMode, cur, i * 4, grad[i * 4], grad[i * 4 + 1], grad[i * 4 + 2], grad[i * 4 + 3] * k, lockA);
        else {
          const g = 0.3 * grad[i * 4] + 0.59 * grad[i * 4 + 1] + 0.11 * grad[i * 4 + 2];
          cur[i] += (g - cur[i]) * k * grad[i * 4 + 3];
        }
      }
      raster.writeFloat(lr, cur);
      return region;
    });
    if (cmd) s.push(cmd, true);
  }
  cancel(h: ToolHost) {
    this.a = this.b = null;
    h.redraw();
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    if (!this.a || !this.b) return;
    const v = h.session.view;
    const pa = v.docToScreen(this.a.x, this.a.y), pb = v.docToScreen(this.b.x, this.b.y);
    g.save();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.beginPath(); g.moveTo(pa.x, pa.y); g.lineTo(pb.x, pb.y); g.stroke();
    g.lineWidth = 1;
    g.strokeStyle = '#fff';
    g.stroke();
    for (const p of [pa, pb]) { g.beginPath(); g.arc(p.x, p.y, 4, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); g.stroke(); }
    g.restore();
  }
}

export class PaintBucketTool implements Tool {
  id = 'paintBucket' as const;
  cursor() {
    return 'crosshair';
  }
  down(h: ToolHost, p: ToolPointer) {
    const s = h.session;
    const qm = useApp.getState().quickMask;
    const target = s.paintTarget(qm);
    if (!target) return toast(s.paintBlockReason(qm) ?? 'Cannot fill here.');
    if (p.x < 0 || p.y < 0 || p.x >= s.doc.width || p.y >= s.doc.height) return;
    const o = opts().bucket;
    const region = floodRegion(samplingImage(s, o.sampleAllLayers), p.x, p.y, o.tolerance, o.contiguous, o.antiAlias);
    const b = region.contentBounds();
    if (!b) return;
    const sel = s.doc.selection;
    const fg = useApp.getState().fg;
    const pat0 = o.fill === 'pattern' ? [...s.doc.patterns.values()][0] : null;
    if (o.fill === 'pattern' && !pat0) return toast('Define a pattern first (Edit › Define Pattern).');
    const layer = s.activeLayer();
    const lockA = target.kind === 'layer' && !!layer?.locks.transparency;
    const cmd = editRaster(s.doc, target, 'Paint Bucket', (raster, ox, oy, plate) => {
      const pat = pat0 ? editPattern(s.doc, pat0.id, raster.channels === 4 ? plate : 0) ?? pat0 : null;
      const pcache = pat ? pat.raster.readFloat({ x: 0, y: 0, w: pat.width, h: pat.height }) : null;
      const fgc = raster.channels === 4 ? editColor(s.doc, fg, plate) : fg;
      const lr = { x: b.x - ox, y: b.y - oy, w: b.w, h: b.h };
      const cur = raster.readFloat(lr);
      const m = region.readFloat(b);
      const cov = sel.isEmpty() || target.kind === 'selection' ? null : sel.read(b);
      for (let y = 0; y < b.h; y++)
        for (let x = 0; x < b.w; x++) {
          const i = y * b.w + x;
          const k = m[i] * (cov ? cov[i] : 1) * o.opacity;
          if (k <= 0) continue;
          let c = fgc, a = 1;
          if (pat && pcache) {
            const px = (((b.x + x) % pat.width) + pat.width) % pat.width, py = (((b.y + y) % pat.height) + pat.height) % pat.height;
            const si = (py * pat.width + px) * 4;
            c = { r: pcache[si], g: pcache[si + 1], b: pcache[si + 2] };
            a = pcache[si + 3];
          }
          if (raster.channels === 4) blendStraightPixel(o.blendMode, cur, i * 4, c.r, c.g, c.b, k * a, lockA);
          else cur[i] += (0.3 * c.r + 0.59 * c.g + 0.11 * c.b - cur[i]) * k;
        }
      raster.writeFloat(lr, cur);
      return b;
    });
    if (cmd) s.push(cmd, true);
  }
}

/** Samples a color (averaged over the configured sample size). */
export function sampleColor(h: ToolHost, x: number, y: number, allLayers: boolean, size: number): (RGB & { a: number }) | null {
  const s = h.session;
  const half = Math.floor(size / 2);
  const r = { x: Math.floor(x) - half, y: Math.floor(y) - half, w: size, h: size };
  if (isCmykDoc(s.doc) || isLabDoc(s.doc)) {
    // Exact stored values (CMYK ink / Lab), averaged per plate.
    const l = s.activeLayer();
    let plates: Float32Array[];
    if (!allLayers && l && hasRaster(l)) plates = readPlates(s.doc, l.raster, { x: r.x - l.x, y: r.y - l.y, w: r.w, h: r.h });
    else {
      if (x < 0 || y < 0 || x >= s.doc.width || y >= s.doc.height) return null;
      plates = Array.from({ length: plateCount(s.doc) }, (_, p) => compositeStraightPlate(s, r, p));
    }
    let A = 0;
    const sums = plates.map(() => [0, 0, 0]);
    for (let i = 0; i < size * size; i++) {
      const a = plates[0][i * 4 + 3];
      A += a;
      plates.forEach((p, k) => { sums[k][0] += p[i * 4] * a; sums[k][1] += p[i * 4 + 1] * a; sums[k][2] += p[i * 4 + 2] * a; });
    }
    if (A <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return { ...decodeColor(s.doc, sums.map((v) => v.map((q) => q / A))), a: A / (size * size) };
  }
  let px: Float32Array;
  const l = s.activeLayer();
  if (!allLayers && l && hasRaster(l)) px = l.raster.readFloat({ x: r.x - l.x, y: r.y - l.y, w: r.w, h: r.h });
  else {
    if (x < 0 || y < 0 || x >= s.doc.width || y >= s.doc.height) return null;
    px = compositeStraight(s, r);
  }
  let R = 0, G = 0, B = 0, A = 0;
  for (let i = 0; i < size * size; i++) {
    const a = px[i * 4 + 3];
    R += px[i * 4] * a; G += px[i * 4 + 1] * a; B += px[i * 4 + 2] * a; A += a;
  }
  if (A <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return { r: R / A, g: G / A, b: B / A, a: A / (size * size) };
}

export class EyedropperTool implements Tool {
  id = 'eyedropper' as const;
  private down_ = false;
  cursor() {
    return 'crosshair';
  }
  busy() {
    return this.down_;
  }
  private pick(h: ToolHost, p: ToolPointer) {
    const o = opts().eyedropper;
    const c = sampleColor(h, p.x, p.y, o.sampleAllLayers, o.sampleSize);
    if (!c || c.a <= 0) return;
    const rgb = { r: c.r, g: c.g, b: c.b };
    if (p.alt) editor.setBackground(rgb);
    else editor.setForeground(rgb);
  }
  down(h: ToolHost, p: ToolPointer) {
    this.down_ = true;
    this.pick(h, p);
  }
  move(h: ToolHost, p: ToolPointer) {
    if (this.down_) this.pick(h, p);
  }
  up() {
    this.down_ = false;
  }
}

export class ColorSamplerTool implements Tool {
  id = 'colorSampler' as const;
  private dragging = -1;
  cursor() {
    return 'crosshair';
  }
  down(h: ToolHost, p: ToolPointer) {
    const samplers = useApp.getState().samplers;
    const v = h.session.view;
    const hit = samplers.findIndex((sp) => { const s = v.docToScreen(sp.x, sp.y); return Math.hypot(s.x - p.sx, s.y - p.sy) < 8; });
    if (hit >= 0 && p.alt) {
      ui.set({ samplers: samplers.filter((_, i) => i !== hit) });
      h.redraw();
      return;
    }
    if (hit >= 0) {
      this.dragging = hit;
      return;
    }
    if (samplers.length >= 10) return toast('A maximum of 10 color samplers is supported.');
    ui.set({ samplers: [...samplers, { x: Math.floor(p.x), y: Math.floor(p.y) }] });
    h.redraw();
  }
  move(h: ToolHost, p: ToolPointer) {
    if (this.dragging < 0) return;
    const samplers = [...useApp.getState().samplers];
    samplers[this.dragging] = { x: Math.floor(p.x), y: Math.floor(p.y) };
    ui.set({ samplers });
    h.redraw();
  }
  up() {
    this.dragging = -1;
  }
}

export class RulerTool implements Tool {
  id = 'ruler' as const;
  private start: { x: number; y: number } | null = null;
  cursor() {
    return 'crosshair';
  }
  down(_h: ToolHost, p: ToolPointer) {
    this.start = { x: p.x, y: p.y };
    ui.set({ measure: { x0: p.x, y0: p.y, x1: p.x, y1: p.y } });
  }
  move(h: ToolHost, p: ToolPointer) {
    if (!this.start) return;
    let x = p.x, y = p.y;
    if (p.shift) {
      const ang = Math.round(Math.atan2(y - this.start.y, x - this.start.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(x - this.start.x, y - this.start.y);
      x = this.start.x + Math.cos(ang) * len;
      y = this.start.y + Math.sin(ang) * len;
    }
    ui.set({ measure: { x0: this.start.x, y0: this.start.y, x1: x, y1: y } });
    h.redraw();
  }
  up() {
    this.start = null;
  }
  drawOverlay(h: ToolHost, g: CanvasRenderingContext2D) {
    const m = useApp.getState().measure;
    if (!m) return;
    const v = h.session.view;
    const a = v.docToScreen(m.x0, m.y0), b = v.docToScreen(m.x1, m.y1);
    g.save();
    g.strokeStyle = '#000';
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    g.strokeStyle = '#ffd400';
    g.lineWidth = 1;
    g.stroke();
    const len = Math.hypot(m.x1 - m.x0, m.y1 - m.y0), ang = (-Math.atan2(m.y1 - m.y0, m.x1 - m.x0) * 180) / Math.PI;
    g.fillStyle = 'rgba(20,20,24,0.85)';
    g.fillRect(b.x + 8, b.y + 8, 130, 18);
    g.fillStyle = '#eee';
    g.font = '11px system-ui, sans-serif';
    g.fillText(`L: ${len.toFixed(1)} px  A: ${ang.toFixed(1)}°`, b.x + 12, b.y + 21);
    g.restore();
  }
}
