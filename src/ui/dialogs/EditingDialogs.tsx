/** Color picker, filter, adjustment, color range and select-and-mask dialogs. */
import { cmykToSrgb, exactCmyk, exactLab, labToSrgb, srgbToCmyk, srgbToLab } from '../../color/plates';
import { uiCmykProfile } from '../../app/colorSettings';
import { applyDocAdjustmentStraight } from '../../adjustments/docAdjust';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Check, NumberField, Select, Slider, ColorSwatch } from '../controls';
import { editor } from '../../app/editor';
import { ui, useApp } from '../../app/store';
import type { RGB } from '../../color/types';
import { hexToRgb, hsvToRgb, rgbCss, rgbToHex, rgbToHsv, rgbToLab, labToRgb, rgbToCmyk, cmykToRgb } from '../../color/convert';
import { filterById } from '../../filters/builtin';
import type { FilterParams } from '../../filters/types';
import { defaults } from '../../filters/types';
import { applyFilter, setFilterPreview, updateSmartFilters } from '../../app/ops/filterOps';
import { AdjustmentEditor } from '../panels/AdjustmentEditors';
import { Adjustment, AdjustmentType, ADJUSTMENT_LABELS, defaultAdjustment } from '../../adjustments/types';
import { applyPixelAdjustment } from '../../app/ops/imageOps';
import { applyAdjustmentToStraight } from '../../adjustments/apply';
import { readLayerContent } from '../../rendering/compositor';
import { applyColorRange, changeSelection } from '../../app/ops/selectOps';
import type { ColorRangeMode } from '../../selection/ops';
import { combineRaster, expandSelection, contractSelection, feather } from '../../selection/ops';
import type { SelectionOp } from '../../selection/selection';
import { newFillLayer } from '../../app/ops/layerOps';
import { applyTextStyle } from '../../tools/typeTool';
import { aiProvider } from '../../ai/provider';
import { TiledRaster } from '../../image-engine/tiledRaster';
import { boxBlur, gaussianBlur } from '../../image-engine/blur';
import { compositeStraight } from '../../app/ops/common';
import { CreateLayerCommand, CreateMaskCommand } from '../../commands/layerCommands';
import { createPixelLayer } from '../../document/layerFactory';
import { expand, intersect } from '../../image-engine/rect';

// ---------------------------------------------------------------------------------------------
// Color picker
// ---------------------------------------------------------------------------------------------
export function ColorPickerDialog({ close, purpose, initial, onPick, title }: { close: () => void; purpose: 'foreground' | 'background' | 'fillLayer' | 'text' | 'callback'; initial?: RGB; onPick?: (c: RGB) => void; title?: string }) {
  const st = useApp.getState();
  const start = initial ?? (purpose === 'background' ? st.bg : st.fg);
  const [hsv, setHsv] = useState(() => rgbToHsv(start));
  const rgb = hsvToRgb(hsv);
  // Exact CMYK / Lab entered in their fields (kept with the colour; cleared by RGB / HSB edits).
  const [exact, setExact] = useState<{ cmyk?: [number, number, number, number]; lab?: [number, number, number] } | null>(() => (exactCmyk(start) ? { cmyk: exactCmyk(start) } : exactLab(start) ? { lab: exactLab(start) } : null));
  const cmykProfile = uiCmykProfile();
  const picked: RGB = exact ? { ...rgb, exact: { r: rgb.r, g: rgb.g, b: rgb.b, ...exact } } : rgb;
  const docMode = editor.active?.doc.canvas.colorMode;
  const outOfGamut = docMode === 'cmyk' && !exact?.cmyk && (() => { const back = cmykToSrgb(srgbToCmyk(rgb, cmykProfile), cmykProfile); return Math.max(Math.abs(back.r - rgb.r), Math.abs(back.g - rgb.g), Math.abs(back.b - rgb.b)) > 0.04; })();
  const sv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = sv.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const hue = hsvToRgb({ h: hsv.h, s: 1, v: 1 });
    const gx = g.createLinearGradient(0, 0, 256, 0);
    gx.addColorStop(0, '#fff');
    gx.addColorStop(1, rgbCss(hue));
    g.fillStyle = gx;
    g.fillRect(0, 0, 256, 256);
    const gy = g.createLinearGradient(0, 0, 0, 256);
    gy.addColorStop(0, 'rgba(0,0,0,0)');
    gy.addColorStop(1, '#000');
    g.fillStyle = gy;
    g.fillRect(0, 0, 256, 256);
  }, [hsv.h]);
  const setRgbOnly = (c: RGB) => setHsv((prev) => { const n = rgbToHsv(c); return n.s === 0 || n.v === 0 ? { ...n, h: prev.h } : n; });
  const setRgb = (c: RGB) => { setExact(exactCmyk(c) ? { cmyk: exactCmyk(c) } : exactLab(c) ? { lab: exactLab(c) } : null); setRgbOnly(c); };
  const setCmyk = (k: number, v: number) => { const n = [...cmyk] as [number, number, number, number]; n[k] = Math.max(0, Math.min(1, v / 100)); setExact({ cmyk: n }); setRgbOnly(cmykToSrgb(n, cmykProfile)); };
  const setLab = (k: number, v: number) => { const n = [...lab] as [number, number, number]; n[k] = v; setExact({ lab: n }); setRgbOnly(labToSrgb(n)); };
  const dragSV = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const upd = (cx: number, cy: number) => setHsv((p) => ({ ...p, s: Math.max(0, Math.min(1, (cx - r.left) / r.width)), v: Math.max(0, Math.min(1, 1 - (cy - r.top) / r.height)) }));
    upd(e.clientX, e.clientY);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => upd(ev.clientX, ev.clientY);
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
  };
  const dragHue = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const upd = (cy: number) => setHsv((p) => ({ ...p, h: Math.max(0, Math.min(359.9, (1 - (cy - r.top) / r.height) * 360)) }));
    upd(e.clientY);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => upd(ev.clientY);
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
  };
  const ok = () => {
    close();
    if (purpose === 'foreground') editor.setForeground(picked);
    else if (purpose === 'background') editor.setBackground(picked);
    else if (purpose === 'fillLayer') newFillLayer({ type: 'solid', color: picked });
    else if (purpose === 'text') {
      editor.setForeground(picked);
      const s = editor.active;
      const l = s?.activeLayer();
      if (s && l?.kind === 'text') applyTextStyle(s, l.id, { color: { ...picked, a: 1 } });
    } else onPick?.(picked);
  };
  const lab = exact?.lab ?? srgbToLab(rgb);
  const cmyk = exact?.cmyk ?? srgbToCmyk(rgb, cmykProfile);
  return (
    <Modal title={purpose === 'background' ? 'Color Picker (Background Color)' : purpose === 'fillLayer' ? 'Color Picker (Solid Color)' : purpose === 'callback' ? `Color Picker${title ? ` (${title})` : ''}` : 'Color Picker (Foreground Color)'} onClose={close} onOk={ok} width={600}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <div className="sv-box" onPointerDown={dragSV}>
          <canvas ref={sv} width={256} height={256} style={{ width: 256, height: 256, borderRadius: 3 }} />
          <div className="picker-marker" style={{ left: hsv.s * 256, top: (1 - hsv.v) * 256 }} />
        </div>
        <div className="hue-strip" onPointerDown={dragHue}><div className="hue-marker" style={{ top: (1 - hsv.h / 360) * 256 }} /></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ width: 70, border: '1px solid var(--border-strong)' }}>
            <div style={{ height: 32, background: rgbCss(rgb) }} title="New" />
            <div style={{ height: 32, background: rgbCss(start) }} title="Current" onClick={() => setRgb(start)} />
          </div>
          <div className="grid2" style={{ gap: '4px 6px' }}>
            <span className="lbl">H</span><NumberField value={Math.round(hsv.h)} onChange={(v) => setHsv({ ...hsv, h: v })} min={0} max={360} unit="°" width={50} />
            <span className="lbl">S</span><NumberField value={Math.round(hsv.s * 100)} onChange={(v) => setHsv({ ...hsv, s: v / 100 })} min={0} max={100} unit="%" width={50} />
            <span className="lbl">B</span><NumberField value={Math.round(hsv.v * 100)} onChange={(v) => setHsv({ ...hsv, v: v / 100 })} min={0} max={100} unit="%" width={50} />
            <span className="lbl">R</span><NumberField value={Math.round(rgb.r * 255)} onChange={(v) => setRgb({ ...rgb, r: v / 255 })} min={0} max={255} width={50} />
            <span className="lbl">G</span><NumberField value={Math.round(rgb.g * 255)} onChange={(v) => setRgb({ ...rgb, g: v / 255 })} min={0} max={255} width={50} />
            <span className="lbl">B</span><NumberField value={Math.round(rgb.b * 255)} onChange={(v) => setRgb({ ...rgb, b: v / 255 })} min={0} max={255} width={50} />
          </div>
        </div>
        <div className="grid2" style={{ gap: '4px 6px' }}>
          <span className="lbl">L</span><NumberField value={Math.round(lab[0])} onChange={(v) => setLab(0, v)} min={0} max={100} width={50} />
          <span className="lbl">a</span><NumberField value={Math.round(lab[1])} onChange={(v) => setLab(1, v)} min={-128} max={127} width={50} />
          <span className="lbl">b</span><NumberField value={Math.round(lab[2])} onChange={(v) => setLab(2, v)} min={-128} max={127} width={50} />
          <span className="lbl">C</span><NumberField value={Math.round(cmyk[0] * 100)} onChange={(v) => setCmyk(0, v)} min={0} max={100} unit="%" width={50} />
          <span className="lbl">M</span><NumberField value={Math.round(cmyk[1] * 100)} onChange={(v) => setCmyk(1, v)} min={0} max={100} unit="%" width={50} />
          <span className="lbl">Y</span><NumberField value={Math.round(cmyk[2] * 100)} onChange={(v) => setCmyk(2, v)} min={0} max={100} unit="%" width={50} />
          <span className="lbl">K</span><NumberField value={Math.round(cmyk[3] * 100)} onChange={(v) => setCmyk(3, v)} min={0} max={100} unit="%" width={50} />
          <span className="lbl">#</span><input className="txt" style={{ width: 70 }} value={rgbToHex(rgb)} onChange={(e) => { const c = hexToRgb(e.target.value); if (c) setRgb(c); }} />
        </div>
      </div>
      {outOfGamut && <div className="row" style={{ gap: 6, color: 'var(--warn, #e5a50a)' }} title="This colour cannot be printed with the document's CMYK profile; it will be mapped to the nearest printable colour.">⚠ Out of CMYK gamut — will print as the nearest printable colour <button className="btn small" onClick={() => setCmyk(0, srgbToCmyk(rgb, cmykProfile)[0] * 100)}>Use printable colour</button></div>}
      <div className="faint">CMYK values use {cmykProfile.name}; Lab is CIE L*a*b* (D50).</div>
      <div className="swatches-grid">{useApp.getState().swatches.map((c, i) => <div key={i} className="sw" style={{ background: rgbCss(c) }} onClick={() => setRgb(c)} />)}</div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------
export function FilterDialog({ close, id, smart }: { close: () => void; id: string; smart?: { layerId: string; index: number; params: FilterParams } }) {
  const def = filterById(id)!;
  const [params, setParams] = useState<FilterParams>(() => ({ ...defaults(def), ...(smart?.params ?? {}) }));
  const [preview, setPreview] = useState(true);
  const s = editor.active!;
  useEffect(() => {
    if (preview && !smart) setFilterPreview(s, id, params);
    else setFilterPreview(s, null, null);
  }, [params, preview]);
  useEffect(() => () => setFilterPreview(s, null, null), []);
  const ok = () => {
    setFilterPreview(s, null, null);
    close();
    if (smart) updateSmartFilters(s, smart.layerId, `Edit ${def.name.replace('…', '')}`, (fs) => fs.map((f, i) => (i === smart.index ? { ...f, params: { ...params } } : f)));
    else applyFilter(id, params);
  };
  return (
    <Modal title={def.name.replace('…', '')} onClose={() => { setFilterPreview(s, null, null); close(); }} onOk={ok} width={420} footerLeft={!smart ? <Check label="Preview" checked={preview} onChange={setPreview} /> : undefined}>
      {def.params.map((p) => {
        const v = params[p.id];
        switch (p.type) {
          case 'number':
            return <Slider key={p.id} label={p.label} value={Number(v)} min={p.min} max={Math.min(p.max, p.max > 2000 ? 2000 : p.max)} step={p.step ?? 1} unit={p.unit} onChange={(x) => setParams({ ...params, [p.id]: x })} />;
          case 'angle':
            return <Slider key={p.id} label={p.label} value={Number(v)} min={-180} max={180} unit="°" onChange={(x) => setParams({ ...params, [p.id]: x })} />;
          case 'select':
            return <Select key={p.id} label={p.label} value={String(v)} onChange={(x) => setParams({ ...params, [p.id]: x })} options={p.options} />;
          case 'boolean':
            return <Check key={p.id} label={p.label} checked={!!v} onChange={(x) => setParams({ ...params, [p.id]: x })} />;
          case 'seed':
            return <div className="row" key={p.id}><span className="muted">Seed {String(v)}</span><button className="btn small" onClick={() => setParams({ ...params, [p.id]: Math.floor(Math.random() * 1e6) })}>{p.label}</button></div>;
        }
        return null;
      })}
      {def.global && !smart && <div className="faint">This filter is computed for the whole layer; the preview may take a moment on large layers.</div>}
      {s.activeLayer()?.kind === 'smartObject' && !smart && <div className="tag ok">Will be added as an editable smart filter.</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Destructive adjustment (Image › Adjustments)
// ---------------------------------------------------------------------------------------------
export function AdjustmentDialog({ close, type }: { close: () => void; type: AdjustmentType }) {
  const [adj, setAdj] = useState<Adjustment>(() => defaultAdjustment(type));
  const [preview, setPreview] = useState(true);
  const s = editor.active!;
  const layer = s.activeLayer()!;
  useEffect(() => {
    if (!preview) {
      s.engine.setOverride(layer.id, null, null);
      return;
    }
    const sel = s.doc.selection;
    s.engine.setOverride(layer.id, {
      // The GPU compositor evaluates the same adjustment itself when it is active.
      gpu: { adjustment: adj },
      read: (r, level, plate = 0) => {
        const px = readLayerContent({ doc: s.doc, level, scale: 1 / (1 << level), opts: { level, plate } }, { ...layer, id: '__noop' } as never, r);
        const cov = sel.isEmpty() ? undefined : sel.mask.readFloat(r, level);
        applyDocAdjustmentStraight(s.doc, adj, plate, px, r.w * r.h, cov);
        return px;
      },
    }, null);
  }, [adj, preview]);
  useEffect(() => () => s.engine.setOverride(layer.id, null, null), []);
  return (
    <Modal title={ADJUSTMENT_LABELS[type]} onClose={() => { s.engine.setOverride(layer.id, null, null); close(); }} onOk={() => { s.engine.setOverride(layer.id, null, null); close(); applyPixelAdjustment(adj); }} width={380}
      footerLeft={<Check label="Preview" checked={preview} onChange={setPreview} />}>
      <div className="faint">Applies directly to the pixels of “{layer.name}”. For a non-destructive version use Layer › New Adjustment Layer.</div>
      <AdjustmentEditor adj={adj} onChange={setAdj} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Color range
// ---------------------------------------------------------------------------------------------
export function ColorRangeDialog({ close }: { close: () => void }) {
  const [mode, setMode] = useState<ColorRangeMode>('sampled');
  const [fuzz, setFuzz] = useState(40);
  const [invert, setInvert] = useState(false);
  const [op, setOp] = useState<SelectionOp>('replace');
  const fg = useApp((st) => st.fg);
  const [samples, setSamples] = useState<RGB[]>([fg]);
  return (
    <Modal title="Color Range" onClose={close} onOk={() => { close(); applyColorRange(mode, samples.map((c) => [c.r, c.g, c.b]), fuzz, invert, op); }} width={420}>
      <Select label="Select" value={mode} onChange={setMode} options={[{ value: 'sampled', label: 'Sampled Colors' }, { value: 'reds', label: 'Reds' }, { value: 'yellows', label: 'Yellows' }, { value: 'greens', label: 'Greens' }, { value: 'cyans', label: 'Cyans' }, { value: 'blues', label: 'Blues' }, { value: 'magentas', label: 'Magentas' }, { value: 'highlights', label: 'Highlights' }, { value: 'midtones', label: 'Midtones' }, { value: 'shadows', label: 'Shadows' }, { value: 'skinTones', label: 'Skin Tones' }]} />
      {mode === 'sampled' && (
        <div className="row wrap">
          <span className="muted">Samples:</span>
          {samples.map((c, i) => <ColorSwatch key={i} color={c} title="Click to remove" onClick={() => setSamples(samples.filter((_, k) => k !== i))} />)}
          <button className="btn small" onClick={() => setSamples([...samples, useApp.getState().fg])}>+ Foreground</button>
          <span className="faint">Tip: pick colors with the Eyedropper first.</span>
        </div>
      )}
      <Slider label="Fuzziness" value={fuzz} min={0} max={200} onChange={setFuzz} />
      <Check label="Invert" checked={invert} onChange={setInvert} />
      <Select label="Operation" value={op} onChange={setOp} options={[{ value: 'replace', label: 'New Selection' }, { value: 'add', label: 'Add' }, { value: 'subtract', label: 'Subtract' }, { value: 'intersect', label: 'Intersect' }]} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Select and Mask
// ---------------------------------------------------------------------------------------------
export function SelectAndMaskDialog({ close }: { close: () => void }) {
  const s = editor.active!;
  const [smooth, setSmooth] = useState(0);
  const [featherPx, setFeather] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [shift, setShift] = useState(0);
  const [refine, setRefine] = useState(0);
  const [output, setOutput] = useState<'selection' | 'mask' | 'newLayerMask'>('selection');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const sel = s.doc.selection;
    const b = sel.bounds(s.doc.bounds);
    if (!b) return close();
    setBusy(true);
    const pad = Math.ceil(Math.max(smooth, featherPx * 3, Math.abs(shift), refine) + 4);
    const r = intersect(expand(b, pad), s.doc.bounds);
    let m = sel.read(r);
    if (refine > 0) {
      const img = compositeStraight(s, r);
      m = await aiProvider().refineEdges(img, m, r.w, r.h, refine);
    }
    if (smooth > 0) { boxBlur(m, r.w, r.h, 1, smooth); for (let i = 0; i < m.length; i++) m[i] = m[i] >= 0.5 ? 1 : 0; boxBlur(m, r.w, r.h, 1, 0.8); }
    if (contrast > 0) { const k = 1 + (contrast / 100) * 20; for (let i = 0; i < m.length; i++) m[i] = Math.max(0, Math.min(1, (m[i] - 0.5) * k + 0.5)); }
    if (featherPx > 0) gaussianBlur(m, r.w, r.h, 1, featherPx);
    const tmp = new TiledRaster(1, 8, 0);
    tmp.writeFloat(r, m);
    const apply = () => {
      combineRaster(sel, tmp, 'replace', s.doc.bounds);
      if (shift > 0) expandSelection(sel, s.doc.bounds, (shift / 100) * 20);
      if (shift < 0) contractSelection(sel, s.doc.bounds, (-shift / 100) * 20);
      void feather;
    };
    const l = s.activeLayer();
    if (output === 'selection' || !l) changeSelection(s, 'Select and Mask', apply);
    else {
      changeSelection(s, 'Select and Mask', apply);
      const mask = { raster: sel.mask.clone(), x: 0, y: 0, enabled: true, linked: true, density: 1, feather: 0 };
      if (output === 'mask') s.push(new CreateMaskCommand('Select and Mask', l.id, l.mask, mask));
      else if (l.kind === 'pixel') {
        const nl = createPixelLayer(`${l.name} (masked)`, s.doc.canvas.bitDepth, l.raster.clone());
        nl.x = l.x; nl.y = l.y;
        nl.mask = mask;
        const parent = l.parent ?? s.doc.root;
        s.push(new CreateLayerCommand('Select and Mask', nl, parent.id, parent.children.indexOf(l) + 1));
        s.setActive(nl.id);
      }
    }
    setBusy(false);
    close();
  };
  return (
    <Modal title="Select and Mask" onClose={close} onOk={run} okDisabled={busy} okLabel={busy ? 'Working…' : 'OK'} width={420}>
      <div className="section-title">Edge Detection</div>
      <Slider label="Refine radius" value={refine} min={0} max={50} unit="px" onChange={setRefine} />
      <div className="faint">Refine radius uses edge-aware refinement (guided filter) to follow hair and fine detail — {aiProvider().label}.</div>
      <div className="section-title">Global Refinements</div>
      <Slider label="Smooth" value={smooth} min={0} max={50} onChange={setSmooth} />
      <Slider label="Feather" value={featherPx} min={0} max={250} step={0.1} unit="px" onChange={setFeather} />
      <Slider label="Contrast" value={contrast} min={0} max={100} unit="%" onChange={setContrast} />
      <Slider label="Shift Edge" value={shift} min={-100} max={100} unit="%" onChange={setShift} />
      <Select label="Output To" value={output} onChange={setOutput} options={[{ value: 'selection', label: 'Selection' }, { value: 'mask', label: 'Layer Mask' }, { value: 'newLayerMask', label: 'New Layer with Layer Mask' }]} />
    </Modal>
  );
}

export { ui };
