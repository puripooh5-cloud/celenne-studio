/** Edit menu operations: history, clipboard, fill, stroke, content-aware fill, presets. */
import { editColor, editPattern, isCmykDoc, isLabDoc, plateCount, platesToRgb, readPlates, rgbToPlates } from '../../color/plates';
import { adoptLayers, convertRasterSpace, spaceOfDoc } from '../../color/convertDocument';
import { editor } from '../editor';
import { ui, useApp } from '../store';
import type { DocumentSession } from '../session';
import { need, needLayer, compositeStraight, compositeStraightPlate, layerAppearance, nextLayerName, insertionPoint, errorText } from './common';
import { editRaster } from '../../commands/rasterCommands';
import { CompositeCommand, CreateLayerCommand } from '../../commands/layerCommands';
import { cloneLayer } from '../../document/clone';
import { createMask, createPixelLayer } from '../../document/layerFactory';
import { hasRaster } from '../../document/types';
import { TiledRaster } from '../../image-engine/tiledRaster';
import { expand, intersect, isEmpty, Rect } from '../../image-engine/rect';
import { rasterContentBounds } from '../../rendering/bounds';
import { BlendMode, blendStraightPixel } from '../../image-engine/blend';
import type { RGB } from '../../color/types';
import { aiProvider } from '../../ai/provider';
import { dilateMask, erodeMask } from '../../image-engine/blur';
import { newId } from '../../document/ids';
import { encodePNG, decodePNG } from '../../formats/codecs';
import { documentFromImage } from '../../formats/registry';
import { layerContentBounds } from '../../rendering/bounds';
import { canvasSize, Anchor } from './imageOps';

export function undo(): void {
  const s = need();
  if (!s) return;
  editor.cancelTool();
  if (!s.history.undo()) ui.toast('info', 'Nothing to undo.', undefined, 1200);
}

export function redo(): void {
  const s = need();
  if (!s) return;
  editor.cancelTool();
  if (!s.history.redo()) ui.toast('info', 'Nothing to redo.', undefined, 1200);
}

/** Ctrl+Z toggles between undo and redo of the last step (classic behaviour); Ctrl+Alt+Z steps back. */
export function toggleLastStep(): void {
  const s = need();
  if (!s) return;
  if (s.history.canRedo && s.history.index === s.history.entries.length - 2) s.history.redo();
  else s.history.undo();
}

// ---------------------------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------------------------
function selectionOrLayerRegion(s: DocumentSession): Rect | null {
  const sel = s.doc.selection;
  if (!sel.isEmpty()) return sel.bounds(s.doc.bounds);
  const l = s.activeLayer();
  return l ? (layerContentBounds(l) ?? null) : null;
}

export async function copy(merged = false, cut = false): Promise<void> {
  const s = need();
  if (!s) return;
  const sel = s.doc.selection;
  const l = s.activeLayer();
  // Without a selection, copying a non-pixel layer copies the layer itself.
  if (sel.isEmpty() && !merged && l && (!hasRaster(l) || l.kind !== 'pixel')) {
    editor.clipboard = { kind: 'layers', layers: s.selectedLayers().map((x) => cloneLayer(x)), sourceDocId: s.doc.id, space: spaceOfDoc(s.doc) };
    if (cut) (await import('./layerOps')).deleteLayers();
    return;
  }
  let region = merged ? (sel.isEmpty() ? s.doc.bounds : sel.bounds(s.doc.bounds)) : selectionOrLayerRegion(s);
  if (!region) return;
  region = intersect(region, merged ? s.doc.bounds : region);
  if (isEmpty(region)) {
    ui.toast('info', 'The selected area is empty.');
    return;
  }
  // Document values for every plate (CMYK: C'M'Y' + K'), and the RGB appearance for other apps.
  let plates: Float32Array[];
  if (merged) plates = Array.from({ length: plateCount(s.doc) }, (_, p) => compositeStraightPlate(s, region!, p));
  else {
    if (!l || !hasRaster(l)) return;
    plates = readPlates(s.doc, l.raster, { x: region.x - l.x, y: region.y - l.y, w: region.w, h: region.h });
  }
  const cov = sel.isEmpty() ? null : sel.read(region);
  if (cov) for (const px of plates) for (let i = 0; i < region.w * region.h; i++) px[i * 4 + 3] *= cov[i];
  const raster = new TiledRaster(4, s.doc.canvas.bitDepth);
  raster.writeFloat({ x: 0, y: 0, w: region.w, h: region.h }, plates[0]);
  if (plates[1]) {
    raster.companion = new TiledRaster(4, s.doc.canvas.bitDepth);
    raster.companion.writeFloat({ x: 0, y: 0, w: region.w, h: region.h }, plates[1]);
  }
  editor.clipboard = { kind: 'pixels', raster, bounds: region, depth: s.doc.canvas.bitDepth, sourceDocId: s.doc.id, space: spaceOfDoc(s.doc) };
  const appearance = isCmykDoc(s.doc) || isLabDoc(s.doc) ? platesToRgb(s.doc, plates, region.w * region.h) : plates[0];
  writeSystemClipboard(appearance, region.w, region.h).catch(() => {});
  if (cut && !merged && l && l.kind === 'pixel') {
    if (l.locks.pixels || l.locks.all) {
      ui.toast('warning', `"${l.name}" is locked.`);
      return;
    }
    const lr = { x: region.x - l.x, y: region.y - l.y, w: region.w, h: region.h };
    const cmd = editRaster(s.doc, { kind: 'layer', layerId: l.id }, 'Cut Pixels', (r) => {
      const cur = r.readFloat(lr);
      for (let i = 0; i < region!.w * region!.h; i++) cur[i * 4 + 3] *= 1 - (cov ? cov[i] : 1);
      r.writeFloat(lr, cur);
      r.compact();
      return region!;
    }, { action: 'edit.cut' });
    if (cmd) s.push(cmd, true);
  }
}

async function writeSystemClipboard(px: Float32Array, w: number, h: number) {
  if (typeof navigator === 'undefined' || !navigator.clipboard || typeof ClipboardItem === 'undefined' || w * h > 64e6) return;
  const u8 = new Uint8ClampedArray(px.length);
  for (let i = 0; i < px.length; i++) u8[i] = px[i] * 255;
  const png = encodePNG(w, h, u8, 8);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png as BlobPart], { type: 'image/png' }) })]);
}

async function readSystemClipboardImage(): Promise<{ w: number; h: number; data: Float32Array } | null> {
  try {
    if (!navigator.clipboard?.read) return null;
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const bytes = new Uint8Array(await (await it.getType(type)).arrayBuffer());
      if (type === 'image/png') {
        const png = decodePNG(bytes);
        const max = png.depth === 16 ? 65535 : 255;
        const data = new Float32Array(png.width * png.height * 4);
        for (let i = 0; i < data.length; i++) data[i] = png.data[i] / max;
        return { w: png.width, h: png.height, data };
      }
    }
  } catch {
    /* permission denied or no image */
  }
  return null;
}

export async function paste(mode: 'normal' | 'inPlace' | 'into' = 'normal'): Promise<void> {
  const s = editor.active;
  const c = editor.clipboard;
  if (!s) {
    // Paste with no document: create one from the clipboard image.
    const img = await readSystemClipboardImage();
    if (img) {
      const px = new Uint8ClampedArray(img.data.length);
      for (let i = 0; i < px.length; i++) px[i] = img.data[i] * 255;
      editor.addDocument(documentFromImage('Clipboard', img.w, img.h, 8, px), 'Paste');
    }
    return;
  }
  if (c?.kind === 'layers') {
    const { parentId, index } = insertionPoint(s);
    const clones = c.layers.map((l) => cloneLayer(l, true));
    adoptLayers(s.doc, c.space ?? { mode: 'rgb', profile: { name: 'sRGB', builtin: 'srgb' } }, clones);
    const cmds = clones.map((cl, i) => new CreateLayerCommand('Paste Layer', cl, parentId, index + i));
    s.push(new CompositeCommand('Paste', cmds, { action: 'edit.paste' }));
    return;
  }
  let raster: TiledRaster, w: number, h: number, srcBounds: Rect | null = null;
  if (c?.kind === 'pixels') {
    raster = c.raster;
    w = c.bounds.w;
    h = c.bounds.h;
    srcBounds = c.bounds;
    if (c.depth !== s.doc.canvas.bitDepth) {
      const conv = new TiledRaster(4, s.doc.canvas.bitDepth);
      conv.writeFloat({ x: 0, y: 0, w, h }, raster.readFloat({ x: 0, y: 0, w, h }));
      if (raster.companion) {
        conv.companion = new TiledRaster(4, s.doc.canvas.bitDepth);
        conv.companion.writeFloat({ x: 0, y: 0, w, h }, raster.companion.readFloat({ x: 0, y: 0, w, h }));
      }
      raster = conv;
    } else raster = raster.clone();
    convertRasterSpace(raster, c.space ?? { mode: 'rgb', profile: { name: 'sRGB', builtin: 'srgb' } }, spaceOfDoc(s.doc));
  } else {
    const img = await readSystemClipboardImage();
    if (!img) {
      ui.toast('info', 'The clipboard is empty.');
      return;
    }
    w = img.w;
    h = img.h;
    raster = new TiledRaster(4, s.doc.canvas.bitDepth);
    raster.writeFloat({ x: 0, y: 0, w, h }, img.data);
    // Images from other apps are sRGB.
    convertRasterSpace(raster, { mode: 'rgb', profile: { name: 'sRGB', builtin: 'srgb' } }, spaceOfDoc(s.doc));
  }
  const sel = s.doc.selection;
  let x: number, y: number;
  if (mode === 'inPlace' && srcBounds) { x = srcBounds.x; y = srcBounds.y; }
  else {
    // Center on the selection, else on the visible canvas center.
    const target = (!sel.isEmpty() && sel.bounds(s.doc.bounds)) || s.doc.bounds;
    x = Math.round(target.x + (target.w - w) / 2);
    y = Math.round(target.y + (target.h - h) / 2);
  }
  const layer = createPixelLayer(nextLayerName(s), s.doc.canvas.bitDepth, raster.clone());
  layer.x = x;
  layer.y = y;
  if (mode === 'into' && !sel.isEmpty()) {
    layer.mask = createMask(false);
    layer.mask.raster = sel.mask.clone();
    layer.mask.linked = false;
  }
  const { parentId, index } = insertionPoint(s);
  s.push(new CreateLayerCommand(mode === 'into' ? 'Paste Into' : 'Paste', layer, parentId, index, { action: 'edit.paste', args: { mode } }));
  s.setActive(layer.id);
}

// ---------------------------------------------------------------------------------------------
// Clear / fill / stroke
// ---------------------------------------------------------------------------------------------
export function clear(): void {
  const r = needLayer();
  if (!r) return;
  const { s, l } = r;
  const sel = s.doc.selection;
  if (sel.isEmpty()) {
    (async () => (await import('./layerOps')).deleteLayers())();
    return;
  }
  const target = s.paintTarget(useApp.getState().quickMask);
  if (!target) {
    ui.toast('info', s.paintBlockReason(false) ?? 'Cannot clear this layer.');
    return;
  }
  const region = sel.bounds(s.doc.bounds);
  if (!region) {
    ui.toast('info', 'The selection is outside the canvas.');
    return;
  }
  const cmd = editRaster(s.doc, target, 'Clear', (raster, ox, oy, plate) => {
    const lr = { x: region.x - ox, y: region.y - oy, w: region.w, h: region.h };
    const cur = raster.readFloat(lr);
    const cov = sel.read(region);
    if (raster.channels === 4) {
      const lockA = l.locks.transparency;
      const bg = editColor(s.doc, useApp.getState().bg, plate);
      for (let i = 0; i < region.w * region.h; i++) {
        if (lockA) { cur[i * 4] += (bg.r - cur[i * 4]) * cov[i]; cur[i * 4 + 1] += (bg.g - cur[i * 4 + 1]) * cov[i]; cur[i * 4 + 2] += (bg.b - cur[i * 4 + 2]) * cov[i]; }
        else cur[i * 4 + 3] *= 1 - cov[i];
      }
    } else for (let i = 0; i < cur.length; i++) cur[i] *= 1 - cov[i];
    raster.writeFloat(lr, cur);
    raster.compact();
    return region;
  }, { action: 'edit.clear' });
  if (cmd) s.push(cmd, true);
}

export interface FillSpec {
  use: 'foreground' | 'background' | 'color' | 'black' | 'white' | 'gray' | 'pattern' | 'contentAware';
  color?: RGB;
  patternId?: string;
  mode: BlendMode;
  opacity: number;
  preserveTransparency: boolean;
}

export async function fill(spec: FillSpec): Promise<void> {
  const r = needLayer();
  if (!r) return;
  const { s, l } = r;
  if (spec.use === 'contentAware') return contentAwareFill();
  const target = s.paintTarget(useApp.getState().quickMask);
  if (!target) {
    ui.toast('info', s.paintBlockReason(false) ?? 'Cannot fill this layer.');
    return;
  }
  const st = useApp.getState();
  const color = spec.use === 'foreground' ? st.fg : spec.use === 'background' ? st.bg : spec.use === 'black' ? { r: 0, g: 0, b: 0 } : spec.use === 'white' ? { r: 1, g: 1, b: 1 } : spec.use === 'gray' ? { r: 0.5, g: 0.5, b: 0.5 } : spec.color ?? st.fg;
  const sel = s.doc.selection;
  const region = sel.isEmpty() ? s.doc.bounds : sel.bounds(s.doc.bounds);
  if (!region) {
    ui.toast('info', 'The selection is outside the canvas.');
    return;
  }
  const lockA = spec.preserveTransparency || l.locks.transparency;
  const cmd = editRaster(s.doc, target, 'Fill', (raster, ox, oy, plate) => {
    const pattern = spec.use === 'pattern' && spec.patternId ? editPattern(s.doc, spec.patternId, raster.channels === 4 ? plate : 0) : null;
    const pcache = pattern ? pattern.raster.readFloat({ x: 0, y: 0, w: pattern.width, h: pattern.height }) : null;
    const fillColor = raster.channels === 4 ? editColor(s.doc, color, plate) : color;
    const lr = { x: region.x - ox, y: region.y - oy, w: region.w, h: region.h };
    const cur = raster.readFloat(lr);
    const cov = sel.isEmpty() ? null : sel.read(region);
    for (let y = 0; y < region.h; y++)
      for (let x = 0; x < region.w; x++) {
        const i = y * region.w + x;
        const k = (cov ? cov[i] : 1) * spec.opacity;
        if (k <= 0) continue;
        let c = fillColor;
        let a = 1;
        if (pattern && pcache) {
          const px = (((region.x + x) % pattern.width) + pattern.width) % pattern.width, py = (((region.y + y) % pattern.height) + pattern.height) % pattern.height;
          const si = (py * pattern.width + px) * 4;
          c = { r: pcache[si], g: pcache[si + 1], b: pcache[si + 2] };
          a = pcache[si + 3];
        }
        if (raster.channels === 4) blendStraightPixel(spec.mode, cur, i * 4, c.r, c.g, c.b, k * a, lockA);
        else cur[i] += (0.3 * c.r + 0.59 * c.g + 0.11 * c.b - cur[i]) * k;
      }
    raster.writeFloat(lr, cur);
    return region;
  }, { action: 'edit.fill', args: spec as unknown as Record<string, unknown> });
  if (cmd) s.push(cmd, true);
}

export function strokeSelection(width: number, color: RGB, location: 'inside' | 'center' | 'outside', mode: BlendMode, opacity: number): void {
  const r = needLayer();
  if (!r) return;
  const { s, l } = r;
  const sel = s.doc.selection;
  if (sel.isEmpty()) {
    ui.toast('info', 'Make a selection first.');
    return;
  }
  const target = s.paintTarget(false);
  if (!target) {
    ui.toast('info', s.paintBlockReason(false) ?? 'Cannot stroke on this layer.');
    return;
  }
  const selB = sel.bounds(s.doc.bounds);
  if (!selB) {
    ui.toast('info', 'The selection is outside the canvas.');
    return;
  }
  const b = expand(selB, Math.ceil(width) + 2);
  const cov = sel.read(b);
  const outer = location === 'inside' ? cov : dilateMask(cov, b.w, b.h, location === 'center' ? width / 2 : width);
  const inner = location === 'outside' ? cov : erodeMask(cov, b.w, b.h, location === 'center' ? width / 2 : width);
  const cmd = editRaster(s.doc, target, 'Stroke', (raster, ox, oy, plate) => {
    const lr = { x: b.x - ox, y: b.y - oy, w: b.w, h: b.h };
    const cur = raster.readFloat(lr);
    const pc = editColor(s.doc, color, plate);
    for (let i = 0; i < b.w * b.h; i++) {
      const k = Math.max(0, outer[i] - inner[i]) * opacity;
      if (k <= 0) continue;
      if (raster.channels === 4) blendStraightPixel(mode, cur, i * 4, pc.r, pc.g, pc.b, k, l.locks.transparency);
      else cur[i] += (0.3 * color.r + 0.59 * color.g + 0.11 * color.b - cur[i]) * k;
    }
    raster.writeFloat(lr, cur);
    return b;
  }, { action: 'edit.stroke', args: { width, location, mode, opacity } });
  if (cmd) s.push(cmd, true);
}

// ---------------------------------------------------------------------------------------------
// Content-aware fill (also used by the Remove / Spot Healing tools)
// ---------------------------------------------------------------------------------------------
/**
 * Fills `mask` (document-space coverage) on the active pixel layer from surrounding content.
 * Returns false when not possible.
 */
export async function inpaintRegion(s: DocumentSession, mask: TiledRaster, label: string, sampleAll = false, toNewLayer = false, prompt?: string): Promise<boolean> {
  const l = s.activeLayer();
  if (!l || (l.kind !== 'pixel' && !toNewLayer)) {
    ui.toast('info', 'Content-aware fill requires a pixel layer (or sampling all layers to a new layer).');
    return false;
  }
  const mb = mask.contentBounds();
  if (!mb) return false;
  const margin = Math.max(48, Math.round(Math.max(mb.w, mb.h) * 1.2));
  const work = intersect(expand(mb, margin), s.doc.bounds);
  if (isEmpty(work)) return false;
  if (work.w * work.h > 8e6) {
    ui.toast('warning', 'The fill area is very large; this may take a while.');
  }
  // Patches are matched on the image's appearance (RGB). CMYK / Lab documents carry their native
  // plates through the same patches, so the fill keeps the image's real inks (K included).
  const src = sampleAll || !hasRaster(l) ? compositeStraight(s, work) : layerAppearance(s, l, work);
  const native = isCmykDoc(s.doc) || isLabDoc(s.doc);
  const provider = aiProvider();
  const carry = native && !prompt && provider.inpaintPlates
    ? (sampleAll || !hasRaster(l)
      ? Array.from({ length: plateCount(s.doc) }, (_, k) => compositeStraightPlate(s, work, k))
      : readPlates(s.doc, l.raster, { x: work.x - l.x, y: work.y - l.y, w: work.w, h: work.h }))
    : null;
  const m = mask.readFloat(work);
  const hole = new Uint8Array(work.w * work.h);
  for (let i = 0; i < hole.length; i++) hole[i] = m[i] > 0.02 ? 1 : 0;
  let cancelled = false;
  const p = ui.progress(`${label}…`, () => { cancelled = true; });
  try {
    await new Promise((r) => setTimeout(r, 16));
    const req = { image: src, width: work.w, height: work.h, mask: hole, prompt };
    let result: Float32Array;
    let resultPlates: Float32Array[];
    if (carry) {
      const r = await provider.inpaintPlates!(req, carry, () => cancelled, (f) => p.update(f));
      result = r.image;
      resultPlates = r.plates;
    } else {
      // Generated content (or a provider that works in RGB only) is separated by the profile.
      result = await provider.inpaint(req, () => cancelled, (f) => p.update(f));
      resultPlates = native ? rgbToPlates(s.doc, result, work.w * work.h) : [result];
    }
    if (cancelled) return false;
    // Blend with soft mask edges.
    const soft = m;
    if (toNewLayer || l.kind !== 'pixel') {
      const nl = createPixelLayer(nextLayerName(s), s.doc.canvas.bitDepth);
      resultPlates.forEach((pl, k) => {
        const out = new Float32Array(pl.length);
        for (let i = 0; i < work.w * work.h; i++) { out.set(pl.subarray(i * 4, i * 4 + 3), i * 4); out[i * 4 + 3] = soft[i] * result[i * 4 + 3]; }
        const target = k === 0 ? nl.raster : (nl.raster.companion = new TiledRaster(4, s.doc.canvas.bitDepth));
        target.writeFloat(work, out);
        target.compact();
      });
      const { parentId, index } = insertionPoint(s);
      s.push(new CreateLayerCommand(label, nl, parentId, index));
      return true;
    }
    const cmd = editRaster(s.doc, { kind: 'layer', layerId: l.id }, label, (raster, ox, oy, plate) => {
      const lr = { x: work.x - ox, y: work.y - oy, w: work.w, h: work.h };
      const cur = raster.readFloat(lr);
      const res = resultPlates[plate] ?? result;
      for (let i = 0; i < work.w * work.h; i++) {
        const k = soft[i];
        if (k <= 0) continue;
        for (let c = 0; c < 4; c++) cur[i * 4 + c] += (res[i * 4 + c] - cur[i * 4 + c]) * k;
      }
      raster.writeFloat(lr, cur);
      return work;
    }, undefined, { labRaw: true });
    if (cmd) s.push(cmd, true);
    return true;
  } catch (e) {
    if (!cancelled) ui.toast('error', `${label} failed`, errorText(e));
    return false;
  } finally {
    p.done();
  }
}

export async function contentAwareFill(): Promise<void> {
  const s = need();
  if (!s) return;
  if (s.doc.selection.isEmpty()) {
    ui.toast('info', 'Select the area to fill first.');
    return;
  }
  // Slightly expand so the fill blends into its surroundings.
  const m = s.doc.selection.mask.clone();
  const b = s.doc.selection.bounds(s.doc.bounds);
  if (!b) {
    ui.toast('info', 'The selection is outside the canvas.');
    return;
  }
  const r = expand(b, 3);
  m.writeFloat(r, dilateMask(m.readFloat(r), r.w, r.h, 2));
  await inpaintRegion(s, m, 'Content-Aware Fill');
}

/**
 * Generative Fill: fills the selection from a text prompt on a new layer (non-destructive).
 * Needs a provider with generative capability (Cloud endpoint or a plugin model).
 */
export async function generativeFill(): Promise<void> {
  const s = need();
  if (!s) return;
  if (s.doc.selection.isEmpty()) {
    ui.toast('info', 'Select the area to fill first.');
    return;
  }
  const provider = aiProvider();
  if (!provider.capabilities().generativeFill) {
    ui.toast('info', `Generative Fill is not available with the "${provider.label}" AI provider.`, 'Configure a Cloud endpoint or install a plugin model in Preferences ▸ AI. Content-Aware Fill works offline.', 9000);
    return;
  }
  const { promptText } = await import('../../ui/prompt');
  const prompt = await promptText('Generative Fill', '', 'Describe what to generate (leave empty to fill from surroundings)');
  if (prompt === null) return;
  const m = s.doc.selection.mask.clone();
  const b = s.doc.selection.bounds(s.doc.bounds);
  if (!b) {
    ui.toast('info', 'The selection is outside the canvas.');
    return;
  }
  const r = expand(b, 3);
  m.writeFloat(r, dilateMask(m.readFloat(r), r.w, r.h, 2));
  await inpaintRegion(s, m, 'Generative Fill', true, true, prompt.trim() || undefined);
}

/**
 * Generative Expand: enlarges the canvas and fills the new area on a new layer — from a prompt
 * with a generative provider, or content-aware (PatchMatch) with the local provider.
 */
export async function generativeExpand(width: number, height: number, anchor: Anchor, prompt?: string): Promise<boolean> {
  const s = need();
  if (!s) return false;
  const d = s.doc;
  if (width < d.width || height < d.height) {
    ui.toast('info', 'Generative Expand only enlarges the canvas.', 'Use Crop or Canvas Size to make it smaller.');
    return false;
  }
  if (width === d.width && height === d.height) return false;
  const provider = aiProvider();
  const generative = provider.capabilities().generativeExpand;
  if (prompt && !generative) ui.toast('info', `The "${provider.label}" provider has no generative model; the new area is filled content-aware from the image (the prompt is not used).`, undefined, 7000);
  const ax = anchor.includes('l') ? 0 : anchor.includes('r') ? 1 : 0.5;
  const ay = anchor.startsWith('t') ? 0 : anchor.startsWith('b') ? 1 : 0.5;
  const dx = Math.round((width - d.width) * ax), dy = Math.round((height - d.height) * ay);
  const old = { x: dx, y: dy, w: d.width, h: d.height };
  canvasSize(width, height, anchor, null);
  // Hole = new canvas area (slightly overlapping the old edge so the fill blends in).
  const hole = new TiledRaster(1, 8, 0);
  const full = new Float32Array(width * height).fill(1);
  const inner = { x: old.x + 2, y: old.y + 2, w: Math.max(0, old.w - 4), h: Math.max(0, old.h - 4) };
  for (let y = inner.y; y < inner.y + inner.h; y++) full.fill(0, y * width + inner.x, y * width + inner.x + inner.w);
  hole.writeFloat({ x: 0, y: 0, w: width, h: height }, full);
  hole.compact();
  return inpaintRegion(s, hole, 'Generative Expand', true, true, generative ? prompt : undefined);
}

// ---------------------------------------------------------------------------------------------
// Define pattern / brush
// ---------------------------------------------------------------------------------------------
export function definePattern(name?: string): void {
  const s = need();
  if (!s) return;
  const region = s.doc.selection.isEmpty() ? s.doc.bounds : s.doc.selection.bounds(s.doc.bounds);
  if (!region) {
    ui.toast('info', 'The selection is outside the canvas.');
    return;
  }
  if (region.w * region.h > 4096 * 4096) {
    ui.toast('warning', 'Pattern is too large (max 4096×4096).');
    return;
  }
  const px = compositeStraight(s, region);
  const raster = new TiledRaster(4, 8);
  raster.writeFloat({ x: 0, y: 0, w: region.w, h: region.h }, px);
  const id = newId('pat');
  s.doc.patterns.set(id, { id, name: name ?? `Pattern ${s.doc.patterns.size + 1}`, width: region.w, height: region.h, raster });
  ui.toast('success', `Pattern defined (${region.w}×${region.h})`);
  ui.bump('docRev');
}

export function defineBrush(name?: string): void {
  const s = need();
  if (!s) return;
  const region = s.doc.selection.isEmpty() ? null : s.doc.selection.bounds(s.doc.bounds);
  if (!region) {
    ui.toast('info', 'Select the brush shape first (dark pixels become paint).');
    return;
  }
  const max = 512;
  const scale = Math.min(1, max / Math.max(region.w, region.h));
  const w = Math.max(1, Math.round(region.w * scale)), h = Math.max(1, Math.round(region.h * scale));
  const px = compositeStraight(s, region);
  const data: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (Math.min(region.h - 1, Math.floor(y / scale)) * region.w + Math.min(region.w - 1, Math.floor(x / scale))) * 4;
      const L = 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2];
      data.push(Math.round((1 - L) * px[i + 3] * 255));
    }
  const st = useApp.getState();
  const preset = { ...st.brush, name: name ?? `Sampled Brush ${st.brushPresets.length + 1}`, tip: 'sampled' as const, tipImage: { width: w, height: h, data }, size: Math.max(region.w, region.h), spacing: 0.25 };
  ui.set({ brushPresets: [...st.brushPresets, preset], brush: preset });
  ui.toast('success', `Brush preset "${preset.name}" defined.`);
}

export function purgeHistory(): void {
  const s = need();
  if (!s) return;
  s.history.clear('Purged');
  for (const l of s.doc.walk()) if (hasRaster(l)) l.raster.purgeMips();
  s.engine.purge();
  ui.toast('info', 'History and caches purged.');
}

export { rasterContentBounds };
