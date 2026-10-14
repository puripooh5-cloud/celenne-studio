/** Document tabs + interactive canvas viewport. */
import { buildCmykGrid, evalCmykGrid } from '../color/cmykDisplayGrid';
import { hasInkAppearance } from '../rendering/inkView';
import { imageSpace, rasterFromImage } from '../formats/decodedRaster';
import { convertRasterSpace, spaceOfDoc } from '../color/convertDocument';
import { useCallback, useEffect, useRef, useState } from 'react';
import { editor } from '../app/editor';
import { ui, useApp } from '../app/store';
import { useSession } from './hooks';
import { createViewportRendererAsync, RendererChoice, ViewportRenderer } from '../rendering/viewportRenderer';
import { setGpuCompositor } from '../rendering/renderEngine';
import type { Tool, ToolHost, ToolPointer } from '../tools/tool';
import { transformController, transformingSelection } from '../tools/transformTool';
import { traceContours } from '../selection/ops';
import { Icon } from './icons';
import { closeSession, openBytes } from '../app/fileOps';
import { platform } from '../app/platform/platform';
import { openContextMenu, PopupItem } from './menu/Menu';
import { run } from '../app/actions';
import { addGuide, guidesLocked, moveGuide, removeGuide } from '../app/ops/viewOps';
import { colorEngine } from '../color/cms';
import { isCmykDoc } from '../color/plates';
import { workingCmykProfile } from '../app/colorSettings';

const cmykDisplayKey = new WeakMap<object, string>();
const cmykGrids = new Map<string, Float32Array>();
import { textEditState, updateEditingText, commitTextEdit, onTextEdit } from '../tools/typeTool';
import { caretChanged, caretKey, caretPointer, drawCaret } from './textCaret';
import type { TextLayer } from '../document/types';
import { layerContentBounds } from '../rendering/bounds';
import { apply } from '../image-engine/matrix';
import { findImporter } from '../formats/registry';
import { decodeImageFile } from '../formats/codecs';
import { createPixelLayer } from '../document/layerFactory';
import { TiledRaster } from '../image-engine/tiledRaster';
import { CreateLayerCommand } from '../commands/layerCommands';
import { insertionPoint } from '../app/ops/common';
import { ALL_SPRING } from './springTools';
import { quadFromRect } from '../image-engine/matrix';

const PASTEBOARD: [number, number, number] = [0.106, 0.11, 0.122];

function DocTabs() {
  const sessions = useApp((s) => s.sessions);
  const active = useApp((s) => s.activeSessionId);
  const dragId = useRef<string | null>(null);
  if (!sessions.length) return null;
  return (
    <div className="doc-tabs" role="tablist">
      {sessions.map((s, i) => (
        <div
          key={s.id}
          role="tab"
          aria-selected={s.id === active}
          className={`doc-tab${s.id === active ? ' active' : ''}`}
          title={s.path ?? s.name}
          draggable
          onDragStart={() => (dragId.current = s.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            if (dragId.current && dragId.current !== s.id) editor.moveSession(dragId.current, i);
            dragId.current = null;
            e.stopPropagation();
          }}
          onMouseDown={(e) => {
            if (e.button === 1) { e.preventDefault(); closeSession(editor.session(s.id) ?? null); return; }
            editor.activate(s.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const sess = editor.session(s.id);
            openContextMenu([
              { type: 'item', label: 'Close', run: () => closeSession(sess ?? null) },
              { type: 'item', label: 'Close Others', run: () => { editor.activate(s.id); run('file.closeOthers'); } },
              { type: 'item', label: 'Close All', run: () => run('file.closeAll') },
              { type: 'separator' },
              { type: 'item', label: 'Duplicate', run: () => { editor.activate(s.id); run('file.duplicate'); } },
              { type: 'item', label: 'Document Properties…', run: () => { editor.activate(s.id); run('image.docInfo'); } },
            ], e.clientX, e.clientY);
          }}
        >
          <span className="name">{s.name}</span>
          {s.modified ? <span className="dot" title="Unsaved changes" /> : null}
          <span className="close" title="Close" onMouseDown={(e) => { e.stopPropagation(); closeSession(editor.session(s.id) ?? null); }}>
            <Icon name="close" size={11} />
          </span>
        </div>
      ))}
    </div>
  );
}

interface AntsCache {
  key: string;
  polys: number[][];
  scale: number;
  ox: number;
  oy: number;
  level: number;
  /** The outline these polygons trace, as an offset from the outline of mask version `base`. */
  base: number;
  bdx: number;
  bdy: number;
}

export function CanvasView() {
  const session = useSession();
  const viewRef = useRef<HTMLDivElement>(null);
  const glHostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [nativeCaret, setNativeCaret] = useState(true);
  const rulerH = useRef<HTMLCanvasElement>(null);
  const rulerV = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
  const sizeRef = useRef({ w: 1, h: 1, dpr: 1 });
  const dirty = useRef(true);
  const overlayDirty = useRef(true);
  const ants = useRef<AntsCache | null>(null);
  const pointerDown = useRef(false);
  const lastPointer = useRef<ToolPointer | null>(null);
  const spaceHeld = useRef(false);
  const guideDrag = useRef<{ id: string | null; orientation: 'horizontal' | 'vertical'; start: number } | null>(null);
  const panDrag = useRef<{ x: number; y: number } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [, setTick] = useState(0);
  const viewFlags = useApp((s) => s.view);
  const tool = useApp((s) => s.tool);
  useApp((s) => s.viewRev);

  // ---------------------------------------------------------------------------------- host
  const host = useCallback((): ToolHost | null => {
    const s = editor.active;
    if (!s) return null;
    return {
      editor,
      session: s,
      redraw: () => { overlayDirty.current = true; },
      setCursor: (c) => { if (viewRef.current) viewRef.current.style.cursor = c; },
      viewportSize: () => ({ w: sizeRef.current.w, h: sizeRef.current.h }),
    };
  }, []);
  useEffect(() => {
    editor.hostFactory = host;
    return () => { editor.hostFactory = null; };
  }, [host]);

  const currentTool = (): Tool | null => editor.currentTool;

  // ---------------------------------------------------------------------------------- renderer
  useEffect(() => {
    const hostEl = glHostRef.current;
    if (!hostEl) return;
    // A fresh canvas per mount: a canvas keeps its first context type forever, so reusing one whose
    // WebGL context was released would make both WebGL and the Canvas2D fallback unavailable.
    let disposed = false;
    let current: { renderer: ViewportRenderer; canvas: HTMLCanvasElement } | null = null;
    const newCanvas = () => {
      const c = document.createElement('canvas');
      c.className = 'gl';
      hostEl.appendChild(c);
      return c;
    };
    const mount = async (choice: RendererChoice) => {
      const first = newCanvas();
      const made = await createViewportRendererAsync(first, choice, () => { first.remove(); return newCanvas(); });
      if (disposed) { made.renderer.dispose(); made.canvas.remove(); return; }
      current = made;
      const r = made.renderer;
      rendererRef.current = r;
      const { w, h, dpr } = sizeRef.current;
      if (w > 1) r.resize(w, h, dpr);
      // GPU compositing runs on the WebGPU renderer's device.
      const gpu = r.kind === 'webgpu' && editor.prefs.performance.gpuCompositing ? (await import('../gpu/device')).currentGpu() : null;
      setGpuCompositor(gpu?.compositor ?? null);
      dirty.current = true;
      (window as unknown as { __celenneRenderer?: string }).__celenneRenderer = r.kind === 'webgpu' && gpu ? 'webgpu (GPU compositing)' : r.kind;
      (window as unknown as { __celenneViewport?: unknown }).__celenneViewport = { renderer: r, canvas: made.canvas };
      setTick((t) => t + 1);
    };
    const unmount = () => {
      if (!current) return;
      if (rendererRef.current === current.renderer) rendererRef.current = null;
      current.renderer.dispose();
      current.canvas.remove();
      current = null;
    };
    const p = editor.prefs.performance;
    const choice: RendererChoice = !p.gpuAcceleration ? 'canvas2d' : p.renderer ?? 'auto';
    void mount(choice);
    // A lost GPU (driver reset): WebGL 2 / CPU compositing take over at once, then WebGPU is tried again.
    let stopLost: (() => void) | null = null;
    void import('../gpu/device').then(({ onGpuLost }) => {
      if (disposed) return;
      stopLost = onGpuLost((why) => {
        console.warn('GPU device lost:', why);
        setGpuCompositor(null);
        unmount();
        ui.toast('warning', 'The GPU was reset; the display switched to WebGL 2.', 'Celenne tries the GPU again in a few seconds.');
        void mount('webgl2');
        setTimeout(() => { if (!disposed && choice !== 'webgl2' && choice !== 'canvas2d') { unmount(); void mount(choice); } }, 4000);
      });
    });
    return () => {
      disposed = true;
      stopLost?.();
      setGpuCompositor(null);
      unmount();
    };
  }, []);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { w: r.width, h: r.height, dpr };
      rendererRef.current?.resize(r.width, r.height, dpr);
      const o = overlayRef.current!;
      o.width = Math.round(r.width * dpr);
      o.height = Math.round(r.height * dpr);
      for (const rc of [rulerH.current, rulerV.current]) {
        if (!rc) continue;
        const rr = rc.getBoundingClientRect();
        rc.width = Math.round(rr.width * dpr);
        rc.height = Math.round(rr.height * dpr);
      }
      const s = editor.active;
      if (s && !s.fitted && r.width > 50) {
        s.view.fit(s.doc.width, s.doc.height, r.width, r.height, false, 24, 1);
        s.fitted = true;
        editor.updateTitle();
        ui.bump('viewRev');
      }
      dirty.current = overlayDirty.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Engine → repaint.
  useEffect(() => {
    if (!session) return;
    session.engine.onUpdate = () => { dirty.current = true; };
    const s = session;
    if (!s.fitted && sizeRef.current.w > 50) {
      s.view.fit(s.doc.width, s.doc.height, sizeRef.current.w, sizeRef.current.h, false, 24, 1);
      s.fitted = true;
      editor.updateTitle();
      ui.bump('viewRev');
    }
    dirty.current = overlayDirty.current = true;
    ants.current = null;
    return () => { s.engine.onUpdate = null; };
  }, [session]);

  useEffect(() => {
    dirty.current = overlayDirty.current = true;
  }, [viewFlags, tool]);
  useEffect(() => onTextEdit(() => setTick((t) => t + 1)), []);

  // Color management / proof LUT.
  const lutFor = () => {
    const s = editor.active;
    if (!s || !colorEngine.ready) return null;
    const vf = useApp.getState().view;
    const pp = workingCmykProfile();
    const proof = vf.proofColors ? { profile: pp, intent: editor.prefs.color.renderingIntent } : null;
    try {
      if (isCmykDoc(s.doc)) {
        // CMYK: the engine converts ink to the display itself (proofing to another CMYK profile when asked).
        const key = `${colorEngine.profileKey(s.doc.profile)}|${editor.prefs.color.displayProfile}|${proof && !colorEngine.sameProfile(pp, s.doc.profile) ? colorEngine.profileKey(pp) + proof.intent : ''}`;
        if (cmykDisplayKey.get(s.engine) !== key) {
          cmykDisplayKey.set(s.engine, key);
          const proofing = proof && !colorEngine.sameProfile(pp, s.doc.profile) ? proof : null;
          if (proofing) s.engine.setView({ cmykDisplay: colorEngine.cmyk8ToRgb8(s.doc.profile, editor.prefs.color.displayProfile, proofing), cmykGrid: null });
          else {
            // One display grid from the exact transform, evaluated by both the CPU and the GPU path.
            let grid = cmykGrids.get(key);
            if (!grid) {
              const x = colorEngine.transform(s.doc.profile, editor.prefs.color.displayProfile, 'relative', true);
              grid = buildCmykGrid((v, n) => x.run(v, n));
              cmykGrids.set(key, grid);
            }
            const g = grid;
            s.engine.setView({ cmykDisplay: (ink, n) => evalCmykGrid(g, ink, n), cmykGrid: g });
          }
        }
        return null;
      }
      // Duotone / Multichannel documents are shown as their printed inks, computed in sRGB.
      if (hasInkAppearance(s.doc)) return colorEngine.displayLUT({ name: 'sRGB IEC61966-2.1', builtin: 'srgb' }, editor.prefs.color.displayProfile, proof, vf.gamutWarning ? pp : null);
      return colorEngine.displayLUT(s.doc.profile, editor.prefs.color.displayProfile, proof, vf.gamutWarning ? pp : null);
    } catch {
      return null;
    }
  };
  useEffect(() => {
    colorEngine.init().then(() => { dirty.current = true; });
  }, []);

  // ---------------------------------------------------------------------------------- frame loop
  useEffect(() => {
    let raf = 0;
    let lastAnts = 0;
    let lastBlink = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const s = editor.active;
      const r = rendererRef.current;
      if (!s || !r) return;
      const eng = s.engine;
      let complete = true;
      if (dirty.current || eng.hasPendingWork()) {
        // While painting, leave frame time to the brush; moving layers has no such competition.
        eng.process(pointerDown.current && editor.currentToolId !== 'move' ? 6 : 12);
        complete = r.render(eng, s.view, { pasteboard: PASTEBOARD, checkerSize: editor.prefs.general.checkerSize, checkerLight: [1, 1, 1], checkerDark: [0.8, 0.8, 0.8], lut: lutFor() });
        dirty.current = !complete || eng.hasPendingWork();
        overlayDirty.current = true;
      }
      const hasSel = !s.doc.selection.isEmpty() && useApp.getState().view.showSelectionEdges && !useApp.getState().quickMask;
      if (hasSel && t - lastAnts > 90) { overlayDirty.current = true; lastAnts = t; }
      // The text caret blinks.
      if (textEditState() && t - lastBlink > 100) { overlayDirty.current = true; lastBlink = t; }
      if (overlayDirty.current) {
        overlayDirty.current = false;
        drawOverlay(s, t);
        drawRulers(s);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const drawOverlay = (s: NonNullable<typeof editor.active>, t: number) => {
    const c = overlayRef.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const { dpr, w, h } = sizeRef.current;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = s.view;
    const flags = useApp.getState().view;
    const doc = s.doc;
    // Canvas border.
    const corners = [v.docToScreen(0, 0), v.docToScreen(doc.width, 0), v.docToScreen(doc.width, doc.height), v.docToScreen(0, doc.height)];
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 1;
    g.beginPath();
    corners.forEach((p, i) => (i ? g.lineTo(p.x + 0.5, p.y + 0.5) : g.moveTo(p.x + 0.5, p.y + 0.5)));
    g.closePath();
    g.stroke();
    if (flags.extras) {
      // Pixel grid.
      if (flags.pixelGrid && v.zoom >= 8 && v.rotation === 0) {
        const vis = v.visibleDocRect(w, h);
        const x0 = Math.max(0, vis.x), x1 = Math.min(doc.width, vis.x + vis.w), y0 = Math.max(0, vis.y), y1 = Math.min(doc.height, vis.y + vis.h);
        g.strokeStyle = 'rgba(128,128,128,0.35)';
        g.beginPath();
        for (let x = x0; x <= x1; x++) { const a = v.docToScreen(x, y0), b = v.docToScreen(x, y1); g.moveTo(Math.round(a.x) + 0.5, a.y); g.lineTo(Math.round(b.x) + 0.5, b.y); }
        for (let y = y0; y <= y1; y++) { const a = v.docToScreen(x0, y), b = v.docToScreen(x1, y); g.moveTo(a.x, Math.round(a.y) + 0.5); g.lineTo(b.x, Math.round(b.y) + 0.5); }
        g.stroke();
      }
      // Grid.
      if (flags.grid) {
        const sp = doc.grid.spacing, sub = Math.max(1, doc.grid.subdivisions);
        const step = sp / sub;
        if (step * v.zoom >= 4) {
          for (let i = 0, x = 0; x <= doc.width; x += step, i++) {
            const a = v.docToScreen(x, 0), b = v.docToScreen(x, doc.height);
            g.strokeStyle = i % sub === 0 ? 'rgba(120,150,255,0.55)' : 'rgba(120,150,255,0.2)';
            g.beginPath(); g.moveTo(a.x + 0.5, a.y); g.lineTo(b.x + 0.5, b.y); g.stroke();
          }
          for (let i = 0, y = 0; y <= doc.height; y += step, i++) {
            const a = v.docToScreen(0, y), b = v.docToScreen(doc.width, y);
            g.strokeStyle = i % sub === 0 ? 'rgba(120,150,255,0.55)' : 'rgba(120,150,255,0.2)';
            g.beginPath(); g.moveTo(a.x, a.y + 0.5); g.lineTo(b.x, b.y + 0.5); g.stroke();
          }
        }
      }
      // Guides.
      if (flags.guides) {
        g.strokeStyle = editor.prefs.guides.guideColor;
        for (const gd of doc.guides) {
          const a = gd.orientation === 'vertical' ? v.docToScreen(gd.position, -1e5) : v.docToScreen(-1e5, gd.position);
          const b = gd.orientation === 'vertical' ? v.docToScreen(gd.position, 1e5) : v.docToScreen(1e5, gd.position);
          g.beginPath(); g.moveTo(a.x + 0.5, a.y + 0.5); g.lineTo(b.x + 0.5, b.y + 0.5); g.stroke();
        }
      }
      // Marching ants.
      if (flags.showSelectionEdges && !doc.selection.isEmpty() && !useApp.getState().quickMask && !transformingSelection()) drawAnts(g, s, t);
      // Color samplers.
      useApp.getState().samplers.forEach((sp, i) => {
        const p = v.docToScreen(sp.x + 0.5, sp.y + 0.5);
        g.strokeStyle = '#000'; g.lineWidth = 3;
        g.beginPath(); g.arc(p.x, p.y, 5, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
        g.fillStyle = '#fff'; g.font = '10px system-ui'; g.fillText(String(i + 1), p.x + 7, p.y - 6);
      });
    }
    // Tool overlay (mode controllers first).
    const h0 = host();
    const tl = currentTool();
    if (h0 && tl?.drawOverlay) {
      g.save();
      tl.drawOverlay(h0, g);
      g.restore();
    }
    // Keep crop/transform overlays drawn even when another tool is not active.
    if (h0 && s.mode.kind === 'transform' && tl !== transformController) transformController.drawOverlay(h0, g);
    // The caret and selection of the text being edited, where the text engine draws the text.
    const te = textEditState();
    const tl2 = te && te.sessionId === s.id ? s.doc.getLayer(te.layerId) : null;
    if (tl2?.kind === 'text') {
      const drawn = drawCaret(g, textAreaRef.current, tl2, v, t);
      setNativeCaret((n) => (n === !drawn ? n : !drawn));
    }
  };

  const drawAnts = (g: CanvasRenderingContext2D, s: NonNullable<typeof editor.active>, t: number) => {
    const doc = s.doc;
    const v = s.view;
    const level = Math.max(0, Math.min(10, v.level(12)));
    const sc = 1 << level;
    const b = doc.selection.bounds(doc.bounds);
    if (!b) return;
    const lr = { x: Math.floor(b.x / sc), y: Math.floor(b.y / sc), w: Math.ceil((b.x + b.w) / sc) - Math.floor(b.x / sc), h: Math.ceil((b.y + b.h) / sc) - Math.floor(b.y / sc) };
    const key = `${doc.selection.version}:${level}:${lr.x},${lr.y},${lr.w},${lr.h}`;
    // Selected pixels being moved: the same outline, shifted (no re-tracing while dragging).
    const moved = doc.selection.movedOutline();
    let odx = 0, ody = 0;
    if (moved && ants.current && ants.current.base === moved.baseVersion && ants.current.level === level) {
      odx = moved.dx - ants.current.bdx;
      ody = moved.dy - ants.current.bdy;
    } else if (!ants.current || ants.current.key !== key) {
      if (lr.w * lr.h > 16e6) return;
      const m = doc.selection.mask.readFloat(lr, level);
      ants.current = { key, polys: traceContours(m, lr.w, lr.h), scale: sc, ox: lr.x, oy: lr.y, level, base: moved ? moved.baseVersion : doc.selection.version, bdx: moved?.mdx ?? 0, bdy: moved?.mdy ?? 0 };
    }
    const a = ants.current;
    g.save();
    g.beginPath();
    for (const poly of a.polys) {
      for (let i = 0; i < poly.length; i += 2) {
        const p = v.docToScreen((poly[i] + a.ox) * a.scale + odx, (poly[i + 1] + a.oy) * a.scale + ody);
        if (i === 0) g.moveTo(p.x, p.y);
        else g.lineTo(p.x, p.y);
      }
      g.closePath();
    }
    g.lineWidth = 1;
    g.strokeStyle = '#fff';
    g.setLineDash([]);
    g.stroke();
    g.strokeStyle = '#000';
    g.setLineDash([4, 4]);
    g.lineDashOffset = -Math.floor(t / 90) % 8;
    g.stroke();
    g.restore();
  };

  const drawRulers = (s: NonNullable<typeof editor.active>) => {
    if (!useApp.getState().view.rulers) return;
    const v = s.view;
    const unit = editor.prefs.general.units;
    const res = s.doc.canvas.resolution;
    const perUnit = unit === 'in' ? res : unit === 'cm' ? res / 2.54 : unit === 'mm' ? res / 25.4 : unit === 'pt' ? res / 72 : unit === 'pica' ? res / 6 : unit === 'percent' ? s.doc.width / 100 : 1;
    for (const [cv, horizontal] of [[rulerH.current, true], [rulerV.current, false]] as const) {
      if (!cv) continue;
      const g = cv.getContext('2d')!;
      const dpr = sizeRef.current.dpr;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#232429';
      g.fillRect(0, 0, cv.width, cv.height);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const len = horizontal ? cv.width / dpr : cv.height / dpr;
      const pxPerUnit = v.zoom * perUnit;
      const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
      const major = steps.find((st) => st * pxPerUnit >= 60) ?? 10000;
      const minor = major / (major % 5 === 0 ? 5 : 2);
      g.strokeStyle = '#6d707a';
      g.fillStyle = '#9b9ea8';
      g.font = '9px system-ui, sans-serif';
      g.lineWidth = 1;
      const origin = horizontal ? v.docToScreen(s.doc.rulerOrigin.x, 0).x : v.docToScreen(0, s.doc.rulerOrigin.y).y;
      const startU = Math.floor(-origin / pxPerUnit / minor) * minor;
      g.beginPath();
      for (let u = startU; (u * pxPerUnit + origin) < len; u += minor) {
        const p = Math.round(u * pxPerUnit + origin) + 0.5;
        const isMajor = Math.abs(u / major - Math.round(u / major)) < 1e-6;
        const tick = isMajor ? 20 : 5;
        if (horizontal) { g.moveTo(p, 20 - tick); g.lineTo(p, 20); } else { g.moveTo(20 - tick, p); g.lineTo(20, p); }
        if (isMajor) {
          const label = String(Math.round(u * 100) / 100);
          if (horizontal) g.fillText(label, p + 2, 9);
          else { g.save(); g.translate(9, p + 2); g.rotate(-Math.PI / 2); g.fillText(label, 0, 0); g.restore(); }
        }
      }
      g.stroke();
      // Cursor indicator.
      const cp = lastPointer.current;
      if (cp) {
        g.strokeStyle = '#3d8bfd';
        g.beginPath();
        if (horizontal) { g.moveTo(cp.sx + 0.5, 0); g.lineTo(cp.sx + 0.5, 20); } else { g.moveTo(0, cp.sy + 0.5); g.lineTo(20, cp.sy + 0.5); }
        g.stroke();
      }
    }
  };

  // ---------------------------------------------------------------------------------- input
  const toPointer = (e: PointerEvent | React.PointerEvent | React.MouseEvent, clickCount = 1): ToolPointer | null => {
    const s = editor.active;
    const el = viewRef.current;
    if (!s || !el) return null;
    const r = el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const d = s.view.screenToDoc(sx, sy);
    const pe = e as PointerEvent;
    return {
      x: d.x, y: d.y, sx, sy,
      pressure: pe.pressure ?? 1, tiltX: pe.tiltX ?? 0, tiltY: pe.tiltY ?? 0, twist: pe.twist ?? 0,
      button: e.button, buttons: e.buttons, shift: e.shiftKey, alt: e.altKey, mod: e.ctrlKey || e.metaKey,
      pointerType: pe.pointerType ?? 'mouse', time: performance.now(), clickCount,
    };
  };

  const spring = (): Tool | null => {
    // Space → hand; Ctrl+Space → zoom; Alt → eyedropper for painting tools.
    if (spaceHeld.current) return editor.tool(lastPointer.current?.mod ? 'zoom' : 'hand');
    return null;
  };

  const guideAt = (p: ToolPointer): string | null => {
    const s = editor.active;
    if (!s || !useApp.getState().view.guides || guidesLocked) return null;
    for (const gd of s.doc.guides) {
      const sp = gd.orientation === 'vertical' ? s.view.docToScreen(gd.position, p.y) : s.view.docToScreen(p.x, gd.position);
      if ((gd.orientation === 'vertical' ? Math.abs(sp.x - p.sx) : Math.abs(sp.y - p.sy)) < 4) return gd.id;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const s = editor.active;
    const h = host();
    if (!s || !h) return;
    viewRef.current?.focus();
    const p = toPointer(e);
    if (!p) return;
    lastPointer.current = p;
    if (e.button === 1 || (e.button === 0 && spaceHeld.current && !p.mod)) {
      panDrag.current = { x: e.clientX, y: e.clientY };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 2) return;
    // Guides (with the Move tool, like professional editors).
    if (editor.currentToolId === 'move' && s.mode.kind === 'none') {
      const gid = guideAt(p);
      if (gid) {
        const gd = s.doc.guideById(gid)!;
        guideDrag.current = { id: gid, orientation: gd.orientation, start: gd.position };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }
    }
    const t = spring() ?? (p.alt && ALL_SPRING.altEyedropper.includes(editor.currentToolId) ? editor.tool('eyedropper') : null) ?? currentTool();
    if (!t) return;
    pointerDown.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    activeTool.current = t;
    t.down?.(h, p);
    overlayDirty.current = true;
  };
  const activeTool = useRef<Tool | null>(null);

  // The cursor position feeds the status bar and Info panel (which samples the composite), so it is
  // published at most once per frame and only when the pixel under the pointer changes.
  const cursorPending = useRef<{ x: number; y: number; inside: boolean } | null>(null);
  const publishCursor = (x: number, y: number, inside: boolean) => {
    const prev = useApp.getState().cursor;
    if (Math.floor(prev.x) === Math.floor(x) && Math.floor(prev.y) === Math.floor(y) && prev.inside === inside && !cursorPending.current) return;
    const first = !cursorPending.current;
    cursorPending.current = { x, y, inside };
    if (first) requestAnimationFrame(() => {
      const c = cursorPending.current;
      cursorPending.current = null;
      if (c) ui.set({ cursor: c });
    });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = editor.active;
    const h = host();
    if (!s || !h) return;
    const events = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [e.nativeEvent];
    if (panDrag.current) {
      s.view.panX += e.clientX - panDrag.current.x;
      s.view.panY += e.clientY - panDrag.current.y;
      panDrag.current = { x: e.clientX, y: e.clientY };
      dirty.current = overlayDirty.current = true;
      return;
    }
    const p = toPointer(e);
    if (!p) return;
    lastPointer.current = p;
    if (guideDrag.current) {
      const gd = guideDrag.current;
      const pos = gd.orientation === 'vertical' ? Math.round(p.x) : Math.round(p.y);
      if (gd.id) {
        const g = s.doc.guideById(gd.id);
        if (g) g.position = pos;
      }
      overlayDirty.current = true;
      return;
    }
    publishCursor(p.x, p.y, p.x >= 0 && p.y >= 0 && p.x < s.doc.width && p.y < s.doc.height);
    const t = pointerDown.current ? activeTool.current : spring() ?? currentTool();
    if (pointerDown.current && t?.move) {
      for (const ev of events.length > 1 ? events : [e.nativeEvent]) {
        const pp = toPointer(ev as PointerEvent);
        if (pp) t.move(h, pp);
      }
    } else if (!pointerDown.current) {
      t?.hover?.(h, p);
      const cur = t?.cursor?.(h, p) ?? 'default';
      if (viewRef.current) viewRef.current.style.cursor = guideAt(p) && editor.currentToolId === 'move' ? 'row-resize' : cur;
      overlayDirty.current = true;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const s = editor.active;
    const h = host();
    if (panDrag.current) { panDrag.current = null; return; }
    if (guideDrag.current && s) {
      const gd = guideDrag.current;
      guideDrag.current = null;
      const p = toPointer(e);
      if (gd.id && p) {
        const g = s.doc.guideById(gd.id);
        const outside = gd.orientation === 'vertical' ? p.sx < 0 : p.sy < 0;
        if (g) {
          const pos = g.position;
          g.position = gd.start;
          if (outside) removeGuide(gd.id);
          else if (pos !== gd.start) moveGuide(gd.id, pos, gd.start);
        }
      } else if (!gd.id && p) {
        const pos = gd.orientation === 'vertical' ? Math.round(p.x) : Math.round(p.y);
        if (p.sx >= 0 && p.sy >= 0) addGuide(gd.orientation, pos);
      }
      overlayDirty.current = true;
      return;
    }
    if (!pointerDown.current || !h) return;
    pointerDown.current = false;
    const p = toPointer(e);
    const t = activeTool.current;
    activeTool.current = null;
    // Never leave a tool mid-drag (it would stay "busy" and block shortcuts).
    if (p) t?.up?.(h, p);
    else t?.cancel?.(h);
    overlayDirty.current = dirty.current = true;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const h = host();
    const p = toPointer(e, 2);
    if (h && p) currentTool()?.doubleClick?.(h, p);
  };

  const onWheel = (e: React.WheelEvent) => {
    const s = editor.active;
    if (!s) return;
    const r = viewRef.current!.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (e.ctrlKey || e.altKey) {
      const factor = Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 30 : 1));
      s.view.zoomAt(sx, sy, s.view.zoom * factor);
      editor.updateTitle();
    } else if (e.shiftKey) s.view.panX -= e.deltaY + e.deltaX;
    else {
      s.view.panX -= e.deltaX;
      s.view.panY -= e.deltaY;
    }
    dirty.current = overlayDirty.current = true;
    ui.bump('viewRev');
  };

  // Keyboard: spring-loaded tools.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e)) {
        if (!spaceHeld.current) {
          spaceHeld.current = true;
          if (viewRef.current) viewRef.current.style.cursor = 'grab';
        }
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld.current = false;
    };
    // Switching windows while Space is held never delivers the keyup: don't get stuck panning.
    const blur = () => {
      spaceHeld.current = false;
      if (viewRef.current) viewRef.current.style.cursor = '';
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Context menu.
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const s = editor.active;
    if (!s) return;
    const hasSel = !s.doc.selection.isEmpty();
    const items: PopupItem[] = hasSel
      ? [
          { type: 'item', label: 'Deselect', run: () => run('select.deselect') },
          { type: 'item', label: 'Select Inverse', run: () => run('select.inverse') },
          { type: 'item', label: 'Feather…', run: () => run('select.modify.feather') },
          { type: 'item', label: 'Select and Mask…', run: () => run('select.selectAndMask') },
          { type: 'separator' },
          { type: 'item', label: 'Save Selection…', run: () => run('select.save') },
          { type: 'item', label: 'Make Work Path…', run: async () => { const { selectionToPath } = await import('../app/ops/selectOps'); const p = selectionToPath(); if (p) (await import('../tools/shapeTools')).setWorkPath(s, p, 'Make Work Path'); } },
          { type: 'separator' },
          { type: 'item', label: 'Layer via Copy', run: () => run('layer.viaCopy') },
          { type: 'item', label: 'Layer via Cut', run: () => run('layer.viaCut') },
          { type: 'separator' },
          { type: 'item', label: 'Content-Aware Fill', run: () => run('edit.contentAwareFill') },
          { type: 'item', label: 'Fill…', run: () => run('edit.fill') },
          { type: 'item', label: 'Stroke…', run: () => run('edit.stroke') },
          { type: 'separator' },
          { type: 'item', label: 'Free Transform', run: () => run('edit.freeTransform') },
          { type: 'item', label: 'Transform Selection', run: () => run('select.transform'), soon: true },
        ]
      : [
          { type: 'item', label: 'Select All', run: () => run('select.all') },
          { type: 'item', label: 'Reselect', run: () => run('select.reselect') },
          { type: 'item', label: 'Select Subject', run: () => run('select.subject') },
          { type: 'separator' },
          { type: 'item', label: 'New Layer', run: () => run('layer.new') },
          { type: 'item', label: 'Duplicate Layer', run: () => run('layer.duplicate') },
          { type: 'item', label: 'Free Transform', run: () => run('edit.freeTransform') },
          { type: 'separator' },
          { type: 'item', label: 'Paste', run: () => run('edit.paste') },
          { type: 'separator' },
          { type: 'item', label: 'Fit on Screen', run: () => run('view.fit') },
          { type: 'item', label: '100%', run: () => run('view.100') },
        ];
    openContextMenu(items, e.clientX, e.clientY);
  };

  // Drag & drop.
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const files = [...e.dataTransfer.files];
    for (const f of files) {
      const opened = await platform().fileFromDrop(f);
      const s = editor.active;
      const isPsd = /\.(psd|psb)$/i.test(f.name);
      if (!s || isPsd || !findImporter(opened.data, f.name)) {
        await openBytes(opened.name, opened.path, opened.data);
        continue;
      }
      // Drop an image onto an open document: new layer, centered at the drop point.
      try {
        const img = await decodeImageFile(opened.data, f.name);
        const r = viewRef.current!.getBoundingClientRect();
        const d = s.view.screenToDoc(e.clientX - r.left, e.clientY - r.top);
        const layer = createPixelLayer(f.name.replace(/\.[^.]+$/, ''), s.doc.canvas.bitDepth);
        layer.raster = rasterFromImage(img, s.doc.canvas.bitDepth);
        // The image's own colour space (sRGB when untagged) → the document's.
        convertRasterSpace(layer.raster, imageSpace(img), spaceOfDoc(s.doc));
        layer.x = Math.round(d.x - img.width / 2);
        layer.y = Math.round(d.y - img.height / 2);
        const { parentId, index } = insertionPoint(s);
        s.push(new CreateLayerCommand('Place Dropped Image', layer, parentId, index));
        s.setActive(layer.id);
        void quadFromRect;
      } catch (err) {
        ui.toast('error', `Could not place "${f.name}"`, (err as Error).message);
      }
    }
  };

  // The text layer being edited, and pointer input on it (placed by the text engine's layout).
  const editedText = () => {
    const e = textEditState();
    const l = e && session && e.sessionId === session.id ? session.doc.getLayer(e.layerId) : null;
    return l?.kind === 'text' ? l : null;
  };
  const textPointer = (phase: 'down' | 'move' | 'up', e: React.PointerEvent<HTMLTextAreaElement>, l: TextLayer) => {
    const r = viewRef.current?.getBoundingClientRect();
    if (!r || !session) return false;
    const done = caretPointer(phase, e, e.clientX - r.left, e.clientY - r.top, e.currentTarget, l, session.view);
    if (done) overlayDirty.current = true;
    return done;
  };

  // Text editing overlay geometry.
  const te = textEditState();
  let textBox: React.CSSProperties | null = null;
  let textValue = '';
  if (te && session && te.sessionId === session.id) {
    const l = session.doc.getLayer(te.layerId);
    if (l?.kind === 'text') {
      textValue = l.text.text;
      const b = layerContentBounds(l) ?? (() => {
        const p = apply(l.text.transform, 0, 0);
        return { x: p.x, y: p.y - l.text.runs[0].style.fontSize, w: 40, h: l.text.runs[0].style.fontSize * 1.3 };
      })();
      const box = l.text.kind === 'paragraph' && l.text.box ? { x: l.text.transform[4] + l.text.box.x, y: l.text.transform[5] + l.text.box.y, w: l.text.box.w, h: l.text.box.h } : b;
      const a = session.view.docToScreen(box.x, box.y), c = session.view.docToScreen(box.x + box.w, box.y + box.h);
      textBox = { left: Math.min(a.x, c.x) - 2, top: Math.min(a.y, c.y) - 2, width: Math.max(20, Math.abs(c.x - a.x) + 30), height: Math.max(20, Math.abs(c.y - a.y) + 6), fontSize: Math.max(8, l.text.runs[0].style.fontSize * session.view.zoom * Math.hypot(l.text.transform[0], l.text.transform[1])), lineHeight: 1.2 };
    }
  }

  const rulers = viewFlags.rulers;
  return (
    <div className="doc-area" onDragOver={(e) => { e.preventDefault(); setDropping(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false); }} onDrop={onDrop}>
      <DocTabs />
      <div className={`canvas-wrap${rulers ? '' : ' no-rulers'}`}>
        <div className="ruler corner" style={{ display: rulers ? undefined : 'none' }} />
        <div className="ruler h" style={{ display: rulers ? undefined : 'none' }} onPointerDown={(e) => { if (editor.active) { guideDrag.current = { id: null, orientation: 'horizontal', start: 0 }; viewRef.current?.setPointerCapture?.(e.pointerId); } }}>
          <canvas ref={rulerH} />
        </div>
        <div className="ruler v" style={{ display: rulers ? undefined : 'none' }} onPointerDown={(e) => { if (editor.active) { guideDrag.current = { id: null, orientation: 'vertical', start: 0 }; viewRef.current?.setPointerCapture?.(e.pointerId); } }}>
          <canvas ref={rulerV} />
        </div>
        <div
          className="viewport"
          ref={viewRef}
          tabIndex={0}
          aria-label="Canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={(e) => { if (pointerDown.current) onPointerUp(e); }}
          onPointerLeave={() => { ui.set((s) => ({ cursor: { ...s.cursor, inside: false } })); overlayDirty.current = true; }}
          onDoubleClick={onDoubleClick}
          onWheel={onWheel}
          onContextMenu={onContextMenu}
        >
          <div className="gl-host" ref={glHostRef} />
          <canvas className="overlay" ref={overlayRef} />
          {textBox && (
            <textarea
              ref={textAreaRef}
              className={`text-editor${nativeCaret ? ' native-caret' : ''}`}
              autoFocus
              spellCheck={false}
              style={textBox}
              value={textValue}
              onChange={(e) => { updateEditingText(e.target.value); caretChanged(); dirty.current = true; setTick((t) => t + 1); }}
              onSelect={() => { caretChanged(); overlayDirty.current = true; }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commitTextEdit(); return; }
                const l = editedText();
                if (l && caretKey(e, e.currentTarget, l)) overlayDirty.current = true;
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                const l = editedText();
                if (l && session && textPointer('down', e, l)) { e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); }
              }}
              onPointerMove={(e) => { const l = editedText(); if (l) textPointer('move', e, l); }}
              onPointerUp={(e) => { const l = editedText(); if (l) textPointer('up', e, l); }}
            />
          )}
          {!session && <Welcome />}
          {dropping && <div className="drop-hint">Drop to open{session ? ' (PSD) or place as a new layer (images)' : ''}</div>}
        </div>
      </div>
    </div>
  );
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function Welcome() {
  const recent = useApp((s) => s.recentFiles);
  return (
    <div className="welcome">
      <div className="card">
        <h1>Celenne Studio</h1>
        <div className="sub">Professional layered image editing with an editable PSD document architecture.</div>
        <div className="actions">
          <button className="btn primary" onClick={() => run('file.new')}>New Document… <span className="faint">Ctrl+N</span></button>
          <button className="btn" onClick={() => run('file.open')}>Open… <span className="faint">Ctrl+O</span></button>
          <button className="btn" onClick={() => run('file.recovered')}>Recovered Documents</button>
        </div>
        <div className="muted" style={{ marginBottom: 8 }}>Or drop PSD, PSB, PNG, JPEG, TIFF, WebP, GIF, BMP or SVG files here.</div>
        {recent.length > 0 && (
          <div className="recent">
            <div className="section-title">Recent</div>
            {recent.slice(0, 12).map((p) => (
              <div key={p} className="recent-item" onClick={() => run('file.openPath', { path: p })} title={p}>
                <span>{p.split(/[\\/]/).pop()}</span>
                <span className="path">{p}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
