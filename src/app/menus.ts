/** Application menu structure. Items reference action ids; submenus may be generated. */
import { ADJUSTMENT_LABELS, AdjustmentType } from '../adjustments/types';
import { allFilters } from '../filters/builtin';
import { useApp } from './store';
import { PANELS } from '../ui/panels/registry';
import { plugins } from '../plugins/pluginHost';

export type MenuItem =
  | { type: 'action'; id: string; label?: string; args?: Record<string, unknown> }
  | { type: 'separator' }
  | { type: 'submenu'; label: string; items: MenuItem[] | (() => MenuItem[]) }
  | { type: 'custom'; label: string; run: () => void; checked?: () => boolean; enabled?: () => boolean };

export interface Menu {
  id: string;
  label: string;
  items: MenuItem[] | (() => MenuItem[]);
}

const a = (id: string, label?: string, args?: Record<string, unknown>): MenuItem => ({ type: 'action', id, label, args });
const sep: MenuItem = { type: 'separator' };
const sub = (label: string, items: MenuItem[] | (() => MenuItem[])): MenuItem => ({ type: 'submenu', label, items });

const ADJ_ORDER: (AdjustmentType | null)[] = ['brightnessContrast', 'levels', 'curves', 'exposure', null, 'vibrance', 'hueSaturation', 'colorBalance', 'blackWhite', 'photoFilter', 'channelMixer', 'colorLookup', null, 'invert', 'posterize', 'threshold', 'gradientMap', 'selectiveColor'];

function adjustmentItems(prefix: string): MenuItem[] {
  return ADJ_ORDER.map((t) => (t ? a(`${prefix}.${t}`, `${ADJUSTMENT_LABELS[t]}…`) : sep));
}

function filterCategory(cat: string): MenuItem[] {
  return allFilters().filter((f) => f.category === cat).map((f) => a(`filter.${f.id}`));
}

export const MENUS: Menu[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      a('file.new'), a('file.open'),
      sub('Open Recent', () => {
        const r = useApp.getState().recentFiles;
        const items: MenuItem[] = r.map((p) => a('file.openPath', p.split(/[\\/]/).pop(), { path: p }));
        if (!items.length) items.push({ type: 'custom', label: '(No recent files)', run: () => {}, enabled: () => false });
        items.push(sep, a('file.clearRecent'));
        return items;
      }),
      a('file.recovered'),
      sep, a('file.close'), a('file.closeAll'), a('file.closeOthers'),
      sep, a('file.save'), a('file.saveAs'), a('file.saveCopy'), a('file.revert'),
      sep, sub('Export', [a('file.quickExportPng'), a('file.exportAs'), a('file.exportPdf'), a('file.exportSlices')]),
      sep, a('file.placeEmbedded'), a('file.placeLinked'),
      sub('Scripts', () => {
        const list = plugins.scripts();
        if (!list.length) return [{ type: 'custom', label: '(No scripts — install a plugin that contributes scripts)', run: () => {}, enabled: () => false }];
        return list.map((sc) => a('file.runScript', sc.name, { id: sc.fullId }));
      }),
      sep, a('file.info'), a('file.duplicate'),
      sep, a('file.quit'),
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      a('edit.undo'), a('edit.redo'), a('edit.stepForward'), a('edit.stepBackward'),
      sep, a('edit.cut'), a('edit.copy'), a('edit.copyMerged'), a('edit.paste'), sub('Paste Special', [a('edit.pasteInPlace'), a('edit.pasteInto')]), a('edit.clear'),
      sep, a('edit.commandPalette'),
      sep, a('edit.fill'), a('edit.stroke'), a('edit.contentAwareFill'), a('edit.generativeFill'),
      sep, a('edit.freeTransform'),
      sub('Transform', [
        a('edit.transform.scale'), a('edit.transform.rotate'), a('edit.transform.skew'), a('edit.transform.distort'), a('edit.transform.perspective'), a('edit.transform.warp'),
        sep, a('edit.transform.rotate180'), a('edit.transform.rotate90cw'), a('edit.transform.rotate90ccw'),
        sep, a('edit.transform.flipH'), a('edit.transform.flipV'),
      ]),
      sep, a('edit.defineBrush'), a('edit.definePattern'),
      sep, a('edit.purge'),
      sep, a('edit.assignProfile'), a('edit.convertProfile'),
      sep, a('edit.shortcuts'), a('edit.plugins'), a('edit.preferences'),
    ],
  },
  {
    id: 'image',
    label: 'Image',
    items: [
      sub('Mode', [a('image.mode.bitmap'), a('image.mode.grayscale'), a('image.mode.duotone'), a('image.mode.indexed'), a('image.mode.rgb'), a('image.mode.cmyk'), a('image.mode.lab'), a('image.mode.multichannel'), sep, a('image.mode.colorTable'), sep, a('image.depth.8'), a('image.depth.16'), a('image.depth.32')]),
      sep, sub('Adjustments', [...adjustmentItems('image.adjust'), sep, a('image.adjust.desaturate'), a('image.adjust.invertPixels')]),
      sep, a('image.size'), a('image.canvasSize'), a('image.generativeExpand'),
      sub('Image Rotation', [a('image.rotate180'), a('image.rotate90cw'), a('image.rotate90ccw'), a('image.rotateArbitrary'), sep, a('image.flipH'), a('image.flipV')]),
      a('image.crop'), a('image.trim'), a('image.revealAll'),
      sep, a('file.duplicate'), a('image.docInfo'),
    ],
  },
  {
    id: 'layer',
    label: 'Layer',
    items: [
      sub('New', [a('layer.new'), a('layer.newGroup'), a('layer.groupLayers'), sep, a('layer.viaCopy'), a('layer.viaCut')]),
      a('layer.duplicate'), a('layer.delete'),
      sep, sub('Layer Style', [a('layer.style'), sep, a('layer.copyStyle'), a('layer.pasteStyle'), a('layer.clearStyle'), a('layer.rasterizeStyle')]),
      sep, sub('New Fill Layer', [a('layer.newFill.solid'), a('layer.newFill.gradient'), a('layer.newFill.pattern')]),
      sub('New Adjustment Layer', adjustmentItems('layer.newAdjustment')),
      sep, sub('Layer Mask', [a('layer.mask.revealAll'), a('layer.mask.hideAll'), a('layer.mask.revealSelection'), a('layer.mask.hideSelection'), sep, a('layer.deleteMask'), a('layer.applyMask'), sep, a('layer.toggleMask'), a('layer.linkMask'), a('layer.invertMask'), a('layer.editMaskToggle')]),
      sub('Vector Mask', [a('layer.addVectorMask'), a('layer.deleteVectorMask')]),
      a('layer.toggleClipping'),
      sep, sub('Smart Objects', [a('layer.convertToSmartObject'), sep, a('layer.editContents'), a('layer.replaceContents'), a('layer.relink'), sep, a('layer.rasterize', 'Rasterize')]),
      sub('Rasterize', [a('layer.rasterize', 'Layer'), a('layer.rasterizeStyle', 'Layer Style'), a('type.rasterize', 'Type')]),
      sep, a('layer.groupLayers'), a('layer.ungroup'),
      sub('Arrange', [a('layer.arrange.front'), a('layer.arrange.forward'), a('layer.arrange.backward'), a('layer.arrange.back')]),
      sub('Align', [a('layer.align.top'), a('layer.align.vcenter'), a('layer.align.bottom'), sep, a('layer.align.left'), a('layer.align.hcenter'), a('layer.align.right')]),
      sub('Distribute', [a('layer.distribute.horizontal'), a('layer.distribute.vertical')]),
      sep, a('layer.lockAll'),
      sep, a('layer.mergeDown'), a('layer.mergeVisible'), a('image.flatten'),
    ],
  },
  {
    id: 'type',
    label: 'Type',
    items: [a('type.toParagraph'), a('type.toPoint'), a('type.vertical'), sep, a('type.fitFrame'), a('type.warp'), a('type.matchFont'), sep, a('type.rasterize')],
  },
  {
    id: 'select',
    label: 'Select',
    items: [
      a('select.all'), a('select.deselect'), a('select.reselect'), a('select.inverse'),
      sep, a('layer.selectAll'),
      sep, a('select.colorRange'), a('select.focusArea'), a('select.subject'), a('select.sky'),
      sep, a('select.selectAndMask'),
      sub('Modify', [a('select.modify.border'), a('select.modify.smooth'), a('select.modify.expand'), a('select.modify.contract'), a('select.modify.feather')]),
      a('select.grow'), a('select.similar'),
      sep, a('select.transform'),
      sep, a('select.quickMask'),
      sep, a('select.load'), a('select.save'),
    ],
  },
  {
    id: 'filter',
    label: 'Filter',
    items: () => [
      a('filter.last'), sep, a('filter.convertForSmart'), sep, a('filter.gallery'), a('filter.liquify'),
      sep,
      sub('Blur', filterCategory('Blur')),
      sub('Distort', filterCategory('Distort')),
      sub('Noise', filterCategory('Noise')),
      sub('Sharpen', filterCategory('Sharpen')),
      sub('Stylize', filterCategory('Stylize')),
      sub('Other', filterCategory('Other')),
      sep,
      sub('Artistic', filterCategory('Artistic')),
      sub('Brush Strokes', filterCategory('Brush Strokes')),
      sub('Sketch', filterCategory('Sketch')),
      sub('Texture', filterCategory('Texture')),
      ...(allFilters().some((f) => f.category === 'Render') ? [sub('Render', filterCategory('Render'))] : []),
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      a('view.proofColors'), a('view.gamutWarning'),
      sep, a('view.zoomIn'), a('view.zoomOut'), a('view.fit'), a('view.fill'), a('view.100'), a('view.200'), a('view.400'), a('view.800'), a('view.printSize'), a('view.zoomCustom'), a('view.resetRotation'),
      sep, a('view.screenMode'),
      sep, a('view.extras'),
      sub('Show', [a('view.showSelectionEdges'), a('view.grid'), a('view.guides'), a('view.pixelGrid'), a('view.smartGuides')]),
      sep, a('view.rulers'),
      sep, a('view.snap'),
      sub('Snap To', [a('view.snapGuides'), a('view.snapGrid'), a('view.snapLayers'), a('view.snapDocument')]),
      sep, a('view.lockGuides'), a('view.clearGuides'), a('view.newGuide'), a('view.newGuideLayout'), a('view.slicesFromGuides'), a('view.clearSlices'),
    ],
  },
  {
    id: 'window',
    label: 'Window',
    items: () => [
      ...PANELS.map((p): MenuItem => ({ type: 'custom', label: p.title, run: () => window.dispatchEvent(new CustomEvent('celenne:togglePanel', { detail: p.id })), checked: () => (window as unknown as { __celennePanelOpen?: (id: string) => boolean }).__celennePanelOpen?.(p.id) ?? false })),
      sep,
      sub('Workspace', [a('window.resetWorkspace')]),
      sep,
      a('window.devtools'),
    ],
  },
  {
    id: 'help',
    label: 'Help',
    items: [a('help.about'), a('help.updates'), sep, a('help.shortcuts'), a('help.compatibility'), a('help.report'), a('help.gpu'), sep, a('help.reports')],
  },
];
