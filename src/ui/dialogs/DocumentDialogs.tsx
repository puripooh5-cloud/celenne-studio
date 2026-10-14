/** New Document, Image Size, Canvas Size, Rotate, Trim, Fill, Stroke, selection & guide dialogs. */
import { workingCmykProfile } from '../../app/colorSettings';
import { useState } from 'react';
import { Modal } from './Modal';
import { Check, NumberField, Select, BlendSelect, ColorSwatch } from '../controls';
import { newDocument, untitledName } from '../../app/fileOps';
import { editor } from '../../app/editor';
import { ui, useApp } from '../../app/store';
import { imageSize, canvasSize, rotateCanvas, trim, Anchor } from '../../app/ops/imageOps';
import { fill, strokeSelection, FillSpec, generativeExpand } from '../../app/ops/editOps';
import { aiProvider } from '../../ai/provider';
import { updateSlice } from '../../app/ops/sliceOps';
import { modify, loadChannelAsSelection } from '../../app/ops/selectOps';
import { addGuide, addGuideLayout, guideLayoutPositions, GuideLayoutSpec, zoomTo } from '../../app/ops/viewOps';
import type { BitDepth } from '../../image-engine/pixels';
import type { BlendMode } from '../../image-engine/blend';
import type { RGB } from '../../color/types';
import { BUILTIN_PROFILES, BuiltinProfileId } from '../../color/icc';
import type { SelectionOp } from '../../selection/selection';

type Unit = 'px' | 'in' | 'cm' | 'mm';
const toPx = (v: number, u: Unit, res: number) => (u === 'px' ? v : u === 'in' ? v * res : u === 'cm' ? (v * res) / 2.54 : (v * res) / 25.4);
const fromPx = (v: number, u: Unit, res: number) => (u === 'px' ? v : u === 'in' ? v / res : u === 'cm' ? (v / res) * 2.54 : (v / res) * 25.4);

const PRESETS = [
  { name: 'Default (1920 × 1080)', w: 1920, h: 1080, res: 72 },
  { name: 'Web Large (2560 × 1440)', w: 2560, h: 1440, res: 72 },
  { name: '4K UHD (3840 × 2160)', w: 3840, h: 2160, res: 72 },
  { name: '8K UHD (7680 × 4320)', w: 7680, h: 4320, res: 72 },
  { name: 'Square Social (1080 × 1080)', w: 1080, h: 1080, res: 72 },
  { name: 'Story (1080 × 1920)', w: 1080, h: 1920, res: 72 },
  { name: 'A4 @ 300 ppi', w: 2480, h: 3508, res: 300 },
  { name: 'US Letter @ 300 ppi', w: 2550, h: 3300, res: 300 },
  { name: 'Postcard 6×4 in @ 300', w: 1800, h: 1200, res: 300 },
  { name: 'Large Print 16K (16384 × 16384)', w: 16384, h: 16384, res: 300 },
];

export function NewDocumentDialog({ close }: { close: () => void }) {
  const [name, setName] = useState(untitledName());
  const [w, setW] = useState(1920);
  const [h, setH] = useState(1080);
  const [res, setRes] = useState(72);
  const [unit, setUnit] = useState<Unit>('px');
  const [mode, setMode] = useState<'rgb' | 'grayscale' | 'cmyk' | 'lab'>('rgb');
  const [depth, setDepth] = useState<BitDepth>(8);
  const [bg, setBg] = useState<'white' | 'black' | 'transparent' | 'background'>('white');
  const [profile, setProfile] = useState<BuiltinProfileId>(editor.prefs.color.workingRGB);
  const bytes = w * h * 4 * (depth / 8);
  const ok = () => {
    close();
    // CMYK and Lab are 8 or 16 bits/channel.
    const d: BitDepth = (mode === 'cmyk' || mode === 'lab') && depth === 32 ? 16 : depth;
    newDocument({ name, width: Math.round(w), height: Math.round(h), resolution: res, colorMode: mode, bitDepth: d, background: bg, profile: mode === 'grayscale' ? 'gray22' : mode === 'cmyk' ? workingCmykProfile() : profile });
  };
  return (
    <Modal title="New Document" onClose={close} onOk={ok} okLabel="Create" width={560} footerLeft={<span className="faint">Image size: {(bytes / 1048576).toFixed(1)} MB</span>}>
      <div className="grid2">
        <span className="lbl">Name</span><input className="txt" value={name} onChange={(e) => setName(e.target.value)} />
        <span className="lbl">Preset</span>
        <Select value="" onChange={(v) => { const p = PRESETS[Number(v)]; if (p) { setW(p.w); setH(p.h); setRes(p.res); } }} options={[{ value: '' as string, label: 'Choose a preset…' }, ...PRESETS.map((p, i) => ({ value: String(i), label: p.name }))]} />
        <span className="lbl">Width</span>
        <div className="row"><NumberField value={fromPx(w, unit, res)} onChange={(v) => setW(Math.max(1, Math.min(300000, toPx(v, unit, res))))} step={unit === 'px' ? 1 : 0.01} width={90} /><Select value={unit} onChange={setUnit} options={[{ value: 'px', label: 'Pixels' }, { value: 'in', label: 'Inches' }, { value: 'cm', label: 'Centimeters' }, { value: 'mm', label: 'Millimeters' }]} /></div>
        <span className="lbl">Height</span>
        <div className="row"><NumberField value={fromPx(h, unit, res)} onChange={(v) => setH(Math.max(1, Math.min(300000, toPx(v, unit, res))))} step={unit === 'px' ? 1 : 0.01} width={90} /><button className="btn small" onClick={() => { setW(h); setH(w); }}>⇄ Swap</button></div>
        <span className="lbl">Resolution</span><NumberField value={res} onChange={(v) => setRes(Math.max(1, v))} unit="ppi" width={90} />
        <span className="lbl">Color Mode</span>
        <div className="row">
          <Select value={mode} onChange={setMode} options={[{ value: 'rgb', label: 'RGB Color' }, { value: 'grayscale', label: 'Grayscale' }, { value: 'cmyk', label: 'CMYK Color' }, { value: 'lab', label: 'Lab Color' }]} />
          <Select value={String(depth) as '8'} onChange={(v) => setDepth(Number(v) as BitDepth)} options={[{ value: '8', label: '8 bit' }, { value: '16', label: '16 bit' }, { value: '32', label: '32 bit (float)', disabled: mode === 'cmyk' || mode === 'lab' }]} />
        </div>
        <span className="lbl">Background</span>
        <Select value={bg} onChange={setBg} options={[{ value: 'white', label: 'White' }, { value: 'black', label: 'Black' }, { value: 'background', label: 'Background Color' }, { value: 'transparent', label: 'Transparent' }]} />
        <span className="lbl">Color Profile</span>
        {mode === 'cmyk' ? <span>{workingCmykProfile().name} <span className="faint">(working CMYK — Preferences ▸ Color Management)</span></span>
          : mode === 'lab' ? <span>Lab Color (D50)</span>
            : <Select value={profile} onChange={setProfile} options={BUILTIN_PROFILES.filter((p) => (mode === 'rgb' ? p.space === 'RGB' : p.space === 'GRAY')).map((p) => ({ value: p.id, label: p.name }))} />}
      </div>
      {(w > 30000 || h > 30000) && <div className="tag warn">Documents larger than 30,000 px are saved as PSB (Large Document Format).</div>}
    </Modal>
  );
}

export function ImageSizeDialog({ close }: { close: () => void }) {
  const s = editor.active!;
  const d = s.doc;
  const [w, setW] = useState(d.width);
  const [h, setH] = useState(d.height);
  const [res, setRes] = useState(d.canvas.resolution);
  const [constrain, setConstrain] = useState(true);
  const [resample, setResample] = useState<'bicubic' | 'bilinear' | 'nearest' | 'none'>('bicubic');
  const [scaleStyles, setScaleStyles] = useState(true);
  const ratio = d.width / d.height;
  const setWidth = (v: number) => { setW(Math.round(v)); if (constrain) setH(Math.max(1, Math.round(v / ratio))); };
  const setHeight = (v: number) => { setH(Math.round(v)); if (constrain) setW(Math.max(1, Math.round(v * ratio))); };
  const noResample = resample === 'none';
  return (
    <Modal title="Image Size" onClose={close} onOk={() => { close(); imageSize(noResample ? d.width : w, noResample ? d.height : h, res, noResample ? null : resample, scaleStyles); }} width={420}
      footerLeft={<span className="faint">{d.width}×{d.height} → {noResample ? `${d.width}×${d.height}` : `${w}×${h}`} px</span>}>
      <div className="grid2">
        <span className="lbl">Width</span><div className="row"><NumberField value={w} onChange={setWidth} min={1} max={300000} unit="px" width={80} disabled={noResample} /><NumberField value={Math.round((w / d.width) * 1000) / 10} onChange={(p) => setWidth((d.width * p) / 100)} unit="%" width={60} disabled={noResample} /></div>
        <span className="lbl">Height</span><div className="row"><NumberField value={h} onChange={setHeight} min={1} max={300000} unit="px" width={80} disabled={noResample} /><NumberField value={Math.round((h / d.height) * 1000) / 10} onChange={(p) => setHeight((d.height * p) / 100)} unit="%" width={60} disabled={noResample} /></div>
        <span className="lbl">Resolution</span><NumberField value={res} onChange={(v) => { if (noResample) { setRes(v); } else setRes(v); }} min={1} unit="ppi" width={80} />
        <span className="lbl" />
        <div className="row wrap"><Check label="Constrain proportions" checked={constrain} onChange={setConstrain} /><Check label="Scale styles" checked={scaleStyles} onChange={setScaleStyles} /></div>
        <span className="lbl">Resample</span>
        <Select value={resample} onChange={setResample} options={[{ value: 'bicubic', label: 'Bicubic (smooth gradients)' }, { value: 'bilinear', label: 'Bilinear' }, { value: 'nearest', label: 'Nearest Neighbor (hard edges)' }, { value: 'none', label: 'Off (change resolution only)' }]} />
      </div>
      {noResample && <div className="faint">Print size changes to {(d.width / res).toFixed(2)} × {(d.height / res).toFixed(2)} in; pixels are unchanged.</div>}
    </Modal>
  );
}

const ANCHORS: Anchor[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];

export function CanvasSizeDialog({ close }: { close: () => void }) {
  const s = editor.active!;
  const d = s.doc;
  const [relative, setRelative] = useState(false);
  const [w, setW] = useState(d.width);
  const [h, setH] = useState(d.height);
  const [anchor, setAnchor] = useState<Anchor>('c');
  const [ext, setExt] = useState<'background' | 'foreground' | 'white' | 'black'>('background');
  const st = useApp.getState();
  const color = ext === 'background' ? st.bg : ext === 'foreground' ? st.fg : ext === 'white' ? { r: 1, g: 1, b: 1 } : { r: 0, g: 0, b: 0 };
  const W = relative ? d.width + w : w, H = relative ? d.height + h : h;
  return (
    <Modal title="Canvas Size" onClose={close} onOk={() => { close(); canvasSize(Math.max(1, Math.round(W)), Math.max(1, Math.round(H)), anchor, color); }} width={400}
      footerLeft={<span className="faint">Current: {d.width}×{d.height} px · New: {W}×{H} px</span>}>
      <div className="grid2">
        <span className="lbl">Width</span><NumberField value={w} onChange={(v) => setW(Math.round(v))} unit="px" width={90} />
        <span className="lbl">Height</span><NumberField value={h} onChange={(v) => setH(Math.round(v))} unit="px" width={90} />
        <span className="lbl" /><Check label="Relative" checked={relative} onChange={(v) => { setRelative(v); setW(v ? 0 : d.width); setH(v ? 0 : d.height); }} />
        <span className="lbl">Anchor</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 26px)', gap: 2 }}>
          {ANCHORS.map((a) => <button key={a} className={`icon-btn${a === anchor ? ' on' : ''}`} style={{ border: '1px solid var(--border)', width: 26, height: 22 }} title={a} onClick={() => setAnchor(a)}>{a === anchor ? '●' : '·'}</button>)}
        </div>
        <span className="lbl">Extension color</span>
        <div className="row"><Select value={ext} onChange={setExt} options={[{ value: 'background', label: 'Background' }, { value: 'foreground', label: 'Foreground' }, { value: 'white', label: 'White' }, { value: 'black', label: 'Black' }]} /><ColorSwatch color={color} /></div>
      </div>
      <div className="faint">Pixels outside the new canvas are kept (non-destructive) and can be revealed later.</div>
    </Modal>
  );
}

export function GenerativeExpandDialog({ close }: { close: () => void }) {
  const d = editor.active!.doc;
  const [w, setW] = useState(Math.round(d.width * 1.25));
  const [h, setH] = useState(d.height);
  const [anchor, setAnchor] = useState<Anchor>('c');
  const [prompt, setPrompt] = useState('');
  const provider = aiProvider();
  const generative = provider.capabilities().generativeExpand;
  return (
    <Modal title="Generative Expand" width={420} okLabel={generative ? 'Generate' : 'Expand'} okDisabled={w < d.width || h < d.height || (w === d.width && h === d.height)}
      onClose={close} onOk={() => { close(); void generativeExpand(Math.round(w), Math.round(h), anchor, prompt.trim() || undefined); }}
      footerLeft={<span className="faint">{d.width}×{d.height} → {Math.round(w)}×{Math.round(h)} px</span>}>
      <div className="grid2">
        <span className="lbl">Width</span><NumberField value={w} min={d.width} onChange={(v) => setW(Math.round(v))} unit="px" width={90} />
        <span className="lbl">Height</span><NumberField value={h} min={d.height} onChange={(v) => setH(Math.round(v))} unit="px" width={90} />
        <span className="lbl">Anchor</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 26px)', gap: 2 }}>
          {ANCHORS.map((a) => <button key={a} className={`icon-btn${a === anchor ? ' on' : ''}`} style={{ border: '1px solid var(--border)', width: 26, height: 22 }} title={a} onClick={() => setAnchor(a)}>{a === anchor ? '●' : '·'}</button>)}
        </div>
        <span className="lbl">Prompt</span>
        <input className="txt" value={prompt} placeholder={generative ? 'Optional: describe the new area' : 'Not used by the local provider'} disabled={!generative} onChange={(e) => setPrompt(e.target.value)} />
      </div>
      <div className="faint">
        {generative
          ? `The new area is generated by "${provider.label}" on a new layer.`
          : `"${provider.label}" has no generative model: the new area is filled content-aware from the image, on a new layer. Configure a Cloud endpoint or plugin model in Preferences ▸ AI for prompt-based expansion.`}
      </div>
    </Modal>
  );
}

export function RotateCanvasDialog({ close }: { close: () => void }) {
  const [deg, setDeg] = useState(15);
  const [cw, setCw] = useState(true);
  return (
    <Modal title="Rotate Canvas" onClose={close} onOk={() => { close(); rotateCanvas(cw ? deg : -deg); }}>
      <div className="row"><NumberField label="Angle" value={deg} onChange={setDeg} min={-359.99} max={359.99} step={0.01} unit="°" /><Select value={cw ? 'cw' : 'ccw'} onChange={(v) => setCw(v === 'cw')} options={[{ value: 'cw', label: 'Clockwise' }, { value: 'ccw', label: 'Counter-clockwise' }]} /></div>
    </Modal>
  );
}

export function TrimDialog({ close }: { close: () => void }) {
  const [basedOn, setBased] = useState<'transparent' | 'topLeft' | 'bottomRight'>('transparent');
  return (
    <Modal title="Trim" onClose={close} onOk={() => { close(); trim(basedOn); }}>
      <Select label="Based on" value={basedOn} onChange={setBased} options={[{ value: 'transparent', label: 'Transparent Pixels' }, { value: 'topLeft', label: 'Top Left Pixel Color' }, { value: 'bottomRight', label: 'Bottom Right Pixel Color' }]} />
    </Modal>
  );
}

export function FillDialog({ close }: { close: () => void }) {
  const [use, setUse] = useState<FillSpec['use']>('foreground');
  const [mode, setMode] = useState<BlendMode>('normal');
  const [opacity, setOpacity] = useState(100);
  const [preserve, setPreserve] = useState(false);
  const [pattern, setPattern] = useState<string>([...(editor.active?.doc.patterns.keys() ?? [])][0] ?? '');
  const patterns = [...(editor.active?.doc.patterns.values() ?? [])];
  return (
    <Modal title="Fill" onClose={close} onOk={() => { close(); fill({ use, mode, opacity: opacity / 100, preserveTransparency: preserve, patternId: pattern }); }}>
      <Select label="Contents" value={use} onChange={setUse} options={[{ value: 'foreground', label: 'Foreground Color' }, { value: 'background', label: 'Background Color' }, { value: 'contentAware', label: 'Content-Aware' }, { value: 'pattern', label: 'Pattern' }, { value: 'black', label: 'Black' }, { value: 'gray', label: '50% Gray' }, { value: 'white', label: 'White' }]} />
      {use === 'pattern' && <Select label="Pattern" value={pattern} onChange={setPattern} options={patterns.length ? patterns.map((p) => ({ value: p.id, label: p.name })) : [{ value: '', label: '(Define a pattern first)' }]} />}
      {use !== 'contentAware' && (
        <>
          <div className="row"><span className="lbl muted">Mode</span><BlendSelect value={mode} onChange={setMode} /></div>
          <NumberField label="Opacity" value={opacity} onChange={setOpacity} min={1} max={100} unit="%" />
          <Check label="Preserve Transparency" checked={preserve} onChange={setPreserve} />
        </>
      )}
    </Modal>
  );
}

export function StrokeDialog({ close }: { close: () => void }) {
  const [width, setWidth] = useState(4);
  const [color, setColor] = useState<RGB>(useApp.getState().fg);
  const [loc, setLoc] = useState<'inside' | 'center' | 'outside'>('center');
  const [mode, setMode] = useState<BlendMode>('normal');
  const [opacity, setOpacity] = useState(100);
  return (
    <Modal title="Stroke" onClose={close} onOk={() => { close(); strokeSelection(width, color, loc, mode, opacity / 100); }}>
      <div className="row"><NumberField label="Width" value={width} onChange={setWidth} min={1} max={250} unit="px" /><ColorSwatch color={color} onClick={() => ui.openDialog('colorPicker', { purpose: 'callback', initial: color, onPick: setColor })} /></div>
      <Select label="Location" value={loc} onChange={setLoc} options={[{ value: 'inside', label: 'Inside' }, { value: 'center', label: 'Center' }, { value: 'outside', label: 'Outside' }]} />
      <div className="row"><span className="lbl muted">Mode</span><BlendSelect value={mode} onChange={setMode} /></div>
      <NumberField label="Opacity" value={opacity} onChange={setOpacity} min={1} max={100} unit="%" />
    </Modal>
  );
}

export function ModifySelectionDialog({ close, kind }: { close: () => void; kind: 'feather' | 'expand' | 'contract' | 'smooth' | 'border' }) {
  const [v, setV] = useState(kind === 'feather' ? 10 : kind === 'border' ? 8 : 4);
  const labels = { feather: 'Feather Radius', expand: 'Expand By', contract: 'Contract By', smooth: 'Sample Radius', border: 'Width' };
  return (
    <Modal title={`${kind[0].toUpperCase()}${kind.slice(1)} Selection`} onClose={close} onOk={() => { close(); modify(kind, v); }}>
      <NumberField label={labels[kind]} value={v} onChange={setV} min={kind === 'feather' ? 0.1 : 1} max={1000} step={kind === 'feather' ? 0.1 : 1} unit="px" />
    </Modal>
  );
}

export function NewGuideDialog({ close }: { close: () => void }) {
  const [o, setO] = useState<'horizontal' | 'vertical'>('vertical');
  const [pos, setPos] = useState(0);
  return (
    <Modal title="New Guide" onClose={close} onOk={() => { close(); addGuide(o, pos); }}>
      <Select label="Orientation" value={o} onChange={setO} options={[{ value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical' }]} />
      <NumberField label="Position" value={pos} onChange={setPos} unit="px" />
    </Modal>
  );
}

export function NewGuideLayoutDialog({ close }: { close: () => void }) {
  const [spec, setSpec] = useState<GuideLayoutSpec>({
    columns: { enabled: true, number: 8, width: null, gutter: 20 },
    rows: { enabled: false, number: 1, height: null, gutter: 0 },
    margin: { enabled: false, top: 0, left: 0, bottom: 0, right: 0 },
    centerColumns: false,
    clearExisting: false,
  });
  const set = <K extends keyof GuideLayoutSpec>(k: K, v: Partial<GuideLayoutSpec[K]> | GuideLayoutSpec[K]) => setSpec((p) => ({ ...p, [k]: typeof v === 'object' ? { ...(p[k] as object), ...v } : v }));
  const doc = editor.active?.doc;
  const n = doc ? guideLayoutPositions(spec, doc.width, doc.height).length : 0;
  return (
    <Modal title="New Guide Layout" width={420} onClose={close} onOk={() => { close(); addGuideLayout(spec); }} footerLeft={<span className="faint">{n} guide{n === 1 ? '' : 's'}</span>}>
      <Check label="Columns" checked={spec.columns.enabled} onChange={(v) => set('columns', { enabled: v })} />
      {spec.columns.enabled && (
        <div className="row wrap">
          <NumberField label="Number" value={spec.columns.number} min={1} max={1000} onChange={(v) => set('columns', { number: v })} />
          <NumberField label="Width" value={spec.columns.width ?? 0} min={0} unit="px" title="0 = fill the available width" onChange={(v) => set('columns', { width: v > 0 ? v : null })} />
          <NumberField label="Gutter" value={spec.columns.gutter} min={0} unit="px" onChange={(v) => set('columns', { gutter: v })} />
        </div>
      )}
      <Check label="Rows" checked={spec.rows.enabled} onChange={(v) => set('rows', { enabled: v })} />
      {spec.rows.enabled && (
        <div className="row wrap">
          <NumberField label="Number" value={spec.rows.number} min={1} max={1000} onChange={(v) => set('rows', { number: v })} />
          <NumberField label="Height" value={spec.rows.height ?? 0} min={0} unit="px" title="0 = fill the available height" onChange={(v) => set('rows', { height: v > 0 ? v : null })} />
          <NumberField label="Gutter" value={spec.rows.gutter} min={0} unit="px" onChange={(v) => set('rows', { gutter: v })} />
        </div>
      )}
      <Check label="Margin" checked={spec.margin.enabled} onChange={(v) => set('margin', { enabled: v })} />
      {spec.margin.enabled && (
        <div className="row wrap">
          <NumberField label="Top" value={spec.margin.top} unit="px" onChange={(v) => set('margin', { top: v })} />
          <NumberField label="Left" value={spec.margin.left} unit="px" onChange={(v) => set('margin', { left: v })} />
          <NumberField label="Bottom" value={spec.margin.bottom} unit="px" onChange={(v) => set('margin', { bottom: v })} />
          <NumberField label="Right" value={spec.margin.right} unit="px" onChange={(v) => set('margin', { right: v })} />
        </div>
      )}
      <Check label="Center Columns" checked={spec.centerColumns} onChange={(v) => set('centerColumns', v)} />
      <Check label="Clear Existing Guides" checked={spec.clearExisting} onChange={(v) => set('clearExisting', v)} />
    </Modal>
  );
}

export function CustomZoomDialog({ close }: { close: () => void }) {
  const [z, setZ] = useState(Math.round((editor.active?.view.zoom ?? 1) * 1000) / 10);
  return (
    <Modal title="Custom Zoom" onClose={close} onOk={() => { close(); zoomTo(z / 100); }}>
      <NumberField label="Zoom" value={z} onChange={setZ} min={1} max={12800} unit="%" step={0.1} />
    </Modal>
  );
}

export function LoadSelectionDialog({ close }: { close: () => void }) {
  const chans = editor.active?.doc.channels ?? [];
  const [ch, setCh] = useState(chans[0]?.id ?? '');
  const [op, setOp] = useState<SelectionOp>('replace');
  const [inv, setInv] = useState(false);
  return (
    <Modal title="Load Selection" onClose={close} onOk={() => { close(); loadChannelAsSelection(ch, op, inv); }} okDisabled={!ch}>
      <Select label="Channel" value={ch} onChange={setCh} options={chans.map((c) => ({ value: c.id, label: c.name }))} />
      <Check label="Invert" checked={inv} onChange={setInv} />
      <Select label="Operation" value={op} onChange={setOp} options={[{ value: 'replace', label: 'New Selection' }, { value: 'add', label: 'Add to Selection' }, { value: 'subtract', label: 'Subtract from Selection' }, { value: 'intersect', label: 'Intersect with Selection' }]} />
    </Modal>
  );
}

export function PromptDialog({ close, title, value, label, resolve }: { close: () => void; title: string; value: string; label: string; resolve: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  return (
    <Modal title={title} onClose={() => { close(); resolve(null); }} onOk={() => { close(); resolve(v.trim() || null); }}>
      <label className="field"><span className="lbl">{label}</span><input className="txt" style={{ width: 260 }} value={v} onChange={(e) => setV(e.target.value)} /></label>
    </Modal>
  );
}

export function SaveCompatDialog({ close, notes, resolve }: { close: () => void; notes: string[]; resolve: (ok: boolean) => void }) {
  return (
    <Modal title="Photoshop Compatibility" onClose={() => { close(); resolve(false); }} onOk={() => { close(); resolve(true); }} okLabel="Save" width={520}>
      <div>Some features cannot be represented exactly in the PSD file:</div>
      <ul className="notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      <div className="faint">Layers are never flattened. All other structure is written as-is, and data Celenne does not edit is preserved byte-for-byte.</div>
    </Modal>
  );
}

export function SliceOptionsDialog({ close, id }: { close: () => void; id: string }) {
  const sl = editor.active?.doc.slices.find((x) => x.id === id);
  const [v, setV] = useState(() => ({ name: sl?.name ?? '', url: sl?.url ?? '', target: sl?.target ?? '', altTag: sl?.altTag ?? '', message: sl?.message ?? '', ...sl?.rect ?? { x: 0, y: 0, w: 1, h: 1 } }));
  if (!sl) { close(); return null; }
  const set = (p: Partial<typeof v>) => setV((o) => ({ ...o, ...p }));
  const ok = () => {
    close();
    updateSlice(id, { name: v.name.trim() || sl.name, url: v.url || undefined, target: v.target || undefined, altTag: v.altTag || undefined, message: v.message || undefined, rect: { x: v.x, y: v.y, w: Math.max(1, v.w), h: Math.max(1, v.h) } }, 'Slice Options');
  };
  const txt = (label: string, k: 'name' | 'url' | 'target' | 'altTag' | 'message') => (
    <label className="field"><span className="lbl">{label}</span><input className="txt" style={{ width: 240 }} value={v[k]} onChange={(e) => set({ [k]: e.target.value })} /></label>
  );
  return (
    <Modal title="Slice Options" width={420} onClose={close} onOk={ok}>
      {txt('Name', 'name')}
      {txt('URL', 'url')}
      {txt('Target', 'target')}
      {txt('Alt Tag', 'altTag')}
      {txt('Message Text', 'message')}
      <div className="row wrap">
        <NumberField label="X" value={v.x} onChange={(x) => set({ x: Math.round(x) })} unit="px" />
        <NumberField label="Y" value={v.y} onChange={(y) => set({ y: Math.round(y) })} unit="px" />
        <NumberField label="W" value={v.w} min={1} onChange={(w) => set({ w: Math.round(w) })} unit="px" />
        <NumberField label="H" value={v.h} min={1} onChange={(h) => set({ h: Math.round(h) })} unit="px" />
      </div>
    </Modal>
  );
}
