/** Context-sensitive tool options bar. */
import { useApp, ui } from '../app/store';
import { editor } from '../app/editor';
import { toolInfo } from '../tools/toolTypes';
import { Icon } from './icons';
import { BlendSelect, Check, ColorSwatch, NumberField, Seg, Select, Slider, IconButton } from './controls';
import { run } from '../app/actions';
import { useSession } from './hooks';
import { commitTransform, cancelTransform, setTransformNumbers, transformNumbers, setWarpMode, setWarpPreset, transformState, warpState } from '../tools/transformTool';
import { defaultWarpPreset, WARP_STYLES, WarpPreset, WarpStyle } from '../image-engine/warp';
import { commitTextEdit, cancelTextEdit, textEditState, applyTextStyle, setTextPath } from '../tools/typeTool';
import { flattenTextPath } from '../typography/pathText';
import { selectedSliceId } from '../tools/sliceTool';
import { currentPluginTool, pluginToolList, pluginToolParams, setCurrentPluginTool, setPluginToolParams } from '../tools/pluginTool';
import { ParamsEditor } from './dialogs/FeatureDialogs';
import { fonts } from '../typography/fonts';
import { gradientPresets } from '../tools/fillSampleTools';
import { buildGradientLUT } from '../color/gradient';
import { CUSTOM_SHAPES } from '../vector/shapes';
import { useEffect, useRef } from 'react';

function GradientStrip({ index, onPick }: { index: number; onPick: (i: number) => void }) {
  const presets = gradientPresets();
  return (
    <div className="row" style={{ gap: 3 }}>
      {presets.map((g, i) => (
        <GradientPreview key={i} lutSource={g} active={i === index} onClick={() => onPick(i)} title={g.name} />
      ))}
    </div>
  );
}

export function GradientPreview({ lutSource, active, onClick, title, width = 34 }: { lutSource: import('../color/types').Gradient; active?: boolean; onClick?: () => void; title?: string; width?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const lut = buildGradientLUT(lutSource, false, c.width);
    const img = g.createImageData(c.width, c.height);
    for (let x = 0; x < c.width; x++)
      for (let y = 0; y < c.height; y++) {
        const chk = ((x >> 2) + (y >> 2)) % 2 ? 200 : 255;
        const a = lut[x * 4 + 3];
        const o = (y * c.width + x) * 4;
        img.data[o] = lut[x * 4] * 255 * a + chk * (1 - a);
        img.data[o + 1] = lut[x * 4 + 1] * 255 * a + chk * (1 - a);
        img.data[o + 2] = lut[x * 4 + 2] * 255 * a + chk * (1 - a);
        img.data[o + 3] = 255;
      }
    g.putImageData(img, 0, 0);
  }, [lutSource]);
  return <canvas ref={ref} width={width * 2} height={36} className="gradient-strip" style={{ width, height: 18, outline: active ? '2px solid var(--accent)' : undefined }} title={title} onClick={onClick} />;
}

const selOps = [
  { value: 'replace' as const, icon: 'selNew', title: 'New selection' },
  { value: 'add' as const, icon: 'selAdd', title: 'Add to selection (Shift)' },
  { value: 'subtract' as const, icon: 'selSubtract', title: 'Subtract from selection (Alt)' },
  { value: 'intersect' as const, icon: 'selIntersect', title: 'Intersect with selection (Shift+Alt)' },
];

export function OptionsBar() {
  const tool = useApp((s) => s.tool);
  const o = useApp((s) => s.toolOptions);
  const brush = useApp((s) => s.brush);
  const fg = useApp((s) => s.fg);
  useApp((s) => s.viewRev);
  const s = useSession();
  const info = toolInfo(tool);
  const sel = o.selection;
  const setSel = (p: Partial<typeof sel>) => ui.setToolOptions('selection', p);

  if (s?.mode.kind === 'transform') {
    const n = transformNumbers();
    const ws = warpState();
    const ts = transformState();
    const title = ts?.selOnly ? 'Transform Selection' : ws ? 'Warp' : 'Free Transform';
    if (ws) {
      const p = ws.preset ?? { ...defaultWarpPreset('none'), style: 'custom' as const };
      const set = (patch: Partial<WarpPreset>) => setWarpPreset({ ...p, ...patch, style: patch.style ?? (p.style === 'custom' ? 'arc' : p.style) });
      return (
        <div className="optionsbar">
          <div className="tool-badge"><Icon name="move" /> {title}</div>
          <Select label="Warp" value={p.style} onChange={(v) => setWarpPreset({ ...defaultWarpPreset(v as WarpStyle), bend: p.style === 'custom' || p.style === 'none' ? defaultWarpPreset(v as WarpStyle).bend : p.bend, horizontalDistortion: p.horizontalDistortion, verticalDistortion: p.verticalDistortion, orientation: p.orientation })}
            options={[{ value: 'custom', label: 'Custom' }, ...WARP_STYLES.map((w) => ({ value: w.id, label: w.label }))]} />
          <Seg value={p.orientation} onChange={(v) => set({ orientation: v as WarpPreset['orientation'] })} options={[{ value: 'horizontal', label: 'Horizontal', title: 'Horizontal orientation' }, { value: 'vertical', label: 'Vertical', title: 'Vertical orientation' }]} />
          <NumberField label="Bend" value={p.bend} onChange={(v) => set({ bend: Math.max(-100, Math.min(100, v)) })} unit="%" step={1} />
          <NumberField label="H" value={p.horizontalDistortion} onChange={(v) => set({ horizontalDistortion: Math.max(-100, Math.min(100, v)) })} unit="%" step={1} />
          <NumberField label="V" value={p.verticalDistortion} onChange={(v) => set({ verticalDistortion: Math.max(-100, Math.min(100, v)) })} unit="%" step={1} />
          <span className="faint">Drag the handles or inside the envelope</span>
          <div style={{ flex: 1 }} />
          <IconButton icon="cancel" title="Cancel (Esc)" onClick={() => cancelTransform()} />
          <IconButton icon="commit" title="Commit (Enter)" onClick={() => commitTransform()} />
        </div>
      );
    }
    return (
      <div className="optionsbar">
        <div className="tool-badge"><Icon name="move" /> {title}</div>
        {n && !n.free && (
          <>
            <NumberField label="X" value={n.x} onChange={(x) => setTransformNumbers({ x })} unit="px" step={1} />
            <NumberField label="Y" value={n.y} onChange={(y) => setTransformNumbers({ y })} unit="px" step={1} />
            <NumberField label="W" value={n.w} onChange={(w) => setTransformNumbers({ w })} unit="%" step={0.1} />
            <NumberField label="H" value={n.h} onChange={(h) => setTransformNumbers({ h })} unit="%" step={0.1} />
            <NumberField label="∠" value={n.angle} onChange={(angle) => setTransformNumbers({ angle })} unit="°" step={0.1} />
            <NumberField label="Skew" value={n.skew} onChange={(skew) => setTransformNumbers({ skew })} unit="°" step={0.1} />
          </>
        )}
        {n?.free && <span className="muted">Distort / perspective active — drag the corners.</span>}
        <span className="faint">Shift: constrain · Alt: from center · Ctrl: distort · Ctrl+Shift: skew · Ctrl+Alt+Shift: perspective</span>
        <button className="btn" title="Switch to Warp mode" onClick={() => setWarpMode()}>Warp</button>
        <div style={{ flex: 1 }} />
        <IconButton icon="cancel" title="Cancel transform (Esc)" onClick={() => cancelTransform()} />
        <IconButton icon="commit" title="Commit transform (Enter)" onClick={() => commitTransform()} />
      </div>
    );
  }

  const te = textEditState();
  const body = (() => {
    switch (tool) {
      case 'move':
        return (
          <>
            <Check label="Auto-Select" checked={o.move.autoSelect} onChange={(v) => ui.setToolOptions('move', { autoSelect: v })} />
            <Select value={o.move.autoSelectTarget} onChange={(v) => ui.setToolOptions('move', { autoSelectTarget: v })} options={[{ value: 'layer', label: 'Layer' }, { value: 'group', label: 'Group' }]} />
            <Check label="Show Transform Controls" checked={o.move.showTransformControls} onChange={(v) => ui.setToolOptions('move', { showTransformControls: v })} />
            <Check label="Snap" checked={o.move.snap} onChange={(v) => ui.setToolOptions('move', { snap: v })} />
            <div className="divider" />
            {(['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'] as const).map((e) => (
              <IconButton key={e} icon={`align${e === 'hcenter' ? 'HCenter' : e === 'vcenter' ? 'VCenter' : e[0].toUpperCase() + e.slice(1)}`} title={`Align ${e}`} onClick={() => run(`layer.align.${e}`)} />
            ))}
            <div className="divider" />
            <button className="btn small" onClick={() => run('layer.distribute.horizontal')}>Distribute H</button>
            <button className="btn small" onClick={() => run('layer.distribute.vertical')}>Distribute V</button>
          </>
        );
      case 'marqueeRect':
      case 'marqueeEllipse':
      case 'marqueeRow':
      case 'marqueeColumn':
      case 'lasso':
      case 'polyLasso':
      case 'magneticLasso':
        return (
          <>
            <Seg value={sel.op} onChange={(v) => setSel({ op: v })} options={selOps} />
            <NumberField label="Feather" value={sel.feather} onChange={(v) => setSel({ feather: v })} min={0} max={1000} unit="px" step={0.5} />
            {tool !== 'marqueeRect' && <Check label="Anti-alias" checked={sel.antiAlias} onChange={(v) => setSel({ antiAlias: v })} />}
            {(tool === 'marqueeRect' || tool === 'marqueeEllipse') && (
              <>
                <Select label="Style" value={sel.style} onChange={(v) => setSel({ style: v })} options={[{ value: 'normal', label: 'Normal' }, { value: 'fixedRatio', label: 'Fixed Ratio' }, { value: 'fixedSize', label: 'Fixed Size' }]} />
                {sel.style === 'fixedRatio' && <><NumberField label="W" value={sel.ratioW} onChange={(v) => setSel({ ratioW: v })} min={0.001} step={0.1} /><NumberField label="H" value={sel.ratioH} onChange={(v) => setSel({ ratioH: v })} min={0.001} step={0.1} /></>}
                {sel.style === 'fixedSize' && <><NumberField label="W" value={sel.fixedW} onChange={(v) => setSel({ fixedW: v })} min={1} unit="px" /><NumberField label="H" value={sel.fixedH} onChange={(v) => setSel({ fixedH: v })} min={1} unit="px" /></>}
              </>
            )}
            {tool === 'magneticLasso' && (
              <>
                <NumberField label="Width" value={sel.width} onChange={(v) => setSel({ width: v })} min={1} max={256} unit="px" />
                <NumberField label="Contrast" value={sel.contrast} onChange={(v) => setSel({ contrast: v })} min={1} max={100} unit="%" />
                <NumberField label="Frequency" value={sel.frequency} onChange={(v) => setSel({ frequency: v })} min={0} max={100} />
              </>
            )}
            <div className="divider" />
            <button className="btn small" onClick={() => run('select.selectAndMask')}>Select and Mask…</button>
          </>
        );
      case 'magicWand':
      case 'quickSelect':
      case 'objectSelect':
        return (
          <>
            <Seg value={sel.op} onChange={(v) => setSel({ op: v })} options={selOps} />
            {tool === 'quickSelect' && <NumberField label="Size" value={sel.brushSize} onChange={(v) => setSel({ brushSize: v })} min={1} max={2000} unit="px" />}
            {tool !== 'objectSelect' && <NumberField label="Tolerance" value={sel.tolerance} onChange={(v) => setSel({ tolerance: v })} min={0} max={255} />}
            {tool === 'magicWand' && <Check label="Anti-alias" checked={sel.antiAlias} onChange={(v) => setSel({ antiAlias: v })} />}
            {tool === 'magicWand' && <Check label="Contiguous" checked={sel.contiguous} onChange={(v) => setSel({ contiguous: v })} />}
            <Check label="Sample All Layers" checked={sel.sampleAllLayers} onChange={(v) => setSel({ sampleAllLayers: v })} />
            <div className="divider" />
            <button className="btn small" onClick={() => run('select.subject')}>Select Subject</button>
            <button className="btn small" onClick={() => run('select.selectAndMask')}>Select and Mask…</button>
          </>
        );
      case 'crop':
        return (
          <>
            <Select label="Ratio" value={o.crop.ratio} onChange={(v) => ui.setToolOptions('crop', { ratio: v })} options={[{ value: 'free', label: 'Ratio (free)' }, { value: 'original', label: 'Original Ratio' }, { value: '1:1', label: '1 : 1 (Square)' }, { value: '4:3', label: '4 : 3' }, { value: '3:2', label: '3 : 2' }, { value: '16:9', label: '16 : 9' }, { value: 'custom', label: 'Custom…' }]} />
            {o.crop.ratio === 'custom' && (
              <>
                <NumberField value={o.crop.customW} onChange={(v) => ui.setToolOptions('crop', { customW: v })} min={0.001} step={1} />
                <span className="muted">×</span>
                <NumberField value={o.crop.customH} onChange={(v) => ui.setToolOptions('crop', { customH: v })} min={0.001} step={1} />
                <Check label="Pixels (W × H)" checked={o.crop.fixedPx} onChange={(v) => ui.setToolOptions('crop', { fixedPx: v })} />
              </>
            )}
            <Select label="Overlay" value={o.crop.overlay} onChange={(v) => ui.setToolOptions('crop', { overlay: v })} options={[{ value: 'thirds', label: 'Rule of Thirds' }, { value: 'grid', label: 'Grid' }, { value: 'none', label: 'None' }]} />
            <Check label="Delete Cropped Pixels" checked={o.crop.deletePixels} onChange={(v) => ui.setToolOptions('crop', { deletePixels: v })} />
            <div style={{ flex: 1 }} />
            <IconButton icon="cancel" title="Cancel crop (Esc)" onClick={() => { const h = editor.hostFactory?.(); if (h) editor.tool('crop')?.cancel?.(h); }} />
            <IconButton icon="commit" title="Commit crop (Enter)" onClick={() => { const h = editor.hostFactory?.(); if (h) editor.tool('crop')?.commit?.(h); }} />
          </>
        );
      case 'slice': {
        const sid = selectedSliceId();
        const sl = s?.doc.slices.find((x) => x.id === sid);
        return (
          <>
            {sl ? <span className="muted">{sl.name}: {sl.rect.x}, {sl.rect.y} · {sl.rect.w}×{sl.rect.h} px</span> : <span className="faint">Drag to create a slice · click to select · Delete removes</span>}
            {sl && <button className="btn small" onClick={() => ui.openDialog('sliceOptions', { id: sl.id })}>Options…</button>}
            <button className="btn small" disabled={!s?.doc.guides.length} onClick={() => run('view.slicesFromGuides')}>Slices From Guides</button>
            <button className="btn small" disabled={!s?.doc.slices.length} onClick={() => run('view.clearSlices')}>Clear Slices</button>
            <div style={{ flex: 1 }} />
            <button className="btn small" onClick={() => run('file.exportSlices')}>Export Slices…</button>
          </>
        );
      }
      case 'perspectiveCrop':
        return (
          <>
            <span className="muted">Drag a box, then move the corners to match the perspective. Enter to apply.</span>
            <div style={{ flex: 1 }} />
            <IconButton icon="cancel" title="Cancel" onClick={() => { const h = editor.hostFactory?.(); if (h) editor.tool('perspectiveCrop')?.cancel?.(h); }} />
            <IconButton icon="commit" title="Apply (Enter)" onClick={() => { const h = editor.hostFactory?.(); if (h) editor.tool('perspectiveCrop')?.commit?.(h); }} />
          </>
        );
      case 'eyedropper':
      case 'colorSampler':
        return (
          <>
            <Select label="Sample Size" value={String(o.eyedropper.sampleSize) as '1'} onChange={(v) => ui.setToolOptions('eyedropper', { sampleSize: Number(v) as 1 })} options={[{ value: '1', label: 'Point Sample' }, { value: '3', label: '3 by 3 Average' }, { value: '5', label: '5 by 5 Average' }, { value: '11', label: '11 by 11 Average' }, { value: '31', label: '31 by 31 Average' }]} />
            <Select label="Sample" value={o.eyedropper.sampleAllLayers ? 'all' : 'current'} onChange={(v) => ui.setToolOptions('eyedropper', { sampleAllLayers: v === 'all' })} options={[{ value: 'current', label: 'Current Layer' }, { value: 'all', label: 'All Layers' }]} />
            {tool === 'colorSampler' && <button className="btn small" onClick={() => ui.set({ samplers: [] })}>Clear All</button>}
          </>
        );
      case 'ruler': {
        const m = useApp.getState().measure;
        const len = m ? Math.hypot(m.x1 - m.x0, m.y1 - m.y0) : 0;
        const ang = m ? (-Math.atan2(m.y1 - m.y0, m.x1 - m.x0) * 180) / Math.PI : 0;
        return (
          <>
            <span className="muted">X: {m?.x0.toFixed(1) ?? '–'}  Y: {m?.y0.toFixed(1) ?? '–'}  W: {m ? (m.x1 - m.x0).toFixed(1) : '–'}  H: {m ? (m.y1 - m.y0).toFixed(1) : '–'}  A: {ang.toFixed(1)}°  L: {len.toFixed(1)} px</span>
            <button className="btn small" disabled={!m} onClick={() => { if (m) import('../app/ops/imageOps').then(({ rotateCanvas }) => rotateCanvas(-(ang > 45 ? ang - 90 : ang < -45 ? ang + 90 : ang))); }}>Straighten</button>
            <button className="btn small" onClick={() => ui.set({ measure: null })}>Clear</button>
          </>
        );
      }
      case 'pluginTool': {
        const list = pluginToolList();
        const t = currentPluginTool();
        if (!t) return <span className="faint">No plugin tools installed. Plugins contributing tools appear here (Edit ▸ Plugins…).</span>;
        return (
          <>
            <Select label="Tool" value={t.fullId} onChange={(v) => setCurrentPluginTool(v)} options={list.map((x) => ({ value: x.fullId, label: x.name }))} />
            <ParamsEditor def={{ params: t.params } as never} params={pluginToolParams(t)} onChange={(p) => setPluginToolParams(t, p)} />
            <div style={{ flex: 1 }} />
            <span className="faint">Runs in the plugin sandbox · one undo step per stroke</span>
          </>
        );
      }
      case 'mixerBrush': {
        const m = o.mixer;
        const set = (p: Partial<typeof m>) => ui.setToolOptions('mixer', p);
        return (
          <>
            <NumberField label="Size" value={brush.size} onChange={(v) => ui.setBrush({ size: v })} min={1} max={5000} unit="px" />
            <NumberField label="Hardness" value={Math.round(brush.hardness * 100)} onChange={(v) => ui.setBrush({ hardness: v / 100 })} min={0} max={100} unit="%" />
            <Check label="Load after stroke" checked={m.loadAfterStroke} onChange={(v) => set({ loadAfterStroke: v })} />
            <Check label="Clean after stroke" checked={m.cleanAfterStroke} onChange={(v) => set({ cleanAfterStroke: v })} />
            <NumberField label="Wet" value={Math.round(m.wet * 100)} onChange={(v) => set({ wet: v / 100 })} min={0} max={100} unit="%" />
            <NumberField label="Load" value={Math.round(m.load * 100)} onChange={(v) => set({ load: v / 100 })} min={1} max={100} unit="%" />
            <NumberField label="Mix" value={Math.round(m.mix * 100)} onChange={(v) => set({ mix: v / 100 })} min={0} max={100} unit="%" />
            <NumberField label="Flow" value={Math.round(brush.flow * 100)} onChange={(v) => ui.setBrush({ flow: v / 100 })} min={1} max={100} unit="%" />
            <Check label="Sample All Layers" checked={m.sampleAllLayers} onChange={(v) => set({ sampleAllLayers: v })} />
          </>
        );
      }
      case 'brush':
      case 'pencil':
      case 'eraser':
      case 'bgEraser':
      case 'colorReplace':
      case 'cloneStamp':
      case 'patternStamp':
      case 'healing':
      case 'spotHealing':
      case 'remove':
      case 'blur':
      case 'sharpen':
      case 'smudge':
      case 'dodge':
      case 'burn':
      case 'sponge':
        return (
          <>
            <NumberField label="Size" value={brush.size} onChange={(v) => ui.setBrush({ size: v })} min={1} max={5000} unit="px" />
            {tool !== 'pencil' && <NumberField label="Hardness" value={Math.round(brush.hardness * 100)} onChange={(v) => ui.setBrush({ hardness: v / 100 })} min={0} max={100} unit="%" />}
            {(tool === 'brush' || tool === 'pencil' || tool === 'cloneStamp' || tool === 'patternStamp') && <><span className="lbl muted">Mode</span><BlendSelect value={brush.blendMode} onChange={(m) => ui.setBrush({ blendMode: m })} width={120} /></>}
            {(tool === 'eraser') && <Select label="Mode" value={o.eraser.mode} onChange={(v) => ui.setToolOptions('eraser', { mode: v })} options={[{ value: 'brush', label: 'Brush' }, { value: 'pencil', label: 'Pencil' }, { value: 'block', label: 'Block' }]} />}
            {['brush', 'pencil', 'eraser', 'cloneStamp', 'patternStamp', 'healing'].includes(tool) && <NumberField label="Opacity" value={Math.round(brush.opacity * 100)} onChange={(v) => ui.setBrush({ opacity: v / 100 })} min={1} max={100} unit="%" />}
            {['brush', 'eraser', 'cloneStamp', 'patternStamp', 'dodge', 'burn'].includes(tool) && <NumberField label="Flow" value={Math.round(brush.flow * 100)} onChange={(v) => ui.setBrush({ flow: v / 100 })} min={1} max={100} unit="%" />}
            {(tool === 'brush' || tool === 'eraser') && <NumberField label="Smoothing" value={Math.round(brush.smoothing * 100)} onChange={(v) => ui.setBrush({ smoothing: v / 100 })} min={0} max={100} unit="%" />}
            {tool === 'brush' && <IconButton icon="brush" title="Airbrush build-up" on={brush.airbrush} onClick={() => ui.setBrush({ airbrush: !brush.airbrush })} />}
            <IconButton icon="pen" title="Pressure controls size" on={brush.dynamics.sizePressure} onClick={() => ui.setBrush({ dynamics: { ...brush.dynamics, sizePressure: !brush.dynamics.sizePressure } })} />
            <IconButton icon="adjust" title="Pressure controls opacity" on={brush.dynamics.opacityPressure} onClick={() => ui.setBrush({ dynamics: { ...brush.dynamics, opacityPressure: !brush.dynamics.opacityPressure } })} />
            {(tool === 'bgEraser' || tool === 'colorReplace') && <NumberField label="Tolerance" value={o.eraser.tolerance} onChange={(v) => ui.setToolOptions('eraser', { tolerance: v })} min={1} max={100} unit="%" />}
            {tool === 'bgEraser' && <Select label="Sampling" value={o.eraser.sampling} onChange={(v) => ui.setToolOptions('eraser', { sampling: v })} options={[{ value: 'continuous', label: 'Continuous' }, { value: 'once', label: 'Once' }, { value: 'background', label: 'Background Swatch' }]} />}
            {tool === 'bgEraser' && <Check label="Protect Foreground" checked={o.eraser.protectForeground} onChange={(v) => ui.setToolOptions('eraser', { protectForeground: v })} />}
            {(tool === 'cloneStamp' || tool === 'healing') && <Check label="Aligned" checked={o.clone.aligned} onChange={(v) => ui.setToolOptions('clone', { aligned: v })} />}
            {(tool === 'cloneStamp' || tool === 'healing') && <Check label="Sample All Layers" checked={o.clone.sampleAllLayers} onChange={(v) => ui.setToolOptions('clone', { sampleAllLayers: v })} />}
            {(tool === 'cloneStamp' || tool === 'healing') && <span className="faint">Alt+click to set source</span>}
            {(tool === 'spotHealing' || tool === 'remove') && <Check label="Sample All Layers" checked={o.retouch.sampleAllLayers} onChange={(v) => ui.setToolOptions('retouch', { sampleAllLayers: v })} />}
            {(tool === 'spotHealing' || tool === 'remove') && <span className="faint">Content-aware (local PatchMatch)</span>}
            {['blur', 'sharpen', 'smudge', 'sponge'].includes(tool) && <NumberField label={tool === 'sponge' ? 'Flow' : 'Strength'} value={Math.round(o.retouch.strength * 100)} onChange={(v) => ui.setToolOptions('retouch', { strength: v / 100 })} min={1} max={100} unit="%" />}
            {(tool === 'dodge' || tool === 'burn') && <Select label="Range" value={o.retouch.range} onChange={(v) => ui.setToolOptions('retouch', { range: v })} options={[{ value: 'shadows', label: 'Shadows' }, { value: 'midtones', label: 'Midtones' }, { value: 'highlights', label: 'Highlights' }]} />}
            {(tool === 'dodge' || tool === 'burn') && <NumberField label="Exposure" value={Math.round(o.retouch.exposure * 100)} onChange={(v) => ui.setToolOptions('retouch', { exposure: v / 100 })} min={1} max={100} unit="%" />}
            {tool === 'sponge' && <Select label="Mode" value={o.retouch.spongeMode} onChange={(v) => ui.setToolOptions('retouch', { spongeMode: v })} options={[{ value: 'desaturate', label: 'Desaturate' }, { value: 'saturate', label: 'Saturate' }]} />}
          </>
        );
      case 'patch':
        return <Select label="Patch" value={o.retouch.patchMode} onChange={(v) => ui.setToolOptions('retouch', { patchMode: v })} options={[{ value: 'source', label: 'Source' }, { value: 'destination', label: 'Destination' }]} />;
      case 'redEye':
        return <><NumberField label="Pupil Size" value={brush.size} onChange={(v) => ui.setBrush({ size: v })} min={2} max={1000} unit="px" /><NumberField label="Darken" value={Math.round(o.retouch.strength * 100)} onChange={(v) => ui.setToolOptions('retouch', { strength: v / 100 })} min={1} max={100} unit="%" /></>;
      case 'magicEraser':
        return (
          <>
            <NumberField label="Tolerance" value={o.eraser.tolerance} onChange={(v) => ui.setToolOptions('eraser', { tolerance: v })} min={0} max={255} />
            <Check label="Contiguous" checked={o.eraser.contiguous} onChange={(v) => ui.setToolOptions('eraser', { contiguous: v })} />
            <Check label="Sample All Layers" checked={o.eraser.sampleAllLayers} onChange={(v) => ui.setToolOptions('eraser', { sampleAllLayers: v })} />
            <NumberField label="Opacity" value={Math.round(brush.opacity * 100)} onChange={(v) => ui.setBrush({ opacity: v / 100 })} min={1} max={100} unit="%" />
          </>
        );
      case 'gradient':
        return (
          <>
            <GradientStrip index={o.gradient.presetIndex} onPick={(i) => ui.setToolOptions('gradient', { presetIndex: i })} />
            <Seg value={o.gradient.type} onChange={(v) => ui.setToolOptions('gradient', { type: v })} options={[{ value: 'linear', label: 'Lin', title: 'Linear' }, { value: 'radial', label: 'Rad', title: 'Radial' }, { value: 'angle', label: 'Ang', title: 'Angle' }, { value: 'reflected', label: 'Ref', title: 'Reflected' }, { value: 'diamond', label: 'Dia', title: 'Diamond' }]} />
            <span className="lbl muted">Mode</span>
            <BlendSelect value={o.gradient.blendMode} onChange={(m) => ui.setToolOptions('gradient', { blendMode: m })} width={110} />
            <NumberField label="Opacity" value={Math.round(o.gradient.opacity * 100)} onChange={(v) => ui.setToolOptions('gradient', { opacity: v / 100 })} min={1} max={100} unit="%" />
            <Check label="Reverse" checked={o.gradient.reverse} onChange={(v) => ui.setToolOptions('gradient', { reverse: v })} />
            <Check label="Dither" checked={o.gradient.dither} onChange={(v) => ui.setToolOptions('gradient', { dither: v })} />
            <Check label="Transparency" checked={o.gradient.transparency} onChange={(v) => ui.setToolOptions('gradient', { transparency: v })} />
          </>
        );
      case 'paintBucket':
        return (
          <>
            <Select value={o.bucket.fill} onChange={(v) => ui.setToolOptions('bucket', { fill: v })} options={[{ value: 'foreground', label: 'Foreground' }, { value: 'pattern', label: 'Pattern' }]} />
            <span className="lbl muted">Mode</span>
            <BlendSelect value={o.bucket.blendMode} onChange={(m) => ui.setToolOptions('bucket', { blendMode: m })} width={110} />
            <NumberField label="Opacity" value={Math.round(o.bucket.opacity * 100)} onChange={(v) => ui.setToolOptions('bucket', { opacity: v / 100 })} min={1} max={100} unit="%" />
            <NumberField label="Tolerance" value={o.bucket.tolerance} onChange={(v) => ui.setToolOptions('bucket', { tolerance: v })} min={0} max={255} />
            <Check label="Anti-alias" checked={o.bucket.antiAlias} onChange={(v) => ui.setToolOptions('bucket', { antiAlias: v })} />
            <Check label="Contiguous" checked={o.bucket.contiguous} onChange={(v) => ui.setToolOptions('bucket', { contiguous: v })} />
            <Check label="All Layers" checked={o.bucket.sampleAllLayers} onChange={(v) => ui.setToolOptions('bucket', { sampleAllLayers: v })} />
          </>
        );
      case 'type': {
        const setType = (p: Partial<typeof o.type>) => {
          ui.setToolOptions('type', p);
          const l = s?.activeLayer();
          if (s && l?.kind === 'text') {
            const style: Record<string, unknown> = {};
            if (p.fontFamily) Object.assign(style, { fontFamily: p.fontFamily, postScriptName: undefined });
            if (p.fontStyleName) Object.assign(style, { fontStyleName: p.fontStyleName, fontWeight: p.fontWeight ?? 400, italic: p.italic ?? false });
            if (p.fontSize) style.fontSize = (p.fontSize * s.doc.canvas.resolution) / 72 / Math.hypot(l.text.transform[0], l.text.transform[1]);
            applyTextStyle(s, l.id, style, p.align ? { align: p.align } : undefined);
          }
        };
        const families = fonts.families.length ? fonts.families : ['Arial', 'Segoe UI', 'Georgia', 'Times New Roman', 'Consolas', 'Verdana'];
        const styles = fonts.stylesOf(o.type.fontFamily);
        return (
          <>
            <Select value={o.type.fontFamily} width={170} onChange={(v) => setType({ fontFamily: v })} options={(families.includes(o.type.fontFamily) ? families : [o.type.fontFamily, ...families]).map((f) => ({ value: f, label: f }))} />
            <Select value={o.type.fontStyleName} width={110} onChange={(v) => { const st = styles.find((x) => x.style === v); setType({ fontStyleName: v, fontWeight: st?.weight ?? 400, italic: st?.italic ?? false }); }} options={styles.map((f) => ({ value: f.style, label: f.style }))} />
            <NumberField value={o.type.fontSize} onChange={(v) => setType({ fontSize: v })} min={0.5} max={1296} unit="pt" step={0.5} />
            <Select value={o.type.antiAlias} onChange={(v) => ui.setToolOptions('type', { antiAlias: v })} options={[{ value: 'none', label: 'None' }, { value: 'sharp', label: 'Sharp' }, { value: 'crisp', label: 'Crisp' }, { value: 'strong', label: 'Strong' }, { value: 'smooth', label: 'Smooth' }]} />
            <Seg value={o.type.align} onChange={(v) => setType({ align: v })} options={[{ value: 'left', icon: 'textLeft', title: 'Left align' }, { value: 'center', icon: 'textCenter', title: 'Center' }, { value: 'right', icon: 'textRight', title: 'Right align' }]} />
            <ColorSwatch color={fg} title="Text color" onClick={() => ui.openDialog('colorPicker', { purpose: 'text' })} />
            {(() => {
              const l = s?.activeLayer();
              const tp = l?.kind === 'text' ? l.text.path : undefined;
              if (!l || !tp) return tool === 'type' && !te ? <span className="faint">Click a path to type on it</span> : null;
              const len = flattenTextPath(tp.subpath)?.length ?? 0;
              return (
                <>
                  <span className="lbl muted">On path</span>
                  <NumberField label="Start" value={Math.round(tp.start)} onChange={(v) => setTextPath(l.id, { start: Math.max(0, Math.min(len, v)) }, 'Move Path Text Start')} min={0} max={Math.round(len)} unit="px" />
                  <NumberField label="End" value={Math.round(tp.end ?? len)} onChange={(v) => setTextPath(l.id, { end: Math.max(0, Math.min(len, v)) }, 'Move Path Text End')} min={0} max={Math.round(len)} unit="px" />
                  <Check label="Flip" checked={tp.flip} onChange={(v) => setTextPath(l.id, { flip: v }, 'Flip Text on Path')} />
                  <button className="btn small" onClick={() => setTextPath(l.id, null, 'Detach Text from Path')}>Detach</button>
                </>
              );
            })()}
            {te && (
              <>
                <div style={{ flex: 1 }} />
                <IconButton icon="cancel" title="Cancel edits (discard)" onClick={() => cancelTextEdit()} />
                <IconButton icon="commit" title="Commit (Esc / Ctrl+Enter)" onClick={() => commitTextEdit()} />
              </>
            )}
          </>
        );
      }
      case 'rectangle':
      case 'ellipse':
      case 'polygon':
      case 'line':
      case 'customShape':
        return (
          <>
            <Select value={o.shape.mode} onChange={(v) => ui.setToolOptions('shape', { mode: v })} options={[{ value: 'shape', label: 'Shape' }, { value: 'path', label: 'Path' }, { value: 'pixels', label: 'Pixels' }]} />
            <span className="lbl muted">Fill</span>
            <ColorSwatch color={fg} title="Fill color (foreground)" onClick={() => ui.openDialog('colorPicker', { purpose: 'foreground' })} />
            <NumberField label="Stroke" value={o.shape.strokeWidth} onChange={(v) => ui.setToolOptions('shape', { strokeWidth: v })} min={0} max={288} unit="px" step={0.5} />
            {tool === 'rectangle' && <NumberField label="Radius" value={o.shape.radius} onChange={(v) => ui.setToolOptions('shape', { radius: v })} min={0} max={10000} unit="px" />}
            {tool === 'polygon' && <><NumberField label="Sides" value={o.shape.sides} onChange={(v) => ui.setToolOptions('shape', { sides: v })} min={3} max={100} /><Check label="Star" checked={o.shape.star} onChange={(v) => ui.setToolOptions('shape', { star: v })} />{o.shape.star && <NumberField label="Indent" value={Math.round(o.shape.starRatio * 100)} onChange={(v) => ui.setToolOptions('shape', { starRatio: v / 100 })} min={1} max={99} unit="%" />}</>}
            {tool === 'line' && <NumberField label="Weight" value={o.shape.lineWeight} onChange={(v) => ui.setToolOptions('shape', { lineWeight: v })} min={0.5} max={1000} unit="px" step={0.5} />}
            {tool === 'customShape' && <Select label="Shape" value={o.shape.customShape} onChange={(v) => ui.setToolOptions('shape', { customShape: v })} options={CUSTOM_SHAPES.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }))} />}
            <span className="faint">Shift: constrain · Alt: from center</span>
          </>
        );
      case 'pen':
      case 'freeformPen':
        return (
          <>
            <Select value={o.pen.mode} onChange={(v) => ui.setToolOptions('pen', { mode: v })} options={[{ value: 'path', label: 'Path' }, { value: 'shape', label: 'Shape' }]} />
            <span className="faint">Click: corner · Drag: curve · Alt-drag: break handles · Click first point to close · Enter to finish</span>
          </>
        );
      case 'zoom':
      case 'hand':
      case 'rotateView':
        return (
          <>
            {tool === 'zoom' && <Check label="Scrubby Zoom" checked={o.zoom.scrubby} onChange={(v) => ui.setToolOptions('zoom', { scrubby: v })} />}
            <button className="btn small" onClick={() => run('view.100')}>100%</button>
            <button className="btn small" onClick={() => run('view.fit')}>Fit Screen</button>
            <button className="btn small" onClick={() => run('view.fill')}>Fill Screen</button>
            {tool === 'rotateView' && <button className="btn small" onClick={() => run('view.resetRotation')}>Reset View</button>}
          </>
        );
      default:
        return <span className="muted">{info.comingSoon ? 'Coming Soon' : ''}</span>;
    }
  })();
  return (
    <div className="optionsbar">
      <div className="tool-badge"><Icon name={tool} /> {info.label.replace(/ Tool$/, '')}</div>
      {body}
    </div>
  );
}

export { Slider };
