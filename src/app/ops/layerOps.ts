/** Layer menu / Layers panel operations. Every change is recorded as an undoable command. */
import { plateCount } from '../../color/plates';
import { editor } from '../editor';
import { ui, useApp } from '../store';
import type { DocumentSession } from '../session';
import { need, needLayer, insertionPoint, nextLayerName, uniqueLayerName, errorText } from './common';
import {
  ChangeBlendModeCommand,
  ChangeOpacityCommand,
  CompositeCommand,
  CreateAdjustmentLayerCommand,
  CreateLayerCommand,
  CreateMaskCommand,
  DeleteLayerCommand,
  editLayer,
  MoveLayerCommand,
  RenameLayerCommand,
  ReplaceLayerCommand,
  SetEffectsCommand,
  SetLayerPropsCommand,
  SetMaskCommand,
  SetVectorMaskCommand,
  TranslateLayersCommand,
  translateLayerDeep,
} from '../../commands/layerCommands';
import { flattenToPixels } from '../../rendering/flatten';
import { recordStateChange } from '../../history/history';
import { createAdjustmentLayer, createFillLayer, createGroupLayer, createMask, createPixelLayer, createSmartObjectLayer } from '../../document/layerFactory';
import type { FillContent, GroupLayer, Layer, LayerId, PixelLayer } from '../../document/types';
import { hasRaster } from '../../document/types';
import { cloneLayer } from '../../document/clone';
import { AdjustmentType, defaultAdjustment } from '../../adjustments/types';
import type { BlendMode } from '../../image-engine/blend';
import { compositeRegion } from '../../rendering/compositor';
import { layerContentBounds, layerVisualBounds } from '../../rendering/bounds';
import { TiledRaster } from '../../image-engine/tiledRaster';
import { intersect, isEmpty, Rect, union } from '../../image-engine/rect';
import { CelenneDocument } from '../../document/document';
import { exportPsd } from '../../psd/export';
import { importPsd } from '../../psd/import';
import { quadFromRect } from '../../image-engine/matrix';
import { uuid } from '../../document/ids';
import { updateAppearance } from '../../layers/appearance';
import { editRaster } from '../../commands/rasterCommands';
import { documentFromImage, findImporter } from '../../formats/registry';
import { decodeImageFile } from '../../formats/codecs';
import { ensureDecoded, renderSmartObject } from '../../layers/smartObjects';
import type { LayerEffects } from '../../effects/types';
import { emptyEffects, normalizeEffects } from '../../effects/types';

// ---------------------------------------------------------------------------------------------
// Create / duplicate / delete
// ---------------------------------------------------------------------------------------------
export function newLayer(name?: string): void {
  const s = need();
  if (!s) return;
  const l = createPixelLayer(name ?? nextLayerName(s), s.doc.canvas.bitDepth);
  const { parentId, index } = insertionPoint(s);
  s.push(new CreateLayerCommand('New Layer', l, parentId, index, { action: 'layer.new' }));
  s.setActive(l.id);
}

export function newGroup(fromSelection = false): void {
  const s = need();
  if (!s) return;
  const g = createGroupLayer(nextLayerName(s, 'Group'));
  if (!fromSelection) {
    const { parentId, index } = insertionPoint(s);
    s.push(new CreateLayerCommand('New Group', g, parentId, index, { action: 'layer.newGroup' }));
    s.setActive(g.id);
    return;
  }
  const layers = topLevelSelection(s);
  if (!layers.length) return newGroup(false);
  recordStateChange(s.doc, s.history, 'Group Layers', () => {
    const top = layers[layers.length - 1];
    const parent = top.parent ?? s.doc.root;
    const idx = parent.children.indexOf(top) + 1;
    s.doc.insertLayer(g, parent, idx);
    for (const l of layers) {
      s.doc.removeLayer(l);
      s.doc.insertLayer(l, g, g.children.length);
    }
  }, { action: 'layer.groupLayers' });
  s.setActive(g.id);
}

/** Selected layers without descendants of other selected layers, in stacking order (bottom → top). */
export function topLevelSelection(s: DocumentSession): Layer[] {
  const sel = s.selectedLayers();
  return sel.filter((l) => !sel.some((o) => o !== l && o.kind === 'group' && s.doc.isAncestor(o, l)));
}

export function duplicateLayers(): void {
  const s = need();
  if (!s) return;
  const layers = topLevelSelection(s);
  if (!layers.length) return;
  const cmds: CreateLayerCommand[] = [];
  const newIds: LayerId[] = [];
  for (const l of [...layers].reverse()) {
    const c = cloneLayer(l, true);
    c.name = uniqueLayerName(s, `${l.name} copy`);
    const parent = l.parent ?? s.doc.root;
    cmds.push(new CreateLayerCommand('Duplicate Layer', c, parent.id, parent.children.indexOf(l) + 1));
    newIds.push(c.id);
  }
  s.push(new CompositeCommand(layers.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer', cmds, { action: 'layer.duplicate' }));
  s.setActive(newIds[0]);
  newIds.slice(1).forEach((id) => s.selectedIds.add(id));
}

export function deleteLayers(): void {
  const s = need();
  if (!s) return;
  const layers = topLevelSelection(s);
  if (!layers.length) return;
  const locked = layers.find((l) => l.locks.all);
  if (locked) {
    ui.toast('warning', `"${locked.name}" is locked and cannot be deleted.`);
    return;
  }
  const below = layers[0].parent?.children[layers[0].parent.children.indexOf(layers[0]) - 1];
  s.push(new DeleteLayerCommand(layers.map((l) => l.id), { action: 'layer.delete' }));
  const next = below ?? s.doc.root.children[s.doc.root.children.length - 1];
  s.setActive(next?.id ?? null);
}

export function renameLayer(id: LayerId, name: string): void {
  const s = need();
  const l = s?.doc.getLayer(id);
  if (!s || !l || !name.trim() || name === l.name) return;
  s.push(new RenameLayerCommand(id, l.name, name.trim()));
}

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------
export function setOpacity(id: LayerId, value: number, fill = false): void {
  const s = need();
  const l = s?.doc.getLayer(id);
  if (!s || !l) return;
  const before = fill ? l.fillOpacity : l.opacity;
  const v = Math.max(0, Math.min(1, value));
  if (v === before) return;
  s.push(new ChangeOpacityCommand(id, before, v, fill));
}

export function setBlendMode(id: LayerId, mode: BlendMode): void {
  const s = need();
  const l = s?.doc.getLayer(id);
  if (!s || !l || l.blendMode === mode) return;
  if (mode === 'passThrough' && l.kind !== 'group') return;
  s.push(new ChangeBlendModeCommand(id, l.blendMode, mode));
}

export function toggleVisibility(id: LayerId, solo = false): void {
  const s = need();
  const l = s?.doc.getLayer(id);
  if (!s || !l) return;
  if (solo) {
    // Alt-click: show only this layer (toggle back when repeated).
    const siblings = (l.parent ?? s.doc.root).children;
    const othersHidden = siblings.every((c) => c === l || !c.visible);
    const cmds = siblings.filter((c) => c !== l).map((c) => new SetLayerPropsCommand('Show/Hide', c.id, { visible: c.visible }, { visible: othersHidden }));
    cmds.push(new SetLayerPropsCommand('Show/Hide', l.id, { visible: l.visible }, { visible: true }));
    s.push(new CompositeCommand('Show/Hide', cmds));
    return;
  }
  s.push(new SetLayerPropsCommand(l.visible ? 'Hide Layer' : 'Show Layer', id, { visible: l.visible }, { visible: !l.visible }, { action: 'layer.toggleVisibility' }));
}

export function setLock(id: LayerId, lock: keyof Layer['locks'], value?: boolean): void {
  const s = need();
  const l = s?.doc.getLayer(id);
  if (!s || !l) return;
  const next = { ...l.locks, [lock]: value ?? !l.locks[lock] };
  if (lock === 'all') { next.transparency = next.pixels = next.position = next.all; }
  s.push(new SetLayerPropsCommand('Lock Layer', id, { locks: { ...l.locks } }, { locks: next }));
}

export function toggleClipping(id?: LayerId): void {
  const r = needLayer();
  if (!r) return;
  const l = id ? r.s.doc.getLayer(id) : r.l;
  if (!l || !l.parent) return;
  if (!l.clipping && l.parent.children.indexOf(l) === 0) {
    ui.toast('info', 'There is no layer below to clip to.');
    return;
  }
  r.s.push(new SetLayerPropsCommand(l.clipping ? 'Release Clipping Mask' : 'Create Clipping Mask', l.id, { clipping: l.clipping }, { clipping: !l.clipping }, { action: 'layer.toggleClipping' }));
}

export function setColorTag(id: LayerId, tag: Layer['colorTag']): void {
  const s = need();
  const l = s?.doc.getLayer(id);
  if (!s || !l) return;
  s.push(new SetLayerPropsCommand('Layer Color', id, { colorTag: l.colorTag }, { colorTag: tag }));
}

// ---------------------------------------------------------------------------------------------
// Arrange
// ---------------------------------------------------------------------------------------------
export function moveLayer(id: LayerId, toParentId: LayerId, toIndex: number): void {
  const s = need();
  const l = s?.doc.getLayer(id);
  const target = s?.doc.getLayer(toParentId);
  if (!s || !l || !target || target.kind !== 'group') return;
  if (l.kind === 'group' && (l === target || s.doc.isAncestor(l, target))) return;
  s.push(new MoveLayerCommand('Reorder Layer', id, toParentId, toIndex, { action: 'layer.move', args: { toParentId, toIndex } }));
}

export function arrange(dir: 'front' | 'forward' | 'backward' | 'back'): void {
  const r = needLayer();
  if (!r) return;
  const { s, l } = r;
  const parent = l.parent ?? s.doc.root;
  const i = parent.children.indexOf(l);
  const n = parent.children.length;
  const to = dir === 'front' ? n : dir === 'forward' ? Math.min(n, i + 2) : dir === 'backward' ? Math.max(0, i - 1) : 0;
  if ((dir === 'front' || dir === 'forward') && i === n - 1) return;
  if ((dir === 'back' || dir === 'backward') && i === 0) return;
  s.push(new MoveLayerCommand('Arrange', l.id, parent.id, to, { action: 'layer.arrange', args: { dir } }));
}

export function ungroup(): void {
  const r = needLayer();
  if (!r || r.l.kind !== 'group') return;
  const { s } = r;
  const g = r.l as GroupLayer;
  recordStateChange(s.doc, s.history, 'Ungroup Layers', () => {
    const parent = g.parent ?? s.doc.root;
    let idx = parent.children.indexOf(g);
    s.doc.removeLayer(g);
    for (const c of [...g.children]) {
      g.children.splice(g.children.indexOf(c), 1);
      s.doc.insertLayer(c, parent, idx++);
    }
  }, { action: 'layer.ungroup' });
  s.setActive(g.children[g.children.length - 1]?.id ?? null);
}

// ---------------------------------------------------------------------------------------------
// Merge / flatten
// ---------------------------------------------------------------------------------------------
/** Renders a set of layers (in their document context order) into a new raster. */
function renderLayers(s: DocumentSession, layers: Layer[], region?: Rect): { raster: TiledRaster; bounds: Rect | null } {
  let bounds: Rect | null = null;
  for (const l of layers) bounds = union(bounds, layerVisualBounds(l) ?? s.doc.bounds);
  const raster = new TiledRaster(4, s.doc.canvas.bitDepth);
  if (!bounds) return { raster, bounds };
  bounds = region ? intersect(bounds, region) : bounds;
  if (isEmpty(bounds)) return { raster, bounds: null };
  const root = createGroupLayer('tmp');
  root.blendMode = 'passThrough';
  root.children = layers;
  const TS = 512;
  // CMYK documents render both plates (C'M'Y' into the raster, K' into its companion).
  const plates = plateCount(s.doc);
  if (plates === 2) raster.companion = new TiledRaster(4, s.doc.canvas.bitDepth);
  for (let y = bounds.y; y < bounds.y + bounds.h; y += TS)
    for (let x = bounds.x; x < bounds.x + bounds.w; x += TS) {
      const r = { x, y, w: Math.min(TS, bounds.x + bounds.w - x), h: Math.min(TS, bounds.y + bounds.h - y) };
      for (let plate = 0; plate < plates; plate++) {
        const buf = compositeRegion(s.doc, r, { level: 0, root, plate });
        for (let i = 0; i < r.w * r.h; i++) {
          const a = buf[i * 4 + 3];
          if (a > 1e-7) { buf[i * 4] /= a; buf[i * 4 + 1] /= a; buf[i * 4 + 2] /= a; }
        }
        (plate ? raster.companion! : raster).writeFloat(r, buf);
      }
    }
  raster.compact();
  raster.companion?.compact();
  return { raster, bounds };
}

export function mergeDown(): void {
  const r = needLayer();
  if (!r) return;
  const { s, l } = r;
  const sel = topLevelSelection(s);
  if (sel.length > 1) return mergeLayers(sel);
  const parent = l.parent ?? s.doc.root;
  const i = parent.children.indexOf(l);
  if (l.kind === 'group') return mergeLayers([l]);
  const below = parent.children[i - 1];
  if (!below) {
    ui.toast('info', 'There is no layer below to merge with.');
    return;
  }
  if (!below.visible || !l.visible) {
    ui.toast('info', 'Both layers must be visible to merge.');
    return;
  }
  mergeLayers([below, l], below.name);
}

export function mergeLayers(layers: Layer[], name?: string): void {
  const s = need();
  if (!s || !layers.length) return;
  const visible = layers.filter((l) => l.visible);
  recordStateChange(s.doc, s.history, layers.length === 1 ? 'Merge Group' : 'Merge Layers', () => {
    const top = layers[layers.length - 1];
    const parent = top.parent ?? s.doc.root;
    const idx = parent.children.indexOf(top);
    const { raster } = renderLayers(s, visible);
    const merged = createPixelLayer(name ?? top.name, s.doc.canvas.bitDepth, raster);
    s.doc.insertLayer(merged, parent, idx + 1);
    for (const l of layers) s.doc.removeLayer(l);
    s.setActive(merged.id);
  }, { action: 'layer.merge' });
}

export function mergeVisible(): void {
  const s = need();
  if (!s) return;
  const visible = s.doc.root.children.filter((l) => l.visible);
  if (visible.length < 2) return;
  mergeLayers(visible, visible[visible.length - 1].name);
}

export function flattenImage(): void {
  const s = need();
  if (!s) return;
  const hidden = s.doc.allLayers().filter((l) => !l.visible).length;
  const doFlatten = () =>
    recordStateChange(s.doc, s.history, 'Flatten Image', () => {
      const all = [...s.doc.root.children];
      const bg = createPixelLayer('Background', s.doc.canvas.bitDepth);
      // White background under the composite, as expected of a flattened image.
      const white = createFillLayer({ type: 'solid', color: { r: 1, g: 1, b: 1 } });
      const { raster } = renderLayers(s, [white, ...all.filter((l) => l.visible)], s.doc.bounds);
      bg.raster = raster;
      for (const l of all) s.doc.removeLayer(l);
      s.doc.insertLayer(bg, s.doc.root);
      s.setActive(bg.id);
    }, { action: 'image.flatten' });
  if (hidden) {
    import('../platform/platform').then(async ({ platform }) => {
      const r = await platform().confirm('Discard hidden layers?', `${hidden} hidden layer(s) will be removed.`, ['OK', 'Cancel']);
      if (r === 0) doFlatten();
    });
  } else doFlatten();
}

// ---------------------------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------------------------
export function addMask(mode: 'revealAll' | 'hideAll' | 'revealSelection' | 'hideSelection' = 'revealAll'): void {
  const r = needLayer();
  if (!r) return;
  const { s, l } = r;
  if (l.mask) {
    ui.toast('info', 'The layer already has a mask.');
    return;
  }
  const sel = s.doc.selection;
  const hasSel = !sel.isEmpty();
  const fromSelection = (invert: boolean) => {
    const m = createMask(true);
    m.raster = sel.mask.clone();
    if (invert) {
      for (const [k] of m.raster.tiles) {
        const t = m.raster.writableTile((k % 65536) - 32768, Math.floor(k / 65536) - 32768);
        for (let i = 0; i < t.data.length; i++) t.data[i] = 255 - t.data[i];
      }
      m.raster.fill = 1 - m.raster.fill;
      m.raster.touch();
    }
    return m;
  };
  let m;
  switch (mode) {
    case 'hideAll':
      m = createMask(false);
      break;
    case 'hideSelection':
      m = hasSel ? fromSelection(true) : createMask(false);
      break;
    default:
      // "Add Layer Mask" with an active selection reveals the selection (professional default).
      m = hasSel ? fromSelection(false) : createMask(true);
  }
  s.push(new CreateMaskCommand('Add Layer Mask', l.id, null, m, { action: 'layer.addMask', args: { mode } }));
  s.editMask = true;
  s.notify();
}

export function deleteMask(apply = false): void {
  const r = needLayer();
  if (!r || !r.l.mask) return;
  const { s, l } = r;
  if (!apply) {
    s.push(new SetMaskCommand('Delete Layer Mask', l.id, l.mask, null, { action: 'layer.deleteMask' }));
    s.editMask = false;
    return;
  }
  if (!hasRaster(l) || l.kind !== 'pixel') {
    ui.toast('info', 'Masks can only be applied to pixel layers. Rasterize the layer first.');
    return;
  }
  const cmd = editLayer(s.doc, l.id, 'Apply Layer Mask', (layer) => {
    const pl = layer as PixelLayer;
    const m = pl.mask!;
    const b = pl.raster.contentBounds();
    if (b) {
      const px = pl.raster.readFloat(b);
      const mv = m.raster.readFloat({ x: b.x + pl.x - m.x, y: b.y + pl.y - m.y, w: b.w, h: b.h });
      for (let i = 0; i < b.w * b.h; i++) px[i * 4 + 3] *= 1 - m.density * (1 - mv[i]);
      pl.raster = pl.raster.clone();
      pl.raster.writeFloat(b, px);
      pl.raster.compact();
    }
    pl.mask = null;
  }, { action: 'layer.applyMask' });
  if (cmd) s.push(cmd, true);
  s.editMask = false;
}

export function setMaskProps(patch: Partial<{ enabled: boolean; linked: boolean; density: number; feather: number }>, label = 'Mask Properties'): void {
  const r = needLayer();
  if (!r || !r.l.mask) return;
  const { s, l } = r;
  const after = { ...l.mask!, ...patch };
  s.push(new SetMaskCommand(label, l.id, l.mask, after));
}

export function invertMask(): void {
  const r = needLayer();
  if (!r || !r.l.mask) return;
  const { s, l } = r;
  const cmd = editRaster(s.doc, { kind: 'mask', layerId: l.id }, 'Invert Mask', (raster) => {
    for (const [k] of raster.tiles) {
      const [tx, ty] = [(k % 65536) - 32768, Math.floor(k / 65536) - 32768];
      const t = raster.writableTile(tx, ty);
      for (let i = 0; i < t.data.length; i++) t.data[i] = 255 - t.data[i];
    }
    raster.fill = 1 - raster.fill;
    raster.touch();
    return null;
  });
  if (cmd) s.push(cmd, true);
}

export function addVectorMask(fromPath = true): void {
  const r = needLayer();
  if (!r) return;
  const { s, l } = r;
  const path = fromPath ? s.doc.paths.find((p) => p.kind === 'work') ?? s.doc.paths[0] : null;
  const vm = { path: path ? structuredClone(path.path) : { subpaths: [], fillRule: 'nonzero' as const }, enabled: true, invert: false, linked: true, density: 1, feather: 0 };
  if (!path) {
    // Reveal-all vector mask: a rectangle covering the canvas.
    const W = s.doc.width, H = s.doc.height;
    const k = (x: number, y: number) => ({ x, y, inX: x, inY: y, outX: x, outY: y, smooth: false });
    vm.path.subpaths.push({ closed: true, op: 'combine', knots: [k(0, 0), k(W, 0), k(W, H), k(0, H)] });
  }
  s.push(new SetVectorMaskCommand('Add Vector Mask', l.id, l.vectorMask, vm));
}

export function deleteVectorMask(): void {
  const r = needLayer();
  if (!r || !r.l.vectorMask) return;
  r.s.push(new SetVectorMaskCommand('Delete Vector Mask', r.l.id, r.l.vectorMask, null));
}

// ---------------------------------------------------------------------------------------------
// Adjustment & fill layers
// ---------------------------------------------------------------------------------------------
export function newAdjustmentLayer(type: AdjustmentType, clip = false): void {
  const s = need();
  if (!s) return;
  const layer = createAdjustmentLayer(defaultAdjustment(type));
  layer.name = uniqueLayerName(s, `${layer.name} 1`);
  layer.clipping = clip;
  // Adjustment layers get a mask (from the selection when present), like professional editors.
  layer.mask = createMask(true);
  if (!s.doc.selection.isEmpty()) layer.mask.raster = s.doc.selection.mask.clone();
  const { parentId, index } = insertionPoint(s);
  s.push(new CreateAdjustmentLayerCommand(`New ${layer.name.replace(/ \d+$/, '')} Layer`, layer, parentId, index, { action: 'layer.newAdjustment', args: { type } }));
  s.setActive(layer.id);
}

export function newFillLayer(fill: FillContent): void {
  const s = need();
  if (!s) return;
  const layer = createFillLayer(fill);
  layer.name = uniqueLayerName(s, `${layer.name} 1`);
  layer.mask = createMask(true);
  if (!s.doc.selection.isEmpty()) layer.mask.raster = s.doc.selection.mask.clone();
  const { parentId, index } = insertionPoint(s);
  s.push(new CreateLayerCommand('New Fill Layer', layer, parentId, index, { action: 'layer.newFill', args: { fill: fill as unknown as Record<string, unknown> } }));
  s.setActive(layer.id);
}

// ---------------------------------------------------------------------------------------------
// Rasterize / convert
// ---------------------------------------------------------------------------------------------
export function rasterize(what: 'layer' | 'style' = 'layer'): void {
  const r = needLayer();
  if (!r) return;
  const { s, l } = r;
  if (what === 'style') {
    if (!l.effects) return;
    if (!hasRaster(l)) {
      ui.toast('info', 'Rasterize the layer first.');
      return;
    }
    recordStateChange(s.doc, s.history, 'Rasterize Layer Style', () => {
      const clone = cloneLayer(l);
      clone.opacity = 1;
      clone.blendMode = 'normal';
      clone.clipping = false;
      const { raster } = renderLayers(s, [clone]);
      const px = createPixelLayer(l.name, s.doc.canvas.bitDepth, raster);
      px.opacity = l.opacity;
      px.blendMode = l.blendMode;
      px.clipping = l.clipping;
      px.visible = l.visible;
      const parent = l.parent ?? s.doc.root;
      const idx = parent.children.indexOf(l);
      s.doc.removeLayer(l);
      s.doc.insertLayer(px, parent, idx);
      s.setActive(px.id);
    });
    return;
  }
  if (l.kind === 'pixel') return;
  if (l.kind === 'group' || l.kind === 'adjustment') {
    ui.toast('info', `${l.kind === 'group' ? 'Groups' : 'Adjustment layers'} cannot be rasterized; use Merge instead.`);
    return;
  }
  recordStateChange(s.doc, s.history, `Rasterize ${l.kind === 'text' ? 'Type' : l.kind === 'shape' ? 'Shape' : l.kind === 'smartObject' ? 'Smart Object' : 'Layer'}`, () => {
    let raster: TiledRaster;
    let x = 0, y = 0;
    if (hasRaster(l)) {
      raster = l.raster.clone();
      x = l.x;
      y = l.y;
    } else {
      const clone = cloneLayer(l);
      clone.opacity = 1;
      clone.blendMode = 'normal';
      clone.effects = null;
      clone.mask = null;
      clone.vectorMask = null;
      raster = renderLayers(s, [clone], s.doc.bounds).raster;
    }
    const px = createPixelLayer(l.name, s.doc.canvas.bitDepth, raster);
    Object.assign(px, { x, y, opacity: l.opacity, fillOpacity: l.fillOpacity, blendMode: l.blendMode, clipping: l.clipping, visible: l.visible, effects: l.effects, locks: { ...l.locks }, colorTag: l.colorTag });
    px.mask = l.mask ? { ...l.mask, raster: l.mask.raster.clone() } : null;
    px.vectorMask = l.kind === 'shape' ? null : l.vectorMask;
    const parent = l.parent ?? s.doc.root;
    const idx = parent.children.indexOf(l);
    s.doc.removeLayer(l);
    s.doc.insertLayer(px, parent, idx);
    s.setActive(px.id);
  }, { action: 'layer.rasterize' });
}

export function convertToSmartObject(): void {
  const s = need();
  if (!s) return;
  const layers = topLevelSelection(s);
  if (!layers.length) return;
  let bounds: Rect | null = null;
  for (const l of layers) bounds = union(bounds, layerVisualBounds(l) ?? s.doc.bounds);
  if (!bounds || isEmpty(bounds)) {
    ui.toast('info', 'The selected layers are empty.');
    return;
  }
  const b = bounds;
  try {
    // Embedded source: a PSD containing the original layers (fully editable via Edit Contents).
    const sub = new CelenneDocument(layers.length === 1 ? layers[0].name : 'Smart Object', { ...s.doc.canvas, width: b.w, height: b.h });
    sub.profile = { ...s.doc.profile };
    for (const l of layers) {
      const c = cloneLayer(l);
      translateDeep(c, -b.x, -b.y);
      sub.insertLayer(c);
    }
    const bytes = exportPsd(sub);
    const src = { id: uuid(), kind: 'embedded' as const, name: `${sub.name}.psb`, fileType: 'psb', data: bytes };
    const { raster } = renderLayers(s, layers.map((l) => cloneLayer(l)));
    recordStateChange(s.doc, s.history, 'Convert to Smart Object', () => {
      const so = createSmartObjectLayer(sub.name, src.id, b.w, b.h, s.doc.canvas.bitDepth);
      so.quad = quadFromRect(b.x, b.y, b.w, b.h);
      so.raster = raster;
      so.x = 0;
      so.y = 0;
      so.usingPreservedPixels = false;
      const flatRaster = new TiledRaster(4, s.doc.canvas.bitDepth);
      flatRaster.writeFloat({ x: 0, y: 0, w: b.w, h: b.h }, raster.readFloat(b));
      if (raster.companion) {
        flatRaster.companion = new TiledRaster(4, s.doc.canvas.bitDepth);
        flatRaster.companion.writeFloat({ x: 0, y: 0, w: b.w, h: b.h }, raster.companion.readFloat(b));
      }
      s.doc.smartSources.set(src.id, { ...src, decoded: { width: b.w, height: b.h, raster: flatRaster, space: { mode: s.doc.canvas.colorMode, profile: s.doc.profile } } });
      const top = layers[layers.length - 1];
      const parent = top.parent ?? s.doc.root;
      s.doc.insertLayer(so, parent, parent.children.indexOf(top) + 1);
      for (const l of layers) s.doc.removeLayer(l);
      s.setActive(so.id);
    }, { action: 'layer.convertToSmartObject' });
  } catch (e) {
    ui.toast('error', 'Could not convert to smart object', errorText(e));
  }
}

function translateDeep(l: Layer, dx: number, dy: number) {
  translateLayerDeep(l, dx, dy);
}

/** Opens a smart object's source in its own tab; saving that tab updates the smart object. */
export async function editSmartContents(): Promise<void> {
  const r = needLayer();
  if (!r || r.l.kind !== 'smartObject') return;
  const { s, l } = r;
  const src = s.doc.smartSources.get(l.sourceId);
  if (!src?.data) {
    ui.toast('warning', src?.kind === 'linked' ? `Open the linked file "${src.name}" directly to edit it.` : 'This smart object has no embedded contents.');
    return;
  }
  try {
    const t = src.fileType.toLowerCase();
    let doc: CelenneDocument;
    if (['psd', 'psb'].includes(t) || src.data[0] === 0x38) doc = importPsd(src.data, src.name).doc;
    else {
      const img = await decodeImageFile(src.data, src.name.includes('.') ? src.name : `${src.name}.${t}`);
      const imp = findImporter(src.data, src.name.includes('.') ? src.name : `${src.name}.${t}`);
      doc = img.native && imp ? (await imp.import(src.data, src.name, {})).doc : documentFromImage(src.name, img.width, img.height, img.depth, img.data, img.icc);
    }
    doc.name = src.name.replace(/\.[^.]+$/, '');
    const child = editor.addDocument(doc, 'Open');
    smartParents.set(child.id, { sessionId: s.id, sourceId: src.id });
    ui.toast('info', 'Editing smart object contents.', 'Save (Ctrl+S) to update the smart object in the parent document.');
  } catch (e) {
    ui.toast('error', 'Could not open smart object contents', errorText(e));
  }
}

export const smartParents = new Map<string, { sessionId: string; sourceId: string }>();

/** Called on save of a smart-object child document. Returns true when handled. */
export function commitSmartContents(child: DocumentSession): boolean {
  const link = smartParents.get(child.id);
  if (!link) return false;
  const parent = editor.session(link.sessionId);
  if (!parent) {
    smartParents.delete(child.id);
    return false;
  }
  const src = parent.doc.smartSources.get(link.sourceId);
  if (!src) return false;
  const bytes = exportPsd(child.doc);
  recordStateChange(parent.doc, parent.history, 'Update Smart Object', () => {
    const flat = flattenToPixels(child.doc);
    const updated = { ...src, fileType: 'psb', data: bytes, decoded: { width: flat.width, height: flat.height, raster: TiledRaster.fromPixels(flat.width, flat.height, 4, flat.depth, flat.data) } };
    parent.doc.smartSources.set(src.id, updated);
    for (const l of parent.doc.walk()) {
      if (l.kind === 'smartObject' && l.sourceId === src.id) {
        l.sourceWidth = flat.width;
        l.sourceHeight = flat.height;
        renderSmartObject(parent.doc, l);
      }
    }
  });
  child.markSaved();
  ui.toast('success', `Updated smart object in "${parent.doc.name}"`);
  return true;
}

export async function replaceSmartContents(): Promise<void> {
  const r = needLayer();
  if (!r || r.l.kind !== 'smartObject') return;
  const { s, l } = r;
  const { platform } = await import('../platform/platform');
  const { openFilters } = await import('../../formats/registry');
  const files = await platform().openFiles(openFilters(), false);
  const f = files[0];
  if (!f) return;
  try {
    const { decodeSmartSource } = await import('../../layers/smartObjects');
    const ext = (f.name.split('.').pop() ?? '').toLowerCase();
    const src = { id: l.sourceId, kind: 'embedded' as const, name: f.name, fileType: ext, data: f.data };
    const dec = await decodeSmartSource(src);
    recordStateChange(s.doc, s.history, 'Replace Contents', () => {
      s.doc.smartSources.set(src.id, { ...src, decoded: dec });
      for (const layer of s.doc.walk()) {
        if (layer.kind === 'smartObject' && layer.sourceId === src.id) {
          layer.sourceWidth = dec.width;
          layer.sourceHeight = dec.height;
          renderSmartObject(s.doc, layer);
        }
      }
    });
  } catch (e) {
    ui.toast('error', 'Could not replace contents', errorText(e));
  }
}

/** Re-renders a smart object from its source (e.g. after a transform), decoding lazily. */
export async function refreshSmartObject(s: DocumentSession, id: LayerId): Promise<boolean> {
  const l = s.doc.getLayer(id);
  if (!l || l.kind !== 'smartObject') return false;
  const ok = await ensureDecoded(s.doc, l);
  if (!ok) {
    const src = s.doc.smartSources.get(l.sourceId);
    ui.toast('warning', 'Smart object contents could not be rendered; the stored rendering is kept.', src?.decodeError);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Layer via copy / cut
// ---------------------------------------------------------------------------------------------
export function layerVia(cut: boolean): void {
  const r = needLayer();
  if (!r) return;
  const { s, l } = r;
  if (!hasRaster(l) || l.kind !== 'pixel') {
    ui.toast('info', 'Layer via Copy/Cut requires a pixel layer.');
    return;
  }
  const sel = s.doc.selection;
  const selB = sel.isEmpty() ? null : sel.bounds(s.doc.bounds);
  const cb = layerContentBounds(l);
  if (!cb) return;
  const region = selB ? intersect(selB, cb) : cb;
  if (isEmpty(region)) {
    ui.toast('info', 'The selected area is empty.');
    return;
  }
  const lr = { x: region.x - l.x, y: region.y - l.y, w: region.w, h: region.h };
  const px = l.raster.readFloat(lr);
  const cov = selB ? sel.read(region) : null;
  if (cov) for (let i = 0; i < region.w * region.h; i++) px[i * 4 + 3] *= cov[i];
  const nl = createPixelLayer(nextLayerName(s), s.doc.canvas.bitDepth);
  nl.raster.writeFloat({ x: region.x, y: region.y, w: region.w, h: region.h }, px);
  nl.raster.compact();
  const parent = l.parent ?? s.doc.root;
  const cmds = [];
  if (cut) {
    const rc = editRaster(s.doc, { kind: 'layer', layerId: l.id }, 'Cut', (raster) => {
      const cur = raster.readFloat(lr);
      for (let i = 0; i < region.w * region.h; i++) cur[i * 4 + 3] *= 1 - (cov ? cov[i] : 1);
      raster.writeFloat(lr, cur);
      raster.compact();
      return region;
    });
    if (rc) cmds.push(rc);
  }
  const create = new CreateLayerCommand('New Layer', nl, parent.id, parent.children.indexOf(l) + 1);
  create.do(s.doc);
  cmds.push(create);
  s.push(new CompositeCommand(cut ? 'Layer via Cut' : 'Layer via Copy', cmds, { action: cut ? 'layer.viaCut' : 'layer.viaCopy' }), true);
  s.setActive(nl.id);
}

// ---------------------------------------------------------------------------------------------
// Align / distribute
// ---------------------------------------------------------------------------------------------
export function align(edge: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'): void {
  const s = need();
  if (!s) return;
  const layers = topLevelSelection(s).filter((l) => !l.locks.position && !l.locks.all);
  const sel = s.doc.selection;
  const ref: Rect | null = layers.length > 1 ? layers.reduce<Rect | null>((u, l) => union(u, layerContentBounds(l) ?? undefined), null) : !sel.isEmpty() ? sel.bounds(s.doc.bounds) : s.doc.bounds;
  if (!ref || !layers.length) return;
  const cmds: TranslateLayersCommand[] = [];
  for (const l of layers) {
    const b = layerContentBounds(l);
    if (!b) continue;
    let dx = 0, dy = 0;
    if (edge === 'left') dx = ref.x - b.x;
    if (edge === 'right') dx = ref.x + ref.w - (b.x + b.w);
    if (edge === 'hcenter') dx = Math.round(ref.x + ref.w / 2 - (b.x + b.w / 2));
    if (edge === 'top') dy = ref.y - b.y;
    if (edge === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
    if (edge === 'vcenter') dy = Math.round(ref.y + ref.h / 2 - (b.y + b.h / 2));
    if (dx || dy) cmds.push(new TranslateLayersCommand([l.id], dx, dy));
  }
  if (cmds.length) s.push(new CompositeCommand('Align', cmds, { action: 'layer.align', args: { edge } }));
}

export function distribute(axis: 'horizontal' | 'vertical'): void {
  const s = need();
  if (!s) return;
  const items = topLevelSelection(s).map((l) => ({ l, b: layerContentBounds(l) })).filter((x): x is { l: Layer; b: Rect } => !!x.b);
  if (items.length < 3) {
    ui.toast('info', 'Select at least three layers to distribute.');
    return;
  }
  const c = (b: Rect) => (axis === 'horizontal' ? b.x + b.w / 2 : b.y + b.h / 2);
  items.sort((a, b) => c(a.b) - c(b.b));
  const first = c(items[0].b), last = c(items[items.length - 1].b);
  const step = (last - first) / (items.length - 1);
  const cmds = items.slice(1, -1).map((it, i) => {
    const d = Math.round(first + step * (i + 1) - c(it.b));
    return new TranslateLayersCommand([it.l.id], axis === 'horizontal' ? d : 0, axis === 'vertical' ? d : 0);
  });
  s.push(new CompositeCommand('Distribute', cmds, { action: 'layer.distribute', args: { axis } }));
}

// ---------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------
export function setEffects(id: LayerId, fx: LayerEffects | null, label = 'Layer Style'): void {
  const s = need();
  const l = s?.doc.getLayer(id);
  if (!s || !l) return;
  s.push(new SetEffectsCommand(id, l.effects, normalizeEffects(fx), label));
}

export function copyStyle(): void {
  const r = needLayer();
  if (!r) return;
  editor.clipboard = { kind: 'style', effects: r.l.effects ? structuredClone(r.l.effects) : null, blend: { opacity: r.l.opacity, fillOpacity: r.l.fillOpacity, blendMode: r.l.blendMode } };
  ui.toast('info', 'Layer style copied.', undefined, 1500);
}

export function pasteStyle(): void {
  const s = need();
  const c = editor.clipboard;
  if (!s || c?.kind !== 'style') return;
  const cmds = s.selectedLayers().map((l) => new SetEffectsCommand(l.id, l.effects, c.effects ? structuredClone(c.effects) : null, 'Paste Layer Style'));
  s.push(new CompositeCommand('Paste Layer Style', cmds));
}

export function clearStyle(): void {
  const s = need();
  if (!s) return;
  s.push(new CompositeCommand('Clear Layer Style', s.selectedLayers().filter((l) => l.effects).map((l) => new SetEffectsCommand(l.id, l.effects, null))));
}

export function ensureEffects(l: Layer): LayerEffects {
  return l.effects ? structuredClone(l.effects) : emptyEffects();
}

/** Re-renders a parametric layer and records the change. */
export function commitAppearance(s: DocumentSession, id: LayerId, label: string, mutate: (l: Layer) => void): void {
  const cmd = editLayer(s.doc, id, label, (l) => {
    mutate(l);
    updateAppearance(s.doc, l);
  });
  if (cmd) s.push(cmd, true);
}

export function selectAllLayers(): void {
  const s = need();
  if (!s) return;
  for (const l of s.doc.walk()) s.selectedIds.add(l.id);
  s.notify();
}

export function selectLayerRelative(dir: 1 | -1): void {
  const s = need();
  if (!s) return;
  const flat = s.doc.allLayers();
  const i = flat.findIndex((l) => l.id === s.activeLayerId);
  const next = flat[Math.max(0, Math.min(flat.length - 1, i + dir))];
  if (next) s.setActive(next.id);
}

export { useApp, ReplaceLayerCommand };
