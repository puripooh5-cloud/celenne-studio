/** Parameter editors for every adjustment type. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Adjustment, CurvePoint, SelectiveColorKey, LevelsChannel } from '../../adjustments/types';
import { curveLUT, parseCubeLUT } from '../../adjustments/apply';
import { Check, ColorSwatch, NumberField, Select, Slider } from '../controls';
import { ui } from '../../app/store';
import type { Gradient, RGB } from '../../color/types';
import { GradientPreview } from '../OptionsBar';
import { gradientPresets } from '../../tools/fillSampleTools';
import { platform } from '../../app/platform/platform';
import { editor } from '../../app/editor';
import { compositeRegion } from '../../rendering/compositor';

/** Luminance / channel histogram of the current composite (coarse level for speed). */
export function useHistogram(): { l: Uint32Array; r: Uint32Array; g: Uint32Array; b: Uint32Array; k: Uint32Array } | null {
  const s = editor.active;
  return useMemo(() => {
    if (!s) return null;
    const lvl = Math.max(0, Math.ceil(Math.log2(Math.max(s.doc.width, s.doc.height) / 512)));
    const sc = 1 << lvl;
    const r = { x: 0, y: 0, w: Math.ceil(s.doc.width / sc), h: Math.ceil(s.doc.height / sc) };
    // Stored channel values: R G B, C' M' Y' (+ K' from plate 1) or L a b.
    const buf = compositeRegion(s.doc, r, { level: lvl });
    const kbuf = s.doc.canvas.colorMode === 'cmyk' ? compositeRegion(s.doc, r, { level: lvl, plate: 1 }) : null;
    const lab = s.doc.canvas.colorMode === 'lab';
    const h = { l: new Uint32Array(256), r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), k: new Uint32Array(256) };
    for (let i = 0; i < r.w * r.h; i++) {
      const a = buf[i * 4 + 3];
      if (a <= 0) continue;
      const R = buf[i * 4] / a, G = buf[i * 4 + 1] / a, B = buf[i * 4 + 2] / a;
      const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
      h.r[q(R)]++; h.g[q(G)]++; h.b[q(B)]++; h.l[q(lab ? R : 0.3 * R + 0.59 * G + 0.11 * B)]++;
      if (kbuf) h.k[q(kbuf[i * 4] / a)]++;
    }
    return h;
    // Recompute when the document changes structurally (approximate: on doc rev).
  }, [s, s?.doc.rev]);
}

export function Histogram({ data, color = '#9b9ea8' }: { data: Uint32Array | null; color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !data) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    let max = 0;
    for (let i = 1; i < 255; i++) max = Math.max(max, data[i]);
    g.fillStyle = color;
    for (let i = 0; i < 256; i++) {
      const hh = max ? Math.min(1, data[i] / max) * c.height : 0;
      g.fillRect((i / 256) * c.width, c.height - hh, Math.ceil(c.width / 256), hh);
    }
  }, [data, color]);
  return <canvas ref={ref} className="histogram" width={512} height={180} />;
}

export function CurveEditor({ points, onChange, histogram }: { points: CurvePoint[]; onChange: (p: CurvePoint[]) => void; histogram?: Uint32Array | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<number>(-1);
  const S = 240;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, S, S);
    if (histogram) {
      let max = 0;
      for (let i = 1; i < 255; i++) max = Math.max(max, histogram[i]);
      g.fillStyle = 'rgba(155,158,168,0.25)';
      for (let i = 0; i < 256; i++) { const hh = max ? Math.min(1, histogram[i] / max) * S : 0; g.fillRect((i / 256) * S, S - hh, 1, hh); }
    }
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo((i * S) / 4, 0); g.lineTo((i * S) / 4, S); g.moveTo(0, (i * S) / 4); g.lineTo(S, (i * S) / 4); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.beginPath(); g.moveTo(0, S); g.lineTo(S, 0); g.stroke();
    const lut = curveLUT(points);
    g.strokeStyle = '#e8e8e8';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let x = 0; x <= S; x++) {
      const v = lut[Math.round((x / S) * (lut.length - 1))];
      const y = S - v * S;
      if (x) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
    g.fillStyle = '#fff';
    for (const p of points) g.fillRect((p.x / 255) * S - 3, S - (p.y / 255) * S - 3, 6, 6);
  }, [points, histogram]);
  const toPt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(255, ((e.clientX - r.left) / r.width) * 255)), y: Math.max(0, Math.min(255, (1 - (e.clientY - r.top) / r.height) * 255)) };
  };
  return (
    <canvas
      ref={ref}
      className="curve-editor"
      width={S}
      height={S}
      style={{ width: S, height: S }}
      onPointerDown={(e) => {
        const p = toPt(e);
        let idx = points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 10);
        const pts = points.map((q) => ({ ...q }));
        if (idx < 0) {
          pts.push({ x: Math.round(p.x), y: Math.round(p.y) });
          pts.sort((a, b) => a.x - b.x);
          idx = pts.findIndex((q) => q.x === Math.round(p.x) && q.y === Math.round(p.y));
          onChange(pts);
        }
        drag.current = idx;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current < 0) return;
        const p = toPt(e);
        const pts = points.map((q) => ({ ...q }));
        const i = drag.current;
        const lo = i > 0 ? pts[i - 1].x + 1 : 0, hi = i < pts.length - 1 ? pts[i + 1].x - 1 : 255;
        const r = ref.current!.getBoundingClientRect();
        const outside = e.clientY > r.bottom + 30 || e.clientY < r.top - 30 || e.clientX < r.left - 30 || e.clientX > r.right + 30;
        if (outside && pts.length > 2 && i > 0 && i < pts.length - 1) {
          pts.splice(i, 1);
          drag.current = -1;
          onChange(pts);
          return;
        }
        pts[i] = { x: Math.round(Math.max(lo, Math.min(hi, p.x))), y: Math.round(p.y) };
        onChange(pts);
      }}
      onPointerUp={() => (drag.current = -1)}
    />
  );
}

function LevelsEditor({ ch, set, hist }: { ch: LevelsChannel; set: (c: LevelsChannel) => void; hist: Uint32Array | null }) {
  return (
    <div className="panel-body" style={{ padding: 0 }}>
      <Histogram data={hist} />
      <Slider label="Input black" value={ch.inBlack} min={0} max={253} onChange={(v) => set({ ...ch, inBlack: Math.min(v, ch.inWhite - 2) })} />
      <Slider label="Gamma" value={ch.gamma} min={0.1} max={9.99} step={0.01} onChange={(v) => set({ ...ch, gamma: v })} />
      <Slider label="Input white" value={ch.inWhite} min={2} max={255} onChange={(v) => set({ ...ch, inWhite: Math.max(v, ch.inBlack + 2) })} />
      <Slider label="Output black" value={ch.outBlack} min={0} max={255} onChange={(v) => set({ ...ch, outBlack: v })} />
      <Slider label="Output white" value={ch.outWhite} min={0} max={255} onChange={(v) => set({ ...ch, outWhite: v })} />
    </div>
  );
}

export function GradientEditor({ gradient, onChange }: { gradient: Gradient; onChange: (g: Gradient) => void }) {
  const [sel, setSel] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const stops = gradient.colorStops;
  return (
    <div className="panel-body" style={{ padding: 0, gap: 6 }}>
      <div className="row wrap" style={{ gap: 3 }}>
        {gradientPresets().map((g, i) => <GradientPreview key={i} lutSource={g} onClick={() => onChange(structuredClone(g))} title={g.name} />)}
      </div>
      <div ref={barRef} style={{ position: 'relative', paddingBottom: 14 }}
        onDoubleClick={(e) => {
          const r = barRef.current!.getBoundingClientRect();
          const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
          const g = structuredClone(gradient);
          g.colorStops.push({ location: t, color: { ...(stops[sel]?.color ?? { r: 0.5, g: 0.5, b: 0.5 }) }, midpoint: 0.5 });
          g.colorStops.sort((a, b) => a.location - b.location);
          onChange(g);
        }}>
        <GradientPreview lutSource={gradient} width={220} />
        {stops.map((st, i) => (
          <div key={i}
            title="Drag to move · double-click the bar to add · drag off to remove"
            style={{ position: 'absolute', left: `calc(${st.location * 100}% - 5px)`, bottom: 0, width: 10, height: 12, background: `rgb(${st.color.r * 255},${st.color.g * 255},${st.color.b * 255})`, border: `2px solid ${i === sel ? '#3d8bfd' : '#ddd'}`, cursor: 'ew-resize' }}
            onPointerDown={(e) => {
              setSel(i);
              const el = e.currentTarget;
              el.setPointerCapture(e.pointerId);
              const r = barRef.current!.getBoundingClientRect();
              const mv = (ev: PointerEvent) => {
                const g = structuredClone(gradient);
                if (Math.abs(ev.clientY - r.bottom) > 40 && g.colorStops.length > 2) {
                  g.colorStops.splice(i, 1);
                  el.removeEventListener('pointermove', mv);
                  onChange(g);
                  return;
                }
                g.colorStops[i].location = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
                onChange(g);
              };
              const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
              el.addEventListener('pointermove', mv);
              el.addEventListener('pointerup', up);
            }}
          />
        ))}
      </div>
      {stops[sel] && (
        <div className="row">
          <ColorSwatch color={stops[sel].color} title="Stop color" onClick={() => ui.openDialog('colorPicker', { purpose: 'callback', initial: stops[sel].color, onPick: (c: RGB) => { const g = structuredClone(gradient); if (g.colorStops[sel]) g.colorStops[sel].color = c; onChange(g); } })} />
          <NumberField label="Location" value={Math.round(stops[sel].location * 100)} onChange={(v) => { const g = structuredClone(gradient); g.colorStops[sel].location = v / 100; onChange(g); }} min={0} max={100} unit="%" />
          <NumberField label="Smooth" value={Math.round(gradient.smoothness * 100)} onChange={(v) => onChange({ ...gradient, smoothness: v / 100 })} min={0} max={100} unit="%" />
        </div>
      )}
    </div>
  );
}

const HS_RANGES = ['Master', 'Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'];
const SC_KEYS: SelectiveColorKey[] = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];

export function AdjustmentEditor({ adj, onChange }: { adj: Adjustment; onChange: (a: Adjustment) => void }) {
  const [channel, setChannel] = useState<'rgb' | 'red' | 'green' | 'blue' | 'black'>('rgb');
  const mode = editor.active?.doc.canvas.colorMode ?? 'rgb';
  const [range, setRange] = useState(0);
  const [tone, setTone] = useState<'shadows' | 'midtones' | 'highlights'>('midtones');
  const [mixOut, setMixOut] = useState<'red' | 'green' | 'blue'>('red');
  const [scKey, setScKey] = useState<SelectiveColorKey>('reds');
  const hist = useHistogram();
  const chanHist = hist ? (channel === 'rgb' ? hist.l : channel === 'black' ? hist.k : hist[channel[0] as 'r' | 'g' | 'b']) : null;
  // Channel names follow the document mode (CMYK adds Black; Lab: composite = Lightness, then a, b).
  type Ch = 'rgb' | 'red' | 'green' | 'blue' | 'black';
  const channelOptions: { value: Ch; label: string }[] = mode === 'cmyk' ? [{ value: 'rgb', label: 'CMYK' }, { value: 'red', label: 'Cyan' }, { value: 'green', label: 'Magenta' }, { value: 'blue', label: 'Yellow' }, { value: 'black', label: 'Black' }]
    : mode === 'lab' ? [{ value: 'rgb', label: 'Lightness' }, { value: 'red', label: 'a' }, { value: 'green', label: 'b' }]
      : mode === 'grayscale' ? [{ value: 'rgb', label: 'Gray' }]
        : [{ value: 'rgb', label: 'RGB' }, { value: 'red', label: 'Red' }, { value: 'green', label: 'Green' }, { value: 'blue', label: 'Blue' }];
  const channelSelect = <Select label="Channel" value={channel} onChange={setChannel} options={channelOptions} />;
  const lvId = { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
  const cvId = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
  switch (adj.type) {
    case 'brightnessContrast':
      return (
        <>
          <Slider label="Brightness" value={adj.brightness} min={adj.useLegacy ? -150 : -150} max={150} onChange={(v) => onChange({ ...adj, brightness: v })} />
          <Slider label="Contrast" value={adj.contrast} min={adj.useLegacy ? -100 : -50} max={100} onChange={(v) => onChange({ ...adj, contrast: v })} />
          <Check label="Use Legacy" checked={adj.useLegacy} onChange={(v) => onChange({ ...adj, useLegacy: v })} />
        </>
      );
    case 'levels':
      return (
        <>
          {channelSelect}
          <LevelsEditor ch={adj[channel] ?? lvId} hist={chanHist} set={(c) => onChange({ ...adj, [channel]: c })} />
        </>
      );
    case 'curves':
      return (
        <>
          {channelSelect}
          <CurveEditor points={adj[channel] ?? cvId} histogram={chanHist} onChange={(p) => onChange({ ...adj, [channel]: p })} />
          <div className="row">
            <button className="btn small" onClick={() => onChange({ ...adj, [channel]: [{ x: 0, y: 0 }, { x: 255, y: 255 }] })}>Reset Channel</button>
            <span className="faint">Click to add points · drag out to remove</span>
          </div>
        </>
      );
    case 'exposure':
      return (
        <>
          <Slider label="Exposure" value={adj.exposure} min={-20} max={20} step={0.01} onChange={(v) => onChange({ ...adj, exposure: v })} />
          <Slider label="Offset" value={adj.offset} min={-0.5} max={0.5} step={0.001} onChange={(v) => onChange({ ...adj, offset: v })} />
          <Slider label="Gamma" value={adj.gamma} min={0.01} max={9.99} step={0.01} onChange={(v) => onChange({ ...adj, gamma: v })} />
        </>
      );
    case 'vibrance':
      return (
        <>
          <Slider label="Vibrance" value={adj.vibrance} min={-100} max={100} onChange={(v) => onChange({ ...adj, vibrance: v })} />
          <Slider label="Saturation" value={adj.saturation} min={-100} max={100} onChange={(v) => onChange({ ...adj, saturation: v })} />
        </>
      );
    case 'hueSaturation': {
      const vals = range === 0 ? adj.master : adj.ranges[range - 1];
      const setVals = (p: Partial<typeof vals>) => {
        if (range === 0) onChange({ ...adj, master: { ...adj.master, ...p } });
        else onChange({ ...adj, ranges: adj.ranges.map((r, i) => (i === range - 1 ? { ...r, ...p } : r)) });
      };
      return (
        <>
          <Select label="Range" value={String(range)} onChange={(v) => setRange(Number(v))} options={HS_RANGES.map((l, i) => ({ value: String(i), label: l, disabled: adj.colorize && i > 0 }))} />
          <Slider label="Hue" value={vals.hue} min={adj.colorize ? 0 : -180} max={adj.colorize ? 360 : 180} onChange={(v) => setVals({ hue: v })} />
          <Slider label="Saturation" value={vals.saturation} min={adj.colorize ? 0 : -100} max={100} onChange={(v) => setVals({ saturation: v })} />
          <Slider label="Lightness" value={vals.lightness} min={-100} max={100} onChange={(v) => setVals({ lightness: v })} />
          <Check label="Colorize" checked={adj.colorize} onChange={(v) => { setRange(0); onChange({ ...adj, colorize: v, master: v ? { hue: 0, saturation: 25, lightness: 0 } : { hue: 0, saturation: 0, lightness: 0 } }); }} />
        </>
      );
    }
    case 'colorBalance': {
      const t = adj[tone];
      const set = (i: number, v: number) => onChange({ ...adj, [tone]: t.map((x, k) => (k === i ? v : x)) as [number, number, number] });
      return (
        <>
          <Select label="Tone" value={tone} onChange={setTone} options={[{ value: 'shadows', label: 'Shadows' }, { value: 'midtones', label: 'Midtones' }, { value: 'highlights', label: 'Highlights' }]} />
          <Slider label="Cyan ↔ Red" value={t[0]} min={-100} max={100} onChange={(v) => set(0, v)} />
          <Slider label="Magenta ↔ Green" value={t[1]} min={-100} max={100} onChange={(v) => set(1, v)} />
          <Slider label="Yellow ↔ Blue" value={t[2]} min={-100} max={100} onChange={(v) => set(2, v)} />
          <Check label="Preserve Luminosity" checked={adj.preserveLuminosity} onChange={(v) => onChange({ ...adj, preserveLuminosity: v })} />
        </>
      );
    }
    case 'blackWhite':
      return (
        <>
          {(['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const).map((k) => (
            <Slider key={k} label={k[0].toUpperCase() + k.slice(1)} value={adj[k]} min={-200} max={300} unit="%" onChange={(v) => onChange({ ...adj, [k]: v })} />
          ))}
          <div className="row">
            <Check label="Tint" checked={adj.tint} onChange={(v) => onChange({ ...adj, tint: v })} />
            <ColorSwatch color={adj.tintColor} title="Tint color" onClick={() => ui.openDialog('colorPicker', { purpose: 'callback', initial: adj.tintColor, onPick: (c: RGB) => onChange({ ...adj, tintColor: c }) })} />
          </div>
        </>
      );
    case 'photoFilter':
      return (
        <>
          <div className="row">
            <span className="muted">Color</span>
            <ColorSwatch color={adj.color} onClick={() => ui.openDialog('colorPicker', { purpose: 'callback', initial: adj.color, onPick: (c: RGB) => onChange({ ...adj, color: c }) })} />
            <Select value="" onChange={(v) => { const presets: Record<string, RGB> = { warm85: { r: 0.925, g: 0.541, b: 0 }, warm81: { r: 0.922, g: 0.694, b: 0.075 }, cool80: { r: 0, g: 0.427, b: 1 }, cool82: { r: 0, g: 0.71, b: 1 }, sepia: { r: 0.675, g: 0.478, b: 0.2 } }; if (presets[v]) onChange({ ...adj, color: presets[v] }); }} options={[{ value: '', label: 'Presets…' }, { value: 'warm85', label: 'Warming (85)' }, { value: 'warm81', label: 'Warming (81)' }, { value: 'cool80', label: 'Cooling (80)' }, { value: 'cool82', label: 'Cooling (82)' }, { value: 'sepia', label: 'Sepia' }]} />
          </div>
          <Slider label="Density" value={adj.density} min={0} max={100} unit="%" onChange={(v) => onChange({ ...adj, density: v })} />
          <Check label="Preserve Luminosity" checked={adj.preserveLuminosity} onChange={(v) => onChange({ ...adj, preserveLuminosity: v })} />
        </>
      );
    case 'channelMixer': {
      const outKey = adj.monochrome ? 'gray' : mixOut;
      const vals = adj[outKey];
      const set = (i: number, v: number) => onChange({ ...adj, [outKey]: vals.map((x, k) => (k === i ? v : x)) as [number, number, number, number] });
      return (
        <>
          {!adj.monochrome && <Select label="Output" value={mixOut} onChange={setMixOut} options={[{ value: 'red', label: 'Red' }, { value: 'green', label: 'Green' }, { value: 'blue', label: 'Blue' }]} />}
          <Slider label="Red" value={vals[0]} min={-200} max={200} unit="%" onChange={(v) => set(0, v)} />
          <Slider label="Green" value={vals[1]} min={-200} max={200} unit="%" onChange={(v) => set(1, v)} />
          <Slider label="Blue" value={vals[2]} min={-200} max={200} unit="%" onChange={(v) => set(2, v)} />
          <Slider label="Constant" value={vals[3]} min={-200} max={200} unit="%" onChange={(v) => set(3, v)} />
          <span className="faint">Total: {vals[0] + vals[1] + vals[2]}%</span>
          <Check label="Monochrome" checked={adj.monochrome} onChange={(v) => onChange({ ...adj, monochrome: v })} />
        </>
      );
    }
    case 'colorLookup':
      return (
        <>
          <div className="muted">{adj.name || adj.lutFileName || 'No lookup table loaded'}</div>
          {!adj.lut && adj.preserved ? <div className="tag warn">Photoshop lookup data preserved (not rendered)</div> : null}
          <button className="btn small" onClick={async () => {
            const files = await platform().openFiles([{ name: '3D LUT (.cube)', extensions: ['cube'] }], false);
            const f = files[0];
            if (!f) return;
            try {
              const lut = parseCubeLUT(new TextDecoder().decode(f.data));
              onChange({ ...adj, lut, name: f.name, lutFileName: f.name, preserved: undefined });
            } catch (e) {
              ui.toast('error', 'Could not load LUT', (e as Error).message);
            }
          }}>Load 3D LUT (.cube)…</button>
        </>
      );
    case 'invert':
      return <div className="muted">Inverts all colors below this layer.</div>;
    case 'posterize':
      return <Slider label="Levels" value={adj.levels} min={2} max={255} onChange={(v) => onChange({ ...adj, levels: v })} />;
    case 'threshold':
      return (
        <>
          <Histogram data={hist?.l ?? null} />
          <Slider label="Threshold Level" value={adj.level} min={1} max={255} onChange={(v) => onChange({ ...adj, level: v })} />
        </>
      );
    case 'gradientMap':
      return (
        <>
          <GradientEditor gradient={adj.gradient} onChange={(g) => onChange({ ...adj, gradient: g })} />
          <Check label="Reverse" checked={adj.reverse} onChange={(v) => onChange({ ...adj, reverse: v })} />
          <Check label="Dither" checked={adj.dither} onChange={(v) => onChange({ ...adj, dither: v })} />
        </>
      );
    case 'selectiveColor': {
      const c = adj.colors[scKey];
      const set = (k: 'c' | 'm' | 'y' | 'k', v: number) => onChange({ ...adj, colors: { ...adj.colors, [scKey]: { ...c, [k]: v } } });
      return (
        <>
          <Select label="Colors" value={scKey} onChange={setScKey} options={SC_KEYS.map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) }))} />
          <Slider label="Cyan" value={c.c} min={-100} max={100} unit="%" onChange={(v) => set('c', v)} />
          <Slider label="Magenta" value={c.m} min={-100} max={100} unit="%" onChange={(v) => set('m', v)} />
          <Slider label="Yellow" value={c.y} min={-100} max={100} unit="%" onChange={(v) => set('y', v)} />
          <Slider label="Black" value={c.k} min={-100} max={100} unit="%" onChange={(v) => set('k', v)} />
          <Select label="Method" value={adj.mode} onChange={(v) => onChange({ ...adj, mode: v })} options={[{ value: 'relative', label: 'Relative' }, { value: 'absolute', label: 'Absolute' }]} />
        </>
      );
    }
  }
}
