/** Image ▸ Mode dialogs: Indexed Color, Bitmap, Color Table and Duotone. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Check, ColorSwatch, NumberField, Select, Slider } from '../controls';
import { ui } from '../../app/store';
import { LambdaCommand } from '../../commands/layerCommands';
import type { RGB } from '../../color/types';
import { defaultDuotone, duotoneColor, DUOTONE_CURVE_X, editedDuotone, effectiveOverprints, overprintLabel, overprintSets, remapOverprints, type DuotoneSpec } from '../../color/inks';
import { editor } from '../../app/editor';
import { flattenToPixels } from '../../rendering/flatten';
import { buildPalette, quantize, toBitmap, DEFAULT_BITMAP, DEFAULT_INDEXED, BitmapOptions, IndexedOptions, PaletteMethod, IndexedDither, ForcedColors, BitmapMethod, HalftoneShape } from '../../color/indexed';
import { convertToBitmap, convertToIndexed, previewDuotone, setColorTable, setDuotone } from '../../app/ops/modeOps';

const PREVIEW = 200;

/** A 1:1 crop from the centre of the flattened document (8-bit straight RGBA). */
function useCenterCrop(): { w: number; h: number; data: Uint8ClampedArray } | null {
  return useMemo(() => {
    const s = editor.active;
    if (!s) return null;
    const d = s.doc;
    const w = Math.min(PREVIEW, d.width), h = Math.min(PREVIEW, d.height);
    const region = { x: Math.floor((d.width - w) / 2), y: Math.floor((d.height - h) / 2), w, h };
    const f = flattenToPixels(d, { depth: 8, region });
    return { w, h, data: f.data as Uint8ClampedArray };
  }, []);
}

function PreviewCanvas({ img, label }: { img: { w: number; h: number; data: Uint8ClampedArray } | null; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !img) return;
    c.width = img.w;
    c.height = img.h;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
  }, [img]);
  return (
    <div style={{ textAlign: 'center' }}>
      <canvas ref={ref} className="checker" style={{ width: 170, height: 170, objectFit: 'contain', imageRendering: 'pixelated', border: '1px solid var(--border)' }} />
      <div className="faint">{label}</div>
    </div>
  );
}

export function IndexedColorDialog({ close }: { close: () => void }) {
  const s = editor.active!;
  const [o, setO] = useState<IndexedOptions>({ ...DEFAULT_INDEXED });
  const set = (p: Partial<IndexedOptions>) => setO((x) => ({ ...x, ...p }));
  const crop = useCenterCrop();
  // Palette from the whole image (downsampled for speed), applied to the 1:1 preview crop.
  const sample = useMemo(() => {
    const d = s.doc;
    const f = flattenToPixels(d, { depth: 8 }).data as Uint8ClampedArray;
    const step = Math.max(1, Math.floor(Math.sqrt((d.width * d.height) / 400_000)));
    if (step === 1) return f;
    const out: number[] = [];
    for (let y = 0; y < d.height; y += step) for (let x = 0; x < d.width; x += step) { const i = (y * d.width + x) * 4; out.push(f[i], f[i + 1], f[i + 2], f[i + 3]); }
    return new Uint8ClampedArray(out);
  }, [s]);
  const pal = useMemo(() => buildPalette(sample, o), [sample, o]);
  const after = useMemo(() => {
    if (!crop) return null;
    const data = new Uint8ClampedArray(crop.data);
    quantize(data, crop.w, crop.h, pal, o);
    return { ...crop, data };
  }, [crop, pal, o]);
  const counted = o.palette === 'exact' || o.palette === 'web' || o.palette === 'blackWhite' || o.palette === 'custom';
  return (
    <Modal title="Indexed Color" onClose={close} onOk={() => { close(); void convertToIndexed(o); }} width={700}>
      <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
        <div className="col" style={{ gap: 8, minWidth: 250 }}>
          <Select label="Palette" value={o.palette} onChange={(v) => set({ palette: v as PaletteMethod })} options={[
            { value: 'exact', label: 'Exact' }, { value: 'perceptual', label: 'Local (Perceptual)' }, { value: 'adaptive', label: 'Local (Adaptive)' },
            { value: 'uniform', label: 'Uniform' }, { value: 'web', label: 'Web' }, { value: 'grayscale', label: 'Grayscale' }, { value: 'blackWhite', label: 'Black & White' },
          ]} />
          <NumberField label="Colors" value={o.colors} onChange={(v) => set({ colors: Math.max(2, Math.min(256, Math.round(v))) })} min={2} max={256} disabled={counted} />
          <Select label="Forced" value={o.forced} onChange={(v) => set({ forced: v as ForcedColors })} options={[{ value: 'none', label: 'None' }, { value: 'blackWhite', label: 'Black and White' }, { value: 'primaries', label: 'Primaries' }, { value: 'web', label: 'Web' }]} />
          <Check label="Transparency" checked={o.transparency} onChange={(v) => set({ transparency: v })} />
          <Select label="Dither" value={o.dither} onChange={(v) => set({ dither: v as IndexedDither })} options={[{ value: 'none', label: 'None' }, { value: 'diffusion', label: 'Diffusion' }, { value: 'pattern', label: 'Pattern' }, { value: 'noise', label: 'Noise' }]} />
          {o.dither !== 'none' && <Slider label="Amount" value={Math.round(o.amount * 100)} onChange={(v) => set({ amount: v / 100 })} min={0} max={100} unit="%" />}
          <div className="faint">{pal.length / 3} colors in the table{o.transparency ? ' (+ transparency when the image has any)' : ''}. The image is flattened and kept to these colors while you edit.</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <PreviewCanvas img={crop} label="Original (100%)" />
          <PreviewCanvas img={after} label="Indexed (100%)" />
        </div>
      </div>
    </Modal>
  );
}

export function BitmapModeDialog({ close }: { close: () => void }) {
  const s = editor.active!;
  const [o, setO] = useState<BitmapOptions>({ ...DEFAULT_BITMAP });
  const set = (p: Partial<BitmapOptions>) => setO((x) => ({ ...x, ...p }));
  const crop = useCenterCrop();
  const after = useMemo(() => {
    if (!crop) return null;
    const data = new Uint8ClampedArray(crop.data);
    toBitmap(data, crop.w, crop.h, o, s.doc.canvas.resolution);
    return { ...crop, data };
  }, [crop, o, s]);
  return (
    <Modal title="Bitmap" onClose={close} onOk={() => { close(); void convertToBitmap(o); }} width={700}>
      <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
        <div className="col" style={{ gap: 8, minWidth: 250 }}>
          <Select label="Method" value={o.method} onChange={(v) => set({ method: v as BitmapMethod })} options={[{ value: 'threshold', label: '50% Threshold' }, { value: 'pattern', label: 'Pattern Dither' }, { value: 'diffusion', label: 'Diffusion Dither' }, { value: 'halftone', label: 'Halftone Screen' }]} />
          {o.method === 'halftone' && (
            <>
              <NumberField label="Frequency" value={o.frequency} onChange={(v) => set({ frequency: Math.max(1, Math.min(999, v)) })} min={1} max={999} unit="lpi" step={1} />
              <NumberField label="Angle" value={o.angle} onChange={(v) => set({ angle: v })} min={-180} max={180} unit="°" />
              <Select label="Shape" value={o.shape} onChange={(v) => set({ shape: v as HalftoneShape })} options={[{ value: 'round', label: 'Round' }, { value: 'ellipse', label: 'Ellipse' }, { value: 'line', label: 'Line' }, { value: 'square', label: 'Square' }, { value: 'cross', label: 'Cross' }, { value: 'diamond', label: 'Diamond' }]} />
              <div className="faint">Cell size {(s.doc.canvas.resolution / o.frequency).toFixed(1)} px at {s.doc.canvas.resolution} ppi.</div>
            </>
          )}
          <div className="faint">The image is flattened to 1 bit (black and white) from its luminance and kept that way while you edit.</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <PreviewCanvas img={crop} label="Original (100%)" />
          <PreviewCanvas img={after} label="Bitmap (100%)" />
        </div>
      </div>
    </Modal>
  );
}

export function ColorTableDialog({ close }: { close: () => void }) {
  const s = editor.active!;
  const [table, setTable] = useState<number[]>(() => [...(s.doc.canvas.colorTable ?? [])]);
  const n = Math.floor(table.length / 3);
  const hex = (i: number) => '#' + [0, 1, 2].map((c) => table[i * 3 + c].toString(16).padStart(2, '0')).join('');
  const pick = (i: number, v: string) => {
    const t = table.slice();
    t[i * 3] = parseInt(v.slice(1, 3), 16); t[i * 3 + 1] = parseInt(v.slice(3, 5), 16); t[i * 3 + 2] = parseInt(v.slice(5, 7), 16);
    setTable(t);
  };
  return (
    <Modal title="Color Table" onClose={close} onOk={() => { close(); setColorTable(table); }} width={470}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(16, 24px)', gap: 2 }}>
        {Array.from({ length: n }, (_, i) => (
          <label key={i} title={`${i}: ${hex(i)}`} style={{ width: 24, height: 24, background: hex(i), border: '1px solid var(--border)', cursor: 'pointer', position: 'relative' }}>
            <input type="color" value={hex(i)} onChange={(e) => pick(i, e.target.value)} style={{ opacity: 0, position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'pointer' }} />
          </label>
        ))}
      </div>
      <div className="faint" style={{ marginTop: 8 }}>{n} colors{s.doc.canvas.colorTableTransparent ? ' + transparency' : ''}. Click a swatch to change it; pixels using that entry are recolored.</div>
    </Modal>
  );
}

/**
 * Image ▸ Mode ▸ Duotone: monotone … quadtone inks (name, colour, 13-point curve) and the
 * overprint colours, previewed live on the document. Colours of custom inks (e.g. PANTONE) read
 * from a file stay as they were until changed here.
 */
export function DuotoneDialog({ close }: { close: () => void }) {
  const s = editor.active!;
  // Captured once: the live preview changes the document's inks while the dialog is open.
  const [original] = useState(() => s.doc.canvas.duotone);
  const [spec, setSpec] = useState<DuotoneSpec>(() => original ?? defaultDuotone());
  const [open, setOpen] = useState<number | null>(null);
  const [showOverprints, setShowOverprints] = useState(false);
  const ramp = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    previewDuotone(spec, original);
    const c = ramp.current;
    if (!c) return;
    c.width = 256; c.height = 1;
    const img = new ImageData(256, 1);
    for (let x = 0; x < 256; x++) { const v = duotoneColor(spec, x / 255); img.data.set([v.r * 255, v.g * 255, v.b * 255, 255], x * 4); }
    c.getContext('2d')!.putImageData(img, 0, 0);
  }, [spec, original]);
  const cancel = () => { previewDuotone(null, original); close(); };
  const count = spec.inks.length;
  const setCount = (n: number) => {
    const inks = spec.inks.slice(0, n);
    while (inks.length < n) inks.push({ name: `Ink ${inks.length + 1}`, color: { r: 0.5, g: 0.5, b: 0.5 }, curve: [0, -1, -1, -1, -1, -1, 300, -1, -1, -1, -1, -1, 1000] });
    setSpec(editedDuotone(spec, { inks, overprints: remapOverprints(spec.overprints, count, n) }));
  };
  const sets = overprintSets(count);
  const setInk = (i: number, patch: Partial<DuotoneSpec['inks'][number]>) => {
    // A new ink colour recomputes the overprints that contain that ink; names and curves keep them.
    const overprints = patch.color ? sets.map((set, k) => (set.includes(i) ? null : spec.overprints[k] ?? null)) : spec.overprints;
    setSpec(editedDuotone(spec, { inks: spec.inks.map((ink, k) => (k === i ? { ...ink, ...patch } : ink)), overprints }));
  };
  const effective = useMemo(() => effectiveOverprints(spec), [spec]);
  const setOverprint = (k: number, c: RGB | null) => setSpec(editedDuotone(spec, { overprints: sets.map((_, j) => (j === k ? c : spec.overprints[j] ?? null)) }));
  const customCount = sets.filter((_, k) => spec.overprints[k]).length;
  return (
    <Modal title="Duotone Options" onClose={cancel} onOk={() => { close(); setDuotone(spec, original); }} width={560}>
      <div className="grid2">
        <span className="lbl">Type</span>
        <Select value={String(count)} onChange={(v) => setCount(Number(v))} options={[{ value: '1', label: 'Monotone' }, { value: '2', label: 'Duotone' }, { value: '3', label: 'Tritone' }, { value: '4', label: 'Quadtone' }]} />
      </div>
      {spec.inks.map((ink, i) => (
        <div key={i} style={{ marginTop: 8 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="faint" style={{ width: 44 }}>Ink {i + 1}</span>
            <button className="btn small" title="Edit the ink's curve" onClick={() => setOpen(open === i ? null : i)}>Curve</button>
            <ColorSwatch color={ink.color} title="Ink color" onClick={() => ui.openDialog('colorPicker', { purpose: 'callback', title: `Ink ${i + 1} Color`, initial: ink.color, onPick: (c: RGB) => setInk(i, { color: c }) })} />
            <input className="txt" style={{ flex: 1 }} value={ink.name} maxLength={63} aria-label={`Ink ${i + 1} name`} onChange={(e) => setInk(i, { name: e.target.value })} />
          </div>
          {open === i && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, auto)', gap: 4, marginTop: 6 }}>
              {DUOTONE_CURVE_X.map((x, k) => (
                <label key={k} className="faint" style={{ display: 'flex', flexDirection: 'column', fontSize: 11 }}>
                  {x}%
                  <input className="txt" style={{ width: 52 }} value={ink.curve[k] < 0 ? '' : String(ink.curve[k] / 10)} placeholder={k === 0 || k === 12 ? undefined : '—'}
                    onChange={(e) => {
                      const t = e.target.value.trim();
                      const v = t === '' && k !== 0 && k !== 12 ? -1 : Math.round(Math.max(0, Math.min(100, Number(t) || 0)) * 10);
                      setInk(i, { curve: ink.curve.map((c, j) => (j === k ? v : c)) });
                    }} />
                </label>
              ))}
            </div>
          )}
        </div>
      ))}
      {count > 1 && (
        <div style={{ marginTop: 10 }}>
          <button className="btn small" aria-expanded={showOverprints} onClick={() => setShowOverprints(!showOverprints)}>Overprint Colors…</button>
          {customCount > 0 && <span className="faint" style={{ marginLeft: 8 }}>{customCount} custom</span>}
          {showOverprints && (
            <div style={{ marginTop: 6 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, auto)', gap: 6, justifyContent: 'start' }}>
                {sets.map((set, k) => (
                  <div key={k} className="row" style={{ gap: 4, alignItems: 'center' }}>
                    <span className="faint" style={{ width: 52, textAlign: 'right' }}>{overprintLabel(set)}</span>
                    <ColorSwatch color={effective[k]} title={`${overprintLabel(set)} overprint${spec.overprints[k] ? ' (custom)' : ' (computed from the inks)'}`}
                      onClick={() => ui.openDialog('colorPicker', { purpose: 'callback', title: `${overprintLabel(set)} Overprint Color`, initial: effective[k], onPick: (c: RGB) => setOverprint(k, c) })} />
                    {spec.overprints[k] ? <button className="btn small" title="Use the computed colour" onClick={() => setOverprint(k, null)}>↺</button> : <span style={{ width: 22 }} />}
                  </div>
                ))}
              </div>
              <div className="row" style={{ marginTop: 6, gap: 8, alignItems: 'center' }}>
                <button className="btn small" disabled={!customCount} onClick={() => setSpec(editedDuotone(spec, { overprints: [] }))}>Reset all</button>
                <span className="faint">How the inks look printed on top of each other, for display and export. Changing an ink’s colour recomputes the overprints that use it.</span>
              </div>
            </div>
          )}
        </div>
      )}
      <canvas ref={ramp} style={{ width: '100%', height: 18, marginTop: 12, border: '1px solid var(--border)', imageRendering: 'auto' }} aria-label="Duotone ramp preview" />
      <div className="faint" style={{ marginTop: 6 }}>
        Curves give the ink percentage at each tone (blank = no point). The document keeps its Grayscale data; the inks are applied when it is shown, printed or exported.
        {original?.rendering && ' Until you change the inks, the file is shown with Photoshop’s own rendering.'}
      </div>
    </Modal>
  );
}

/** Channel Options: name, kind (alpha / spot), overlay or ink colour, opacity / solidity. */
export function ChannelOptionsDialog({ close, channelId }: { close: () => void; channelId: string }) {
  const s = editor.active!;
  const ch = s.doc.channels.find((c) => c.id === channelId);
  const [name, setName] = useState(ch?.name ?? '');
  const [kind, setKind] = useState<'alpha' | 'spot'>(ch?.kind ?? 'alpha');
  const [color, setColor] = useState<RGB>(ch?.color ?? { r: 1, g: 0, b: 0 });
  const [amount, setAmount] = useState(Math.round(((ch?.kind === 'spot' ? ch?.solidity : ch?.opacity) ?? 0.5) * 100));
  const [selected, setSelected] = useState(!!ch?.indicatesSelected);
  if (!ch) { close(); return null; }
  const ok = () => {
    close();
    const before = s.doc.channels.map((c) => ({ ...c }));
    const after = s.doc.channels.map((c) => (c.id !== ch.id ? { ...c } : {
      ...c, name: name.trim() || c.name, kind, color: { r: color.r, g: color.g, b: color.b },
      opacity: kind === 'alpha' ? amount / 100 : c.opacity, solidity: kind === 'spot' ? amount / 100 : undefined,
      indicatesSelected: kind === 'alpha' && selected, visible: kind === 'spot' ? (c.kind === 'spot' ? c.visible : true) : false,
    }));
    s.push(new LambdaCommand('Channel Options', (d) => { d.channels = after.map((c) => ({ ...c })); d.emit({ type: 'channels' }); }, (d) => { d.channels = before.map((c) => ({ ...c })); d.emit({ type: 'channels' }); }));
    s.engine.invalidateAll();
  };
  return (
    <Modal title="Channel Options" onClose={close} onOk={ok} width={400}>
      <div className="grid2">
        <span className="lbl">Name</span>
        <input className="txt" value={name} maxLength={63} onChange={(e) => setName(e.target.value)} aria-label="Channel name" />
        <span className="lbl">Kind</span>
        <Select value={kind} onChange={(v) => setKind(v as 'alpha' | 'spot')} options={[{ value: 'alpha', label: 'Alpha channel (mask)', disabled: s.doc.canvas.colorMode === 'multichannel' }, { value: 'spot', label: 'Spot color (ink)' }]} />
        {kind === 'alpha' && (<><span className="lbl">Color indicates</span><Select value={selected ? 'sel' : 'mask'} onChange={(v) => setSelected(v === 'sel')} options={[{ value: 'mask', label: 'Masked areas' }, { value: 'sel', label: 'Selected areas' }]} /></>)}
        <span className="lbl">{kind === 'spot' ? 'Ink color' : 'Overlay color'}</span>
        <ColorSwatch color={color} onClick={() => ui.openDialog('colorPicker', { purpose: 'callback', initial: color, onPick: (c: RGB) => setColor(c) })} />
        <span className="lbl">{kind === 'spot' ? 'Solidity' : 'Opacity'}</span>
        <NumberField value={amount} onChange={setAmount} min={0} max={100} unit="%" />
      </div>
      {kind === 'spot' && <div className="faint" style={{ marginTop: 8 }}>Solidity 0% prints a transparent ink (it multiplies with what is below); 100% covers like an opaque ink. Black in the channel is full ink.</div>}
    </Modal>
  );
}
