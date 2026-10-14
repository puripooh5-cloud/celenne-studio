/** Warp Text, Filter Gallery, Focus Area and Match Font dialogs. */
import { isCmykDoc, isLabDoc, platesToRgb } from '../../color/plates';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Check, IconButton, NumberField, Select, Seg, Slider } from '../controls';
import { editor } from '../../app/editor';
import { ui, useApp } from '../../app/store';
import type { TextLayer } from '../../document/types';
import { cloneLayer } from '../../document/clone';
import { renderTextLayer } from '../../layers/appearance';
import { applyTextStyle, setTextWarp } from '../../tools/typeTool';
import { textWarpPreset } from '../../typography/render';
import { defaultWarpPreset, WARP_STYLES, WarpPreset, WarpStyle } from '../../image-engine/warp';
import { allFilters, filterById } from '../../filters/builtin';
import type { FilterDef, FilterParams, FloatImage, ParamDef } from '../../filters/types';
import { defaults } from '../../filters/types';
import { runFilterSync } from '../../filters/runner';
import { applyFilterStack, filterTarget } from '../../app/ops/filterOps';
import { readLayerContent } from '../../rendering/compositor';
import { resolveTarget } from '../../commands/rasterTarget';
import { rasterContentBounds } from '../../rendering/bounds';
import type { Rect } from '../../image-engine/rect';
import { intersect, isEmpty } from '../../image-engine/rect';
import { compositeRegion } from '../../rendering/compositor';
import { fonts } from '../../typography/fonts';
import { FontMatch, inkMask, matchFonts } from '../../typography/matchFont';
import { analyzeFocus, focusArea, FocusAreaSpec } from '../../app/ops/selectOps';
import { autoRange, estimateNoise, focusMask } from '../../selection/focusArea';

// ---------------------------------------------------------------------------------------------
// Warp Text
// ---------------------------------------------------------------------------------------------
export function WarpTextDialog({ close }: { close: () => void }) {
  const s = editor.active!;
  const layer = s.activeLayer() as TextLayer;
  const orig = useMemo(() => cloneLayer(layer), []);
  const [p, setP] = useState<WarpPreset>(() => textWarpPreset(layer.text) ?? { ...defaultWarpPreset('none') });
  const preview = (w: WarpPreset) => {
    const l = s.doc.getLayer(layer.id) as TextLayer | null;
    if (!l) return;
    l.text.warp = toTextWarp(w, orig.text.warp);
    renderTextLayer(s.doc, l);
    s.doc.emit({ type: 'layer', layerId: l.id });
  };
  const restore = () => {
    const l = s.doc.getLayer(layer.id) as TextLayer | null;
    if (!l) return;
    l.text = structuredClone(orig.text);
    l.raster = orig.raster.clone();
    l.x = orig.x; l.y = orig.y;
    l.usingPreservedPixels = orig.usingPreservedPixels;
    l.rev++;
    s.doc.emit({ type: 'layer', layerId: l.id });
  };
  useEffect(() => { preview(p); }, [p]);
  const set = (patch: Partial<WarpPreset>) => setP((x) => ({ ...x, ...patch }));
  const none = p.style === 'none';
  return (
    <Modal title="Warp Text" width={380}
      onClose={() => { restore(); close(); }}
      onOk={() => { restore(); close(); setTextWarp(layer.id, none ? null : toTextWarp(p, orig.text.warp)); }}>
      <Select label="Style" value={p.style} onChange={(v) => set({ style: v as WarpStyle, bend: p.style === 'none' && v !== 'none' ? 50 : p.bend })} options={WARP_STYLES.map((w) => ({ value: w.id, label: w.label }))} />
      <Seg value={p.orientation} onChange={(v) => set({ orientation: v as WarpPreset['orientation'] })} options={[{ value: 'horizontal', label: 'Horizontal', title: 'Horizontal' }, { value: 'vertical', label: 'Vertical', title: 'Vertical' }]} />
      <Slider label="Bend" value={p.bend} min={-100} max={100} unit="%" onChange={(v) => set({ bend: v })} />
      <Slider label="Horizontal Distortion" value={p.horizontalDistortion} min={-100} max={100} unit="%" onChange={(v) => set({ horizontalDistortion: v })} />
      <Slider label="Vertical Distortion" value={p.verticalDistortion} min={-100} max={100} unit="%" onChange={(v) => set({ verticalDistortion: v })} />
      {none && <div className="faint">Style “None” removes the warp.</div>}
      <div className="faint">The text stays editable. Warp curves are Celenne's approximation of Photoshop's styles.</div>
    </Modal>
  );
}

function toTextWarp(p: WarpPreset, prev: TextLayer['text']['warp']): TextLayer['text']['warp'] {
  // Keep unknown PSD fields (e.g. bounds) from the file's warp record.
  return { ...(prev ?? {}), style: p.style, value: p.bend, perspective: p.horizontalDistortion, perspectiveOther: p.verticalDistortion, rotate: p.orientation };
}

// ---------------------------------------------------------------------------------------------
// Filter Gallery
// ---------------------------------------------------------------------------------------------
interface StackItem { key: number; id: string; params: FilterParams; visible: boolean }

const PW = 520, PH = 420;
let keySeq = 1;

function galleryFilters(): FilterDef[] {
  return allFilters().filter((f) => f.gallery && !f.runAsync && !f.comingSoon);
}

/** Source image for the preview: the filter target read at a pyramid level (straight floats). */
function readPreviewSource(level: number, rect: Rect): FloatImage | null {
  const s = editor.active;
  if (!s) return null;
  const t = filterTarget(s);
  if ('error' in t) return null;
  if (t.kind === 'smart' || t.target.kind === 'layer') {
    const layer = t.kind === 'smart' ? t.layer : s.doc.getLayer((t.target as { layerId: string }).layerId)!;
    const ctx = { doc: s.doc, level, scale: 1 / (1 << level), opts: { level } };
    let data = readLayerContent(ctx, { ...layer, id: '__noop' } as never, rect);
    // Previews use the appearance of CMYK / Lab layers.
    if (isCmykDoc(s.doc) || isLabDoc(s.doc)) {
      const plates = [data];
      if (isCmykDoc(s.doc)) plates.push(readLayerContent({ ...ctx, opts: { level, plate: 1 } }, { ...layer, id: '__noop' } as never, rect));
      data = platesToRgb(s.doc, plates, rect.w * rect.h);
    }
    return { w: rect.w, h: rect.h, ch: 4, data };
  }
  const res = resolveTarget(s.doc, t.target)!;
  const sc = 1 << level;
  const data = res.raster.readFloat({ x: rect.x - Math.round(res.x / sc), y: rect.y - Math.round(res.y / sc), w: rect.w, h: rect.h }, level);
  return { w: rect.w, h: rect.h, ch: 1, data };
}

function contentRect(): Rect | null {
  const s = editor.active;
  if (!s) return null;
  const t = filterTarget(s);
  if ('error' in t) return null;
  if (t.kind === 'raster' && t.target.kind !== 'layer') return s.doc.bounds;
  const l = t.kind === 'smart' ? t.layer : s.doc.getLayer((t.target as { layerId: string }).layerId);
  if (!l || !('raster' in l)) return s.doc.bounds;
  const b = rasterContentBounds(l.raster);
  return b ? { x: b.x + l.x, y: b.y + l.y, w: b.w, h: b.h } : null;
}

/** Draws a straight-alpha float image centred in the canvas, scaled to fit when `fit` is set. */
function drawImage(c: HTMLCanvasElement | null, img: FloatImage | null, fit = false) {
  if (!c) return;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  if (!img) return;
  const id = new ImageData(img.w, img.h);
  for (let i = 0; i < img.w * img.h; i++) {
    if (img.ch === 4) {
      id.data[i * 4] = img.data[i * 4] * 255; id.data[i * 4 + 1] = img.data[i * 4 + 1] * 255; id.data[i * 4 + 2] = img.data[i * 4 + 2] * 255; id.data[i * 4 + 3] = img.data[i * 4 + 3] * 255;
    } else { const v = img.data[i] * 255; id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
  }
  const k = fit ? Math.min(c.width / img.w, c.height / img.h) : 1;
  if (k === 1) { g.putImageData(id, Math.floor((c.width - img.w) / 2), Math.floor((c.height - img.h) / 2)); return; }
  const tmp = new OffscreenCanvas(img.w, img.h);
  tmp.getContext('2d')!.putImageData(id, 0, 0);
  g.imageSmoothingQuality = 'high';
  const w = img.w * k, h = img.h * k;
  g.drawImage(tmp, (c.width - w) / 2, (c.height - h) / 2, w, h);
}

function runStack(src: FloatImage, stack: StackItem[], level: number, origin: { x: number; y: number }, bounds: Rect): FloatImage {
  const st = useApp.getState();
  let img: FloatImage = { ...src, data: src.data.slice() };
  const scale = 1 / (1 << level);
  for (const it of stack) {
    if (!it.visible) continue;
    const def = filterById(it.id);
    if (!def) continue;
    img = runFilterSync(def, it.params, img, { scale, originX: origin.x, originY: origin.y, bounds: { x: bounds.x * scale, y: bounds.y * scale, w: bounds.w * scale, h: bounds.h * scale }, foreground: [st.fg.r, st.fg.g, st.fg.b], background: [st.bg.r, st.bg.g, st.bg.b] });
  }
  return img;
}

export function FilterGalleryDialog({ close }: { close: () => void }) {
  const filters = useMemo(galleryFilters, []);
  const cats = useMemo(() => [...new Set(filters.map((f) => f.category))], [filters]);
  const [stack, setStack] = useState<StackItem[]>(() => [{ key: keySeq++, id: filters[0].id, params: defaults(filters[0]), visible: true }]);
  const [cur, setCur] = useState(0);
  const [zoom, setZoom] = useState<'fit' | '100'>('fit');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const content = useMemo(contentRect, []);
  // Preview geometry (level + source rect at that level).
  const geo = useMemo(() => {
    const b = content;
    if (!b) return null;
    if (zoom === 'fit') {
      const level = Math.max(0, Math.ceil(Math.log2(Math.max(b.w / PW, b.h / PH, 1))));
      const sc = 1 << level;
      const r = { x: Math.floor(b.x / sc), y: Math.floor(b.y / sc), w: Math.max(1, Math.min(PW, Math.ceil(b.w / sc))), h: Math.max(1, Math.min(PH, Math.ceil(b.h / sc))) };
      return { level, rect: r };
    }
    const cx = Math.round(b.x + b.w / 2 - PW / 2 + pan.x), cy = Math.round(b.y + b.h / 2 - PH / 2 + pan.y);
    return { level: 0, rect: { x: cx, y: cy, w: PW, h: PH } };
  }, [content, zoom, pan]);
  const source = useMemo(() => (geo ? readPreviewSource(geo.level, geo.rect) : null), [geo]);
  // Thumbnails: a small crop of the source through each filter (computed lazily, once).
  const thumbSrc = useMemo(() => {
    if (!content) return null;
    const level = Math.max(0, Math.ceil(Math.log2(Math.max(content.w / 72, content.h / 54, 1))));
    const sc = 1 << level;
    const r = { x: Math.floor(content.x / sc), y: Math.floor(content.y / sc), w: Math.max(1, Math.min(72, Math.ceil(content.w / sc))), h: Math.max(1, Math.min(54, Math.ceil(content.h / sc))) };
    const img = readPreviewSource(level, r);
    return img ? { img, level, r } : null;
  }, [content]);

  useEffect(() => {
    if (!source || !geo || !content) return;
    setBusy(true);
    const t = setTimeout(() => {
      try { drawImage(canvas.current, runStack(source, stack, geo.level, { x: geo.rect.x, y: geo.rect.y }, content), zoom === 'fit'); }
      catch (e) { ui.toast('error', 'Preview failed', (e as Error).message); }
      setBusy(false);
    }, 120);
    return () => clearTimeout(t);
  }, [source, stack, geo]);

  if (!content) {
    return <Modal title="Filter Gallery" onClose={close} onOk={close}>The current layer is empty or cannot be filtered.</Modal>;
  }
  const item = stack[cur];
  const def = item ? filterById(item.id) : undefined;
  const setItem = (patch: Partial<StackItem>) => setStack((st) => st.map((x, i) => (i === cur ? { ...x, ...patch } : x)));
  const pick = (f: FilterDef) => setItem({ id: f.id, params: defaults(f) });
  const ok = () => {
    const list = stack.filter((x) => x.visible).map((x) => ({ id: x.id, params: x.params }));
    close();
    if (list.length) applyFilterStack(list);
  };
  const onPan = (e: React.PointerEvent) => {
    if (zoom !== '100') return;
    const sx = e.clientX, sy = e.clientY, p0 = pan;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => setPan({ x: p0.x - (ev.clientX - sx), y: p0.y - (ev.clientY - sy) });
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
  };
  return (
    <Modal title={`Filter Gallery${def ? ` (${def.name.replace('…', '')})` : ''}`} width={1060} onClose={close} onOk={ok}
      footerLeft={<span className="row" style={{ gap: 8 }}><Select label="Zoom" value={zoom} onChange={(v) => setZoom(v)} options={[{ value: 'fit', label: 'Fit in view' }, { value: '100', label: '100%' }]} />{busy && <span className="faint">Rendering…</span>}</span>}>
      <div className="row" style={{ alignItems: 'stretch', gap: 12 }}>
        <div className="checker" style={{ width: PW, height: PH, flex: 'none', cursor: zoom === '100' ? 'grab' : 'default' }} onPointerDown={onPan}>
          <canvas ref={canvas} width={PW} height={PH} style={{ width: PW, height: PH, display: 'block' }} />
        </div>
        <div style={{ width: 250, maxHeight: PH, overflowY: 'auto', flex: 'none' }}>
          {cats.map((c) => (
            <div key={c}>
              <div className="section-title">{c}</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {filters.filter((f) => f.category === c).map((f) => (
                  <GalleryThumb key={f.id} f={f} active={item?.id === f.id} src={thumbSrc} content={content} onClick={() => pick(f)} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {def && <ParamsEditor def={def} params={item.params} onChange={(params) => setItem({ params })} />}
          <div style={{ flex: 1 }} />
          <div className="section-title">Effect layers (bottom → top applied first)</div>
          <div className="list" style={{ maxHeight: 150, overflowY: 'auto' }}>
            {stack.map((x, i) => (
              <div key={x.key} className={`list-item ${i === cur ? 'active' : ''}`} onClick={() => setCur(i)}>
                <Check label="" checked={x.visible} onChange={(v) => setStack((st) => st.map((y, j) => (j === i ? { ...y, visible: v } : y)))} />
                <span className="grow">{filterById(x.id)?.name.replace('…', '')}</span>
              </div>
            )).reverse()}
          </div>
          <div className="row">
            <IconButton icon="plus" title="New effect layer (duplicates the selected one)" onClick={() => { setStack((st) => [...st, { ...st[cur], key: keySeq++, params: { ...st[cur].params } }]); setCur(stack.length); }} />
            <IconButton icon="trash" title="Delete effect layer" onClick={() => { if (stack.length > 1) { setStack((st) => st.filter((_, i) => i !== cur)); setCur(Math.max(0, cur - 1)); } }} />
            <button className="btn small" title="Move up" onClick={() => { if (cur < stack.length - 1) { setStack((st) => { const n = [...st]; [n[cur], n[cur + 1]] = [n[cur + 1], n[cur]]; return n; }); setCur(cur + 1); } }}>▲</button>
            <button className="btn small" title="Move down" onClick={() => { if (cur > 0) { setStack((st) => { const n = [...st]; [n[cur], n[cur - 1]] = [n[cur - 1], n[cur]]; return n; }); setCur(cur - 1); } }}>▼</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function GalleryThumb({ f, active, src, content, onClick }: { f: FilterDef; active: boolean; src: { img: FloatImage; level: number; r: Rect } | null; content: Rect; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!src) return;
    const id = setTimeout(() => {
      try { drawImage(ref.current, runStack(src.img, [{ key: 0, id: f.id, params: defaults(f), visible: true }], src.level, { x: src.r.x, y: src.r.y }, content), true); } catch { /* thumbnail only */ }
    }, 30);
    return () => clearTimeout(id);
  }, [src]);
  return (
    <button className={`gallery-thumb ${active ? 'active' : ''}`} title={f.name.replace('…', '')} onClick={onClick} style={{ padding: 2, border: active ? '2px solid var(--accent)' : '2px solid transparent', background: 'none', cursor: 'pointer', width: 78 }}>
      <canvas ref={ref} width={72} height={54} className="checker" style={{ width: 72, height: 54, display: 'block' }} />
      <div className="faint" style={{ fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name.replace('…', '')}</div>
    </button>
  );
}

export function ParamsEditor({ def, params, onChange }: { def: FilterDef; params: FilterParams; onChange: (p: FilterParams) => void }) {
  const set = (id: string, v: number | string | boolean) => onChange({ ...params, [id]: v });
  return (
    <>
      {def.params.map((p: ParamDef) => {
        const v = params[p.id];
        switch (p.type) {
          case 'number': return <Slider key={p.id} label={p.label} value={Number(v)} min={p.min} max={p.max} step={p.step ?? 1} unit={p.unit} onChange={(x) => set(p.id, x)} />;
          case 'angle': return <NumberField key={p.id} label={p.label} value={Number(v)} unit="°" onChange={(x) => set(p.id, x)} />;
          case 'select': return <Select key={p.id} label={p.label} value={String(v)} onChange={(x) => set(p.id, x)} options={p.options} />;
          case 'boolean': return <Check key={p.id} label={p.label} checked={!!v} onChange={(x) => set(p.id, x)} />;
          case 'seed': return <button key={p.id} className="btn small" onClick={() => set(p.id, Math.floor(Math.random() * 1e6))}>{p.label}</button>;
        }
        return null;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Focus Area
// ---------------------------------------------------------------------------------------------
export function FocusAreaDialog({ close }: { close: () => void }) {
  const s = editor.active!;
  const [auto, setAuto] = useState(true);
  const [range, setRange] = useState(50);
  const [autoNoise, setAutoNoise] = useState(true);
  const [noise, setNoise] = useState(0);
  const [soften, setSoften] = useState(true);
  const [view, setView] = useState<'overlay' | 'mask'>('overlay');
  const [output, setOutput] = useState<FocusAreaSpec['output']>('selection');
  const canvas = useRef<HTMLCanvasElement>(null);
  const estimate = useMemo(() => estimatedNoise(s), []);
  const noiseValue = autoNoise ? estimate : noise / 100;
  const analysis = useMemo(() => analyzeFocus(s, noiseValue, 480), [noiseValue]);
  const autoValue = useMemo(() => autoRange(analysis.fm), [analysis]);
  const rangeValue = auto ? autoValue : range / 100;
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const { fm } = analysis;
    const m = focusMask(fm, rangeValue, soften);
    c.width = fm.w; c.height = fm.h;
    const id = new ImageData(fm.w, fm.h);
    for (let i = 0; i < fm.w * fm.h; i++) {
      const k = m[i];
      if (view === 'mask') { const v = k * 255; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; }
      else for (let ch = 0; ch < 3; ch++) id.data[i * 4 + ch] = (fm.rgba[i * 4 + ch] * k + (ch === 0 ? 1 : 0) * 0.5 * (1 - k) + fm.rgba[i * 4 + ch] * 0.5 * (1 - k)) * 255;
      id.data[i * 4 + 3] = 255;
    }
    c.getContext('2d')!.putImageData(id, 0, 0);
  }, [analysis, rangeValue, soften, view]);
  const ok = () => {
    close();
    focusArea({ range: rangeValue, noise: noiseValue, soften, output });
  };
  return (
    <Modal title="Focus Area" width={520} onClose={close} onOk={ok}>
      <div className="checker" style={{ maxWidth: 480, maxHeight: 360, display: 'flex', justifyContent: 'center' }}>
        <canvas ref={canvas} style={{ maxWidth: 480, maxHeight: 360, display: 'block' }} />
      </div>
      <Seg value={view} onChange={setView} options={[{ value: 'overlay', label: 'Overlay', title: 'Out-of-focus areas tinted red' }, { value: 'mask', label: 'Black & White', title: 'Selection as a mask' }]} />
      <div className="row"><Slider label="In-Focus Range" value={Math.round(rangeValue * 100)} min={0} max={100} onChange={(v) => { setAuto(false); setRange(v); }} /><Check label="Auto" checked={auto} onChange={setAuto} /></div>
      <div className="row"><Slider label="Image Noise Level" value={Math.round(noiseValue * 100)} min={0} max={100} onChange={(v) => { setAutoNoise(false); setNoise(v); }} /><Check label="Auto" checked={autoNoise} onChange={setAutoNoise} /></div>
      <Check label="Soften Edge" checked={soften} onChange={setSoften} />
      <Select label="Output To" value={output} onChange={setOutput} options={[{ value: 'selection', label: 'Selection' }, { value: 'layerMask', label: 'Layer Mask' }, { value: 'newLayerWithMask', label: 'New Layer with Layer Mask' }]} />
    </Modal>
  );
}

/** Automatic Image Noise Level (robust estimate on a proxy of the visible image). */
function estimatedNoise(s: NonNullable<typeof editor.active>): number {
  const { fm } = analyzeFocus(s, 0, 512);
  return estimateNoise(fm.rgba, fm.w, fm.h);
}

// ---------------------------------------------------------------------------------------------
// Match Font
// ---------------------------------------------------------------------------------------------
export function MatchFontDialog({ close }: { close: () => void }) {
  const s = editor.active!;
  const region = useMemo(() => {
    const sb = s.doc.selection.isEmpty() ? null : s.doc.selection.bounds(s.doc.bounds);
    if (sb) return sb;
    const l = s.activeLayer();
    if (l && 'raster' in l) {
      const b = rasterContentBounds(l.raster);
      return b ? intersect({ x: b.x + l.x, y: b.y + l.y, w: b.w, h: b.h }, s.doc.bounds) : null;
    }
    return null;
  }, []);
  const sample = useMemo(() => {
    if (!region || isEmpty(region)) return null;
    // Work at ≤ 600 px wide for speed.
    const level = Math.max(0, Math.floor(Math.log2(Math.max(1, region.w / 600))));
    const ls = 1 << level;
    const r = { x: Math.floor(region.x / ls), y: Math.floor(region.y / ls), w: Math.max(1, Math.ceil(region.w / ls)), h: Math.max(1, Math.ceil(region.h / ls)) };
    const px = compositeRegion(s.doc, r, { level });
    for (let i = 0; i < r.w * r.h; i++) { const a = px[i * 4 + 3]; if (a > 1e-6) { px[i * 4] /= a; px[i * 4 + 1] /= a; px[i * 4 + 2] /= a; } }
    return { mask: inkMask(px, r.w, r.h), w: r.w, h: r.h };
  }, [region]);
  const [text, setText] = useState('');
  const [results, setResults] = useState<FontMatch[]>([]);
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void fonts.load(); }, []);
  useEffect(() => {
    if (!sample || !text.trim()) { setResults([]); return; }
    setBusy(true);
    const t = setTimeout(() => {
      setResults(matchFonts(sample.mask, sample.w, sample.h, text, fonts.faces));
      setPick(0);
      setBusy(false);
    }, 300);
    return () => clearTimeout(t);
  }, [text, sample]);
  if (!sample) {
    return <Modal title="Match Font" onClose={close} onOk={close}>Select the text you want to identify (a rectangle around one line of text works best), then choose Match Font again.</Modal>;
  }
  const ok = () => {
    const m = results[pick];
    close();
    if (!m) return;
    const style = { fontFamily: m.face.family, fontStyleName: m.face.style, fontWeight: m.face.weight, italic: m.face.italic };
    ui.setToolOptions('type', style);
    const l = s.activeLayer();
    if (l?.kind === 'text') applyTextStyle(s, l.id, { ...style, postScriptName: m.face.postScriptName });
    ui.toast('success', `Font set to ${m.face.family} ${m.face.style}`);
  };
  return (
    <Modal title="Match Font" width={480} onClose={close} onOk={ok} okDisabled={!results.length}
      footerLeft={<span className="faint">{fonts.faces.length} installed fonts{fonts.localAccess !== 'granted' ? ' (common fonts only)' : ''}</span>}>
      <MaskPreview mask={sample.mask} w={sample.w} h={sample.h} />
      <label className="field"><span className="lbl">Text in the sample</span><input className="txt" style={{ width: 280 }} autoFocus value={text} placeholder="Type exactly what the selected text says" onChange={(e) => setText(e.target.value)} /></label>
      {busy && <div className="faint">Comparing fonts…</div>}
      <div className="list" style={{ maxHeight: 260, overflowY: 'auto' }}>
        {results.map((r, i) => (
          <div key={`${r.face.family}-${r.face.style}`} className={`list-item ${i === pick ? 'active' : ''}`} style={{ height: 'auto', padding: '4px 8px' }} onClick={() => setPick(i)} onDoubleClick={ok}>
            <span className="grow" style={{ fontFamily: `"${r.face.family}"`, fontWeight: r.face.weight, fontStyle: r.face.italic ? 'italic' : 'normal', fontSize: 20 }}>{text}</span>
            <span className="faint">{r.face.family} {r.face.style}</span>
          </div>
        ))}
      </div>
      <div className="faint">Matching compares letter shapes with each installed font; it is not text recognition.</div>
    </Modal>
  );
}

function MaskPreview({ mask, w, h }: { mask: Float32Array; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = w; c.height = h;
    const id = new ImageData(w, h);
    for (let i = 0; i < w * h; i++) { const v = 255 - mask[i] * 255; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
    c.getContext('2d')!.putImageData(id, 0, 0);
  }, [mask]);
  return <canvas ref={ref} style={{ maxWidth: 440, maxHeight: 120, display: 'block', margin: '0 auto 8px', border: '1px solid var(--border)' }} title="Detected ink" />;
}
