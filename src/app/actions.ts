/**
 * Action registry. Menus, keyboard shortcuts, the command palette, recorded macros and plugins
 * all invoke application functionality through these ids.
 */
import { editor } from './editor';
import { ui, useApp } from './store';
import * as file from './fileOps';
import * as layer from './ops/layerOps';
import * as sel from './ops/selectOps';
import * as img from './ops/imageOps';
import * as mode from './ops/modeOps';
import { DEFAULT_BITMAP, DEFAULT_INDEXED, type BitmapOptions, type IndexedOptions } from '../color/indexed';
import * as edit from './ops/editOps';
import * as filt from './ops/filterOps';
import * as view from './ops/viewOps';
import { ADJUSTMENT_LABELS, AdjustmentType, defaultAdjustment } from '../adjustments/types';
import { allFilters } from '../filters/builtin';
import type { RecordedOp } from '../history/history';
import type { BlendMode } from '../image-engine/blend';
import { simpleGradient } from '../color/types';
import { CompositeCommand, CreateLayerCommand, SetEffectsCommand, SetLayerPropsCommand, TranslateLayersCommand } from '../commands/layerCommands';
import { createShapeLayer, createTextLayer } from '../document/layerFactory';
import { renderShapeLayer, renderTextLayer } from '../layers/appearance';
import { insertionPoint, nextLayerName } from './ops/common';
import { OVERPRINT_COUNT } from '../color/inks';
import { BUILTIN_PROFILES } from '../color/icc';
import type { BuiltinProfileId } from '../color/icc';
import type { Intent } from '../color/cms';
import type { Homography } from '../image-engine/matrix';

export interface Action {
  id: string;
  label: string;
  shortcut?: string;
  run: (args?: Record<string, unknown>) => unknown;
  enabled?: () => boolean;
  checked?: () => boolean;
  comingSoon?: boolean;
  category?: string;
}

const registry = new Map<string, Action>();

export function register(a: Action): void {
  registry.set(a.id, a);
}

export function action(id: string): Action | undefined {
  return registry.get(id);
}

export function allActions(): Action[] {
  return [...registry.values()];
}

export async function run(id: string, args?: Record<string, unknown>): Promise<void> {
  const a = registry.get(id);
  if (!a) {
    console.warn(`Unknown action ${id}`);
    return;
  }
  if (a.comingSoon) {
    ui.toast('info', `${a.label.replace(/…$/, '')} is coming soon.`, 'This menu item is a placeholder for a planned feature.');
    return;
  }
  if (a.enabled && !a.enabled()) return;
  try {
    await a.run(args);
  } catch (e) {
    ui.toast('error', `${a.label} failed`, e instanceof Error ? e.message : String(e));
  }
}

const hasDoc = () => !!editor.active;
const hasLayer = () => !!editor.active?.activeLayer();
const hasSel = () => !!editor.active && !editor.active.doc.selection.isEmpty();
const activeKind = () => editor.active?.activeLayer()?.kind;
const dialog = (type: string, props?: Record<string, unknown>) => () => {
  ui.openDialog(type, props);
};

function reg(id: string, label: string, run: Action['run'], extra: Partial<Action> = {}) {
  register({ id, label, run, ...extra });
}

// ---------------------------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------------------------
reg('file.new', 'New…', dialog('newDocument'), { shortcut: 'Ctrl+N' });
reg('file.open', 'Open…', () => file.openDialog(), { shortcut: 'Ctrl+O' });
reg('file.openPath', 'Open Recent', (a) => file.openPath(String(a?.path)));
reg('file.clearRecent', 'Clear Recent File List', () => file.clearRecent());
reg('file.close', 'Close', () => file.closeSession(), { shortcut: 'Ctrl+W', enabled: hasDoc });
reg('file.closeAll', 'Close All', () => file.closeAll(), { shortcut: 'Alt+Ctrl+W', enabled: hasDoc });
reg('file.closeOthers', 'Close Others', () => file.closeAll(editor.activeId ?? undefined), { enabled: hasDoc });
reg('file.save', 'Save', () => {
  const s = editor.active;
  if (s && layer.commitSmartContents(s)) return;
  return file.save();
}, { shortcut: 'Ctrl+S', enabled: hasDoc });
reg('file.saveAs', 'Save As…', () => file.saveAs(), { shortcut: 'Shift+Ctrl+S', enabled: hasDoc });
reg('file.saveCopy', 'Save a Copy…', () => file.saveCopy(), { shortcut: 'Alt+Ctrl+S', enabled: hasDoc });
reg('file.revert', 'Revert', () => file.revert(), { shortcut: 'F12', enabled: () => !!editor.active?.doc.filePath });
reg('file.exportAs', 'Export As…', dialog('exportAs'), { shortcut: 'Alt+Shift+Ctrl+W', enabled: hasDoc });
reg('file.quickExportPng', 'Quick Export as PNG', () => file.exportAs(editor.active, 'png'), { enabled: hasDoc });
reg('file.exportSlices', 'Export Slices…', async () => (await import('./ops/sliceOps')).exportSlices(), { enabled: hasDoc });
reg('view.slicesFromGuides', 'Slices From Guides', async () => (await import('./ops/sliceOps')).slicesFromGuides(), { enabled: () => !!editor.active?.doc.guides.length });
reg('view.clearSlices', 'Clear Slices', async () => (await import('./ops/sliceOps')).clearSlices(), { enabled: () => !!editor.active?.doc.slices.length });
reg('file.exportPdf', 'Export as PDF…', () => ui.openDialog('exportAs', { format: 'pdf' }), { enabled: hasDoc });
reg('file.placeEmbedded', 'Place Embedded…', () => file.placeFile(false), { enabled: hasDoc });
reg('file.placeLinked', 'Place Linked…', () => file.placeFile(true), { enabled: hasDoc });
reg('file.info', 'File Info…', dialog('fileInfo'), { shortcut: 'Alt+Shift+Ctrl+I', enabled: hasDoc });
reg('file.recovered', 'Recovered Documents…', dialog('recovered'));
reg('file.duplicate', 'Duplicate…', () => file.duplicateDocument(), { enabled: hasDoc });
reg('file.quit', 'Exit', () => window.close(), { shortcut: 'Ctrl+Q' });

// ---------------------------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------------------------
reg('edit.undo', 'Undo', () => edit.undo(), { shortcut: 'Ctrl+Z', enabled: () => !!editor.active?.history.canUndo });
reg('edit.redo', 'Redo', () => edit.redo(), { shortcut: 'Shift+Ctrl+Z', enabled: () => !!editor.active?.history.canRedo });
reg('edit.stepBackward', 'Step Backward', () => edit.undo(), { shortcut: 'Alt+Ctrl+Z', enabled: () => !!editor.active?.history.canUndo });
reg('edit.stepForward', 'Step Forward', () => edit.redo(), { enabled: () => !!editor.active?.history.canRedo });
reg('edit.cut', 'Cut', () => edit.copy(false, true), { shortcut: 'Ctrl+X', enabled: hasLayer });
reg('edit.copy', 'Copy', () => edit.copy(false), { shortcut: 'Ctrl+C', enabled: hasLayer });
reg('edit.copyMerged', 'Copy Merged', () => edit.copy(true), { shortcut: 'Shift+Ctrl+C', enabled: hasDoc });
reg('edit.paste', 'Paste', (a) => edit.paste((a?.mode as 'normal') ?? 'normal'), { shortcut: 'Ctrl+V' });
reg('edit.pasteInPlace', 'Paste in Place', () => edit.paste('inPlace'), { shortcut: 'Shift+Ctrl+V', enabled: hasDoc });
reg('edit.pasteInto', 'Paste Into', () => edit.paste('into'), { shortcut: 'Alt+Shift+Ctrl+V', enabled: hasSel });
reg('edit.clear', 'Clear', () => edit.clear(), { shortcut: 'Delete', enabled: hasLayer });
reg('edit.fill', 'Fill…', (a) => (a ? edit.fill(a as never) : ui.openDialog('fill')), { shortcut: 'Shift+F5', enabled: hasLayer });
reg('edit.fillForeground', 'Fill with Foreground', () => edit.fill({ use: 'foreground', mode: 'normal', opacity: 1, preserveTransparency: false }), { shortcut: 'Alt+Backspace', enabled: hasLayer });
reg('edit.fillBackground', 'Fill with Background', () => edit.fill({ use: 'background', mode: 'normal', opacity: 1, preserveTransparency: false }), { shortcut: 'Ctrl+Backspace', enabled: hasLayer });
reg('edit.stroke', 'Stroke…', dialog('stroke'), { enabled: hasSel });
reg('edit.contentAwareFill', 'Content-Aware Fill', () => edit.contentAwareFill(), { enabled: hasSel });
reg('edit.generativeFill', 'Generative Fill…', () => edit.generativeFill(), { enabled: hasSel });
reg('edit.freeTransform', 'Free Transform', () => startTransform(), { shortcut: 'Ctrl+T', enabled: hasLayer });
for (const [id, label] of [['scale', 'Scale'], ['rotate', 'Rotate'], ['skew', 'Skew'], ['distort', 'Distort'], ['perspective', 'Perspective']] as const)
  reg(`edit.transform.${id}`, label, () => startTransform(id), { enabled: hasLayer });
reg('edit.transform.warp', 'Warp', () => startTransform('warp'), { enabled: hasLayer });
reg('edit.transform.rotate180', 'Rotate 180°', () => quickTransform('rotate180'), { enabled: hasLayer });
reg('edit.transform.rotate90cw', 'Rotate 90° Clockwise', () => quickTransform('rotate90cw'), { enabled: hasLayer });
reg('edit.transform.rotate90ccw', 'Rotate 90° Counter Clockwise', () => quickTransform('rotate90ccw'), { enabled: hasLayer });
reg('edit.transform.flipH', 'Flip Horizontal', () => quickTransform('flipH'), { enabled: hasLayer });
reg('edit.transform.flipV', 'Flip Vertical', () => quickTransform('flipV'), { enabled: hasLayer });
reg('edit.definePattern', 'Define Pattern…', () => edit.definePattern(), { enabled: hasDoc });
reg('edit.defineBrush', 'Define Brush Preset…', () => edit.defineBrush(), { enabled: hasSel });
reg('edit.purge', 'Purge All', () => edit.purgeHistory(), { enabled: hasDoc });
reg('edit.assignProfile', 'Assign Profile…', dialog('profile', { mode: 'assign' }), { enabled: hasDoc });
reg('edit.convertProfile', 'Convert to Profile…', dialog('profile', { mode: 'convert' }), { enabled: hasDoc });
reg('edit.shortcuts', 'Keyboard Shortcuts…', dialog('shortcuts'), { shortcut: 'Alt+Shift+Ctrl+K' });
reg('edit.preferences', 'Preferences…', dialog('preferences'), { shortcut: 'Ctrl+K' });
reg('edit.plugins', 'Plugins…', dialog('plugins'));
reg('file.runScript', 'Run Script', (a) => runPluginScript(String(a?.id ?? '')), { enabled: hasDoc, category: 'replay' });
reg('edit.commandPalette', 'Search Commands…', dialog('commandPalette'), { shortcut: 'Ctrl+F' });

async function startTransform(kind?: string) {
  const { beginTransform } = await import('../tools/transformTool');
  beginTransform(kind as never);
}
async function quickTransform(kind: string) {
  const { quickTransformLayer } = await import('../tools/transformTool');
  quickTransformLayer(kind as never);
}

// ---------------------------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------------------------
reg('image.mode.rgb', 'RGB Color', () => img.setColorMode('rgb'), { checked: () => editor.active?.doc.canvas.colorMode === 'rgb', enabled: hasDoc });
reg('image.mode.grayscale', 'Grayscale', () => img.setColorMode('grayscale'), { checked: () => editor.active?.doc.canvas.colorMode === 'grayscale' && !editor.active?.doc.canvas.duotone, enabled: hasDoc });
reg('image.mode.duotone', 'Duotone…', dialog('duotone'), { checked: () => !!editor.active?.doc.canvas.duotone, enabled: () => editor.active?.doc.canvas.colorMode === 'grayscale' && editor.active.doc.canvas.bitDepth !== 32 });
reg('image.mode.multichannel', 'Multichannel', () => mode.convertToMultichannel(), { checked: () => editor.active?.doc.canvas.colorMode === 'multichannel', enabled: () => hasDoc() && editor.active?.doc.canvas.colorMode !== 'multichannel' });
reg('image.mode.cmyk', 'CMYK Color', () => mode.convertColorMode('cmyk'), { checked: () => editor.active?.doc.canvas.colorMode === 'cmyk', enabled: hasDoc });
reg('image.mode.lab', 'Lab Color', () => mode.convertColorMode('lab'), { checked: () => editor.active?.doc.canvas.colorMode === 'lab', enabled: hasDoc });
reg('image.mode.bitmap', 'Bitmap…', dialog('bitmapMode'), { checked: () => editor.active?.doc.canvas.colorMode === 'bitmap', enabled: () => hasDoc() && editor.active?.doc.canvas.colorMode !== 'bitmap' });
reg('image.mode.indexed', 'Indexed Color…', dialog('indexedColor'), { checked: () => editor.active?.doc.canvas.colorMode === 'indexed', enabled: () => hasDoc() && editor.active?.doc.canvas.colorMode !== 'indexed' });
reg('image.mode.colorTable', 'Color Table…', dialog('colorTable'), { enabled: () => editor.active?.doc.canvas.colorMode === 'indexed' });
for (const d of [8, 16, 32] as const) reg(`image.depth.${d}`, `${d} Bits/Channel`, () => img.setBitDepth(d), { checked: () => editor.active?.doc.canvas.bitDepth === d, enabled: hasDoc });
reg('image.size', 'Image Size…', (a) => (a ? img.imageSize(a.w as number, a.h as number, a.resolution as number, a.resample as never, !!a.scaleStyles) : ui.openDialog('imageSize')), { shortcut: 'Alt+Ctrl+I', enabled: hasDoc });
reg('image.canvasSize', 'Canvas Size…', (a) => (a ? img.canvasSize(a.w as number, a.h as number, a.anchor as never, null) : ui.openDialog('canvasSize')), { shortcut: 'Alt+Ctrl+C', enabled: hasDoc });
reg('image.rotate180', '180°', () => img.rotateCanvas(180), { enabled: hasDoc });
reg('image.rotate90cw', '90° Clockwise', () => img.rotateCanvas(90), { enabled: hasDoc });
reg('image.rotate90ccw', '90° Counter Clockwise', () => img.rotateCanvas(-90), { enabled: hasDoc });
reg('image.rotateArbitrary', 'Arbitrary…', (a) => (a?.deg !== undefined ? img.rotateCanvas(a.deg as number) : ui.openDialog('rotateCanvas')), { enabled: hasDoc });
reg('image.flipH', 'Flip Canvas Horizontal', () => img.flipCanvas(true), { enabled: hasDoc });
reg('image.flipV', 'Flip Canvas Vertical', () => img.flipCanvas(false), { enabled: hasDoc });
reg('image.crop', 'Crop', () => img.cropToSelection(), { enabled: hasSel });
reg('image.generativeExpand', 'Generative Expand…', (a) => (a?.w ? edit.generativeExpand(Number(a.w), Number(a.h), (a.anchor as never) ?? 'c', a.prompt as string | undefined) : ui.openDialog('generativeExpand')), { enabled: hasDoc });
reg('image.trim', 'Trim…', (a) => (a ? img.trim(a.basedOn as never) : ui.openDialog('trim')), { enabled: hasDoc });
reg('image.revealAll', 'Reveal All', () => img.revealAll(), { enabled: hasDoc });
reg('image.flatten', 'Flatten Image', () => layer.flattenImage(), { enabled: hasDoc });
reg('image.docInfo', 'Document Properties…', dialog('docInfo'), { enabled: hasDoc });
for (const t of Object.keys(ADJUSTMENT_LABELS) as AdjustmentType[]) {
  reg(`image.adjust.${t}`, `${ADJUSTMENT_LABELS[t]}…`, (a) => (a?.adjustment ? img.applyPixelAdjustment(a.adjustment as never) : ui.openDialog('adjustment', { type: t, destructive: true })), { enabled: () => activeKind() === 'pixel' });
}
reg('image.adjust.desaturate', 'Desaturate', () => img.applyPixelAdjustment({ ...defaultAdjustment('hueSaturation'), master: { hue: 0, saturation: -100, lightness: 0 } } as never), { shortcut: 'Shift+Ctrl+U', enabled: () => activeKind() === 'pixel' });
reg('image.adjust.invertPixels', 'Invert', () => img.applyPixelAdjustment({ type: 'invert' }), { shortcut: 'Ctrl+I', enabled: () => activeKind() === 'pixel' });

// ---------------------------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------------------------
reg('layer.new', 'New Layer', () => layer.newLayer(), { shortcut: 'Shift+Ctrl+N', enabled: hasDoc });
reg('layer.newGroup', 'New Group', () => layer.newGroup(false), { enabled: hasDoc });
reg('layer.groupLayers', 'Group Layers', () => layer.newGroup(true), { shortcut: 'Ctrl+G', enabled: hasLayer });
reg('layer.ungroup', 'Ungroup Layers', () => layer.ungroup(), { shortcut: 'Shift+Ctrl+G', enabled: () => activeKind() === 'group' });
reg('layer.duplicate', 'Duplicate Layer', () => layer.duplicateLayers(), { shortcut: 'Ctrl+J', enabled: hasLayer });
reg('layer.viaCopy', 'Layer via Copy', () => layer.layerVia(false), { enabled: hasLayer });
reg('layer.viaCut', 'Layer via Cut', () => layer.layerVia(true), { shortcut: 'Shift+Ctrl+J', enabled: hasLayer });
reg('layer.delete', 'Delete Layer', () => layer.deleteLayers(), { enabled: hasLayer });
reg('layer.rename', 'Rename Layer…', () => ui.bump('docRev'), { enabled: hasLayer });
reg('layer.style', 'Blending Options…', () => editor.active?.activeLayer() && ui.openDialog('layerStyle', { layerId: editor.active!.activeLayer()!.id }), { enabled: hasLayer });
reg('layer.copyStyle', 'Copy Layer Style', () => layer.copyStyle(), { enabled: hasLayer });
reg('layer.pasteStyle', 'Paste Layer Style', () => layer.pasteStyle(), { enabled: () => editor.clipboard?.kind === 'style' && hasLayer() });
reg('layer.clearStyle', 'Clear Layer Style', () => layer.clearStyle(), { enabled: () => !!editor.active?.activeLayer()?.effects });
reg('layer.rasterizeStyle', 'Rasterize Layer Style', () => layer.rasterize('style'), { enabled: () => !!editor.active?.activeLayer()?.effects });
reg('layer.newFill.solid', 'Solid Color…', (a) => (a?.color ? layer.newFillLayer({ type: 'solid', color: a.color as never }) : ui.openDialog('colorPicker', { purpose: 'fillLayer' })), { enabled: hasDoc });
reg('layer.newFill.gradient', 'Gradient…', () => layer.newFillLayer({ type: 'gradient', gradient: simpleGradient(useApp.getState().fg, useApp.getState().bg, 'Foreground to Background'), style: 'linear', angle: 90, scale: 100, reverse: false, dither: true, alignWithLayer: true, offsetX: 0, offsetY: 0 }), { enabled: hasDoc });
reg('layer.newFill.pattern', 'Pattern…', () => {
  const s = editor.active;
  const first = s ? [...s.doc.patterns.values()][0] : undefined;
  if (!first) {
    ui.toast('info', 'Define a pattern first (Edit › Define Pattern).');
    return;
  }
  layer.newFillLayer({ type: 'pattern', patternId: first.id, scale: 100, phaseX: 0, phaseY: 0 });
}, { enabled: hasDoc });
reg('layer.newFill', 'New Fill Layer', (a) => layer.newFillLayer(a?.fill as never), { enabled: hasDoc });
for (const t of Object.keys(ADJUSTMENT_LABELS) as AdjustmentType[]) reg(`layer.newAdjustment.${t}`, `${ADJUSTMENT_LABELS[t]}…`, () => layer.newAdjustmentLayer(t), { enabled: hasDoc });
reg('layer.newAdjustment', 'New Adjustment Layer', (a) => layer.newAdjustmentLayer(a?.type as AdjustmentType), { enabled: hasDoc });
reg('layer.addMask', 'Add Layer Mask', (a) => layer.addMask((a?.mode as never) ?? 'revealAll'), { enabled: () => hasLayer() && !editor.active?.activeLayer()?.mask });
reg('layer.mask.revealAll', 'Reveal All', () => layer.addMask('revealAll'), { enabled: () => hasLayer() && !editor.active?.activeLayer()?.mask });
reg('layer.mask.hideAll', 'Hide All', () => layer.addMask('hideAll'), { enabled: () => hasLayer() && !editor.active?.activeLayer()?.mask });
reg('layer.mask.revealSelection', 'Reveal Selection', () => layer.addMask('revealSelection'), { enabled: () => hasSel() && !editor.active?.activeLayer()?.mask });
reg('layer.mask.hideSelection', 'Hide Selection', () => layer.addMask('hideSelection'), { enabled: () => hasSel() && !editor.active?.activeLayer()?.mask });
reg('layer.deleteMask', 'Delete Mask', () => layer.deleteMask(false), { enabled: () => !!editor.active?.activeLayer()?.mask });
reg('layer.applyMask', 'Apply Mask', () => layer.deleteMask(true), { enabled: () => !!editor.active?.activeLayer()?.mask });
reg('layer.toggleMask', 'Disable/Enable Mask', () => layer.setMaskProps({ enabled: !editor.active?.activeLayer()?.mask?.enabled }, 'Toggle Mask'), { enabled: () => !!editor.active?.activeLayer()?.mask, shortcut: 'Shift+\\' });
reg('layer.linkMask', 'Link/Unlink Mask', () => layer.setMaskProps({ linked: !editor.active?.activeLayer()?.mask?.linked }, 'Link Mask'), { enabled: () => !!editor.active?.activeLayer()?.mask });
reg('layer.invertMask', 'Invert Mask', () => layer.invertMask(), { enabled: () => !!editor.active?.activeLayer()?.mask });
reg('layer.editMaskToggle', 'Edit Mask / Pixels', () => { const s = editor.active; if (s?.activeLayer()?.mask) { s.editMask = !s.editMask; s.notify(); } }, { shortcut: 'Ctrl+\\', enabled: () => !!editor.active?.activeLayer()?.mask });
reg('layer.addVectorMask', 'Add Vector Mask', () => layer.addVectorMask(true), { enabled: () => hasLayer() && !editor.active?.activeLayer()?.vectorMask });
reg('layer.deleteVectorMask', 'Delete Vector Mask', () => layer.deleteVectorMask(), { enabled: () => !!editor.active?.activeLayer()?.vectorMask });
reg('layer.toggleClipping', 'Create/Release Clipping Mask', () => layer.toggleClipping(), { shortcut: 'Alt+Ctrl+G', enabled: hasLayer });
reg('layer.convertToSmartObject', 'Convert to Smart Object', () => layer.convertToSmartObject(), { enabled: hasLayer });
reg('layer.editContents', 'Edit Contents', () => layer.editSmartContents(), { enabled: () => activeKind() === 'smartObject' });
reg('layer.replaceContents', 'Replace Contents…', () => layer.replaceSmartContents(), { enabled: () => activeKind() === 'smartObject' });
reg('layer.relink', 'Relink to File…', () => layer.replaceSmartContents(), { enabled: () => activeKind() === 'smartObject' });
reg('layer.rasterize', 'Rasterize Layer', () => layer.rasterize('layer'), { enabled: () => !!activeKind() && !['pixel', 'group', 'adjustment'].includes(activeKind()!) });
reg('layer.arrange.front', 'Bring to Front', () => layer.arrange('front'), { shortcut: 'Shift+Ctrl+]', enabled: hasLayer });
reg('layer.arrange.forward', 'Bring Forward', () => layer.arrange('forward'), { shortcut: 'Ctrl+]', enabled: hasLayer });
reg('layer.arrange.backward', 'Send Backward', () => layer.arrange('backward'), { shortcut: 'Ctrl+[', enabled: hasLayer });
reg('layer.arrange.back', 'Send to Back', () => layer.arrange('back'), { shortcut: 'Shift+Ctrl+[', enabled: hasLayer });
for (const [e, l] of [['left', 'Left Edges'], ['hcenter', 'Horizontal Centers'], ['right', 'Right Edges'], ['top', 'Top Edges'], ['vcenter', 'Vertical Centers'], ['bottom', 'Bottom Edges']] as const)
  reg(`layer.align.${e}`, l, () => layer.align(e), { enabled: hasLayer });
reg('layer.distribute.horizontal', 'Horizontal Centers', () => layer.distribute('horizontal'), { enabled: hasLayer });
reg('layer.distribute.vertical', 'Vertical Centers', () => layer.distribute('vertical'), { enabled: hasLayer });
reg('layer.lockAll', 'Lock Layer', () => { const l = editor.active?.activeLayer(); if (l) layer.setLock(l.id, 'all'); }, { shortcut: 'Ctrl+/', enabled: hasLayer });
reg('layer.mergeDown', 'Merge Down', () => layer.mergeDown(), { shortcut: 'Ctrl+E', enabled: hasLayer });
reg('layer.mergeVisible', 'Merge Visible', () => layer.mergeVisible(), { shortcut: 'Shift+Ctrl+E', enabled: hasDoc });
reg('layer.selectAll', 'All Layers', () => layer.selectAllLayers(), { shortcut: 'Alt+Ctrl+A', enabled: hasDoc });
reg('layer.selectAbove', 'Select Layer Above', () => layer.selectLayerRelative(1), { shortcut: 'Alt+]', enabled: hasDoc });
reg('layer.selectBelow', 'Select Layer Below', () => layer.selectLayerRelative(-1), { shortcut: 'Alt+[', enabled: hasDoc });
reg('layer.hide', 'Hide Layers', () => { const l = editor.active?.activeLayer(); if (l) layer.toggleVisibility(l.id); }, { shortcut: 'Ctrl+,', enabled: hasLayer });
// Macro replay targets (operate on the active layer).
reg('layer.setOpacity', 'Set Opacity', (a) => { const l = editor.active?.activeLayer(); if (l) layer.setOpacity(l.id, Number(a?.value)); });
reg('layer.setFillOpacity', 'Set Fill', (a) => { const l = editor.active?.activeLayer(); if (l) layer.setOpacity(l.id, Number(a?.value), true); });
reg('layer.setBlendMode', 'Set Blend Mode', (a) => { const l = editor.active?.activeLayer(); if (l) layer.setBlendMode(l.id, a?.mode as BlendMode); });
reg('layer.toggleVisibility', 'Toggle Visibility', () => { const l = editor.active?.activeLayer(); if (l) layer.toggleVisibility(l.id); });
reg('layer.merge', 'Merge', () => layer.mergeDown());
reg('layer.arrange', 'Arrange', (a) => layer.arrange(a?.dir as never));
reg('layer.align', 'Align', (a) => layer.align(a?.edge as never));
reg('layer.distribute', 'Distribute', (a) => layer.distribute(a?.axis as never));

// ---------------------------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------------------------
reg('type.rasterize', 'Rasterize Type Layer', () => layer.rasterize('layer'), { enabled: () => activeKind() === 'text' });
reg('type.toParagraph', 'Convert to Paragraph Text', async () => (await import('../tools/typeTool')).convertTextKind('paragraph'), { enabled: () => activeKind() === 'text' });
reg('type.toPoint', 'Convert to Point Text', async () => (await import('../tools/typeTool')).convertTextKind('point'), { enabled: () => activeKind() === 'text' });
reg('type.vertical', 'Vertical Orientation', async () => (await import('../tools/typeTool')).toggleTextOrientation(), {
  enabled: () => activeKind() === 'text',
  checked: () => { const l = editor.active?.activeLayer(); return l?.kind === 'text' && l.text.orientation === 'vertical'; },
});
reg('type.fitFrame', 'Fit Text to Frame', async () => (await import('../tools/typeTool')).fitTextToFrame(), { enabled: () => { const l = editor.active?.activeLayer(); return l?.kind === 'text' && l.text.kind === 'paragraph'; } });
reg('type.warp', 'Warp Text…', dialog('warpText'), { enabled: () => { const l = editor.active?.activeLayer(); return l?.kind === 'text' && !l.text.path; } });
reg('type.matchFont', 'Match Font…', dialog('matchFont'), { enabled: hasDoc });

// ---------------------------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------------------------
reg('select.all', 'All', () => sel.selectAll(), { shortcut: 'Ctrl+A', enabled: hasDoc });
reg('select.deselect', 'Deselect', () => sel.deselect(), { shortcut: 'Ctrl+D', enabled: hasSel });
reg('select.reselect', 'Reselect', () => sel.reselect(), { shortcut: 'Shift+Ctrl+D', enabled: hasDoc });
reg('select.inverse', 'Inverse', () => sel.inverse(), { shortcut: 'Shift+Ctrl+I', enabled: hasDoc });
reg('select.colorRange', 'Color Range…', (a) => (a ? sel.applyColorRange(a.mode as never, a.samples as never, a.fuzziness as number, !!a.invert, a.op as never) : ui.openDialog('colorRange')), { enabled: hasDoc });
reg('select.subject', 'Subject', () => sel.selectSubject('subject'), { enabled: hasDoc });
reg('select.sky', 'Sky', () => sel.selectSubject('sky'), { enabled: hasDoc });
reg('select.focusArea', 'Focus Area…', (a) => (a?.output ? sel.focusArea(a as never) : ui.openDialog('focusArea')), { enabled: hasDoc });
reg('select.selectAndMask', 'Select and Mask…', dialog('selectAndMask'), { shortcut: 'Alt+Ctrl+R', enabled: hasSel });
for (const k of ['border', 'smooth', 'expand', 'contract', 'feather'] as const)
  reg(`select.modify.${k}`, `${k[0].toUpperCase()}${k.slice(1)}…`, (a) => (a?.amount !== undefined ? sel.modify(k, Number(a.amount)) : ui.openDialog('modifySelection', { kind: k })), { enabled: hasSel, shortcut: k === 'feather' ? 'Shift+F6' : undefined });
reg('select.modify', 'Modify', (a) => sel.modify(a?.kind as never, Number(a?.amount)));
reg('select.grow', 'Grow', () => sel.grow(false), { enabled: hasSel });
reg('select.similar', 'Similar', () => sel.grow(true), { enabled: hasSel });
reg('select.transform', 'Transform Selection', async () => (await import('../tools/transformTool')).beginTransformSelection(), { enabled: hasSel });
reg('select.quickMask', 'Edit in Quick Mask Mode', () => sel.toggleQuickMask(), { shortcut: 'Q', checked: () => useApp.getState().quickMask, enabled: hasDoc });
reg('select.save', 'Save Selection…', () => sel.saveSelectionToChannel(), { enabled: hasSel });
reg('select.load', 'Load Selection…', (a) => {
  if (a?.channel) {
    const ch = editor.active?.doc.channels.find((c) => c.name === a.channel);
    if (ch) sel.loadChannelAsSelection(ch.id, a.op as never, !!a.invert);
    return;
  }
  ui.openDialog('loadSelection');
}, { enabled: () => !!editor.active?.doc.channels.length });

// ---------------------------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------------------------
reg('filter.last', 'Last Filter', () => filt.repeatLastFilter(), { shortcut: 'Alt+Ctrl+F', enabled: () => !!filt.lastFilter && hasDoc() });
reg('filter.convertForSmart', 'Convert for Smart Filters', () => layer.convertToSmartObject(), { enabled: hasLayer });
reg('filter.liquify', 'Liquify…', dialog('liquify'), { shortcut: 'Shift+Ctrl+X', enabled: () => activeKind() === 'pixel' || activeKind() === 'smartObject' });
reg('filter.gallery', 'Filter Gallery…', (a) => (a?.stack ? filt.applyFilterStack(a.stack as never) : ui.openDialog('filterGallery')), { enabled: hasLayer });
reg('filter.apply', 'Apply Filter', (a) => filt.applyFilter(String(a?.id), (a?.params as never) ?? {}));
for (const f of allFilters()) {
  reg(`filter.${f.id}`, f.name, () => (f.params.length ? ui.openDialog('filter', { id: f.id }) : filt.applyFilter(f.id, {})), { enabled: hasLayer, comingSoon: f.comingSoon });
}

// ---------------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------------
reg('view.zoomIn', 'Zoom In', () => view.zoomBy(1), { shortcut: 'Ctrl+=', enabled: hasDoc });
reg('view.zoomOut', 'Zoom Out', () => view.zoomBy(-1), { shortcut: 'Ctrl+-', enabled: hasDoc });
reg('view.fit', 'Fit on Screen', () => view.fitOnScreen(false), { shortcut: 'Ctrl+0', enabled: hasDoc });
reg('view.fill', 'Fill Screen', () => view.fitOnScreen(true), { enabled: hasDoc });
reg('view.100', '100%', () => view.zoomTo(1), { shortcut: 'Ctrl+1', enabled: hasDoc });
reg('view.200', '200%', () => view.zoomTo(2), { enabled: hasDoc });
reg('view.400', '400%', () => view.zoomTo(4), { enabled: hasDoc });
reg('view.800', '800%', () => view.zoomTo(8), { enabled: hasDoc });
reg('view.printSize', 'Print Size', () => view.printSize(), { enabled: hasDoc });
reg('view.zoomCustom', 'Custom Zoom…', (a) => (a?.zoom ? view.zoomTo(Number(a.zoom)) : ui.openDialog('customZoom')), { enabled: hasDoc });
reg('view.resetRotation', 'Reset View Rotation', () => view.rotateView(null), { enabled: () => !!editor.active && editor.active.view.rotation !== 0 });
reg('view.proofColors', 'Proof Colors', () => view.toggleView('proofColors'), { shortcut: 'Ctrl+Y', checked: () => useApp.getState().view.proofColors, enabled: hasDoc });
reg('view.gamutWarning', 'Gamut Warning', () => view.toggleView('gamutWarning'), { shortcut: 'Shift+Ctrl+Y', checked: () => useApp.getState().view.gamutWarning, enabled: hasDoc });
reg('view.extras', 'Extras', () => view.toggleView('extras'), { shortcut: 'Ctrl+H', checked: () => useApp.getState().view.extras });
reg('view.showSelectionEdges', 'Selection Edges', () => view.toggleView('showSelectionEdges'), { checked: () => useApp.getState().view.showSelectionEdges });
reg('view.grid', 'Grid', () => view.toggleView('grid'), { shortcut: "Ctrl+'", checked: () => useApp.getState().view.grid });
reg('view.guides', 'Guides', () => view.toggleView('guides'), { shortcut: 'Ctrl+;', checked: () => useApp.getState().view.guides });
reg('view.pixelGrid', 'Pixel Grid', () => view.toggleView('pixelGrid'), { checked: () => useApp.getState().view.pixelGrid });
reg('view.rulers', 'Rulers', () => view.toggleView('rulers'), { shortcut: 'Ctrl+R', checked: () => useApp.getState().view.rulers });
reg('view.snap', 'Snap', () => view.toggleView('snap'), { shortcut: 'Shift+Ctrl+;', checked: () => useApp.getState().view.snap });
reg('view.snapGuides', 'Guides', () => view.toggleView('snapToGuides'), { checked: () => useApp.getState().view.snapToGuides });
reg('view.snapGrid', 'Grid', () => view.toggleView('snapToGrid'), { checked: () => useApp.getState().view.snapToGrid });
reg('view.snapLayers', 'Layers', () => view.toggleView('snapToLayers'), { checked: () => useApp.getState().view.snapToLayers });
reg('view.snapDocument', 'Document Bounds', () => view.toggleView('snapToDocument'), { checked: () => useApp.getState().view.snapToDocument });
reg('view.smartGuides', 'Smart Guides', () => view.toggleView('smartGuides'), { checked: () => useApp.getState().view.smartGuides });
reg('view.lockGuides', 'Lock Guides', () => view.toggleLockGuides(), { shortcut: 'Alt+Ctrl+;', checked: () => view.guidesLocked });
reg('view.clearGuides', 'Clear Guides', () => view.clearGuides(), { enabled: () => !!editor.active?.doc.guides.length });
reg('view.newGuide', 'New Guide…', (a) => (a ? view.addGuide(a.orientation as never, Number(a.position)) : ui.openDialog('newGuide')), { enabled: hasDoc });
reg('view.newGuideLayout', 'New Guide Layout…', (a) => (a?.columns ? view.addGuideLayout(a as never) : ui.openDialog('newGuideLayout')), { enabled: hasDoc });
reg('view.screenMode', 'Full Screen Mode', () => {
  ui.set((s) => ({ screenMode: s.screenMode === 'full' ? 'standard' : 'full' }));
  window.celenne?.toggleFullScreen();
}, { shortcut: 'F', checked: () => useApp.getState().screenMode === 'full' });

// ---------------------------------------------------------------------------------------------
// Window / Help
// ---------------------------------------------------------------------------------------------
reg('window.resetWorkspace', 'Reset Essentials', () => window.dispatchEvent(new CustomEvent('celenne:resetWorkspace')));
reg('window.devtools', 'Toggle Developer Tools', () => window.celenne?.toggleDevTools(), { shortcut: 'Ctrl+Shift+F12' });
reg('help.about', 'About Celenne Studio', dialog('about'));
reg('help.updates', 'Check for Updates…', dialog('updates'));
reg('help.reports', 'Error Reports…', dialog('reports'));
reg('help.compatibility', 'PSD Compatibility Matrix', dialog('compatMatrix'));
reg('help.report', 'Compatibility Report (current document)', dialog('compatibility'), { enabled: hasDoc });
reg('help.gpu', 'GPU & Performance Info', dialog('gpuInfo'));
reg('help.shortcuts', 'Keyboard Shortcuts', dialog('shortcuts'));

// ---------------------------------------------------------------------------------------------
// Replay-only actions: re-run operations recorded into macros with their recorded arguments.
// They are not shown in menus; the command palette hides them (category 'replay').
// ---------------------------------------------------------------------------------------------
const replayOnly = { category: 'replay' } as const;
reg('image.bitDepth', 'Bit Depth', (a) => img.setBitDepth(Number(a?.depth) as 8 | 16 | 32), { ...replayOnly, enabled: hasDoc });
reg('image.mode.toIndexed', 'Indexed Color', (a) => mode.convertToIndexed({ ...DEFAULT_INDEXED, ...(a as Partial<IndexedOptions>) }), { ...replayOnly, enabled: hasDoc });
reg('image.mode.toBitmap', 'Bitmap', (a) => mode.convertToBitmap({ ...DEFAULT_BITMAP, ...(a as Partial<BitmapOptions>) }), { ...replayOnly, enabled: hasDoc });
reg('image.colorTable', 'Color Table', (a) => { if (Array.isArray(a?.table)) mode.setColorTable((a!.table as number[]).map((v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))))); }, { ...replayOnly, enabled: hasDoc });
reg('image.mode', 'Color Mode', (a) => (a?.mode === 'multichannel' ? mode.convertToMultichannel() : a?.mode === 'cmyk' || a?.mode === 'lab' ? mode.convertColorMode(a.mode) : img.setColorMode(a?.mode === 'grayscale' ? 'grayscale' : 'rgb')), { ...replayOnly, enabled: hasDoc });
reg('image.duotone', 'Duotone', (a) => {
  // Validated: 1–4 inks, each a name, an sRGB colour and a 13-point curve; optional overprint colours (null = computed).
  const inks = Array.isArray(a?.inks) ? (a!.inks as { name?: unknown; color?: { r?: unknown; g?: unknown; b?: unknown }; curve?: unknown }[]).slice(0, 4) : [];
  if (!inks.length) return;
  const num = (v: unknown, lo: number, hi: number, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
  const spec = {
    inks: inks.map((i, k) => ({
      name: String(i.name ?? `Ink ${k + 1}`).slice(0, 63),
      color: { r: num(i.color?.r, 0, 1, 0), g: num(i.color?.g, 0, 1, 0), b: num(i.color?.b, 0, 1, 0) },
      curve: Array.from({ length: 13 }, (_, j) => (Array.isArray(i.curve) ? Math.round(num(i.curve[j], -1, 1000, -1)) : j === 0 ? 0 : j === 12 ? 1000 : -1)).map((v, j) => (j === 0 || j === 12 ? Math.max(0, v) : v)),
    })),
    overprints: (Array.isArray(a?.overprints) ? (a!.overprints as ({ r?: unknown; g?: unknown; b?: unknown } | null)[]) : []).slice(0, OVERPRINT_COUNT[inks.length])
      .map((c) => (c && typeof c === 'object' ? { r: num(c.r, 0, 1, 0), g: num(c.g, 0, 1, 0), b: num(c.b, 0, 1, 0) } : null)),
  };
  mode.setDuotone(spec, editor.active?.doc.canvas.duotone);
}, { ...replayOnly, enabled: hasDoc });
reg('channel.mergeSpot', 'Merge Spot Channel', (a) => {
  const d = editor.active?.doc;
  const ch = d?.channels.find((c) => c.kind === 'spot' && c.name === String(a?.name ?? ''));
  if (!ch) { ui.toast('warning', `No spot channel named "${String(a?.name)}"; this step was skipped.`); return; }
  mode.mergeSpot(ch.id);
}, { ...replayOnly, enabled: hasDoc });
reg('image.rotate', 'Rotate Canvas', (a) => img.rotateCanvas(Number(a?.deg ?? 90)), { ...replayOnly, enabled: hasDoc });
reg('image.flip', 'Flip Canvas', (a) => img.flipCanvas(a?.horizontal !== false), { ...replayOnly, enabled: hasDoc });
reg('image.adjust', 'Apply Adjustment', (a) => { if (a?.adjustment) img.applyPixelAdjustment(a.adjustment as never); }, { ...replayOnly, enabled: () => activeKind() === 'pixel' });
const builtinByName = (name: unknown): BuiltinProfileId | null => BUILTIN_PROFILES.find((p) => p.name === name)?.id ?? null;
reg('image.assignProfile', 'Assign Profile', (a) => {
  const id = builtinByName(a?.name);
  if (!id) { ui.toast('warning', `Profile "${String(a?.name)}" is not a built-in profile; this step was skipped.`); return; }
  img.assignProfile({ name: String(a?.name), builtin: id });
}, { ...replayOnly, enabled: hasDoc });
reg('image.convertProfile', 'Convert to Profile', (a) => {
  const id = builtinByName(a?.name);
  if (!id) { ui.toast('warning', `Profile "${String(a?.name)}" is not a built-in profile; this step was skipped.`); return; }
  return img.convertToProfile(id, (a?.intent as Intent) ?? 'relative', a?.bpc !== false);
}, { ...replayOnly, enabled: hasDoc });
reg('layer.translate', 'Move Layers', (a) => {
  const s = editor.active;
  const ids = s?.selectedLayers().filter((l) => !l.locks.all && !l.locks.position).map((l) => l.id) ?? [];
  if (!s || !ids.length) return;
  s.push(new TranslateLayersCommand(ids, Number(a?.dx ?? 0), Number(a?.dy ?? 0), { action: 'layer.translate', args: a }));
}, { ...replayOnly, enabled: hasLayer });
reg('layer.move', 'Reorder Layer', (a) => {
  const s = editor.active, l = s?.activeLayer();
  if (!s || !l?.parent) return;
  // Parent ids are document-specific: replay reorders within the active layer's own parent.
  layer.moveLayer(l.id, l.parent.id, Math.max(0, Math.min(l.parent.children.length - 1, Number(a?.toIndex ?? 0))));
}, { ...replayOnly, enabled: hasLayer });
reg('layer.setStyle', 'Set Layer Style', (a) => {
  const s = editor.active, l = s?.activeLayer();
  if (!s || !l || !a) return;
  const cmds: import("../history/history").Command[] = [new SetEffectsCommand(l.id, l.effects, (a.effects as never) ?? null)];
  cmds.push(new SetLayerPropsCommand('Blending Options', l.id, { opacity: l.opacity, fillOpacity: l.fillOpacity, blendMode: l.blendMode, advanced: l.advanced }, { opacity: Number(a.opacity ?? l.opacity), fillOpacity: Number(a.fillOpacity ?? l.fillOpacity), blendMode: (a.blendMode as BlendMode) ?? l.blendMode, advanced: (a.advanced as never) ?? l.advanced }));
  s.push(new CompositeCommand('Layer Style', cmds, { action: 'layer.setStyle', args: a }));
}, { ...replayOnly, enabled: hasLayer });
reg('edit.freeTransformApply', 'Apply Transform', async (a) => {
  const s = editor.active;
  const m = a?.matrix as number[] | undefined;
  if (!s || !m || m.length !== 9) return;
  const { transformLayersByMatrix } = await import('../tools/transformTool');
  transformLayersByMatrix(s, s.selectedLayers().map((l) => l.id), m as unknown as Homography, a?.affine !== false);
}, { ...replayOnly, enabled: hasLayer });
reg('shape.create', 'Create Shape', (a) => {
  const s = editor.active;
  if (!s || !a?.path) return;
  const l = createShapeLayer(nextLayerName(s, String(a.name ?? 'Shape').replace(/\s+\d+$/, '')), structuredClone(a.path as never), (a.origin as never) ?? null, s.doc.canvas.bitDepth);
  if (a.fill) l.fill = structuredClone(a.fill as never);
  if (a.stroke) l.stroke = structuredClone(a.stroke as never);
  renderShapeLayer(s.doc, l);
  const { parentId, index } = insertionPoint(s);
  s.push(new CreateLayerCommand('Create Shape', l, parentId, index, { action: 'shape.create', args: a }));
  s.setActive(l.id);
}, { ...replayOnly, enabled: hasDoc });
reg('type.create', 'Create Text', (a) => {
  const s = editor.active;
  const text = a?.text as { text?: string } | undefined;
  if (!s || !text?.text) return;
  const l = createTextLayer(text.text, s.doc.canvas.bitDepth, 0, 0);
  l.text = structuredClone(text as never);
  l.name = text.text.slice(0, 40);
  renderTextLayer(s.doc, l);
  const { parentId, index } = insertionPoint(s);
  s.push(new CreateLayerCommand('Create Text', l, parentId, index, { action: 'type.create', args: a }));
  s.setActive(l.id);
}, { ...replayOnly, enabled: hasDoc });

export function replay(op: RecordedOp): Promise<void> {
  return run(op.action, op.args);
}

/** File ▸ Scripts: runs a plugin script and, after confirmation, the actions it returns. */
async function runPluginScript(id: string): Promise<void> {
  const s = editor.active;
  const { plugins } = await import('../plugins/pluginHost');
  const def = plugins.scripts().find((x) => x.fullId === id);
  if (!s || !def) return;
  const d = s.doc;
  const describe = (l: import('../document/types').Layer): Record<string, unknown> => ({
    id: l.id, name: l.name, kind: l.kind, visible: l.visible, opacity: l.opacity, blendMode: l.blendMode,
    ...(l.kind === 'group' ? { children: l.children.map(describe) } : {}),
  });
  const document = {
    name: d.name, width: d.width, height: d.height, resolution: d.canvas.resolution, colorMode: d.canvas.colorMode, bitDepth: d.canvas.bitDepth,
    layers: d.root.children.map(describe), activeLayerId: s.activeLayerId, selection: d.selection.isEmpty() ? null : d.selection.bounds(d.bounds),
  };
  const p = ui.progress(`${def.name}…`);
  let steps: { action: string; args?: Record<string, unknown> }[];
  try {
    steps = await plugins.runScript(id, document);
  } catch (e) {
    p.done();
    ui.toast('error', `${def.name} failed`, (e as Error).message);
    return;
  } finally {
    p.done();
  }
  // Scripts may only drive document commands: no file writes, quitting, preferences or plugin management.
  const blocked = /^(file\.(save|saveAs|saveCopy|quit|close|closeAll|closeOthers|export|quickExport|runScript|open|place|revert)|edit\.(plugins|preferences|shortcuts)|app\.)/;
  const bad = steps.find((x) => blocked.test(x.action) || !allActions().some((a) => a.id === x.action));
  if (bad) { ui.toast('error', `${def.name} asked for an action that scripts cannot run: ${bad.action}`); return; }
  if (!steps.length) { ui.toast('info', `${def.name} finished without changes.`); return; }
  const { platform } = await import('./platform/platform');
  const ok = await platform().confirm(`Run "${def.name}"?`, `The script will perform ${steps.length} step${steps.length === 1 ? '' : 's'}: ${[...new Set(steps.map((x) => action(x.action)?.label ?? x.action))].slice(0, 8).join(', ')}${steps.length > 8 ? '…' : ''}. Each step can be undone.`, ['Run', 'Cancel']);
  if (ok !== 0) return;
  for (const st of steps) await run(st.action, st.args);
}
