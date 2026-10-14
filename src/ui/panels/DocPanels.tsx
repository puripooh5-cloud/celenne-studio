/** History, Channels and Paths panels. */
import { editColor } from '../../color/plates';
import { useState } from 'react';
import { useSession, useHistoryRev } from '../hooks';
import { IconButton } from '../controls';
import { Icon } from '../icons';
import { RasterThumb } from './Thumb';
import { openContextMenu } from '../menu/Menu';
import { LambdaCommand } from '../../commands/layerCommands';
import { loadChannelAsSelection, saveSelectionToChannel, pathToSelection, selectionToPath } from '../../app/ops/selectOps';
import { newId } from '../../document/ids';
import { TiledRaster } from '../../image-engine/tiledRaster';
import { ui, useApp } from '../../app/store';
import { clonePath } from '../../vector/types';
import { setWorkPath } from '../../tools/shapeTools';
import { editRaster } from '../../commands/rasterCommands';
import { rasterizePath, pathBounds } from '../../vector/rasterize';
import { intersect, isEmpty, expand } from '../../image-engine/rect';
import { blendStraightPixel } from '../../image-engine/blend';
import { dilateMask, erodeMask } from '../../image-engine/blur';
import type { AlphaChannel } from '../../document/types';
import { mergeSpot } from '../../app/ops/modeOps';
import { mergeSpotUnavailable } from '../../color/inkModes';

export function HistoryPanel() {
  const s = useSession();
  useHistoryRev();
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!s) return <div className="panel"><div className="empty">No document</div></div>;
  const h = s.history;
  return (
    <div className="panel">
      <div className="list" style={{ flex: 1, overflow: 'auto' }}>
        {h.snapshots.map((sn) => (
          <div key={sn.id} className="list-item" onClick={() => h.restoreSnapshot(sn.id)} onContextMenu={(e) => { e.preventDefault(); openContextMenu([{ type: 'item', label: 'Rename Snapshot', run: () => setRenaming(sn.id) }, { type: 'item', label: 'Delete Snapshot', run: () => h.deleteSnapshot(sn.id) }], e.clientX, e.clientY); }} title="Click to restore this snapshot (undoable)">
            <Icon name="snapshot" size={14} />
            {renaming === sn.id ? (
              <input className="txt" autoFocus defaultValue={sn.name} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} onBlur={(e) => { h.renameSnapshot(sn.id, e.target.value); setRenaming(null); }} />
            ) : (
              <span className="grow">{sn.name}</span>
            )}
          </div>
        ))}
        {h.snapshots.length > 0 && <div className="menu-sep" />}
        {h.entries.map((e, i) => (
          <div key={e.id} className={`list-item${i === h.index ? ' active' : i > h.index ? ' future' : ''}`} onClick={() => h.goto(i)} onDoubleClick={() => setRenaming(e.id)} title={new Date(e.time).toLocaleTimeString()}>
            <span style={{ width: 14 }}>{i === h.index ? '▸' : ''}</span>
            {renaming === e.id ? (
              <input className="txt" autoFocus defaultValue={e.label} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }} onBlur={(ev) => { h.renameEntry(e.id, ev.target.value); setRenaming(null); }} />
            ) : (
              <span className="grow">{e.label}</span>
            )}
          </div>
        ))}
      </div>
      <div className="panel-toolbar">
        <span className="faint">{h.entries.length} states · {(h.memoryBytes() / 1048576).toFixed(1)} MB</span>
        <div className="spacer" />
        <IconButton icon="snapshot" title="Create new snapshot" onClick={() => h.createSnapshot()} />
        <IconButton icon="trash" title="Clear history (keeps current state)" onClick={() => h.clear('Current State')} />
      </div>
    </div>
  );
}

export function ChannelsPanel() {
  const s = useSession();
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!s) return <div className="panel"><div className="empty">No document</div></div>;
  const eng = s.engine;
  const v = eng.view.channels;
  const setCh = (c: Partial<typeof v>) => {
    eng.setView({ channels: { ...v, ...c } });
    ui.bump('docRev');
  };
  const cmykDoc = s.doc.canvas.colorMode === 'cmyk';
  type Key = 'r' | 'g' | 'b' | 'k';
  const isOn = (k: Key) => (k === 'k' ? v.k !== false : v[k]);
  const keys: Key[] = cmykDoc ? ['r', 'g', 'b', 'k'] : ['r', 'g', 'b'];
  const only = (k: Key) => setCh({ r: k === 'r', g: k === 'g', b: k === 'b', k: k === 'k' });
  const channelRow = (label: string, key: Key | null, shortcut: string) => {
    const on = key ? isOn(key) : keys.every(isOn);
    const single = key && isOn(key) && keys.filter(isOn).length === 1;
    return (
      <div className={`list-item${!s.activeChannelId && (single || (!key && on)) ? ' active' : ''}`} onClick={() => { if (key) only(key); else setCh({ r: true, g: true, b: true, k: true }); s.activeChannelId = null; s.notify(); }}>
        <span onClick={(e) => { e.stopPropagation(); if (key) setCh({ [key]: !isOn(key) }); }} style={{ width: 20 }}>{on ? <Icon name="eye" size={13} /> : ''}</span>
        <span className="grow">{label}</span>
        <span className="faint">{shortcut}</span>
      </div>
    );
  };
  const setChannels = (label: string, next: AlphaChannel[]) => {
    const before = s.doc.channels.map((c) => ({ ...c }));
    const after = next.map((c) => ({ ...c }));
    s.push(new LambdaCommand(label, (d) => { d.channels = after.map((c) => ({ ...c })); d.emit({ type: 'channels' }); }, (d) => { d.channels = before.map((c) => ({ ...c })); d.emit({ type: 'channels' }); }));
  };
  return (
    <div className="panel">
      <div className="list" style={{ flex: 1, overflow: 'auto' }}>
        {s.doc.canvas.colorMode !== 'multichannel' && channelRow(s.doc.canvas.duotone ? 'Duotone' : { grayscale: 'Gray', indexed: 'Index', bitmap: 'Bitmap', cmyk: 'CMYK', lab: 'Lab' }[s.doc.canvas.colorMode as string] ?? 'RGB', null, 'Ctrl+2')}
        {s.doc.canvas.colorMode === 'rgb' && (<>{channelRow('Red', 'r', 'Ctrl+3')}{channelRow('Green', 'g', 'Ctrl+4')}{channelRow('Blue', 'b', 'Ctrl+5')}</>)}
        {cmykDoc && (<>{channelRow('Cyan', 'r', 'Ctrl+3')}{channelRow('Magenta', 'g', 'Ctrl+4')}{channelRow('Yellow', 'b', 'Ctrl+5')}{channelRow('Black', 'k', 'Ctrl+6')}</>)}
        {s.doc.canvas.colorMode === 'lab' && (<>{channelRow('Lightness', 'r', 'Ctrl+3')}{channelRow('a', 'g', 'Ctrl+4')}{channelRow('b', 'b', 'Ctrl+5')}</>)}
        {s.activeLayer()?.mask && (
          <div className={`list-item${eng.view.maskOfLayer ? ' active' : ''}`} onClick={() => { const l = s.activeLayer()!; eng.setView({ maskOfLayer: eng.view.maskOfLayer ? null : l.id }); ui.bump('docRev'); }}>
            <span style={{ width: 20 }} />
            <span className="grow" style={{ fontStyle: 'italic' }}>{s.activeLayer()!.name} Mask</span>
          </div>
        )}
        {s.doc.channels.map((c) => (
          <div key={c.id} className={`list-item${s.activeChannelId === c.id ? ' active' : ''}`} style={{ height: 40 }}
            onClick={() => { s.activeChannelId = s.activeChannelId === c.id ? null : c.id; s.notify(); }}
            onDoubleClick={() => setRenaming(c.id)}
            onContextMenu={(e) => { e.preventDefault(); openContextMenu([
              { type: 'item', label: 'Load as Selection', run: () => loadChannelAsSelection(c.id) },
              { type: 'item', label: 'Add to Selection', run: () => loadChannelAsSelection(c.id, 'add') },
              { type: 'item', label: 'Subtract from Selection', run: () => loadChannelAsSelection(c.id, 'subtract') },
              { type: 'item', label: 'Intersect with Selection', run: () => loadChannelAsSelection(c.id, 'intersect') },
              { type: 'separator' },
              { type: 'item', label: 'Duplicate Channel', run: () => setChannels('Duplicate Channel', [...s.doc.channels, { ...c, id: newId('ch'), name: `${c.name} copy`, raster: c.raster.clone() }]) },
              { type: 'item', label: 'Rename Channel', run: () => setRenaming(c.id) },
              { type: 'item', label: 'Channel Options…', run: () => ui.openDialog('channelOptions', { channelId: c.id }) },
              { type: 'item', label: c.kind === 'spot' ? 'Convert to Alpha Channel' : 'Convert to Spot Channel', run: () => setChannels('Channel Options', s.doc.channels.map((x) => (x.id === c.id ? { ...x, kind: x.kind === 'spot' ? 'alpha' : 'spot', solidity: 0, visible: x.kind !== 'spot' } : x))) },
              ...(c.kind === 'spot' && s.doc.canvas.colorMode !== 'multichannel' ? [{ type: 'item' as const, label: 'Merge Spot Channel', disabled: !!mergeSpotUnavailable(s.doc, c.id), run: () => mergeSpot(c.id) }] : []),
              { type: 'item', label: 'Delete Channel', run: () => setChannels('Delete Channel', s.doc.channels.filter((x) => x.id !== c.id)) },
            ], e.clientX, e.clientY); }}>
            {/* Spot inks: the eye prints / hides the ink (document state). Alpha channels: overlay display. */}
            <span style={{ width: 20 }} title={c.kind === 'spot' ? 'Show or hide the printed ink' : 'Show as overlay'} onClick={(e) => {
              e.stopPropagation();
              if (c.kind === 'spot') { c.visible = !c.visible; s.doc.emit({ type: 'channels' }); s.engine.invalidateAll(); ui.bump('docRev'); return; }
              const vis = eng.view.visibleAlphaChannels; eng.setView({ visibleAlphaChannels: vis.includes(c.id) ? vis.filter((x) => x !== c.id) : [...vis, c.id] }); ui.bump('docRev');
            }}>
              {(c.kind === 'spot' ? c.visible : eng.view.visibleAlphaChannels.includes(c.id)) ? <Icon name="eye" size={13} /> : ''}
            </span>
            <RasterThumb raster={c.raster} width={s.doc.width} height={s.doc.height} size={30} />
            {renaming === c.id ? (
              <input className="txt" autoFocus defaultValue={c.name} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} onBlur={(e) => { setChannels('Rename Channel', s.doc.channels.map((x) => (x.id === c.id ? { ...x, name: e.target.value || x.name } : x))); setRenaming(null); }} />
            ) : (
              <span className="grow">{c.kind === 'spot' && <span className="swatch-dot" style={{ display: 'inline-block', width: 9, height: 9, marginRight: 5, borderRadius: 2, border: '1px solid var(--border)', background: `rgb(${c.color.r * 255},${c.color.g * 255},${c.color.b * 255})` }} />}{c.name}{c.kind === 'spot' && s.doc.canvas.colorMode !== 'multichannel' ? ' (spot)' : ''}</span>
            )}
          </div>
        ))}
      </div>
      <div className="panel-toolbar">
        <IconButton icon="channelToSelection" title="Load channel as selection" disabled={!s.activeChannelId} onClick={() => s.activeChannelId && loadChannelAsSelection(s.activeChannelId)} />
        <IconButton icon="selectionToChannel" title="Save selection as channel" disabled={s.doc.selection.isEmpty()} onClick={() => saveSelectionToChannel()} />
        <div className="spacer" />
        <IconButton icon="newLayer" title="Create new channel" onClick={() => setChannels('New Channel', [...s.doc.channels, s.doc.canvas.colorMode === 'multichannel'
          // Multichannel: a new ink (white = no ink), at the document's depth.
          ? { id: newId('ch'), name: `Spot ${s.doc.channels.length + 1}`, kind: 'spot', raster: new TiledRaster(1, s.doc.canvas.bitDepth === 16 ? 16 : 8, 1), visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 0, solidity: 0, indicatesSelected: false }
          : { id: newId('ch'), name: `Alpha ${s.doc.channels.length + 1}`, kind: 'alpha', raster: new TiledRaster(1, 8, 0), visible: false, color: { r: 1, g: 0, b: 0 }, opacity: 0.5, indicatesSelected: false }])} />
        <IconButton icon="trash" title="Delete channel" disabled={!s.activeChannelId} onClick={() => { const id = s.activeChannelId; s.activeChannelId = null; setChannels('Delete Channel', s.doc.channels.filter((x) => x.id !== id)); }} />
      </div>
    </div>
  );
}

export function PathsPanel() {
  const s = useSession();
  const [renaming, setRenaming] = useState<string | null>(null);
  useApp((st) => st.docRev);
  if (!s) return <div className="panel"><div className="empty">No document</div></div>;
  const d = s.doc;
  const active = d.paths.find((p) => p.id === s.activePathId) ?? null;
  const setPaths = (label: string, fn: (paths: typeof d.paths) => typeof d.paths) => {
    const before = structuredClone(d.paths);
    const after = fn(structuredClone(d.paths));
    s.push(new LambdaCommand(label, (doc) => { doc.paths = structuredClone(after); doc.emit({ type: 'paths' }); }, (doc) => { doc.paths = structuredClone(before); doc.emit({ type: 'paths' }); }));
  };
  const fillOrStroke = (stroke: boolean) => {
    if (!active) return;
    const target = s.paintTarget(useApp.getState().quickMask);
    if (!target) { ui.toast('info', s.paintBlockReason(false) ?? 'Select a pixel layer.'); return; }
    const fg = useApp.getState().fg;
    const w = useApp.getState().brush.size;
    const pb = pathBounds(active.path);
    if (!pb) return;
    const r = intersect(expand(pb, stroke ? Math.ceil(w) + 2 : 1), d.bounds);
    if (isEmpty(r)) return;
    let cov = rasterizePath(active.path, r);
    if (stroke) {
      const outer = dilateMask(cov, r.w, r.h, w / 2), inner = erodeMask(cov, r.w, r.h, w / 2);
      cov = outer.map((o, i) => Math.max(0, o - inner[i]));
    }
    const cmd = editRaster(d, target, stroke ? 'Stroke Path' : 'Fill Path', (raster, ox, oy, plate) => {
      const lr = { x: r.x - ox, y: r.y - oy, w: r.w, h: r.h };
      const cur = raster.readFloat(lr);
      const c = editColor(d, fg, plate);
      for (let i = 0; i < r.w * r.h; i++) {
        if (cov[i] <= 0) continue;
        if (raster.channels === 4) blendStraightPixel('normal', cur, i * 4, c.r, c.g, c.b, cov[i], false);
        else cur[i] += (0.3 * fg.r + 0.59 * fg.g + 0.11 * fg.b - cur[i]) * cov[i];
      }
      raster.writeFloat(lr, cur);
      return r;
    });
    if (cmd) s.push(cmd, true);
  };
  return (
    <div className="panel">
      <div className="list" style={{ flex: 1, overflow: 'auto' }}>
        {s.activeLayer()?.vectorMask && <div className="list-item faint"><Icon name="pen" size={13} /><span className="grow">{s.activeLayer()!.name} Vector Mask</span></div>}
        {d.paths.map((p) => (
          <div key={p.id} className={`list-item${active?.id === p.id ? ' active' : ''}`} onClick={() => { s.activePathId = p.id; s.notify(); }} onDoubleClick={() => (p.kind === 'work' ? setPaths('Save Path', (ps) => ps.map((x) => (x.id === p.id ? { ...x, kind: 'saved', name: `Path ${ps.filter((y) => y.kind !== 'work').length + 1}` } : x))) : setRenaming(p.id))}
            onContextMenu={(e) => { e.preventDefault(); openContextMenu([
              { type: 'item', label: 'Make Selection', run: () => pathToSelection(p.path) },
              { type: 'item', label: 'Fill Path', run: () => { s.activePathId = p.id; fillOrStroke(false); } },
              { type: 'item', label: 'Stroke Path', run: () => { s.activePathId = p.id; fillOrStroke(true); } },
              { type: 'separator' },
              { type: 'item', label: 'Duplicate Path', run: () => setPaths('Duplicate Path', (ps) => [...ps, { id: newId('path'), name: `${p.name} copy`, kind: 'saved', path: clonePath(p.path) }]) },
              { type: 'item', label: 'Clipping Path…', run: () => setPaths('Clipping Path', (ps) => ps.map((x) => ({ ...x, kind: x.id === p.id ? 'clipping' : x.kind === 'clipping' ? 'saved' : x.kind }))) },
              { type: 'item', label: 'Delete Path', run: () => setPaths('Delete Path', (ps) => ps.filter((x) => x.id !== p.id)) },
            ], e.clientX, e.clientY); }}>
            <Icon name="pen" size={13} />
            {renaming === p.id ? (
              <input className="txt" autoFocus defaultValue={p.name} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} onBlur={(e) => { setPaths('Rename Path', (ps) => ps.map((x) => (x.id === p.id ? { ...x, name: e.target.value || x.name } : x))); setRenaming(null); }} />
            ) : (
              <span className="grow" style={{ fontStyle: p.kind === 'work' ? 'italic' : undefined }}>{p.name}{p.kind === 'clipping' ? ' (clipping)' : ''}</span>
            )}
          </div>
        ))}
        {!d.paths.length && <div className="empty">No paths. Draw with the Pen or shape tools in Path mode.</div>}
      </div>
      <div className="panel-toolbar">
        <IconButton icon="pathFill" title="Fill path with foreground color" disabled={!active} onClick={() => fillOrStroke(false)} />
        <IconButton icon="pathStroke" title="Stroke path with brush size" disabled={!active} onClick={() => fillOrStroke(true)} />
        <IconButton icon="channelToSelection" title="Load path as a selection" disabled={!active} onClick={() => active && pathToSelection(active.path)} />
        <IconButton icon="selectionToChannel" title="Make work path from selection" disabled={d.selection.isEmpty()} onClick={() => { const p = selectionToPath(); if (p) setWorkPath(s, p, 'Make Work Path'); }} />
        <div className="spacer" />
        <IconButton icon="newLayer" title="Create new path" onClick={() => { const id = newId('path'); setPaths('New Path', (ps) => [...ps, { id, name: `Path ${ps.filter((x) => x.kind !== 'work').length + 1}`, kind: 'saved', path: { subpaths: [], fillRule: 'nonzero' } }]); s.activePathId = id; }} />
        <IconButton icon="trash" title="Delete path" disabled={!active} onClick={() => active && setPaths('Delete Path', (ps) => ps.filter((x) => x.id !== active.id))} />
      </div>
    </div>
  );
}
