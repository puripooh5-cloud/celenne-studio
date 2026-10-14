/** Layer Style dialog with live preview; commits a single undoable step. */
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { BlendSelect, Check, ColorSwatch, NumberField, Select, Slider } from '../controls';
import { editor } from '../../app/editor';
import { ui, useApp } from '../../app/store';
import {
  defaultBevel, defaultColorOverlay, defaultGlow, defaultGradientOverlay, defaultInnerGlow, defaultPatternOverlay, defaultSatin, defaultShadow, defaultStroke,
  EFFECT_LABELS, EffectKind, emptyEffects, LayerEffects, ShadowEffect, GlowEffect, InnerGlowEffect,
} from '../../effects/types';
import { CompositeCommand, SetEffectsCommand, SetLayerPropsCommand } from '../../commands/layerCommands';
import type { RGB } from '../../color/types';
import { simpleGradient } from '../../color/types';
import { GradientEditor } from '../panels/AdjustmentEditors';
import type { BlendIf, BlendIfRange, Layer } from '../../document/types';
import { DEFAULT_BLEND_IF_RANGE } from '../../document/types';

const ORDER: EffectKind[] = ['bevel', 'stroke', 'innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'outerGlow', 'dropShadow'];
const MULTI = new Set<EffectKind>(['stroke', 'innerShadow', 'colorOverlay', 'gradientOverlay', 'dropShadow']);

function makeDefault(k: EffectKind) {
  const { fg, bg } = useApp.getState();
  switch (k) {
    case 'dropShadow': return defaultShadow(false);
    case 'innerShadow': return { ...defaultShadow(true), layerKnocksOut: false };
    case 'outerGlow': return defaultGlow();
    case 'innerGlow': return defaultInnerGlow();
    case 'bevel': return defaultBevel();
    case 'satin': return defaultSatin();
    case 'colorOverlay': return defaultColorOverlay();
    case 'gradientOverlay': return defaultGradientOverlay(simpleGradient(fg, bg));
    case 'patternOverlay': return defaultPatternOverlay();
    case 'stroke': return defaultStroke();
  }
}

function colorPick(initial: RGB, onPick: (c: RGB) => void) {
  ui.openDialog('colorPicker', { purpose: 'callback', initial, onPick });
}

export function LayerStyleDialog({ close, layerId, effect }: { close: () => void; layerId: string; effect?: EffectKind }) {
  const s = editor.active!;
  const layer = s.doc.getLayer(layerId) as Layer;
  const original = useRef({ fx: layer.effects ? structuredClone(layer.effects) : null, opacity: layer.opacity, fill: layer.fillOpacity, mode: layer.blendMode, advanced: structuredClone(layer.advanced) });
  const [fx, setFx] = useState<LayerEffects>(() => (layer.effects ? structuredClone(layer.effects) : emptyEffects()));
  const [sel, setSel] = useState<{ kind: EffectKind | 'blending'; index: number }>(() => ({ kind: effect ?? 'blending', index: 0 }));
  const [opacity, setOpacity] = useState(layer.opacity);
  const [fill, setFill] = useState(layer.fillOpacity);
  const [mode, setMode] = useState(layer.blendMode);
  const [advanced, setAdvanced] = useState(structuredClone(layer.advanced));
  const light = s.doc.globalLight;

  // Live preview: mutate the layer directly; restored on cancel.
  useEffect(() => {
    const l = s.doc.getLayer(layerId);
    if (!l) return;
    l.effects = structuredClone(fx);
    l.opacity = opacity;
    l.fillOpacity = fill;
    l.blendMode = mode;
    l.advanced = structuredClone(advanced);
    l.rev++;
    s.doc.emit({ type: 'layer', layerId });
  }, [fx, opacity, fill, mode, advanced]);

  const restore = () => {
    const l = s.doc.getLayer(layerId);
    if (!l) return;
    const o = original.current;
    l.effects = o.fx ? structuredClone(o.fx) : null;
    l.opacity = o.opacity;
    l.fillOpacity = o.fill;
    l.blendMode = o.mode;
    l.advanced = structuredClone(o.advanced);
    l.rev++;
    s.doc.emit({ type: 'layer', layerId });
  };
  const ok = () => {
    restore();
    const o = original.current;
    const cmds = [];
    const anyEffect = ORDER.some((k) => { const v = fx[k]; return Array.isArray(v) ? v.length > 0 : !!v; });
    cmds.push(new SetEffectsCommand(layerId, o.fx, anyEffect ? fx : null));
    if (o.opacity !== opacity || o.fill !== fill || o.mode !== mode || JSON.stringify(o.advanced) !== JSON.stringify(advanced))
      cmds.push(new SetLayerPropsCommand('Blending Options', layerId, { opacity: o.opacity, fillOpacity: o.fill, blendMode: o.mode, advanced: o.advanced }, { opacity, fillOpacity: fill, blendMode: mode, advanced }));
    s.push(new CompositeCommand('Layer Style', cmds, { action: 'layer.setStyle', args: { effects: anyEffect ? structuredClone(fx) : null, opacity, fillOpacity: fill, blendMode: mode, advanced: structuredClone(advanced) } }));
    close();
  };
  const cancel = () => {
    restore();
    close();
  };

  const listOf = (k: EffectKind): unknown[] => {
    const v = fx[k] as unknown;
    return Array.isArray(v) ? v : v ? [v] : [];
  };
  const update = (k: EffectKind, index: number, patch: Record<string, unknown>) => {
    const next = structuredClone(fx) as unknown as Record<string, unknown>;
    const v = next[k];
    if (Array.isArray(v)) v[index] = { ...v[index], ...patch };
    else if (v) next[k] = { ...(v as object), ...patch };
    setFx(next as unknown as LayerEffects);
  };
  const toggle = (k: EffectKind, on: boolean, index = 0) => {
    const next = structuredClone(fx) as unknown as Record<string, unknown>;
    const v = next[k];
    if (Array.isArray(v)) {
      if (on && !v.length) v.push(makeDefault(k));
      else if (v[index]) (v[index] as { enabled: boolean }).enabled = on;
    } else if (on && !v) next[k] = makeDefault(k);
    else if (v) (v as { enabled: boolean }).enabled = on;
    setFx(next as unknown as LayerEffects);
    setSel({ kind: k, index });
  };
  const add = (k: EffectKind) => {
    const next = structuredClone(fx) as unknown as Record<string, unknown>;
    (next[k] as unknown[]).push(makeDefault(k));
    setFx(next as unknown as LayerEffects);
    setSel({ kind: k, index: (next[k] as unknown[]).length - 1 });
  };
  const remove = (k: EffectKind, index: number) => {
    const next = structuredClone(fx) as unknown as Record<string, unknown>;
    if (Array.isArray(next[k])) (next[k] as unknown[]).splice(index, 1);
    else next[k] = null;
    setFx(next as unknown as LayerEffects);
    setSel({ kind: 'blending', index: 0 });
  };

  const common = (k: EffectKind, e: { blendMode: string; opacity: number }) => (
    <>
      <div className="row"><span className="lbl muted" style={{ width: 90 }}>Blend Mode</span><BlendSelect value={e.blendMode as never} onChange={(m) => update(k, sel.index, { blendMode: m })} /></div>
      <Slider label="Opacity" value={Math.round(e.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => update(k, sel.index, { opacity: v / 100 })} />
    </>
  );
  const angleRow = (k: EffectKind, e: { angle: number; useGlobalLight?: boolean }) => (
    <div className="row wrap">
      <NumberField label="Angle" value={e.useGlobalLight ? light.angle : e.angle} onChange={(v) => { if (e.useGlobalLight) { s.doc.globalLight.angle = v; setFx(structuredClone(fx)); } else update(k, sel.index, { angle: v }); }} unit="°" />
      {'useGlobalLight' in e && <Check label="Use Global Light" checked={!!e.useGlobalLight} onChange={(v) => update(k, sel.index, { useGlobalLight: v })} />}
    </div>
  );

  const editor_ = () => {
    if (sel.kind === 'blending') {
      return (
        <>
          <div className="section-title">General Blending</div>
          <div className="row"><span className="lbl muted" style={{ width: 90 }}>Blend Mode</span><BlendSelect value={mode} allowPassThrough={layer.kind === 'group'} onChange={setMode} /></div>
          <Slider label="Opacity" value={Math.round(opacity * 100)} min={0} max={100} unit="%" onChange={(v) => setOpacity(v / 100)} />
          <div className="section-title">Advanced Blending</div>
          <Slider label="Fill Opacity" value={Math.round(fill * 100)} min={0} max={100} unit="%" onChange={(v) => setFill(v / 100)} />
          <div className="row wrap">
            <span className="muted">Channels:</span>
            {(['R', 'G', 'B'] as const).map((c, i) => <Check key={c} label={c} checked={advanced.channels[i]} onChange={(v) => { const ch = [...advanced.channels] as [boolean, boolean, boolean]; ch[i] = v; setAdvanced({ ...advanced, channels: ch }); }} />)}
          </div>
          <Select label="Knockout" value={advanced.knockout} onChange={(v) => setAdvanced({ ...advanced, knockout: v })} options={[{ value: 'none', label: 'None' }, { value: 'shallow', label: 'Shallow' }, { value: 'deep', label: 'Deep' }]} />
          <Check label="Blend Clipped Layers as Group" checked={advanced.blendClippedAsGroup} onChange={(v) => setAdvanced({ ...advanced, blendClippedAsGroup: v })} />
          <Check label="Blend Interior Effects as Group" checked={advanced.blendInteriorAsGroup} onChange={(v) => setAdvanced({ ...advanced, blendInteriorAsGroup: v })} />
          <Check label="Transparency Shapes Layer" checked={advanced.transparencyShapesLayer} onChange={(v) => setAdvanced({ ...advanced, transparencyShapesLayer: v })} />
          <BlendIfEditor value={advanced.blendIf} onChange={(blendIf) => setAdvanced({ ...advanced, blendIf })} />
        </>
      );
    }
    const k = sel.kind;
    const e = listOf(k)[sel.index] as Record<string, unknown> | undefined;
    if (!e) return <div className="muted">Enable “{EFFECT_LABELS[k]}” to edit it.</div>;
    switch (k) {
      case 'dropShadow':
      case 'innerShadow': {
        const x = e as unknown as ShadowEffect;
        return (
          <>
            {common(k, x)}
            <div className="row"><span className="muted" style={{ width: 90 }}>Color</span><ColorSwatch color={x.color} onClick={() => colorPick(x.color, (c) => update(k, sel.index, { color: c }))} /></div>
            {angleRow(k, x)}
            <Slider label="Distance" value={x.distance} min={0} max={1000} unit="px" onChange={(v) => update(k, sel.index, { distance: v })} />
            <Slider label={k === 'dropShadow' ? 'Spread' : 'Choke'} value={x.spread} min={0} max={100} unit="%" onChange={(v) => update(k, sel.index, { spread: v })} />
            <Slider label="Size" value={x.size} min={0} max={250} unit="px" onChange={(v) => update(k, sel.index, { size: v })} />
            {k === 'dropShadow' && <Check label="Layer Knocks Out Drop Shadow" checked={x.layerKnocksOut} onChange={(v) => update(k, sel.index, { layerKnocksOut: v })} />}
          </>
        );
      }
      case 'outerGlow':
      case 'innerGlow': {
        const x = e as unknown as GlowEffect & Partial<InnerGlowEffect>;
        return (
          <>
            {common(k, x)}
            <div className="row"><span className="muted" style={{ width: 90 }}>Color</span><ColorSwatch color={x.color} onClick={() => colorPick(x.color, (c) => update(k, sel.index, { color: c }))} /></div>
            <Select label="Technique" value={x.technique} onChange={(v) => update(k, sel.index, { technique: v })} options={[{ value: 'softer', label: 'Softer' }, { value: 'precise', label: 'Precise' }]} />
            {k === 'innerGlow' && <Select label="Source" value={x.source ?? 'edge'} onChange={(v) => update(k, sel.index, { source: v })} options={[{ value: 'edge', label: 'Edge' }, { value: 'center', label: 'Center' }]} />}
            <Slider label={k === 'outerGlow' ? 'Spread' : 'Choke'} value={x.spread} min={0} max={100} unit="%" onChange={(v) => update(k, sel.index, { spread: v })} />
            <Slider label="Size" value={x.size} min={0} max={250} unit="px" onChange={(v) => update(k, sel.index, { size: v })} />
            <Slider label="Range" value={x.range} min={1} max={100} unit="%" onChange={(v) => update(k, sel.index, { range: v })} />
          </>
        );
      }
      case 'bevel': {
        const x = fx.bevel!;
        return (
          <>
            <Select label="Style" value={x.style} onChange={(v) => update(k, 0, { style: v })} options={[{ value: 'outerBevel', label: 'Outer Bevel' }, { value: 'innerBevel', label: 'Inner Bevel' }, { value: 'emboss', label: 'Emboss' }, { value: 'pillowEmboss', label: 'Pillow Emboss' }, { value: 'strokeEmboss', label: 'Stroke Emboss' }]} />
            <Select label="Technique" value={x.technique} onChange={(v) => update(k, 0, { technique: v })} options={[{ value: 'smooth', label: 'Smooth' }, { value: 'chiselHard', label: 'Chisel Hard' }, { value: 'chiselSoft', label: 'Chisel Soft' }]} />
            <Slider label="Depth" value={x.depth} min={1} max={1000} unit="%" onChange={(v) => update(k, 0, { depth: v })} />
            <Select label="Direction" value={x.direction} onChange={(v) => update(k, 0, { direction: v })} options={[{ value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }]} />
            <Slider label="Size" value={x.size} min={0} max={250} unit="px" onChange={(v) => update(k, 0, { size: v })} />
            <Slider label="Soften" value={x.soften} min={0} max={16} unit="px" onChange={(v) => update(k, 0, { soften: v })} />
            {angleRow(k, x)}
            <NumberField label="Altitude" value={x.useGlobalLight ? light.altitude : x.altitude} onChange={(v) => (x.useGlobalLight ? ((s.doc.globalLight.altitude = v), setFx(structuredClone(fx))) : update(k, 0, { altitude: v }))} unit="°" />
            <div className="row"><span className="muted" style={{ width: 90 }}>Highlight</span><BlendSelect value={x.highlightMode} onChange={(m) => update(k, 0, { highlightMode: m })} width={100} /><ColorSwatch color={x.highlightColor} onClick={() => colorPick(x.highlightColor, (c) => update(k, 0, { highlightColor: c }))} /><NumberField value={Math.round(x.highlightOpacity * 100)} onChange={(v) => update(k, 0, { highlightOpacity: v / 100 })} unit="%" width={42} /></div>
            <div className="row"><span className="muted" style={{ width: 90 }}>Shadow</span><BlendSelect value={x.shadowMode} onChange={(m) => update(k, 0, { shadowMode: m })} width={100} /><ColorSwatch color={x.shadowColor} onClick={() => colorPick(x.shadowColor, (c) => update(k, 0, { shadowColor: c }))} /><NumberField value={Math.round(x.shadowOpacity * 100)} onChange={(v) => update(k, 0, { shadowOpacity: v / 100 })} unit="%" width={42} /></div>
            <div className="faint">Gloss contours and texture are preserved from PSD; rendering uses a linear contour.</div>
          </>
        );
      }
      case 'satin': {
        const x = fx.satin!;
        return (
          <>
            {common(k, x)}
            <div className="row"><span className="muted" style={{ width: 90 }}>Color</span><ColorSwatch color={x.color} onClick={() => colorPick(x.color, (c) => update(k, 0, { color: c }))} /><Check label="Invert" checked={x.invert} onChange={(v) => update(k, 0, { invert: v })} /></div>
            <NumberField label="Angle" value={x.angle} onChange={(v) => update(k, 0, { angle: v })} unit="°" />
            <Slider label="Distance" value={x.distance} min={1} max={250} unit="px" onChange={(v) => update(k, 0, { distance: v })} />
            <Slider label="Size" value={x.size} min={0} max={250} unit="px" onChange={(v) => update(k, 0, { size: v })} />
          </>
        );
      }
      case 'colorOverlay': {
        const x = fx.colorOverlay[sel.index];
        return <>{common(k, x)}<div className="row"><span className="muted" style={{ width: 90 }}>Color</span><ColorSwatch color={x.color} onClick={() => colorPick(x.color, (c) => update(k, sel.index, { color: c }))} /></div></>;
      }
      case 'gradientOverlay': {
        const x = fx.gradientOverlay[sel.index];
        return (
          <>
            {common(k, x)}
            <GradientEditor gradient={x.gradient} onChange={(g) => update(k, sel.index, { gradient: g })} />
            <div className="row wrap">
              <Select label="Style" value={x.style} onChange={(v) => update(k, sel.index, { style: v })} options={[{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }, { value: 'angle', label: 'Angle' }, { value: 'reflected', label: 'Reflected' }, { value: 'diamond', label: 'Diamond' }]} />
              <Check label="Reverse" checked={x.reverse} onChange={(v) => update(k, sel.index, { reverse: v })} />
              <Check label="Dither" checked={x.dither} onChange={(v) => update(k, sel.index, { dither: v })} />
            </div>
            <NumberField label="Angle" value={x.angle} onChange={(v) => update(k, sel.index, { angle: v })} unit="°" />
            <Slider label="Scale" value={x.scale} min={10} max={150} unit="%" onChange={(v) => update(k, sel.index, { scale: v })} />
          </>
        );
      }
      case 'patternOverlay': {
        const x = fx.patternOverlay!;
        const pats = [...s.doc.patterns.values()];
        return (
          <>
            {common(k, x)}
            <Select label="Pattern" value={x.patternId} onChange={(v) => update(k, 0, { patternId: v, patternName: pats.find((p) => p.id === v)?.name ?? '' })} options={pats.length ? pats.map((p) => ({ value: p.id, label: p.name })) : [{ value: x.patternId, label: x.patternName || '(no patterns — use Edit › Define Pattern)' }]} />
            <Slider label="Scale" value={x.scale} min={1} max={1000} unit="%" onChange={(v) => update(k, 0, { scale: v })} />
          </>
        );
      }
      case 'stroke': {
        const x = fx.stroke[sel.index];
        return (
          <>
            <Slider label="Size" value={x.size} min={1} max={250} unit="px" onChange={(v) => update(k, sel.index, { size: v })} />
            <Select label="Position" value={x.position} onChange={(v) => update(k, sel.index, { position: v })} options={[{ value: 'outside', label: 'Outside' }, { value: 'inside', label: 'Inside' }, { value: 'center', label: 'Center' }]} />
            {common(k, x)}
            <Select label="Fill Type" value={x.fillType === 'pattern' ? 'color' : x.fillType} onChange={(v) => update(k, sel.index, { fillType: v, gradient: x.gradient ?? simpleGradient(useApp.getState().fg, useApp.getState().bg) })} options={[{ value: 'color', label: 'Color' }, { value: 'gradient', label: 'Gradient' }]} />
            {x.fillType === 'gradient' && x.gradient ? <GradientEditor gradient={x.gradient} onChange={(g) => update(k, sel.index, { gradient: g })} /> : <div className="row"><span className="muted" style={{ width: 90 }}>Color</span><ColorSwatch color={x.color} onClick={() => colorPick(x.color, (c) => update(k, sel.index, { color: c }))} /></div>}
          </>
        );
      }
    }
  };

  return (
    <Modal title={`Layer Style — ${layer.name}`} onClose={cancel} onOk={ok} width={760}
      footerLeft={<><button className="btn small" onClick={() => setFx(emptyEffects())}>Clear All</button><Check label="Effects visible" checked={fx.enabled} onChange={(v) => setFx({ ...fx, enabled: v })} /></>}>
      <div className="row" style={{ alignItems: 'stretch', gap: 12, minHeight: 440 }}>
        <div className="list" style={{ width: 210, borderRight: '1px solid var(--border)', paddingRight: 8 }}>
          <div className={`list-item${sel.kind === 'blending' ? ' active' : ''}`} onClick={() => setSel({ kind: 'blending', index: 0 })}><span className="grow">Blending Options</span></div>
          {ORDER.flatMap((k) => {
            const items = listOf(k) as { enabled: boolean }[];
            const rows = (items.length ? items : [null]).map((it, i) => (
              <div key={`${k}${i}`} className={`list-item${sel.kind === k && sel.index === i ? ' active' : ''}`} onClick={() => setSel({ kind: k, index: i })}>
                <input type="checkbox" checked={!!it?.enabled} onChange={(e) => toggle(k, e.target.checked, i)} onClick={(e) => e.stopPropagation()} />
                <span className="grow">{EFFECT_LABELS[k]}</span>
                {MULTI.has(k) && it && i === items.length - 1 && <button className="icon-btn" title="Add another" onClick={(e) => { e.stopPropagation(); add(k); }}>+</button>}
                {it && <button className="icon-btn" title="Remove effect" onClick={(e) => { e.stopPropagation(); remove(k, i); }}>−</button>}
              </div>
            ));
            return rows;
          })}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
          <strong>{sel.kind === 'blending' ? 'Blending Options' : EFFECT_LABELS[sel.kind]}</strong>
          {editor_()}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Blend If
// ---------------------------------------------------------------------------------------------
type BlendIfKey = keyof BlendIf;

function defaultBlendIf(): BlendIf {
  const c = () => ({ thisLayer: [...DEFAULT_BLEND_IF_RANGE] as BlendIfRange, underlying: [...DEFAULT_BLEND_IF_RANGE] as BlendIfRange });
  return { gray: c(), red: c(), green: c(), blue: c() };
}

function BlendIfEditor({ value, onChange }: { value: BlendIf | undefined; onChange: (v: BlendIf) => void }) {
  const [ch, setCh] = useState<BlendIfKey>('gray');
  const bi = value ?? defaultBlendIf();
  const set = (which: 'thisLayer' | 'underlying', r: BlendIfRange) => onChange({ ...bi, [ch]: { ...bi[ch], [which]: r } });
  const tint = ch === 'red' ? '#f33' : ch === 'green' ? '#3c3' : ch === 'blue' ? '#39f' : '#fff';
  return (
    <>
      <div className="section-title">Blend If</div>
      <Select label="Channel" value={ch} onChange={setCh} options={(() => {
        // Channel names follow the document mode (CMYK: C'M'Y' plate; Lab: L a b).
        const m = editor.active?.doc.canvas.colorMode;
        const names = m === 'cmyk' ? ['Cyan', 'Magenta', 'Yellow'] : m === 'lab' ? ['Lightness', 'a', 'b'] : ['Red', 'Green', 'Blue'];
        return [{ value: 'gray' as const, label: 'Gray' }, { value: 'red' as const, label: names[0] }, { value: 'green' as const, label: names[1] }, { value: 'blue' as const, label: names[2] }];
      })()} />
      <RangeSlider label="This Layer" range={bi[ch].thisLayer} tint={tint} onChange={(r) => set('thisLayer', r)} />
      <RangeSlider label="Underlying Layer" range={bi[ch].underlying} tint={tint} onChange={(r) => set('underlying', r)} />
      <div className="faint">Drag a handle; Alt+drag splits it for a smooth transition.</div>
    </>
  );
}

/** Photoshop-style Blend If slider: black and white handles, each splittable into two. */
function RangeSlider({ label, range, tint, onChange }: { label: string; range: BlendIfRange; tint: string; onChange: (r: BlendIfRange) => void }) {
  const W = 256;
  const ref = useRef<HTMLDivElement>(null);
  const valueAt = (clientX: number) => {
    const b = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(255, Math.round(((clientX - b.left) / b.width) * 255)));
  };
  const onDown = (e: React.PointerEvent) => {
    const v = valueAt(e.clientX);
    // Pick the nearest handle; Alt drags only that half of a split pair.
    const d = range.map((x) => Math.abs(x - v));
    let idx = d.indexOf(Math.min(...d));
    if (range[0] === range[1] && (idx === 0 || idx === 1)) idx = e.altKey ? (v < range[0] ? 0 : 1) : -1;
    else if (range[2] === range[3] && (idx === 2 || idx === 3)) idx = e.altKey ? (v < range[2] ? 2 : 3) : -2;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x = valueAt(ev.clientX);
      const r = [...range] as BlendIfRange;
      if (idx === -1) { r[0] = r[1] = Math.min(x, r[2]); }
      else if (idx === -2) { r[2] = r[3] = Math.max(x, r[1]); }
      else {
        r[idx] = x;
        // Keep the order black-low ≤ black-high ≤ white-low ≤ white-high.
        for (let i = idx + 1; i < 4; i++) r[i] = Math.max(r[i], r[i - 1]);
        for (let i = idx - 1; i >= 0; i--) r[i] = Math.min(r[i], r[i + 1]);
      }
      onChange(r);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    move(e.nativeEvent);
  };
  const handle = (v: number, dark: boolean, key: number) => (
    <div key={key} style={{ position: 'absolute', left: `calc(${(v / 255) * 100}% - 5px)`, top: 12, width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderBottom: `8px solid ${dark ? '#111' : '#eee'}`, filter: 'drop-shadow(0 0 1px #888)' }} />
  );
  return (
    <div style={{ margin: '4px 0 10px' }}>
      <div className="row"><span className="muted">{label}:</span><span className="faint">{range[0] === range[1] ? range[0] : `${range[0]} / ${range[1]}`}</span><div style={{ flex: 1 }} /><span className="faint">{range[2] === range[3] ? range[2] : `${range[2]} / ${range[3]}`}</span></div>
      <div ref={ref} onPointerDown={onDown} style={{ position: 'relative', width: W, height: 22, cursor: 'ew-resize', touchAction: 'none' }}>
        <div style={{ height: 12, background: `linear-gradient(to right, #000, ${tint})`, border: '1px solid var(--border)' }} />
        {handle(range[0], true, 0)}{range[1] !== range[0] && handle(range[1], true, 1)}
        {handle(range[2], false, 2)}{range[3] !== range[2] && handle(range[3], false, 3)}
      </div>
    </div>
  );
}
