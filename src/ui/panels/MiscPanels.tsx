/** Brushes, Brush Settings, Tool Presets, Character, Paragraph, Actions, Adjustments and Compatibility panels. */
import { useEffect, useReducer, useRef, useState } from 'react';
import { useApp, ui } from '../../app/store';
import { useSession } from '../hooks';
import { editor } from '../../app/editor';
import { Check, ColorSwatch, IconButton, NumberField, Select, Slider, Seg, BlendSelect } from '../controls';
import { BrushSettings, BRUSH_PRESETS, TOOLS, ToolId, defaultBrush } from '../../tools/toolTypes';
import { dabCoverage, makeTipSampler } from '../../brush/engine';
import { macros } from '../../app/macros';
import { Icon } from '../icons';
import { platform } from '../../app/platform/platform';
import { applyTextStyle } from '../../tools/typeTool';
import { fonts } from '../../typography/fonts';
import type { RGB } from '../../color/types';
import { ADJUSTMENT_LABELS, AdjustmentType } from '../../adjustments/types';
import { newAdjustmentLayer } from '../../app/ops/layerOps';
import { loadJSON, saveJSON } from '../../app/settings';
import { run } from '../../app/actions';
import { editLayer } from '../../commands/layerCommands';
import { renderTextLayer } from '../../layers/appearance';
import { promptText, confirmAction } from '../prompt';

function BrushPreview({ b, w = 60, h = 34 }: { b: BrushSettings; w?: number; h?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const img = g.createImageData(w, h);
    const bb = { ...b, size: Math.min(h - 6, b.size) };
    const tip = makeTipSampler(bb);
    const acc = new Float32Array(w * h);
    const n = 12;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const d = { x: 6 + t * (w - 12), y: h / 2 + Math.sin(t * Math.PI * 2) * (h / 6), radius: (bb.size / 2) * (0.5 + 0.5 * Math.sin(t * Math.PI)), angle: (bb.angle * Math.PI) / 180, roundness: bb.roundness, flow: bb.flow, opacity: 1, pressure: 1 };
      const cov = dabCoverage(d, { x: 0, y: 0, w, h }, bb, tip);
      for (let k = 0; k < acc.length; k++) acc[k] = acc[k] + (1 - acc[k]) * cov[k] * bb.flow;
    }
    for (let k = 0; k < acc.length; k++) { img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = 230; img.data[k * 4 + 3] = acc[k] * 255; }
    g.putImageData(img, 0, 0);
  }, [b, w, h]);
  return <canvas ref={ref} width={w} height={h} />;
}

export function BrushesPanel() {
  const presets = useApp((s) => s.brushPresets);
  const brush = useApp((s) => s.brush);
  return (
    <div className="panel">
      <div className="panel-body">
        <Slider label="Size" value={brush.size} min={1} max={1000} unit="px" onChange={(v) => ui.setBrush({ size: v })} />
        <div className="brush-grid">
          {presets.map((p, i) => (
            <div key={i} className={`brush-cell${p.name === brush.name ? ' active' : ''}`} title={p.name} onClick={() => ui.set({ brush: { ...p, size: p.size } })}
              onContextMenu={async (e) => { e.preventDefault(); if (await confirmAction(`Delete brush preset "${p.name}"?`, undefined, 'Delete')) ui.set((s) => ({ brushPresets: s.brushPresets.filter((_, k) => k !== i) })); }}>
              <BrushPreview b={p} />
              <span>{p.name}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="panel-toolbar">
        <button className="btn small" onClick={async () => {
          const files = await platform().openFiles([{ name: 'Celenne brushes (.lbrush.json)', extensions: ['json'] }], false);
          const f = files[0];
          if (!f) return;
          try {
            const list = JSON.parse(new TextDecoder().decode(f.data)) as BrushSettings[];
            if (!Array.isArray(list)) throw new Error('Expected a list of brushes');
            ui.set((s) => ({ brushPresets: [...s.brushPresets, ...list.map((b) => ({ ...defaultBrush(), ...b }))] }));
            ui.toast('success', `Imported ${list.length} brush preset(s).`);
          } catch (e) {
            ui.toast('error', 'Could not import brushes', (e as Error).message);
          }
        }}>Import…</button>
        <button className="btn small" onClick={() => platform().writePath('brushes.lbrush.json', new TextEncoder().encode(JSON.stringify(useApp.getState().brushPresets, null, 2)))}>Export…</button>
        <button className="btn small" title="Photoshop .abr import is planned" onClick={() => ui.toast('info', 'ABR brush import is coming soon.')}>ABR <span className="tag soon">Soon</span></button>
        <div className="spacer" />
        <IconButton icon="plus" title="Save current brush as preset" onClick={async () => { const name = await promptText('New Brush Preset', `${brush.name} copy`); if (name) ui.set((s) => ({ brushPresets: [...s.brushPresets, { ...s.brush, name }] })); }} />
        <IconButton icon="reset" title="Reset brushes" onClick={() => ui.set({ brushPresets: BRUSH_PRESETS })} />
      </div>
    </div>
  );
}

export function BrushSettingsPanel() {
  const b = useApp((s) => s.brush);
  const d = b.dynamics;
  const setD = (p: Partial<typeof d>) => ui.setBrush({ dynamics: { ...d, ...p } });
  return (
    <div className="panel">
      <div className="panel-body">
        <div className="row" style={{ justifyContent: 'center', background: 'var(--bg-0)', borderRadius: 4 }}><BrushPreview b={b} w={220} h={60} /></div>
        <div className="section-title">Brush Tip Shape</div>
        <Slider label="Size" value={b.size} min={1} max={2000} unit="px" onChange={(v) => ui.setBrush({ size: v })} />
        <Slider label="Hardness" value={Math.round(b.hardness * 100)} min={0} max={100} unit="%" onChange={(v) => ui.setBrush({ hardness: v / 100 })} />
        <Slider label="Angle" value={b.angle} min={-180} max={180} unit="°" onChange={(v) => ui.setBrush({ angle: v })} />
        <Slider label="Roundness" value={Math.round(b.roundness * 100)} min={1} max={100} unit="%" onChange={(v) => ui.setBrush({ roundness: v / 100 })} />
        <Slider label="Spacing" value={Math.round(b.spacing * 100)} min={1} max={1000} unit="%" onChange={(v) => ui.setBrush({ spacing: v / 100 })} />
        <Slider label="Smoothing" value={Math.round(b.smoothing * 100)} min={0} max={100} unit="%" onChange={(v) => ui.setBrush({ smoothing: v / 100 })} />
        <Check label="Aliased (pencil edges)" checked={b.aliased} onChange={(v) => ui.setBrush({ aliased: v })} />
        <div className="section-title">Shape Dynamics</div>
        <Check label="Pen pressure controls size" checked={d.sizePressure} onChange={(v) => setD({ sizePressure: v })} />
        <Slider label="Min. size" value={Math.round(d.minSize * 100)} min={0} max={100} unit="%" onChange={(v) => setD({ minSize: v / 100 })} />
        <Slider label="Size jitter" value={Math.round(d.sizeJitter * 100)} min={0} max={100} unit="%" onChange={(v) => setD({ sizeJitter: v / 100 })} />
        <Slider label="Angle jitter" value={Math.round(d.angleJitter * 100)} min={0} max={100} unit="%" onChange={(v) => setD({ angleJitter: v / 100 })} />
        <Select label="Angle control" value={d.angleControl} onChange={(v) => setD({ angleControl: v })} options={[{ value: 'none', label: 'Off' }, { value: 'direction', label: 'Direction' }, { value: 'tilt', label: 'Pen Tilt' }, { value: 'rotation', label: 'Rotation' }]} />
        <Check label="Roundness from pen tilt" checked={d.roundnessFromTilt} onChange={(v) => setD({ roundnessFromTilt: v })} />
        <Slider label="Velocity → size" value={Math.round(d.sizeFromVelocity * 100)} min={-100} max={100} unit="%" onChange={(v) => setD({ sizeFromVelocity: v / 100 })} />
        <div className="section-title">Scattering</div>
        <Slider label="Scatter" value={Math.round(b.scatter * 100)} min={0} max={1000} unit="%" onChange={(v) => ui.setBrush({ scatter: v / 100 })} />
        <Slider label="Count" value={b.count} min={1} max={16} onChange={(v) => ui.setBrush({ count: v })} />
        <div className="section-title">Texture</div>
        <Select label="Texture" value={b.texture} onChange={(v) => ui.setBrush({ texture: v })} options={[{ value: 'none', label: 'None' }, { value: 'noise', label: 'Noise' }, { value: 'chalk', label: 'Chalk' }, { value: 'charcoal', label: 'Charcoal' }, { value: 'canvas', label: 'Canvas' }, { value: 'ink', label: 'Ink' }]} />
        <Slider label="Scale" value={Math.round(b.textureScale * 100)} min={10} max={1000} unit="%" onChange={(v) => ui.setBrush({ textureScale: v / 100 })} />
        <Slider label="Depth" value={Math.round(b.textureDepth * 100)} min={0} max={100} unit="%" onChange={(v) => ui.setBrush({ textureDepth: v / 100 })} />
        <div className="section-title">Transfer</div>
        <Check label="Pen pressure controls opacity" checked={d.opacityPressure} onChange={(v) => setD({ opacityPressure: v })} />
        <Check label="Pen pressure controls flow" checked={d.flowPressure} onChange={(v) => setD({ flowPressure: v })} />
        <Slider label="Opacity jitter" value={Math.round(d.opacityJitter * 100)} min={0} max={100} unit="%" onChange={(v) => setD({ opacityJitter: v / 100 })} />
        <Slider label="Flow jitter" value={Math.round(d.flowJitter * 100)} min={0} max={100} unit="%" onChange={(v) => setD({ flowJitter: v / 100 })} />
        <Check label="Airbrush build-up" checked={b.airbrush} onChange={(v) => ui.setBrush({ airbrush: v })} />
      </div>
    </div>
  );
}

interface ToolPreset {
  name: string;
  tool: ToolId;
  brush?: BrushSettings;
  options: unknown;
}

export function ToolPresetsPanel() {
  const [presets, setPresets] = useState<ToolPreset[]>(() => loadJSON('celenne.toolPresets.v1', []));
  const tool = useApp((s) => s.tool);
  const save = (p: ToolPreset[]) => { setPresets(p); saveJSON('celenne.toolPresets.v1', p); };
  return (
    <div className="panel">
      <div className="list" style={{ flex: 1, overflow: 'auto' }}>
        {presets.map((p, i) => (
          <div key={i} className="list-item" onClick={() => { editor.setTool(p.tool); ui.set((s) => ({ toolOptions: { ...s.toolOptions, ...(p.options as object) }, brush: p.brush ?? s.brush })); }}>
            <Icon name={p.tool} size={14} />
            <span className="grow">{p.name}</span>
            <IconButton icon="trash" title="Delete" onClick={(e) => { e.stopPropagation(); save(presets.filter((_, k) => k !== i)); }} />
          </div>
        ))}
        {!presets.length && <div className="empty">Save tool settings as presets for quick recall.</div>}
      </div>
      <div className="panel-toolbar">
        <span className="faint">{TOOLS.find((t) => t.id === tool)?.label}</span>
        <div className="spacer" />
        <IconButton icon="plus" title="New tool preset from current settings" onClick={async () => { const name = await promptText('New Tool Preset', `${TOOLS.find((t) => t.id === tool)?.label} 1`); if (name) { const st = useApp.getState(); save([...presets, { name, tool, brush: st.brush, options: st.toolOptions }]); } }} />
      </div>
    </div>
  );
}

function useTextLayer() {
  const s = useSession();
  const l = s?.activeLayer();
  return s && l?.kind === 'text' ? { s, l } : null;
}

export function CharacterPanel() {
  const t = useTextLayer();
  if (!t) return <div className="panel"><div className="empty">Select a type layer to edit character settings.</div></div>;
  const { s, l } = t;
  const st = l.text.runs[0].style;
  const set = (p: Parameters<typeof applyTextStyle>[2]) => applyTextStyle(s, l.id, p);
  const styles = fonts.stylesOf(st.fontFamily);
  const scale = Math.hypot(l.text.transform[0], l.text.transform[1]);
  return (
    <div className="panel">
      <div className="panel-body">
        {l.text.runs.length > 1 && <div className="faint">This layer has {l.text.runs.length} style runs; changes apply to the whole layer.</div>}
        <Select value={st.fontFamily} onChange={(v) => set({ fontFamily: v, postScriptName: undefined })} options={[...new Set([st.fontFamily, ...fonts.families])].map((f) => ({ value: f, label: f }))} />
        <Select value={st.fontStyleName} onChange={(v) => { const f = styles.find((x) => x.style === v); set({ fontStyleName: v, fontWeight: f?.weight ?? 400, italic: f?.italic ?? false, postScriptName: f?.postScriptName }); }} options={[...new Set([st.fontStyleName, ...styles.map((x) => x.style)])].map((x) => ({ value: x, label: x }))} />
        <div className="row wrap">
          <NumberField label="Size" value={Math.round(((st.fontSize * scale * 72) / s.doc.canvas.resolution) * 10) / 10} onChange={(v) => set({ fontSize: (v * s.doc.canvas.resolution) / 72 / scale })} unit="pt" step={0.5} />
          <NumberField label="Leading" value={st.leading ?? 0} onChange={(v) => set({ leading: v > 0 ? v : null })} unit="px" title="0 = Auto" />
        </div>
        <div className="row wrap">
          <Select label="Kerning" value={st.kerning} onChange={(v) => set({ kerning: v })} options={[{ value: 'metrics', label: 'Metrics' }, { value: 'optical', label: 'Optical' }, { value: 'none', label: '0' }]} />
          <NumberField label="Tracking" value={st.tracking} onChange={(v) => set({ tracking: v })} step={10} />
        </div>
        <div className="row wrap">
          <NumberField label="V scale" value={Math.round(st.verticalScale * 100)} onChange={(v) => set({ verticalScale: v / 100 })} unit="%" />
          <NumberField label="H scale" value={Math.round(st.horizontalScale * 100)} onChange={(v) => set({ horizontalScale: v / 100 })} unit="%" />
        </div>
        <div className="row wrap">
          <NumberField label="Baseline" value={st.baselineShift} onChange={(v) => set({ baselineShift: v })} unit="px" />
          <span className="muted">Color</span>
          <ColorSwatch color={st.color} onClick={() => ui.openDialog('colorPicker', { purpose: 'callback', initial: st.color, onPick: (c: RGB) => set({ color: { ...c, a: 1 } }) })} />
        </div>
        <div className="row wrap">
          <Check label="Faux Bold" checked={st.fauxBold} onChange={(v) => set({ fauxBold: v })} />
          <Check label="Faux Italic" checked={st.fauxItalic} onChange={(v) => set({ fauxItalic: v })} />
          <Check label="Underline" checked={st.underline} onChange={(v) => set({ underline: v })} />
          <Check label="Strikethrough" checked={st.strikethrough} onChange={(v) => set({ strikethrough: v })} />
        </div>
        <div className="row wrap">
          <Select label="Case" value={st.textCase} onChange={(v) => set({ textCase: v })} options={[{ value: 'none', label: 'Normal' }, { value: 'allCaps', label: 'All Caps' }, { value: 'smallCaps', label: 'Small Caps' }]} />
          <Select label="Position" value={st.baseline} onChange={(v) => set({ baseline: v })} options={[{ value: 'normal', label: 'Normal' }, { value: 'superscript', label: 'Superscript' }, { value: 'subscript', label: 'Subscript' }]} />
          <Check label="Ligatures" checked={st.ligatures} onChange={(v) => set({ ligatures: v })} />
        </div>
        <div className="row"><span className="lbl muted">Weight axis</span><Slider value={st.fontWeight} min={100} max={900} step={1} onChange={(v) => set({ fontWeight: v })} /></div>
        <Select label="Anti-alias" value={l.text.antiAlias} onChange={(v) => { const cmd = editLayer(s.doc, l.id, 'Anti-alias', (x) => { (x as typeof l).text.antiAlias = v; renderTextLayer(s.doc, x as typeof l); }); if (cmd) s.push(cmd, true); }} options={[{ value: 'none', label: 'None' }, { value: 'sharp', label: 'Sharp' }, { value: 'crisp', label: 'Crisp' }, { value: 'strong', label: 'Strong' }, { value: 'smooth', label: 'Smooth' }]} />
      </div>
    </div>
  );
}

export function ParagraphPanel() {
  const t = useTextLayer();
  if (!t) return <div className="panel"><div className="empty">Select a type layer to edit paragraph settings.</div></div>;
  const { s, l } = t;
  const p = l.text.paragraphs[0].style;
  const set = (x: Partial<typeof p>) => applyTextStyle(s, l.id, {}, x);
  return (
    <div className="panel">
      <div className="panel-body">
        <Seg value={p.align} onChange={(v) => set({ align: v })} options={[
          { value: 'left', icon: 'textLeft', title: 'Left align' }, { value: 'center', icon: 'textCenter', title: 'Center' }, { value: 'right', icon: 'textRight', title: 'Right align' },
          { value: 'justifyLeft', icon: 'textJustify', title: 'Justify last left' }, { value: 'justifyCenter', label: 'JC', title: 'Justify last centered' }, { value: 'justifyRight', label: 'JR', title: 'Justify last right' }, { value: 'justifyAll', label: 'JA', title: 'Justify all' },
        ]} />
        {l.text.kind === 'point' && p.align.startsWith('justify') && <div className="faint">Justification applies to paragraph (box) text.</div>}
        <div className="row wrap">
          <NumberField label="Indent left" value={p.indentStart} onChange={(v) => set({ indentStart: v })} unit="px" />
          <NumberField label="Indent right" value={p.indentEnd} onChange={(v) => set({ indentEnd: v })} unit="px" />
          <NumberField label="First line" value={p.indentFirst} onChange={(v) => set({ indentFirst: v })} unit="px" />
        </div>
        <div className="row wrap">
          <NumberField label="Space before" value={p.spaceBefore} onChange={(v) => set({ spaceBefore: v })} unit="px" />
          <NumberField label="Space after" value={p.spaceAfter} onChange={(v) => set({ spaceAfter: v })} unit="px" />
        </div>
        <Check label="Hyphenate" checked={p.hyphenate} onChange={(v) => set({ hyphenate: v })} />
        <div className="row wrap">
          <Select label="Composer" value={p.composer ?? 'single'} onChange={(v) => set({ composer: v })} options={[
            { value: 'single', label: 'Adobe Single-line' }, { value: 'every', label: 'Adobe Every-line' }, { value: 'celenne', label: 'Celenne (balanced)' },
          ]} />
          <Check label="Optical margins" checked={!!p.opticalMargins} onChange={(v) => set({ opticalMargins: v })} />
        </div>
        {(p.composer === 'celenne' || p.opticalMargins) && <div className="faint">Celenne layout: Photoshop lays this paragraph out with its own composer and margins when it opens the file.</div>}
        {l.text.kind === 'paragraph' && <button className="btn small" onClick={() => run('type.fitFrame')}>Fit Text to Frame</button>}
        <div className="row wrap">
          <Seg value={l.text.orientation} onChange={(v) => { if (v !== l.text.orientation) run('type.vertical'); }} options={[{ value: 'horizontal', label: 'Horizontal', title: 'Horizontal text' }, { value: 'vertical', label: 'Vertical', title: 'Vertical text' }]} />
          <button className="btn small" disabled={!!l.text.path} title={l.text.path ? 'Text on a path cannot be warped' : undefined} onClick={() => run('type.warp')}>Warp Text…</button>
          {l.text.path && <span className="faint">On a path</span>}
        </div>
      </div>
    </div>
  );
}

export function ActionsPanel() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [sel, setSel] = useState<{ setId: string; macroId: string | null } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set(['set-default']));
  const recording = useApp((s) => s.recordingAction);
  useEffect(() => macros.on(force), []);
  const m = sel?.macroId ? macros.macro(sel.setId, sel.macroId) : null;
  return (
    <div className="panel">
      <div className="list" style={{ flex: 1, overflow: 'auto' }}>
        {macros.sets.map((set) => (
          <div key={set.id}>
            <div className={`list-item${sel?.setId === set.id && !sel.macroId ? ' active' : ''}`} onClick={() => setSel({ setId: set.id, macroId: null })}>
              <span onClick={(e) => { e.stopPropagation(); const n = new Set(open); if (n.has(set.id)) n.delete(set.id); else n.add(set.id); setOpen(n); }}>{open.has(set.id) ? '▼' : '▶'}</span>
              <Icon name="folder" size={14} /><span className="grow">{set.name}</span>
            </div>
            {open.has(set.id) && set.macros.map((mm) => (
              <div key={mm.id}>
                <div className={`list-item${sel?.macroId === mm.id ? ' active' : ''}`} style={{ paddingLeft: 26 }} onClick={() => setSel({ setId: set.id, macroId: mm.id })} onDoubleClick={async () => { const n = await promptText('Rename Action', mm.name); if (n) macros.rename(set.id, mm.id, n); }}>
                  {recording === mm.id && <span style={{ color: '#e5484d' }}>●</span>}
                  <span className="grow">{mm.name}</span>
                  <span className="faint">{mm.steps.length}</span>
                </div>
                {sel?.macroId === mm.id && mm.steps.map((st, i) => (
                  <div key={i} className="list-item" style={{ paddingLeft: 44, height: 20, fontSize: 11 }}>
                    <input type="checkbox" checked={st.enabled} onChange={() => macros.toggleStep(set.id, mm.id, i)} title="Include this step" />
                    <span className="grow" style={{ color: st.enabled ? undefined : 'var(--text-faint)' }}>{st.label}</span>
                    <IconButton icon="close" title="Delete step" onClick={() => macros.deleteStep(set.id, mm.id, i)} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="panel-toolbar">
        <IconButton icon="stop" title="Stop recording" disabled={!recording} onClick={() => macros.stopRecording()} />
        <IconButton icon="record" title="Begin recording" on={!!recording} disabled={!m} onClick={() => m && sel && macros.startRecording(sel.setId, m.id)} />
        <IconButton icon="play" title="Play selected action" disabled={!m} onClick={() => m && sel && macros.play(sel.setId, m.id)} />
        <div className="spacer" />
        <IconButton icon="folder" title="New action set" onClick={async () => { const n = await promptText('New Action Set', 'Set 1'); if (n) macros.newSet(n); }} />
        <IconButton icon="newLayer" title="New action" onClick={async () => { const setId = sel?.setId ?? macros.sets[0]?.id ?? macros.newSet('Set 1').id; const n = await promptText('New Action', 'Action 1'); if (n) { const mm = macros.newMacro(setId, n); if (mm) { setSel({ setId, macroId: mm.id }); macros.startRecording(setId, mm.id); } } }} />
        <IconButton icon="trash" title="Delete" disabled={!sel} onClick={() => { if (!sel) return; if (sel.macroId) macros.deleteMacro(sel.setId, sel.macroId); else macros.deleteSet(sel.setId); setSel(null); }} />
        <IconButton icon="gear" title="Import / export" onClick={async () => {
          if (sel && (await confirmAction('Export the selected action set?', 'Choose Cancel to import an action set instead.', 'Export'))) { await platform().writePath('actions.lactions.json', new TextEncoder().encode(macros.exportSet(sel.setId))); return; }
          const files = await platform().openFiles([{ name: 'Celenne actions', extensions: ['json'] }], false);
          if (files[0]) try { macros.importSet(new TextDecoder().decode(files[0].data)); } catch (e) { ui.toast('error', 'Import failed', (e as Error).message); }
        }} />
      </div>
    </div>
  );
}

export function AdjustmentsPanel() {
  const types = Object.keys(ADJUSTMENT_LABELS) as AdjustmentType[];
  const icon: Record<AdjustmentType, string> = { brightnessContrast: '☀', levels: '▤', curves: '∿', exposure: '±', vibrance: '▽', hueSaturation: '◐', colorBalance: '⚖', blackWhite: '◧', photoFilter: '◎', channelMixer: '⊕', colorLookup: '▦', invert: '◑', posterize: '▥', threshold: '◩', gradientMap: '▭', selectiveColor: '◆' };
  return (
    <div className="panel">
      <div className="panel-body">
        <div className="muted">Add a non-destructive adjustment layer:</div>
        <div className="brush-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(34px, 1fr))' }}>
          {types.map((t) => (
            <button key={t} className="icon-btn" style={{ width: '100%', height: 30, fontSize: 16 }} title={ADJUSTMENT_LABELS[t]} onClick={() => newAdjustmentLayer(t)}>{icon[t]}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CompatibilityPanel() {
  const s = useSession();
  if (!s) return <div className="panel"><div className="empty">No document</div></div>;
  const issues = s.doc.compatibility;
  return (
    <div className="panel">
      <div className="panel-body">
        <div className="row"><strong>{s.doc.name}</strong><span className="tag">{s.doc.fileFormat?.toUpperCase() ?? 'NEW'}</span></div>
        {!issues.length && <div className="tag ok" style={{ display: 'inline-block' }}>All document features are editable.</div>}
        {issues.map((i, k) => (
          <div key={k} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>
            <div className="row"><span className={`tag ${i.status === 'editable' ? 'ok' : 'warn'}`}>{i.status}</span><strong>{i.feature}</strong>{i.layerName && <span className="faint">· {i.layerName}</span>}</div>
            <div className="muted" style={{ fontSize: 11 }}>{i.message}</div>
          </div>
        ))}
        <button className="btn small" onClick={() => run('help.compatibility')}>View full compatibility matrix</button>
      </div>
    </div>
  );
}

export { BlendSelect };
