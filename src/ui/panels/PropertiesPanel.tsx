/** Properties panel (context-sensitive). */
import { useSession } from '../hooks';
import type { AdjustmentLayer, FillLayer, Layer, Paint, ShapeLayer, SmartObjectLayer, TextLayer } from '../../document/types';
import { ADJUSTMENT_LABELS, Adjustment, defaultAdjustment } from '../../adjustments/types';
import type { JSX } from 'react';
import { ModifyAdjustmentCommand, SetLayerFieldCommand, TranslateLayersCommand } from '../../commands/layerCommands';
import { AdjustmentEditor, GradientEditor } from './AdjustmentEditors';
import { Check, ColorSwatch, IconButton, NumberField, Section, Select, BlendSelect } from '../controls';
import { layerContentBounds } from '../../rendering/bounds';
import * as L from '../../app/ops/layerOps';
import { run } from '../../app/actions';
import { ui } from '../../app/store';
import type { RGB } from '../../color/types';
import { pathFromOrigin } from '../../vector/shapes';
import { applyTextStyle } from '../../tools/typeTool';
import { fonts } from '../../typography/fonts';
import { updateSmartFilters } from '../../app/ops/filterOps';
import { filterById } from '../../filters/builtin';
import type { DocumentSession } from '../../app/session';
import { Icon } from '../icons';
import { simpleGradient } from '../../color/types';

function DocProps({ s }: { s: DocumentSession }) {
  const c = s.doc.canvas;
  return (
    <div className="panel-body">
      <Section title="Document">
        <div className="grid2">
          <span className="lbl">Size</span><span>{c.width} × {c.height} px</span>
          <span className="lbl">Resolution</span><span>{c.resolution} ppi</span>
          <span className="lbl">Mode</span><span>{c.colorMode.toUpperCase()} / {c.bitDepth}-bit</span>
          <span className="lbl">Profile</span><span title={s.doc.profile.name}>{s.doc.profile.name}</span>
          <span className="lbl">Layers</span><span>{s.doc.layerCount()}</span>
        </div>
      </Section>
      <div className="row wrap">
        <button className="btn small" onClick={() => run('image.size')}>Image Size…</button>
        <button className="btn small" onClick={() => run('image.canvasSize')}>Canvas Size…</button>
        <button className="btn small" onClick={() => run('image.trim')}>Trim…</button>
      </div>
      <Section title="Rulers & Grids">
        <div className="row wrap">
          <Check label="Rulers" checked={ui.get().view.rulers} onChange={() => run('view.rulers')} />
          <Check label="Grid" checked={ui.get().view.grid} onChange={() => run('view.grid')} />
          <Check label="Guides" checked={ui.get().view.guides} onChange={() => run('view.guides')} />
        </div>
        <NumberField label="Grid spacing" value={s.doc.grid.spacing} onChange={(v) => { s.doc.grid.spacing = Math.max(1, v); ui.bump('viewRev'); }} min={1} unit="px" />
      </Section>
    </div>
  );
}

function TransformInfo({ s, l }: { s: DocumentSession; l: Layer }) {
  const b = layerContentBounds(l);
  if (!b) return <div className="muted">Empty layer</div>;
  const move = (dx: number, dy: number) => { if (dx || dy) s.push(new TranslateLayersCommand([l.id], dx, dy)); };
  return (
    <Section title="Transform">
      <div className="row wrap">
        <NumberField label="X" value={b.x} onChange={(v) => move(Math.round(v - b.x), 0)} unit="px" />
        <NumberField label="Y" value={b.y} onChange={(v) => move(0, Math.round(v - b.y))} unit="px" />
        <span className="muted">W {b.w} · H {b.h} px</span>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <IconButton icon="flipH" title="Flip horizontal" onClick={() => run('edit.transform.flipH')} />
        <IconButton icon="rotateCw" title="Rotate 90° CW" onClick={() => run('edit.transform.rotate90cw')} />
        <button className="btn small" onClick={() => run('edit.freeTransform')}>Free Transform</button>
      </div>
    </Section>
  );
}

function PaintEditor({ label, paint, onChange, allowNone = true }: { label: string; paint: Paint; onChange: (p: Paint) => void; allowNone?: boolean }) {
  return (
    <div className="row wrap">
      <span className="muted" style={{ minWidth: 40 }}>{label}</span>
      <Select value={paint.type} onChange={(t) => {
        if (t === 'none') onChange({ type: 'none' });
        else if (t === 'solid') onChange({ type: 'solid', color: paint.type === 'solid' ? paint.color : { r: 0.3, g: 0.45, b: 0.9 } });
        else if (t === 'gradient') onChange({ type: 'gradient', gradient: simpleGradient(ui.get().fg, ui.get().bg), style: 'linear', angle: 90, scale: 100, reverse: false, dither: true });
      }} options={[...(allowNone ? [{ value: 'none' as const, label: 'None' }] : []), { value: 'solid' as const, label: 'Solid color' }, { value: 'gradient' as const, label: 'Gradient' }]} />
      {paint.type === 'solid' && <ColorSwatch color={paint.color} onClick={() => ui.openDialog('colorPicker', { purpose: 'callback', initial: paint.color, onPick: (c: RGB) => onChange({ type: 'solid', color: c }) })} />}
      {paint.type === 'gradient' && (
        <div style={{ width: '100%' }}>
          <GradientEditor gradient={paint.gradient} onChange={(g) => onChange({ ...paint, gradient: g })} />
          <div className="row">
            <Select value={paint.style} onChange={(v) => onChange({ ...paint, style: v })} options={[{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }, { value: 'angle', label: 'Angle' }, { value: 'reflected', label: 'Reflected' }, { value: 'diamond', label: 'Diamond' }]} />
            <NumberField label="∠" value={paint.angle} onChange={(v) => onChange({ ...paint, angle: v })} unit="°" />
          </div>
        </div>
      )}
    </div>
  );
}

function ShapeProps({ s, l }: { s: DocumentSession; l: ShapeLayer }) {
  const edit = (label: string, mutate: (x: ShapeLayer) => void) => L.commitAppearance(s, l.id, label, (x) => mutate(x as ShapeLayer));
  const o = l.origin;
  return (
    <>
      {o && o.kind !== 'custom' && (
        <Section title={`Live Shape: ${o.kind.replace(/([A-Z])/g, ' $1')}`}>
          <div className="row wrap">
            <NumberField label="W" value={o.w} onChange={(v) => edit('Shape Size', (x) => { x.origin = { ...x.origin!, w: Math.max(1, v) }; x.path = pathFromOrigin(x.origin); })} unit="px" />
            <NumberField label="H" value={o.h} onChange={(v) => edit('Shape Size', (x) => { x.origin = { ...x.origin!, h: Math.max(1, v) }; x.path = pathFromOrigin(x.origin); })} unit="px" />
            <NumberField label="X" value={o.x} onChange={(v) => edit('Shape Position', (x) => { x.origin = { ...x.origin!, x: v }; x.path = pathFromOrigin(x.origin); })} unit="px" />
            <NumberField label="Y" value={o.y} onChange={(v) => edit('Shape Position', (x) => { x.origin = { ...x.origin!, y: v }; x.path = pathFromOrigin(x.origin); })} unit="px" />
          </div>
          {(o.kind === 'rectangle' || o.kind === 'roundedRectangle') && (
            <div className="row wrap" style={{ marginTop: 6 }}>
              {(['TL', 'TR', 'BR', 'BL'] as const).map((c, i) => (
                <NumberField key={c} label={c} value={o.radii?.[i] ?? 0} width={42} onChange={(v) => edit('Corner Radius', (x) => { const r = [...(x.origin!.radii ?? [0, 0, 0, 0])] as [number, number, number, number]; r[i] = Math.max(0, v); x.origin = { ...x.origin!, kind: 'roundedRectangle', radii: r }; x.path = pathFromOrigin(x.origin); })} />
              ))}
            </div>
          )}
          {(o.kind === 'polygon' || o.kind === 'star') && <NumberField label="Sides" value={o.sides ?? 5} onChange={(v) => edit('Polygon Sides', (x) => { x.origin = { ...x.origin!, sides: Math.max(3, Math.round(v)) }; x.path = pathFromOrigin(x.origin); })} min={3} max={100} />}
        </Section>
      )}
      <Section title="Appearance">
        <PaintEditor label="Fill" paint={l.fill} onChange={(p) => edit('Shape Fill', (x) => { x.fill = p; })} />
        <div className="row wrap" style={{ marginTop: 6 }}>
          <Check label="Stroke" checked={l.stroke.enabled} onChange={(v) => edit('Shape Stroke', (x) => { x.stroke = { ...x.stroke, enabled: v }; })} />
          <NumberField label="Width" value={l.stroke.width} onChange={(v) => edit('Stroke Width', (x) => { x.stroke = { ...x.stroke, width: Math.max(0, v), enabled: true }; })} unit="px" step={0.5} />
        </div>
        {l.stroke.enabled && (
          <>
            <PaintEditor label="Color" paint={l.stroke.paint} allowNone={false} onChange={(p) => edit('Stroke Color', (x) => { x.stroke = { ...x.stroke, paint: p }; })} />
            <div className="row wrap">
              <Select label="Align" value={l.stroke.alignment} onChange={(v) => edit('Stroke Alignment', (x) => { x.stroke = { ...x.stroke, alignment: v }; })} options={[{ value: 'inside', label: 'Inside' }, { value: 'center', label: 'Center' }, { value: 'outside', label: 'Outside' }]} />
              <Select label="Caps" value={l.stroke.cap} onChange={(v) => edit('Stroke Caps', (x) => { x.stroke = { ...x.stroke, cap: v }; })} options={[{ value: 'butt', label: 'Butt' }, { value: 'round', label: 'Round' }, { value: 'square', label: 'Square' }]} />
              <Select label="Joins" value={l.stroke.join} onChange={(v) => edit('Stroke Joins', (x) => { x.stroke = { ...x.stroke, join: v }; })} options={[{ value: 'miter', label: 'Miter' }, { value: 'round', label: 'Round' }, { value: 'bevel', label: 'Bevel' }]} />
              <Select label="Dash" value={l.stroke.dash.length ? (l.stroke.dash[0] === 0 ? 'dots' : 'dashed') : 'solid'} onChange={(v) => edit('Stroke Dash', (x) => { x.stroke = { ...x.stroke, dash: v === 'solid' ? [] : v === 'dots' ? [0, 2] : [4, 2], cap: v === 'dots' ? 'round' : x.stroke.cap }; })} options={[{ value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }, { value: 'dots', label: 'Dotted' }]} />
            </div>
          </>
        )}
      </Section>
    </>
  );
}

function TextProps({ s, l }: { s: DocumentSession; l: TextLayer }) {
  const st = l.text.runs[0]?.style;
  if (!st) return null;
  const scale = Math.hypot(l.text.transform[0], l.text.transform[1]);
  const pt = (st.fontSize * scale * 72) / s.doc.canvas.resolution;
  return (
    <Section title="Character">
      {l.missingFonts.length > 0 && (
        <div className="tag warn" style={{ display: 'block', marginBottom: 6 }}>Font not installed: {l.missingFonts.join(', ')} — substituted when re-rendered</div>
      )}
      {l.usingPreservedPixels && <div className="faint" style={{ marginBottom: 6 }}>Showing Photoshop's stored rendering until the text is edited.</div>}
      <div className="row wrap">
        <Select value={st.fontFamily} width={150} onChange={(v) => applyTextStyle(s, l.id, { fontFamily: v, postScriptName: undefined })} options={[...new Set([st.fontFamily, ...fonts.families])].map((f) => ({ value: f, label: f }))} />
        <NumberField value={Math.round(pt * 10) / 10} onChange={(v) => applyTextStyle(s, l.id, { fontSize: (v * s.doc.canvas.resolution) / 72 / scale })} unit="pt" step={0.5} />
        <ColorSwatch color={st.color} onClick={() => ui.openDialog('colorPicker', { purpose: 'callback', initial: st.color, onPick: (c: RGB) => applyTextStyle(s, l.id, { color: { ...c, a: 1 } }) })} />
      </div>
      <div className="row wrap" style={{ marginTop: 6 }}>
        <NumberField label="Tracking" value={st.tracking} onChange={(v) => applyTextStyle(s, l.id, { tracking: v })} step={10} />
        <NumberField label="Leading" value={st.leading ?? Math.round(st.fontSize * 1.2)} onChange={(v) => applyTextStyle(s, l.id, { leading: v })} unit="px" />
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn small" onClick={() => run(l.text.kind === 'point' ? 'type.toParagraph' : 'type.toPoint')}>Convert to {l.text.kind === 'point' ? 'Paragraph' : 'Point'} Text</button>
        <button className="btn small" onClick={() => run('type.rasterize')}>Rasterize</button>
      </div>
    </Section>
  );
}

function SmartProps({ s, l }: { s: DocumentSession; l: SmartObjectLayer }) {
  const src = s.doc.smartSources.get(l.sourceId);
  return (
    <>
      <Section title="Smart Object">
        <div className="grid2">
          <span className="lbl">Source</span><span>{src?.name ?? 'missing'}</span>
          <span className="lbl">Type</span><span>{src ? `${src.kind === 'linked' ? 'Linked' : 'Embedded'} ${src.fileType.toUpperCase()}` : '—'}</span>
          <span className="lbl">Size</span><span>{Math.round(l.sourceWidth)} × {Math.round(l.sourceHeight)} px</span>
          <span className="lbl">Rendering</span><span>{l.usingPreservedPixels ? 'Stored (Photoshop)' : 'Live from source'}</span>
        </div>
        {src?.decodeError && <div className="tag warn" style={{ display: 'block', marginTop: 6 }}>{src.decodeError}</div>}
        <div className="row wrap" style={{ marginTop: 6 }}>
          <button className="btn small" onClick={() => run('layer.editContents')}>Edit Contents</button>
          <button className="btn small" onClick={() => run('layer.replaceContents')}>Replace…</button>
          <button className="btn small" onClick={() => run('layer.rasterize')}>Rasterize</button>
        </div>
      </Section>
      <Section title="Smart Filters" right={<Check label="On" checked={l.smartFiltersEnabled} onChange={(v) => updateSmartFilters(s, l.id, 'Toggle Smart Filters', (f) => f, v)} />}>
        {!l.smartFilters.length && <div className="faint">Apply a filter to this layer to add a smart filter.</div>}
        {l.smartFilters.map((f, i) => (
          <div key={f.id} className="row" style={{ padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
            <IconButton icon={f.enabled ? 'eye' : 'eyeOff'} title="Toggle" onClick={() => updateSmartFilters(s, l.id, 'Toggle Smart Filter', (fs) => fs.map((x, k) => (k === i ? { ...x, enabled: !x.enabled } : x)))} />
            <span style={{ flex: 1 }}>{f.name}</span>
            <BlendSelect value={f.blendMode} width={90} onChange={(m) => updateSmartFilters(s, l.id, 'Smart Filter Blending', (fs) => fs.map((x, k) => (k === i ? { ...x, blendMode: m } : x)))} />
            <NumberField value={Math.round(f.opacity * 100)} width={40} unit="%" min={0} max={100} onChange={(v) => updateSmartFilters(s, l.id, 'Smart Filter Opacity', (fs) => fs.map((x, k) => (k === i ? { ...x, opacity: v / 100 } : x)))} />
            <IconButton icon="gear" title="Edit filter settings" onClick={() => filterById(f.filterId)?.params.length && ui.openDialog('filter', { id: f.filterId, smart: { layerId: l.id, index: i, params: f.params } })} />
            <IconButton icon="trash" title="Delete smart filter" onClick={() => updateSmartFilters(s, l.id, 'Delete Smart Filter', (fs) => fs.filter((_, k) => k !== i))} />
          </div>
        ))}
      </Section>
    </>
  );
}

function FillProps({ s, l }: { s: DocumentSession; l: FillLayer }) {
  const set = (fill: FillLayer['fill']) => s.push(new SetLayerFieldCommand('Fill Content', l.id, 'fill', l.fill, fill));
  const f = l.fill;
  return (
    <Section title={f.type === 'solid' ? 'Color Fill' : f.type === 'gradient' ? 'Gradient Fill' : 'Pattern Fill'}>
      {f.type === 'solid' && <div className="row"><ColorSwatch color={f.color} size={36} onClick={() => ui.openDialog('colorPicker', { purpose: 'callback', initial: f.color, onPick: (c: RGB) => set({ type: 'solid', color: c }) })} /></div>}
      {f.type === 'gradient' && (
        <>
          <GradientEditor gradient={f.gradient} onChange={(g) => set({ ...f, gradient: g })} />
          <div className="row wrap">
            <Select value={f.style} onChange={(v) => set({ ...f, style: v })} options={[{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }, { value: 'angle', label: 'Angle' }, { value: 'reflected', label: 'Reflected' }, { value: 'diamond', label: 'Diamond' }]} />
            <NumberField label="Angle" value={f.angle} onChange={(v) => set({ ...f, angle: v })} unit="°" />
            <NumberField label="Scale" value={f.scale} onChange={(v) => set({ ...f, scale: v })} unit="%" min={1} max={1000} />
            <Check label="Reverse" checked={f.reverse} onChange={(v) => set({ ...f, reverse: v })} />
            <Check label="Dither" checked={f.dither} onChange={(v) => set({ ...f, dither: v })} />
          </div>
        </>
      )}
      {f.type === 'pattern' && (
        <div className="row wrap">
          <Select value={f.patternId} onChange={(v) => set({ ...f, patternId: v })} options={[...s.doc.patterns.values()].map((p) => ({ value: p.id, label: p.name }))} />
          <NumberField label="Scale" value={f.scale} onChange={(v) => set({ ...f, scale: v })} unit="%" min={1} max={1000} />
        </div>
      )}
    </Section>
  );
}

function MaskProps({ s, l }: { s: DocumentSession; l: Layer }) {
  const m = l.mask;
  const vm = l.vectorMask;
  if (!m && !vm) return null;
  return (
    <Section title="Masks">
      {m && (
        <>
          <div className="row wrap">
            <span className="muted">Pixel mask</span>
            <Check label="Enabled" checked={m.enabled} onChange={(v) => L.setMaskProps({ enabled: v }, 'Toggle Mask')} />
            <Check label="Linked" checked={m.linked} onChange={(v) => L.setMaskProps({ linked: v }, 'Link Mask')} />
            <button className={`btn small${s.editMask ? ' primary' : ''}`} onClick={() => { s.editMask = !s.editMask; s.notify(); }}>{s.editMask ? 'Editing Mask' : 'Edit Mask'}</button>
          </div>
          <NumberField label="Density" value={Math.round(m.density * 100)} onChange={(v) => L.setMaskProps({ density: v / 100 }, 'Mask Density')} min={0} max={100} unit="%" />
          <NumberField label="Feather" value={m.feather} onChange={(v) => L.setMaskProps({ feather: v }, 'Mask Feather')} min={0} max={1000} unit="px" step={0.5} />
          <div className="row wrap">
            <button className="btn small" onClick={() => L.invertMask()}>Invert</button>
            <button className="btn small" onClick={() => run('select.selectAndMask')}>Select and Mask…</button>
            <button className="btn small" onClick={() => L.deleteMask(true)}>Apply</button>
            <button className="btn small danger" onClick={() => L.deleteMask(false)}>Delete</button>
          </div>
        </>
      )}
      {vm && (
        <div className="row wrap" style={{ marginTop: 6 }}>
          <span className="muted">Vector mask</span>
          <Check label="Enabled" checked={vm.enabled} onChange={(v) => s.push(new SetLayerFieldCommand('Vector Mask', l.id, 'vectorMask', vm, { ...vm, enabled: v }))} />
          <Check label="Invert" checked={vm.invert} onChange={(v) => s.push(new SetLayerFieldCommand('Vector Mask', l.id, 'vectorMask', vm, { ...vm, invert: v }))} />
          <NumberField label="Feather" value={vm.feather} onChange={(v) => s.push(new SetLayerFieldCommand('Vector Mask Feather', l.id, 'vectorMask', vm, { ...vm, feather: Math.max(0, v) }))} unit="px" />
        </div>
      )}
    </Section>
  );
}

export function PropertiesPanel() {
  const s = useSession();
  if (!s) return <div className="panel"><div className="empty">No document</div></div>;
  const l = s.activeLayer();
  if (!l) return <div className="panel"><DocProps s={s} /></div>;
  let body: JSX.Element | null = null;
  const title = l.kind === 'adjustment' ? ADJUSTMENT_LABELS[(l as AdjustmentLayer).adjustment.type] : l.kind === 'pixel' ? 'Pixel Layer' : l.kind === 'group' ? 'Group' : l.kind === 'text' ? 'Type Layer' : l.kind === 'shape' ? 'Shape Layer' : l.kind === 'smartObject' ? 'Smart Object' : l.kind === 'fill' ? 'Fill Layer' : 'Layer';
  switch (l.kind) {
    case 'adjustment': {
      const adj = l.adjustment;
      body = (
        <Section title={ADJUSTMENT_LABELS[adj.type]}>
          <div className="panel-body" style={{ padding: 0 }}>
            <AdjustmentEditor adj={adj} onChange={(a: Adjustment) => s.push(new ModifyAdjustmentCommand(l.id, l.adjustment, a))} />
            <div className="row">
              <Check label="Clip to layer below" checked={l.clipping} onChange={() => L.toggleClipping(l.id)} />
              <button className="btn small" onClick={() => s.push(new ModifyAdjustmentCommand(l.id, l.adjustment, defaultAdjustment(adj.type)))}>Reset</button>
            </div>
          </div>
        </Section>
      );
      break;
    }
    case 'shape':
      body = <ShapeProps s={s} l={l} />;
      break;
    case 'text':
      body = <TextProps s={s} l={l} />;
      break;
    case 'smartObject':
      body = <SmartProps s={s} l={l} />;
      break;
    case 'fill':
      body = <FillProps s={s} l={l} />;
      break;
    case 'group':
      body = <div className="muted">{l.children.length} item(s) · Blend: {l.blendMode === 'passThrough' ? 'Pass Through' : l.blendMode}</div>;
      break;
    default:
      body = (
        <Section title="Quick Actions">
          <div className="row wrap">
            <button className="btn small" onClick={async () => { const { aiProvider } = await import('../../ai/provider'); const p = ui.progress('Removing background…'); try { const m = await aiProvider().removeBackground(s, l.id); const { CreateMaskCommand } = await import('../../commands/layerCommands'); s.push(new CreateMaskCommand('Remove Background', l.id, l.mask, { raster: m, x: 0, y: 0, enabled: true, linked: true, density: 1, feather: 0 })); } finally { p.done(); } }}>Remove Background</button>
            <button className="btn small" onClick={() => run('select.subject')}>Select Subject</button>
          </div>
        </Section>
      );
  }
  return (
    <div className="panel">
      <div className="panel-body">
        <div className="row" style={{ gap: 8 }}>
          <Icon name={l.kind === 'adjustment' ? 'adjust' : l.kind === 'text' ? 'text' : l.kind === 'shape' ? 'shape' : l.kind === 'smartObject' ? 'smart' : l.kind === 'group' ? 'folder' : 'newLayer'} />
          <strong>{title}</strong>
          <span className="faint" style={{ marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
        </div>
        {l.metadata.unsupported.length > 0 && <div className="tag warn" style={{ display: 'block' }} title={l.metadata.unsupported.join('\n')}>Preserved Photoshop data: {l.metadata.unsupported.join('; ')}</div>}
        {body}
        {(l.kind === 'pixel' || l.kind === 'smartObject' || l.kind === 'text' || l.kind === 'shape') && <TransformInfo s={s} l={l} />}
        <MaskProps s={s} l={l} />
      </div>
    </div>
  );
}
