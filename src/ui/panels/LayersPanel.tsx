/** Layers panel. */
import { imageSpace, rasterFromImage } from '../../formats/decodedRaster';
import { convertRasterSpace, spaceOfDoc } from '../../color/convertDocument';
import { useRef, useState } from 'react';
import { useSession } from '../hooks';
import type { Layer, LayerId } from '../../document/types';
import * as L from '../../app/ops/layerOps';
import { loadLayerTransparency } from '../../app/ops/selectOps';
import { BlendSelect, IconButton, NumberField } from '../controls';
import { Icon } from '../icons';
import { LayerThumb } from './Thumb';
import { openContextMenu, PopupItem } from '../menu/Menu';
import { run } from '../../app/actions';
import { ui } from '../../app/store';
import { ADJUSTMENT_LABELS, AdjustmentType } from '../../adjustments/types';
import { EFFECT_LABELS, EffectKind, hasAnyEffect } from '../../effects/types';
import { platform } from '../../app/platform/platform';
import { decodeImageFile } from '../../formats/codecs';
import { createPixelLayer } from '../../document/layerFactory';
import { TiledRaster } from '../../image-engine/tiledRaster';
import { CreateLayerCommand, SetEffectsCommand } from '../../commands/layerCommands';
import type { DocumentSession } from '../../app/session';
import { editLayer } from '../../commands/layerCommands';
import { updateAppearance } from '../../layers/appearance';
import { editor } from '../../app/editor';
import type { RGB } from '../../color/types';

/** Double-click on a layer: edit its content like professional editors do. */
function editLayerContent(s: DocumentSession, l: Layer) {
  s.setActive(l.id);
  const pickColor = (initial: RGB, apply: (layer: Layer, c: RGB) => void, label: string) =>
    ui.openDialog('colorPicker', {
      purpose: 'callback',
      initial,
      onPick: (c: RGB) => {
        const cmd = editLayer(s.doc, l.id, label, (layer) => { apply(layer, c); updateAppearance(s.doc, layer); });
        if (cmd) s.push(cmd, true);
      },
    });
  if (l.kind === 'adjustment') window.dispatchEvent(new CustomEvent('celenne:showPanel', { detail: 'properties' }));
  else if (l.kind === 'fill' && l.fill.type === 'solid') pickColor(l.fill.color, (x, c) => { if (x.kind === 'fill') x.fill = { type: 'solid', color: c }; }, 'Fill Color');
  else if (l.kind === 'fill') window.dispatchEvent(new CustomEvent('celenne:showPanel', { detail: 'properties' }));
  else if (l.kind === 'shape' && l.fill.type === 'solid') pickColor(l.fill.color, (x, c) => { if (x.kind === 'shape') x.fill = { type: 'solid', color: c }; }, 'Shape Fill');
  else if (l.kind === 'text') {
    editor.setTool('type');
    void import('../../tools/typeTool').then((m) => m.startTextEdit(s, l.id, false));
  } else ui.openDialog('layerStyle', { layerId: l.id });
}

type DropPos = { id: LayerId; where: 'above' | 'below' | 'into' } | null;

function kindIcon(l: Layer): string | null {
  switch (l.kind) {
    case 'text': return 'text';
    case 'shape': return 'shape';
    case 'smartObject': return 'smart';
    case 'video': return 'video';
    default: return null;
  }
}

function effectList(l: Layer): { kind: EffectKind; index: number; enabled: boolean }[] {
  const fx = l.effects;
  if (!fx) return [];
  const out: { kind: EffectKind; index: number; enabled: boolean }[] = [];
  const multi = (k: 'dropShadow' | 'innerShadow' | 'colorOverlay' | 'gradientOverlay' | 'stroke') => fx[k].forEach((e, i) => out.push({ kind: k, index: i, enabled: e.enabled }));
  if (fx.bevel) out.push({ kind: 'bevel', index: 0, enabled: fx.bevel.enabled });
  multi('stroke');
  multi('innerShadow');
  if (fx.innerGlow) out.push({ kind: 'innerGlow', index: 0, enabled: fx.innerGlow.enabled });
  if (fx.satin) out.push({ kind: 'satin', index: 0, enabled: fx.satin.enabled });
  multi('colorOverlay');
  multi('gradientOverlay');
  if (fx.patternOverlay) out.push({ kind: 'patternOverlay', index: 0, enabled: fx.patternOverlay.enabled });
  if (fx.outerGlow) out.push({ kind: 'outerGlow', index: 0, enabled: fx.outerGlow.enabled });
  multi('dropShadow');
  return out;
}

function toggleEffect(s: DocumentSession, l: Layer, kind: EffectKind | 'all', index = 0) {
  if (!l.effects) return;
  const fx = structuredClone(l.effects);
  if (kind === 'all') fx.enabled = !fx.enabled;
  else {
    const v = fx[kind];
    if (Array.isArray(v)) v[index].enabled = !v[index].enabled;
    else if (v) (v as { enabled: boolean }).enabled = !(v as { enabled: boolean }).enabled;
  }
  s.push(new SetEffectsCommand(l.id, l.effects, fx, 'Toggle Effect'));
}

export function LayersPanel() {
  const s = useSession();
  const [renaming, setRenaming] = useState<LayerId | null>(null);
  const [drop, setDrop] = useState<DropPos>(null);
  const [fxOpen, setFxOpen] = useState<Set<LayerId>>(new Set());
  const [filter, setFilter] = useState('');
  const dragIds = useRef<LayerId[]>([]);
  const lastClicked = useRef<LayerId | null>(null);
  if (!s) return <div className="panel"><div className="empty">No document</div></div>;
  const active = s.activeLayer();
  const doc = s.doc;

  const flatVisible: Layer[] = [];
  const collect = (ls: Layer[]) => {
    for (const l of [...ls].reverse()) {
      flatVisible.push(l);
      if (l.kind === 'group' && l.expanded) collect(l.children);
    }
  };
  collect(doc.root.children);

  const select = (l: Layer, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) s.toggleSelected(l.id);
    else if (e.shiftKey && lastClicked.current) {
      const a = flatVisible.findIndex((x) => x.id === lastClicked.current), b = flatVisible.findIndex((x) => x.id === l.id);
      const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
      s.selectedIds.clear();
      for (let i = lo; i <= hi; i++) s.selectedIds.add(flatVisible[i].id);
      s.activeLayerId = l.id;
      s.notify();
    } else s.setActive(l.id);
    lastClicked.current = l.id;
    s.editMask = false;
    s.engine.setView({ maskOfLayer: null });
  };

  const rowMenu = (l: Layer, e: React.MouseEvent) => {
    e.preventDefault();
    if (!s.selectedIds.has(l.id)) s.setActive(l.id);
    const items: PopupItem[] = [
      { type: 'item', label: 'Blending Options…', run: () => ui.openDialog('layerStyle', { layerId: l.id }) },
      { type: 'separator' },
      { type: 'item', label: 'Duplicate Layer', run: () => L.duplicateLayers() },
      { type: 'item', label: 'Delete Layer', run: () => L.deleteLayers() },
      { type: 'item', label: 'Rename Layer', run: () => setRenaming(l.id) },
      { type: 'separator' },
      { type: 'item', label: 'Group from Layers', run: () => L.newGroup(true) },
      ...(l.kind === 'group' ? [{ type: 'item' as const, label: 'Ungroup Layers', run: () => L.ungroup() }] : []),
      { type: 'separator' },
      { type: 'item', label: 'Convert to Smart Object', run: () => L.convertToSmartObject() },
      ...(l.kind === 'smartObject' ? [{ type: 'item' as const, label: 'Edit Contents', run: () => L.editSmartContents() }, { type: 'item' as const, label: 'Replace Contents…', run: () => L.replaceSmartContents() }] : []),
      { type: 'item', label: l.kind === 'text' ? 'Rasterize Type' : l.kind === 'shape' ? 'Rasterize Shape' : 'Rasterize Layer', run: () => L.rasterize('layer'), disabled: ['pixel', 'group', 'adjustment'].includes(l.kind) },
      ...(l.effects ? [{ type: 'item' as const, label: 'Rasterize Layer Style', run: () => L.rasterize('style') }] : []),
      { type: 'separator' },
      { type: 'item', label: l.clipping ? 'Release Clipping Mask' : 'Create Clipping Mask', run: () => L.toggleClipping(l.id) },
      ...(!l.mask ? [{ type: 'item' as const, label: 'Add Layer Mask', run: () => L.addMask('revealAll') }] : [
        { type: 'item' as const, label: l.mask.enabled ? 'Disable Layer Mask' : 'Enable Layer Mask', run: () => L.setMaskProps({ enabled: !l.mask!.enabled }, 'Toggle Mask') },
        { type: 'item' as const, label: 'Apply Layer Mask', run: () => L.deleteMask(true) },
        { type: 'item' as const, label: 'Delete Layer Mask', run: () => L.deleteMask(false) },
      ]),
      ...(!l.vectorMask ? [{ type: 'item' as const, label: 'Add Vector Mask', run: () => L.addVectorMask(true) }] : [{ type: 'item' as const, label: 'Delete Vector Mask', run: () => L.deleteVectorMask() }]),
      { type: 'separator' },
      { type: 'item', label: 'Copy Layer Style', run: () => L.copyStyle() },
      { type: 'item', label: 'Paste Layer Style', run: () => L.pasteStyle() },
      { type: 'item', label: 'Clear Layer Style', run: () => L.clearStyle(), disabled: !l.effects },
      { type: 'separator' },
      { type: 'submenu', label: 'Color', items: (['none', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray'] as const).map((c) => ({ type: 'item' as const, label: c === 'none' ? 'No Color' : c[0].toUpperCase() + c.slice(1), run: () => L.setColorTag(l.id, c), checked: l.colorTag === c })) },
      { type: 'separator' },
      { type: 'item', label: 'Merge Down', run: () => L.mergeDown() },
      { type: 'item', label: 'Merge Visible', run: () => L.mergeVisible() },
      { type: 'item', label: 'Flatten Image', run: () => L.flattenImage() },
    ];
    openContextMenu(items, e.clientX, e.clientY);
  };

  const onDragStart = (l: Layer, e: React.DragEvent) => {
    const ids = s.selectedIds.has(l.id) ? L.topLevelSelection(s).map((x) => x.id) : [l.id];
    dragIds.current = ids;
    e.dataTransfer.setData('application/x-celenne-layers', ids.join(','));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (l: Layer, e: React.DragEvent) => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const where = l.kind === 'group' && y > 0.3 && y < 0.7 ? 'into' : y < 0.5 ? 'above' : 'below';
    // dragover fires continuously: re-render the panel only when the drop position changes.
    setDrop((d) => (d && d.id === l.id && d.where === where ? d : { id: l.id, where }));
  };
  const onDrop = async (target: Layer, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const d = drop;
    setDrop(null);
    if (e.dataTransfer.files.length) {
      // Files from the OS: new layers.
      for (const f of [...e.dataTransfer.files]) {
        try {
          const opened = await platform().fileFromDrop(f);
          const img = await decodeImageFile(opened.data, f.name);
          const layer = createPixelLayer(f.name.replace(/\.[^.]+$/, ''), doc.canvas.bitDepth);
          layer.raster = rasterFromImage(img, doc.canvas.bitDepth);
          convertRasterSpace(layer.raster, imageSpace(img), spaceOfDoc(doc));
          layer.x = Math.round((doc.width - img.width) / 2);
          layer.y = Math.round((doc.height - img.height) / 2);
          const parent = target.parent ?? doc.root;
          s.push(new CreateLayerCommand('Place Dropped Image', layer, parent.id, parent.children.indexOf(target) + 1));
        } catch (err) {
          ui.toast('error', `Could not add "${f.name}"`, (err as Error).message);
        }
      }
      return;
    }
    if (!d) return;
    for (const id of dragIds.current) {
      if (id === target.id) continue;
      const moving = doc.getLayer(id);
      if (!moving) continue;
      if (d.where === 'into' && target.kind === 'group') L.moveLayer(id, target.id, target.children.length);
      else {
        const parent = target.parent ?? doc.root;
        const idx = parent.children.indexOf(target);
        L.moveLayer(id, parent.id, d.where === 'above' ? idx + 1 : idx);
      }
    }
    dragIds.current = [];
  };

  const renderRow = (l: Layer, depth: number) => {
    const isActive = active?.id === l.id;
    const selected = s.selectedIds.has(l.id);
    const fx = hasAnyEffect(l.effects);
    const fxRows = fx && fxOpen.has(l.id) ? effectList(l) : [];
    const warn = l.metadata.unsupported.length > 0 || (l.kind === 'text' && l.missingFonts.length > 0);
    const dropClass = drop?.id === l.id ? ` drop-${drop.where}` : '';
    if (filter && !l.name.toLowerCase().includes(filter.toLowerCase()) && l.kind !== 'group') return null;
    return (
      <div key={l.id}>
        <div
          className={`layer-row${isActive ? ' active' : selected ? ' selected' : ''}${dropClass}${l.colorTag !== 'none' ? ` color-tag-${l.colorTag}` : ''}`}
          draggable={renaming !== l.id}
          onDragStart={(e) => onDragStart(l, e)}
          onDragOver={(e) => onDragOver(l, e)}
          onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDrop(null); }}
          onDrop={(e) => onDrop(l, e)}
          onMouseDown={(e) => { if (e.button === 0) select(l, e); }}
          onContextMenu={(e) => rowMenu(l, e)}
          onDoubleClick={(e) => {
            // Quick clicks on the row's buttons (visibility, expand, effects, mask link) are not a double-click on the layer.
            if ((e.target as HTMLElement).closest('.eye, .twisty, .fx, .mask-link, .badges')) return;
            if ((e.target as HTMLElement).closest('.name')) setRenaming(l.id);
            else editLayerContent(s, l);
          }}
          role="treeitem"
          aria-selected={selected}
          aria-level={depth + 1}
        >
          <div className={`eye${l.visible ? '' : ' off'}`} title="Toggle visibility (Alt+click: show only this layer)" onMouseDown={(e) => { e.stopPropagation(); L.toggleVisibility(l.id, e.altKey); }}>
            <Icon name="eye" size={14} />
          </div>
          <div className="indent" style={{ width: depth * 14 }} />
          {l.kind === 'group' ? (
            <span className="twisty" onMouseDown={(e) => { e.stopPropagation(); l.expanded = !l.expanded; s.notify(); }}>{l.expanded ? '▼' : '▶'}</span>
          ) : (
            <span className="twisty" />
          )}
          {l.clipping && <span className="clip-arrow" title="Clipped to the layer below">↳</span>}
          <LayerThumb
            doc={doc}
            layer={l}
            kind="layer"
            selected={isActive && !s.editMask && !!l.mask}
            onClick={(e) => {
              e.stopPropagation();
              if (e.ctrlKey || e.metaKey) loadLayerTransparency(l.id, e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace');
              else { s.setActive(l.id); s.editMask = false; s.engine.setView({ maskOfLayer: null }); s.notify(); }
            }}
          />
          {l.mask && (
            <>
              <span className="mask-link" title={l.mask.linked ? 'Mask linked (click to unlink)' : 'Mask unlinked'} onMouseDown={(e) => { e.stopPropagation(); s.setActive(l.id); L.setMaskProps({ linked: !l.mask!.linked }, 'Link Mask'); }}>
                {l.mask.linked ? '⛓' : '·'}
              </span>
              <div style={{ position: 'relative', opacity: l.mask.enabled ? 1 : 0.4 }}>
                <LayerThumb
                  doc={doc}
                  layer={l}
                  kind="mask"
                  selected={isActive && s.editMask}
                  onClick={(e) => {
                    e.stopPropagation();
                    s.setActive(l.id);
                    if (e.shiftKey) { L.setMaskProps({ enabled: !l.mask!.enabled }, 'Toggle Mask'); return; }
                    if (e.ctrlKey || e.metaKey) { loadLayerTransparency(l.id, 'replace', true); return; }
                    if (e.altKey) { s.engine.setView({ maskOfLayer: s.engine.view.maskOfLayer === l.id ? null : l.id }); return; }
                    s.editMask = true;
                    s.notify();
                  }}
                />
                {!l.mask.enabled && <span style={{ position: 'absolute', inset: 0, color: '#e5484d', fontSize: 22, lineHeight: '30px', textAlign: 'center', pointerEvents: 'none' }}>✕</span>}
              </div>
            </>
          )}
          {l.vectorMask && <div className="thumb icon" title="Vector mask" style={{ width: 24, height: 24 }}><Icon name="pen" size={14} /></div>}
          <div className="name" title={l.name}>
            {renaming === l.id ? (
              <input
                className="txt"
                autoFocus
                defaultValue={l.name}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onBlur={(e) => { L.renameLayer(l.id, e.target.value); setRenaming(null); }}
              />
            ) : (
              <span style={{ fontStyle: l.kind === 'adjustment' ? 'normal' : undefined }}>{l.name}</span>
            )}
          </div>
          <div className="badges">
            {warn && <span title={[...l.metadata.unsupported, ...(l.kind === 'text' && l.missingFonts.length ? [`Missing font: ${l.missingFonts.join(', ')}`] : [])].join('\n')} style={{ color: 'var(--warning)' }}><Icon name="warning" /></span>}
            {l.kind === 'text' && l.text.paragraphs.some((p) => p.style.composer === 'celenne' || p.style.opticalMargins) && <span className="celenne-badge" title="Celenne layout (composer or optical margins). Photoshop lays this text out with its own composer when it opens the file.">C</span>}
            {kindIcon(l) && <Icon name={kindIcon(l)!} />}
            {(l.locks.all || l.locks.pixels || l.locks.position || l.locks.transparency) && <Icon name="lock" />}
            {fx && (
              <span className="fx" title="Layer effects (click to expand)" onMouseDown={(e) => { e.stopPropagation(); const n = new Set(fxOpen); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); setFxOpen(n); }}>
                fx {fxOpen.has(l.id) ? '▴' : '▾'}
              </span>
            )}
          </div>
        </div>
        {fxRows.length > 0 && (
          <>
            <div className="effect-row" style={{ paddingLeft: depth * 14 }}>
              <span className="eye" onMouseDown={() => toggleEffect(s, l, 'all')}>{l.effects!.enabled ? <Icon name="eye" size={12} /> : ''}</span>
              <span>Effects</span>
            </div>
            {fxRows.map((f) => (
              <div key={`${f.kind}${f.index}`} className="effect-row" style={{ paddingLeft: depth * 14 + 16 }} onDoubleClick={() => ui.openDialog('layerStyle', { layerId: l.id, effect: f.kind })}>
                <span className="eye" onMouseDown={() => toggleEffect(s, l, f.kind, f.index)}>{f.enabled ? <Icon name="eye" size={12} /> : ''}</span>
                <span>{EFFECT_LABELS[f.kind]}</span>
              </div>
            ))}
          </>
        )}
        {l.kind === 'group' && l.expanded && [...l.children].reverse().map((c) => renderRow(c, depth + 1))}
      </div>
    );
  };

  const lockBtn = (lock: keyof Layer['locks'], icon: string, title: string) => (
    <IconButton icon={icon} title={title} on={!!active?.locks[lock]} disabled={!active} onClick={() => active && L.setLock(active.id, lock)} />
  );

  return (
    <div className="panel" onDragOver={(e) => e.preventDefault()}>
      <div className="layers-top">
        <div className="row">
          <BlendSelect value={active?.blendMode ?? 'normal'} allowPassThrough={active?.kind === 'group'} onChange={(m) => active && L.setBlendMode(active.id, m)} width={128} />
          <NumberField label="Opacity" value={Math.round((active?.opacity ?? 1) * 100)} onChange={(v) => active && L.setOpacity(active.id, v / 100)} onCommit={() => s.history.seal()} min={0} max={100} unit="%" width={46} disabled={!active} />
        </div>
        <div className="row">
          <span className="muted">Lock:</span>
          {lockBtn('transparency', 'lockTransparency', 'Lock transparent pixels')}
          {lockBtn('pixels', 'lockPixels', 'Lock image pixels')}
          {lockBtn('position', 'lockPosition', 'Lock position')}
          {lockBtn('all', 'lock', 'Lock all')}
          <div style={{ flex: 1 }} />
          <NumberField label="Fill" value={Math.round((active?.fillOpacity ?? 1) * 100)} onChange={(v) => active && L.setOpacity(active.id, v / 100, true)} onCommit={() => s.history.seal()} min={0} max={100} unit="%" width={46} disabled={!active || active.kind === 'group'} />
        </div>
        <input className="txt" placeholder="Filter layers by name" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="layer-list" role="tree" aria-label="Layers" onContextMenu={(e) => e.preventDefault()}>
        {[...doc.root.children].reverse().map((l) => renderRow(l, 0))}
        {!doc.root.children.length && <div className="empty">No layers</div>}
      </div>
      <div className="panel-toolbar">
        <IconButton icon="fx" title="Add a layer style" disabled={!active} onClick={() => active && ui.openDialog('layerStyle', { layerId: active.id })} />
        <IconButton icon="mask" title="Add layer mask" disabled={!active || !!active.mask} onClick={() => L.addMask('revealAll')} />
        <IconButton
          icon="adjust"
          title="Create new fill or adjustment layer"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openContextMenu([
              { type: 'item', label: 'Solid Color…', run: () => run('layer.newFill.solid') },
              { type: 'item', label: 'Gradient…', run: () => run('layer.newFill.gradient') },
              { type: 'item', label: 'Pattern…', run: () => run('layer.newFill.pattern') },
              { type: 'separator' },
              ...(Object.keys(ADJUSTMENT_LABELS) as AdjustmentType[]).map((t) => ({ type: 'item' as const, label: `${ADJUSTMENT_LABELS[t]}…`, run: () => L.newAdjustmentLayer(t) })),
            ], r.left, r.top - 420);
          }}
        />
        <IconButton icon="folder" title="Create a new group" onClick={() => L.newGroup(false)} />
        <IconButton icon="newLayer" title="Create a new layer (Shift+Ctrl+N)" onClick={() => L.newLayer()} />
        <div className="spacer" />
        <IconButton icon="trash" title="Delete layer" disabled={!active} onClick={() => L.deleteLayers()} />
      </div>
    </div>
  );
}
