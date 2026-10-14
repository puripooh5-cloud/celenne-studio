/** Image ▸ Mode: Indexed Color, Bitmap and Color Table (native single-layer modes). */
import { ui } from '../store';
import { need } from './common';
import { recordStateChange } from '../../history/history';
import { flattenToPixels } from '../../rendering/flatten';
import { createPixelLayer } from '../../document/layerFactory';
import { TiledRaster } from '../../image-engine/tiledRaster';
import { buildPalette, IndexedOptions, quantize, toBitmap, BitmapOptions } from '../../color/indexed';
import { conformAfterStep, isSingleLayerMode, markConformed } from '../../color/modeConform';
import { addHistoryHook, DocumentSession } from '../session';
import { builtinProfileName } from '../../color/icc';
import { platform } from '../platform/platform';
import { editor } from '../editor';
import { colorEngine } from '../../color/cms';
import { convertDocumentColor, ModeTarget } from '../../color/convertDocument';
import { workingCmykProfile } from '../colorSettings';
import type { ColorProfileRef } from '../../document/types';
import type { DuotoneSpec } from '../../color/inks';
import { duotoneToRgb, fromMultichannel, mergeSpotChannel, mergeSpotUnavailable, toMultichannel } from '../../color/inkModes';

addHistoryHook((s: DocumentSession) => {
  const msg = conformAfterStep(s.doc, s.history);
  if (msg) ui.toast('info', msg);
});

/** The flattened document as 8-bit straight RGBA (transparency kept). */
function composite8(s: DocumentSession): Uint8ClampedArray {
  const f = flattenToPixels(s.doc, { depth: 8 });
  return f.data as Uint8ClampedArray;
}

async function confirmFlatten(s: DocumentSession, mode: string): Promise<boolean> {
  const layers = s.doc.allLayers().length;
  if (layers <= 1 && s.doc.root.children[0]?.kind === 'pixel') return true;
  const r = await platform().confirm(`Flatten image?`, `${mode} documents have a single layer: the ${layers} layers will be flattened. You can undo this step.`, ['Flatten', 'Cancel']);
  return r === 0;
}

function replaceWithSingleLayer(s: DocumentSession, rgba: Uint8ClampedArray): void {
  const d = s.doc;
  const raster = TiledRaster.fromPixels(d.width, d.height, 4, 8, rgba);
  const bg = createPixelLayer('Background', 8, raster);
  for (const l of [...d.root.children]) d.removeLayer(l);
  d.insertLayer(bg, d.root);
  d.channels = [];
  s.setActive(bg.id);
}

/** Image ▸ Mode ▸ Indexed Color. */
export async function convertToIndexed(o: IndexedOptions): Promise<void> {
  const s = need();
  if (!s) return;
  if (!(await confirmFlatten(s, 'Indexed Color'))) return;
  const p = ui.progress('Converting to Indexed Color…');
  try {
    await new Promise((r) => setTimeout(r, 16));
    const rgba = composite8(s);
    // A table slot is reserved for transparency only when the image has transparent pixels.
    const hasTransparency = o.transparency && rgba.some((v, i) => (i & 3) === 3 && v < 128);
    const pal = buildPalette(rgba, { ...o, transparency: hasTransparency });
    quantize(rgba, s.doc.width, s.doc.height, pal, { ...o, transparency: hasTransparency });
    recordStateChange(s.doc, s.history, 'Indexed Color', () => {
      replaceWithSingleLayer(s, rgba);
      if (s.doc.profile.builtin !== 'srgb' && s.doc.canvas.colorMode === 'grayscale') s.doc.profile = { name: builtinProfileName('srgb'), builtin: 'srgb' };
      s.doc.canvas = { ...s.doc.canvas, colorMode: 'indexed', bitDepth: 8, colorTable: pal, colorTableTransparent: hasTransparency };
      markConformed(s.doc);
    }, { action: 'image.mode.toIndexed', args: { ...o } as unknown as Record<string, unknown> });
    s.engine.invalidateAll();
    ui.toast('success', `Indexed Color: ${pal.length / 3} colors${hasTransparency ? ' + transparency' : ''}`);
  } finally {
    p.done();
  }
}

/** Image ▸ Mode ▸ Bitmap (from Grayscale, as in Photoshop; other modes pass through luminance). */
export async function convertToBitmap(o: BitmapOptions): Promise<void> {
  const s = need();
  if (!s) return;
  if (!(await confirmFlatten(s, 'Bitmap'))) return;
  const p = ui.progress('Converting to Bitmap…');
  try {
    await new Promise((r) => setTimeout(r, 16));
    const rgba = composite8(s);
    toBitmap(rgba, s.doc.width, s.doc.height, o, s.doc.canvas.resolution);
    recordStateChange(s.doc, s.history, 'Bitmap', () => {
      replaceWithSingleLayer(s, rgba);
      s.doc.profile = { name: builtinProfileName('gray22'), builtin: 'gray22' };
      s.doc.canvas = { ...s.doc.canvas, colorMode: 'bitmap', bitDepth: 8, colorTable: undefined, colorTableTransparent: undefined };
      markConformed(s.doc);
    }, { action: 'image.mode.toBitmap', args: { ...o } as unknown as Record<string, unknown> });
    s.engine.invalidateAll();
  } finally {
    p.done();
  }
}

/** Image ▸ Mode ▸ Color Table: replaces table entries and recolours the pixels that used them. */
export function setColorTable(table: number[], label = 'Color Table'): void {
  const s = need();
  if (!s || s.doc.canvas.colorMode !== 'indexed') return;
  const old = s.doc.canvas.colorTable ?? [];
  const n = Math.min(256, Math.floor(table.length / 3));
  const map = new Map<number, number>();
  for (let i = 0; i < Math.min(n, old.length / 3); i++) map.set((old[i * 3] << 16) | (old[i * 3 + 1] << 8) | old[i * 3 + 2], (table[i * 3] << 16) | (table[i * 3 + 1] << 8) | table[i * 3 + 2]);
  const layer = s.doc.root.children[0];
  recordStateChange(s.doc, s.history, label, () => {
    if (layer?.kind === 'pixel') {
      const b = s.doc.bounds;
      const f = layer.raster.readFloat(b);
      for (let i = 0; i < f.length; i += 4) {
        if (f[i + 3] < 0.5) continue;
        const k = (Math.round(f[i] * 255) << 16) | (Math.round(f[i + 1] * 255) << 8) | Math.round(f[i + 2] * 255);
        const v = map.get(k);
        if (v !== undefined && v !== k) { f[i] = (v >> 16) / 255; f[i + 1] = ((v >> 8) & 255) / 255; f[i + 2] = (v & 255) / 255; }
      }
      layer.raster.writeFloat(b, f);
    }
    s.doc.canvas = { ...s.doc.canvas, colorTable: table.slice(0, n * 3) };
    markConformed(s.doc);
  }, { action: 'image.colorTable', args: { table } });
  s.engine.invalidateAll();
}

/** Leaves Indexed / Bitmap for RGB or Grayscale (pixels are already exact; only the mode changes). */
export function leaveSingleLayerMode(mode: 'rgb' | 'grayscale'): boolean {
  const s = need();
  if (!s || !isSingleLayerMode(s.doc)) return false;
  const from = s.doc.canvas.colorMode;
  recordStateChange(s.doc, s.history, mode === 'rgb' ? 'RGB Color' : 'Grayscale', () => {
    const d = s.doc;
    if (mode === 'grayscale' && from === 'indexed') {
      const l = d.root.children[0];
      if (l?.kind === 'pixel') {
        const f = l.raster.readFloat(d.bounds);
        for (let i = 0; i < f.length; i += 4) { const g = 0.299 * f[i] + 0.587 * f[i + 1] + 0.114 * f[i + 2]; f[i] = f[i + 1] = f[i + 2] = g; }
        l.raster.writeFloat(d.bounds, f);
      }
    }
    d.profile = mode === 'rgb' ? { name: builtinProfileName('srgb'), builtin: 'srgb' } : { name: builtinProfileName('gray22'), builtin: 'gray22' };
    d.canvas = { ...d.canvas, colorMode: mode, colorTable: undefined, colorTableTransparent: undefined };
  }, { action: 'image.mode', args: { mode } });
  s.engine.invalidateAll();
  return true;
}

// ---------------------------------------------------------------------------------------------
// Duotone and Multichannel
// ---------------------------------------------------------------------------------------------
/** Live preview while the Duotone dialog is open (null restores `restore`). */
export function previewDuotone(spec: DuotoneSpec | null, restore: DuotoneSpec | undefined): void {
  const s = need();
  if (!s) return;
  s.doc.canvas = { ...s.doc.canvas, duotone: spec ?? restore };
  s.engine.invalidateAll();
  s.doc.emit({ type: 'channels' });
}

/** Image ▸ Mode ▸ Duotone: Grayscale → Duotone, or new inks for a Duotone document. */
export function setDuotone(spec: DuotoneSpec, before?: DuotoneSpec): void {
  const s = need();
  if (!s) return;
  if (s.doc.canvas.colorMode !== 'grayscale') { ui.toast('info', 'Duotone needs a Grayscale document.', 'Convert to Grayscale first (Image ▸ Mode ▸ Grayscale).'); return; }
  if (s.doc.canvas.bitDepth === 32) { ui.toast('info', 'Duotone documents are 8 or 16 bits/channel.'); return; }
  s.doc.canvas = { ...s.doc.canvas, duotone: before };
  const label = before ? 'Duotone Options' : 'Duotone';
  recordStateChange(s.doc, s.history, label, () => { s.doc.canvas = { ...s.doc.canvas, duotone: spec }; }, { action: 'image.duotone', args: { inks: spec.inks.map((i) => ({ name: i.name, color: { r: i.color.r, g: i.color.g, b: i.color.b }, curve: i.curve })), overprints: spec.overprints.map((c) => (c ? { r: c.r, g: c.g, b: c.b } : null)) } });
  s.engine.invalidateAll();
}

/** Image ▸ Mode ▸ Multichannel (flattens: Multichannel documents have no layers). */
export async function convertToMultichannel(): Promise<void> {
  const s = need();
  if (!s || s.doc.canvas.colorMode === 'multichannel') return;
  const layers = s.doc.allLayers().length;
  if (layers > 1 || (layers === 1 && s.doc.root.children[0]?.kind !== 'pixel')) {
    const r = await platform().confirm('Flatten image?', `Multichannel documents have no layers: the ${layers} layers are flattened into ink channels. You can undo this step.`, ['Flatten', 'Cancel']);
    if (r !== 0) return;
  }
  if (!(await colorEngine.init())) { ui.toast('error', 'Color management engine failed to load', colorEngine.error ?? undefined); return; }
  recordStateChange(s.doc, s.history, 'Multichannel', () => toMultichannel(s.doc), { action: 'image.mode', args: { mode: 'multichannel' } });
  s.setActive(null);
  s.activeChannelId = s.doc.channels[0]?.id ?? null;
  s.engine.invalidateAll();
  ui.toast('info', 'Multichannel: each channel is an ink.', 'Select a channel in the Channels panel to paint on it.');
}

/** Channels ▸ Merge Spot Channel (keeps the layers: the ink becomes masked Color Fill layers on top). */
export function mergeSpot(channelId: string): void {
  const s = need();
  if (!s) return;
  const why = mergeSpotUnavailable(s.doc, channelId);
  if (why) { ui.toast('info', why); return; }
  const name = s.doc.channels.find((c) => c.id === channelId)!.name;
  let topId: string | null = null;
  recordStateChange(s.doc, s.history, 'Merge Spot Channel', () => { topId = mergeSpotChannel(s.doc, channelId).id; }, { action: 'channel.mergeSpot', args: { name } });
  if (s.activeChannelId === channelId) s.activeChannelId = null;
  s.setActive(topId);
  s.engine.invalidateAll();
  ui.toast('info', `Merged spot channel “${name}”`, 'The ink is now Color Fill layers at the top of the layer stack, masked by the channel, so it prints and exports with the image. Undo restores the channel.');
}

/** Duotone / Multichannel → `target`. */
async function leaveInkMode(s: DocumentSession, target: ModeTarget, profile?: ColorProfileRef): Promise<void> {
  const d = s.doc;
  const c = editor.prefs.color;
  if (d.canvas.duotone && target === 'grayscale') {
    recordStateChange(d, s.history, 'Grayscale', () => { d.canvas = { ...d.canvas, duotone: undefined }; }, { action: 'image.mode', args: { mode: target } });
    s.engine.invalidateAll();
    return;
  }
  if (!(await colorEngine.init())) { ui.toast('error', 'Color management engine failed to load', colorEngine.error ?? undefined); return; }
  const label = { rgb: 'RGB Color', grayscale: 'Grayscale', cmyk: 'CMYK Color', lab: 'Lab Color' }[target];
  const prof: ColorProfileRef = target === 'cmyk' ? profile ?? workingCmykProfile()
    : target === 'lab' ? { name: 'Lab Color (D50)', builtin: 'labD50' }
      : target === 'grayscale' ? profile ?? { name: builtinProfileName('gray22'), builtin: 'gray22' }
        : profile ?? { name: builtinProfileName(c.workingRGB), builtin: c.workingRGB };
  recordStateChange(d, s.history, label, () => {
    let reached: ModeTarget = 'rgb';
    if (d.canvas.duotone) duotoneToRgb(d);
    else {
      reached = fromMultichannel(d, target === 'cmyk' ? 'cmyk' : 'rgb');
      if (reached === 'cmyk') d.profile = prof;
    }
    if (reached !== target || (target === 'rgb' && d.profile.builtin !== prof.builtin)) convertDocumentColor(d, target, prof, c.renderingIntent, c.blackPointCompensation);
  }, { action: 'image.mode', args: { mode: target } });
  const bg = d.root.children[0];
  if (bg) s.setActive(bg.id);
  s.activeChannelId = null;
  s.engine.invalidateAll();
}

/**
 * Image ▸ Mode ▸ RGB / Grayscale / CMYK / Lab through colour management. CMYK uses the working CMYK
 * profile (Preferences ▸ Color Management, or the built-in approximate profile).
 */
export async function convertColorMode(target: ModeTarget, profile?: ColorProfileRef): Promise<void> {
  const s = need();
  if (!s) return;
  const inkMode = !!s.doc.canvas.duotone || s.doc.canvas.colorMode === 'multichannel';
  if (s.doc.canvas.colorMode === target && !inkMode) return;
  if (inkMode) return leaveInkMode(s, target, profile);
  if (isSingleLayerMode(s.doc)) {
    if (target === 'rgb' || target === 'grayscale') { leaveSingleLayerMode(target); return; }
    leaveSingleLayerMode('rgb');
  }
  if (s.doc.canvas.bitDepth === 32 && (target === 'cmyk' || target === 'lab')) {
    ui.toast('info', 'CMYK and Lab documents are 8 or 16 bits/channel.', 'Convert to 16 Bits/Channel first (Image ▸ Mode).');
    return;
  }
  if (!(await colorEngine.init())) {
    ui.toast('error', 'Color management engine failed to load', colorEngine.error ?? undefined);
    return;
  }
  const c = editor.prefs.color;
  const prof: ColorProfileRef = target === 'cmyk' ? profile ?? workingCmykProfile()
    : target === 'lab' ? { name: 'Lab Color (D50)', builtin: 'labD50' }
      : target === 'grayscale' ? profile ?? { name: builtinProfileName('gray22'), builtin: 'gray22' }
        : profile ?? { name: builtinProfileName(c.workingRGB), builtin: c.workingRGB };
  const label = { rgb: 'RGB Color', grayscale: 'Grayscale', cmyk: 'CMYK Color', lab: 'Lab Color' }[target];
  const p = ui.progress(`Converting to ${label}…`);
  try {
    await new Promise((r) => setTimeout(r, 16));
    recordStateChange(s.doc, s.history, label, () => convertDocumentColor(s.doc, target, prof, c.renderingIntent, c.blackPointCompensation), { action: 'image.mode', args: { mode: target } });
    s.engine.invalidateAll();
    if (target === 'cmyk') ui.toast('success', `Converted to CMYK (${prof.name}).`);
  } catch (e) {
    ui.toast('error', `Could not convert to ${label}`, (e as Error).message);
  } finally {
    p.done();
  }
}
