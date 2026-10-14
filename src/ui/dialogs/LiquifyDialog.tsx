/**
 * Liquify workspace: edits a displacement field on a proxy of the active layer, previews it live
 * and applies it once at full resolution (undoable as a single history step).
 */
import { rasterAppearance } from '../../color/plates';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Check, NumberField, Slider } from '../controls';
import { editor } from '../../app/editor';
import { ui } from '../../app/store';
import { DEFAULT_LIQUIFY_BRUSH, LIQUIFY_TOOLS, LiquifyBrush, LiquifyMesh, LiquifyTool, sampleBilinearPremul, warpWithField } from '../../filters/liquify';
import { editRaster } from '../../commands/rasterCommands';
import { resolveTarget } from '../../commands/rasterTarget';
import { rasterContentBounds } from '../../rendering/bounds';
import { Rect, translate, union } from '../../image-engine/rect';
import type { TiledRaster } from '../../image-engine/tiledRaster';

const MAX_PROXY = 1400;
const VIEW_W = 860, VIEW_H = 600;

interface Setup {
  raster: TiledRaster;
  layerId: string;
  /** Edit region in layer coordinates (full resolution). */
  region: Rect;
  /** Full-resolution px per proxy px (power of two, so a pyramid level can be read directly). */
  scale: number;
  level: number;
  pw: number;
  ph: number;
  proxy: Float32Array;
}

function prepare(): Setup | { error: string } {
  const s = editor.active;
  if (!s) return { error: 'Open a document first.' };
  const l = s.activeLayer();
  if (!l) return { error: 'Select a layer to liquify.' };
  if (l.kind === 'smartObject') return { error: 'Liquify works on pixels. Rasterize the smart object first (Layer ▸ Rasterize ▸ Smart Object).' };
  if (l.kind !== 'pixel') return { error: `"${l.name}" is not a pixel layer. Rasterize it first to use Liquify.` };
  if (l.locks.all || l.locks.pixels) return { error: `"${l.name}" is locked.` };
  const t = resolveTarget(s.doc, { kind: 'layer', layerId: l.id });
  if (!t) return { error: 'The layer has no pixels.' };
  const content = rasterContentBounds(t.raster);
  const docInLayer = translate(s.doc.bounds, -t.x, -t.y);
  const region = content ? union(content, docInLayer)! : docInLayer;
  let level = 0;
  while (Math.max(region.w, region.h) / (1 << level) > MAX_PROXY) level++;
  const scale = 1 << level;
  // Align the region to the proxy grid so proxy pixels map exactly onto pyramid pixels.
  const rx = Math.floor(region.x / scale) * scale, ry = Math.floor(region.y / scale) * scale;
  const aligned = { x: rx, y: ry, w: Math.ceil((region.x + region.w - rx) / scale) * scale, h: Math.ceil((region.y + region.h - ry) / scale) * scale };
  const pw = aligned.w / scale, ph = aligned.h / scale;
  // The proxy is a preview: CMYK / Lab layers show their RGB appearance (the apply warps every plate).
  const proxy = rasterAppearance(s.doc, t.raster, { x: rx / scale, y: ry / scale, w: pw, h: ph }, level);
  return { raster: t.raster, layerId: l.id, region: aligned, scale, level, pw, ph, proxy };
}

export function LiquifyDialog({ close }: { close: () => void }) {
  const setup = useMemo(prepare, []);
  useEffect(() => {
    if ('error' in setup) {
      ui.toast('warning', 'Liquify', setup.error);
      close();
    }
  }, [setup, close]);
  if ('error' in setup) return null;
  return <LiquifyWorkspace setup={setup} close={close} />;
}

function LiquifyWorkspace({ setup, close }: { setup: Setup; close: () => void }) {
  const { pw, ph, scale } = setup;
  const mesh = useMemo(() => new LiquifyMesh(pw, ph), [pw, ph]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<ImageData | null>(null);
  const [tool, setTool] = useState<LiquifyTool>('forwardWarp');
  const [brush, setBrush] = useState<LiquifyBrush>({ ...DEFAULT_LIQUIFY_BRUSH, size: Math.min(300, Math.max(20, Math.round(Math.max(setup.region.w, setup.region.h) / 10))) });
  const [showMask, setShowMask] = useState(true);
  const [showMesh, setShowMesh] = useState(false);
  const [reconstructAmt, setReconstructAmt] = useState(50);
  const [undoDepth, setUndoDepth] = useState(0);
  const undoStack = useRef<ReturnType<LiquifyMesh['snapshot']>[]>([]);
  const [busy, setBusy] = useState(false);
  const view = useMemo(() => {
    const k = Math.min(VIEW_W / pw, VIEW_H / ph);
    return { w: Math.max(1, Math.round(pw * k)), h: Math.max(1, Math.round(ph * k)), k };
  }, [pw, ph]);

  // --- rendering --------------------------------------------------------------------------
  const redraw = (dirty?: { x: number; y: number; w: number; h: number } | null) => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    if (!imageRef.current) imageRef.current = ctx.createImageData(pw, ph);
    const img = imageRef.current;
    const r = dirty ?? { x: 0, y: 0, w: pw, h: ph };
    const warped = warpWithField(setup.proxy, pw, ph, mesh, 1, r);
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        const s = (y * r.w + x) * 4, i = mesh.w * (y + r.y) + x + r.x, d = i * 4;
        let R = warped[s], G = warped[s + 1], B = warped[s + 2], A = warped[s + 3];
        const f = showMask ? mesh.freeze[i] * 0.55 : 0;
        if (f > 0) {
          // Frozen areas are tinted red over the image.
          R = R * A * (1 - f) + f; G = G * A * (1 - f); B = B * A * (1 - f);
          A = A + f * (1 - A);
          if (A > 0) { R /= A; G /= A; B /= A; }
        }
        img.data[d] = R * 255; img.data[d + 1] = G * 255; img.data[d + 2] = B * 255; img.data[d + 3] = A * 255;
      }
    ctx.putImageData(img, 0, 0, r.x, r.y, r.w, r.h);
    if (showMesh) drawMesh();
  };

  const drawMesh = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const step = Math.max(8, Math.round(Math.min(pw, ph) / 24));
    const p: [number, number] = [0, 0];
    ctx.save();
    ctx.strokeStyle = 'rgba(80,160,255,0.55)';
    ctx.lineWidth = Math.max(0.5, 1 / view.k);
    // The mesh shows where each grid point's content moved: forward positions ≈ p − D(p).
    for (let y = 0; y <= ph; y += step) {
      ctx.beginPath();
      for (let x = 0; x <= pw; x += 2) {
        mesh.sample(x, y, p);
        const X = x - p[0], Y = y - p[1];
        if (x === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.stroke();
    }
    for (let x = 0; x <= pw; x += step) {
      ctx.beginPath();
      for (let y = 0; y <= ph; y += 2) {
        mesh.sample(x, y, p);
        const X = x - p[0], Y = y - p[1];
        if (y === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.stroke();
    }
    ctx.restore();
  };

  useEffect(() => { redraw(); }, [showMask, showMesh]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- interaction ------------------------------------------------------------------------
  const pushUndo = () => {
    undoStack.current.push(mesh.snapshot());
    if (undoStack.current.length > 30) undoStack.current.shift();
    setUndoDepth(undoStack.current.length);
  };
  const undo = () => {
    const s = undoStack.current.pop();
    if (!s) return;
    mesh.restore(s);
    setUndoDepth(undoStack.current.length);
    redraw();
  };

  const proxyBrush = (): LiquifyBrush => ({ ...brush, size: Math.max(2, brush.size / scale) });
  const toGrid = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * pw, y: ((e.clientY - r.top) / r.height) * ph };
  };

  const drawCursor = (p: { x: number; y: number } | null) => {
    const o = overlayRef.current;
    if (!o) return;
    const ctx = o.getContext('2d')!;
    ctx.clearRect(0, 0, o.width, o.height);
    if (!p) return;
    const rad = (brush.size / scale / 2) * view.k;
    const cx = p.x * view.k, cy = p.y * view.k;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const inner = rad * (1 - brush.density);
    if (inner > 2 && inner < rad - 2) { ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(cx, cy, inner, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || busy) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    pushUndo();
    let last = toGrid(e);
    let cur = last;
    let pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 1;
    const t = e.altKey && tool === 'twirlCW' ? 'twirlCCW' : e.altKey && tool === 'pucker' ? 'bloat' : e.altKey && tool === 'bloat' ? 'pucker' : e.altKey && tool === 'freeze' ? 'thaw' : tool;
    const stationary = t === 'twirlCW' || t === 'twirlCCW' || t === 'pucker' || t === 'bloat' || t === 'reconstruct' || t === 'smooth' || t === 'freeze' || t === 'thaw';
    const step = (from: { x: number; y: number } | null, to: { x: number; y: number }) => {
      const b = proxyBrush();
      b.pressure *= pressure;
      const dirty = mesh.apply(t, to.x, to.y, from, b);
      if (dirty) {
        // Displaced content can land outside the brush footprint only via D itself, which is
        // local, so redrawing the dirty rect is exact.
        if (showMesh) redraw(); else redraw(dirty);
      }
    };
    step(null, cur);
    let raf = 0;
    const tick = () => {
      if (stationary) step(null, cur);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const move = (ev: PointerEvent) => {
      cur = toGrid(ev);
      if (ev.pointerType === 'pen' && ev.pressure > 0) pressure = ev.pressure;
      drawCursor(cur);
      if (stationary) return;
      // Sub-step long moves so warps stay smooth.
      const dist = Math.hypot(cur.x - last.x, cur.y - last.y);
      const spacing = Math.max(1, proxyBrush().size * 0.1);
      const n = Math.max(1, Math.ceil(dist / spacing));
      let prev = last;
      for (let i = 1; i <= n; i++) {
        const p = { x: last.x + ((cur.x - last.x) * i) / n, y: last.y + ((cur.y - last.y) * i) / n };
        step(prev, p);
        prev = p;
      }
      last = cur;
    };
    const up = () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  // Keyboard: tool keys, [ ] brush size, Ctrl+Z undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); undo(); return; }
      if (e.key === '[') { setBrush((b) => ({ ...b, size: Math.max(1, Math.round(b.size * 0.85)) })); return; }
      if (e.key === ']') { setBrush((b) => ({ ...b, size: Math.min(15000, Math.round(b.size * 1.18) + 1) })); return; }
      const k = (e.shiftKey ? 'Shift+' : '') + e.key.toUpperCase();
      const def = LIQUIFY_TOOLS.find((x) => x.key === k);
      if (def && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setTool(def.id); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // --- apply at full resolution -------------------------------------------------------------
  const apply = async () => {
    const s = editor.active;
    if (!s || mesh.isIdentity()) { close(); return; }
    setBusy(true);
    const prog = ui.progress('Applying Liquify… 0%');
    await new Promise((r) => setTimeout(r, 0));
    try {
      const { region } = setup;
      const maxD = Math.ceil(mesh.maxDisplacement() * scale) + 2;
      const cmd = editRaster(s.doc, { kind: 'layer', layerId: setup.layerId }, 'Liquify', (raster, ox, oy) => {
        // Source is read before writing, so strips read the original from a snapshot.
        const original = raster.clone();
        const stripH = Math.max(32, Math.floor((16 * 1024 * 1024) / Math.max(1, region.w * 16)));
        for (let y = 0; y < region.h; y += stripH) {
          const h = Math.min(stripH, region.h - y);
          const srcRect = { x: region.x, y: region.y + y - maxD, w: region.w, h: h + 2 * maxD };
          const src = original.readFloat(srcRect);
          // Field sampling happens in region-relative coordinates; the source strip is offset by maxD rows.
          const out = new Float32Array(region.w * h * 4);
          const tmp: [number, number] = [0, 0];
          for (let yy = 0; yy < h; yy++) {
            const py = y + yy;
            for (let x = 0; x < region.w; x++) {
              mesh.sample((x + 0.5) / scale - 0.5, (py + 0.5) / scale - 0.5, tmp);
              const sx = x + tmp[0] * scale;
              const sy = yy + maxD + tmp[1] * scale;
              sampleBilinearPremul(src, region.w, srcRect.h, sx, sy, out, (yy * region.w + x) * 4);
            }
          }
          raster.writeFloat({ x: region.x, y: region.y + y, w: region.w, h }, out);
          prog.update((y + h) / region.h, `Applying Liquify… ${Math.round(((y + h) / region.h) * 100)}%`);
        }
        raster.compact();
        return translate(region, ox, oy);
      });
      if (cmd) s.push(cmd, true);
      close();
    } catch (e) {
      ui.toast('error', 'Liquify failed', (e as Error).message);
      setBusy(false);
    } finally {
      prog.done();
    }
  };

  const tb = (patch: Partial<LiquifyBrush>) => setBrush((b) => ({ ...b, ...patch }));
  return (
    <Modal title="Liquify" onClose={close} onOk={apply} okDisabled={busy} width={1240} footerLeft={<span className="faint">Proxy {pw}×{ph}{scale > 1 ? ` (1:${scale})` : ''} · applied at full resolution · Alt reverses twirl / pucker / freeze</span>}>
      <div className="liquify">
        <div className="liquify-tools" role="toolbar" aria-label="Liquify tools">
          {LIQUIFY_TOOLS.map((t) => (
            <button key={t.id} className={`btn small ${tool === t.id ? 'active' : ''}`} title={`${t.label} (${t.key})`} aria-pressed={tool === t.id} onClick={() => setTool(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="liquify-view" style={{ width: VIEW_W, height: VIEW_H }}>
          <div className="checker" style={{ width: view.w, height: view.h, position: 'relative' }}>
            <canvas ref={canvasRef} width={pw} height={ph} style={{ width: view.w, height: view.h, display: 'block', cursor: 'none', touchAction: 'none' }} onPointerDown={onPointerDown} onPointerMove={(e) => drawCursor(toGrid(e))} onPointerLeave={() => drawCursor(null)} />
            <canvas ref={overlayRef} width={view.w} height={view.h} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
          </div>
        </div>
        <div className="liquify-props">
          <div className="section-title">Brush Tool Options</div>
          <div className="grid2">
            <span className="lbl">Size</span><NumberField value={brush.size} onChange={(v) => tb({ size: Math.max(1, Math.min(15000, v)) })} unit="px" width={80} />
            <span className="lbl">Pressure</span><Slider value={brush.pressure * 100} min={1} max={100} onChange={(v) => tb({ pressure: v / 100 })} />
            <span className="lbl">Density</span><Slider value={brush.density * 100} min={0} max={100} onChange={(v) => tb({ density: v / 100 })} />
            <span className="lbl">Rate</span><Slider value={brush.rate * 100} min={0} max={100} onChange={(v) => tb({ rate: v / 100 })} />
            <span className="lbl">Turbulence</span><Slider value={brush.turbulence * 100} min={0} max={100} onChange={(v) => tb({ turbulence: v / 100 })} />
          </div>
          <div className="section-title">Brush Reconstruct</div>
          <div className="row">
            <Slider value={reconstructAmt} min={1} max={100} onChange={setReconstructAmt} />
            <button className="btn small" onClick={() => { pushUndo(); mesh.reconstructAll(reconstructAmt / 100); redraw(); }}>Reconstruct</button>
          </div>
          <div className="row"><button className="btn small" onClick={() => { pushUndo(); mesh.resetField(); redraw(); }}>Restore All</button><button className="btn small" disabled={undoDepth === 0} onClick={undo}>Undo (Ctrl+Z)</button></div>
          <div className="section-title">Mask Options</div>
          <div className="row">
            <button className="btn small" onClick={() => { pushUndo(); mesh.freeze.fill(0); redraw(); }}>None</button>
            <button className="btn small" onClick={() => { pushUndo(); mesh.freeze.fill(1); redraw(); }}>Mask All</button>
            <button className="btn small" onClick={() => { pushUndo(); mesh.invertFreeze(); redraw(); }}>Invert</button>
          </div>
          <div className="section-title">View Options</div>
          <Check label="Show Mask" checked={showMask} onChange={setShowMask} />
          <Check label="Show Mesh" checked={showMesh} onChange={setShowMesh} />
        </div>
      </div>
    </Modal>
  );
}

