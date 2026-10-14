/** Image-engine tests: rasters, blending, compositing, masks, adjustments, filters, history, selection, brush, liquify. */
import { describe, expect, it } from 'vitest';
import { TiledRaster } from '../../src/image-engine/tiledRaster';
import { BLEND_MODES, compositeSpan } from '../../src/image-engine/blend';
import { compositeRegion } from '../../src/rendering/compositor';
import { createAdjustmentLayer, createFillLayer, createGroupLayer, createMask } from '../../src/document/layerFactory';
import { defaultAdjustment } from '../../src/adjustments/types';
import { applyAdjustmentToStraight, curveLUT } from '../../src/adjustments/apply';
import { BUILTIN_FILTERS } from '../../src/filters/builtin';
import { defaults } from '../../src/filters/types';
import { runFilterSync } from '../../src/filters/runner';
import { History } from '../../src/history/history';
import { SetLayerPropsCommand, DeleteLayerCommand } from '../../src/commands/layerCommands';
import { Selection } from '../../src/selection/selection';
import { feather, traceContours } from '../../src/selection/ops';
import { DabEmitter } from '../../src/brush/engine';
import { defaultBrush } from '../../src/tools/toolTypes';
import { LiquifyMesh, warpWithField, DEFAULT_LIQUIFY_BRUSH } from '../../src/filters/liquify';
import { invert, multiply, compose, decompose } from '../../src/image-engine/matrix';
import { warpRaster } from '../../src/image-engine/resample';
import { add, newDoc, solidLayer } from '../helpers/build';

const px = (doc: ReturnType<typeof newDoc>, x: number, y: number) => Array.from(compositeRegion(doc, { x, y, w: 1, h: 1 }, { level: 0 })).map((v) => Math.round(v * 1000) / 1000);

describe('TiledRaster', () => {
  it('snapshots are copy-on-write and restore exactly', () => {
    const r = new TiledRaster(4, 8, 0);
    r.writeFloat({ x: 0, y: 0, w: 2, h: 1 }, new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]));
    const snap = r.snapshot();
    r.writeFloat({ x: 0, y: 0, w: 1, h: 1 }, new Float32Array([0, 0, 1, 1]));
    expect(Array.from(r.readFloat({ x: 0, y: 0, w: 1, h: 1 }))).toEqual([0, 0, 1, 1]);
    r.restore(snap);
    expect(Array.from(r.readFloat({ x: 0, y: 0, w: 1, h: 1 }))).toEqual([1, 0, 0, 1]);
  });

  it('keeps 16-bit precision', () => {
    const r = new TiledRaster(1, 16, 0);
    const v = 12345 / 65535;
    r.writeFloat({ x: 3, y: 3, w: 1, h: 1 }, new Float32Array([v]));
    expect(Math.round(r.readFloat({ x: 3, y: 3, w: 1, h: 1 })[0] * 65535)).toBe(12345);
  });

  it('uses the fill value for untouched tiles, including pyramid levels', () => {
    const r = new TiledRaster(1, 8, 1);
    expect(r.readFloat({ x: 1000, y: -500, w: 1, h: 1 })[0]).toBe(1);
    r.writeFloat({ x: 0, y: 0, w: 2, h: 2 }, new Float32Array(4));
    // Level 1 pixel (0,0) averages the 4 zero pixels.
    expect(r.readFloat({ x: 0, y: 0, w: 1, h: 1 }, 1)[0]).toBe(0);
    // A far-away level-1 pixel comes from the fill value.
    expect(r.readFloat({ x: 600, y: 600, w: 1, h: 1 }, 1)[0]).toBe(1);
  });

  it('computes content bounds sparsely', () => {
    const r = new TiledRaster(4, 8, 0);
    r.writeFloat({ x: 300, y: 10, w: 1, h: 1 }, new Float32Array([1, 1, 1, 1]));
    expect(r.contentBounds()).toEqual({ x: 300, y: 10, w: 1, h: 1 });
  });
});

describe('Blend modes', () => {
  it('normal at 100% replaces, at 50% mixes', () => {
    const dst = new Float32Array([0, 0, 1, 1]);
    compositeSpan('normal', dst, 0, new Float32Array([1, 0, 0, 1]), 0, 1, { opacity: 1 });
    expect(Array.from(dst)).toEqual([1, 0, 0, 1]);
    const d2 = new Float32Array([0, 0, 1, 1]);
    compositeSpan('normal', d2, 0, new Float32Array([1, 0, 0, 1]), 0, 1, { opacity: 0.5 });
    expect(Array.from(d2).map((v) => +v.toFixed(3))).toEqual([0.5, 0, 0.5, 1]);
  });

  it('multiply and screen follow the W3C formulas', () => {
    const m = new Float32Array([0.5, 0.5, 0.5, 1]);
    compositeSpan('multiply', m, 0, new Float32Array([0.5, 1, 0, 1]), 0, 1, { opacity: 1 });
    expect(Array.from(m).map((v) => +v.toFixed(3))).toEqual([0.25, 0.5, 0, 1]);
    const s = new Float32Array([0.5, 0.5, 0.5, 1]);
    compositeSpan('screen', s, 0, new Float32Array([0.5, 1, 0, 1]), 0, 1, { opacity: 1 });
    expect(Array.from(s).map((v) => +v.toFixed(3))).toEqual([0.75, 1, 0.5, 1]);
  });

  it('every mode produces finite, in-range results and respects zero opacity', () => {
    for (const mode of BLEND_MODES.map((m) => m.id).filter((m) => m !== 'passThrough')) {
      for (const [b, sc] of [[[0.2, 0.5, 0.9, 1], [0.7, 0.1, 0.4, 1]], [[0, 0, 0, 0], [1, 1, 1, 0.5]], [[1, 1, 1, 1], [0, 0, 0, 1]]] as const) {
        const d = new Float32Array(b);
        compositeSpan(mode, d, 0, new Float32Array(sc), 0, 1, { opacity: 1, x0: 0, y0: 0, width: 1 });
        for (const v of d) {
          expect(Number.isFinite(v), mode).toBe(true);
          expect(v, mode).toBeGreaterThanOrEqual(-1e-6);
          expect(v, mode).toBeLessThanOrEqual(1 + 1e-6);
        }
        const z = new Float32Array(b);
        compositeSpan(mode, z, 0, new Float32Array(sc), 0, 1, { opacity: 0 });
        expect(Array.from(z), mode).toEqual(Array.from(b).map((v) => Math.fround(v)));
      }
    }
  });
});

describe('Compositor', () => {
  it('stacks layers with opacity and hidden layers', () => {
    const doc = newDoc(8, 8);
    add(doc, solidLayer(doc, 'bg', 0, 0, 8, 8, [1, 1, 1, 1]));
    const red = add(doc, solidLayer(doc, 'red', 0, 0, 4, 4, [1, 0, 0, 1]));
    red.opacity = 0.5;
    expect(px(doc, 1, 1)).toEqual([1, 0.5, 0.5, 1]);
    expect(px(doc, 6, 6)).toEqual([1, 1, 1, 1]);
    red.visible = false;
    expect(px(doc, 1, 1)).toEqual([1, 1, 1, 1]);
  });

  it('applies layer masks (with density)', () => {
    const doc = newDoc(8, 8);
    add(doc, solidLayer(doc, 'bg', 0, 0, 8, 8, [1, 1, 1, 1]));
    const red = add(doc, solidLayer(doc, 'red', 0, 0, 8, 8, [1, 0, 0, 1]));
    red.mask = createMask(true);
    red.mask.raster.writeFloat({ x: 0, y: 0, w: 4, h: 8 }, new Float32Array(32));
    expect(px(doc, 1, 1)).toEqual([1, 1, 1, 1]);
    expect(px(doc, 6, 1)).toEqual([1, 0, 0, 1]);
    red.mask.density = 0.5;
    expect(px(doc, 1, 1)).toEqual([1, 0.5, 0.5, 1]);
  });

  it('clips layers to the base alpha', () => {
    const doc = newDoc(8, 8);
    add(doc, solidLayer(doc, 'base', 0, 0, 4, 8, [0, 0, 1, 1]));
    const clip = add(doc, solidLayer(doc, 'clip', 0, 0, 8, 8, [1, 0, 0, 1]));
    clip.clipping = true;
    expect(px(doc, 1, 1)).toEqual([1, 0, 0, 1]);
    expect(px(doc, 6, 1)).toEqual([0, 0, 0, 0]);
  });

  it('isolates normal groups and passes through pass-through groups', () => {
    const doc = newDoc(4, 4);
    add(doc, solidLayer(doc, 'bg', 0, 0, 4, 4, [0.5, 0.5, 0.5, 1]));
    const g = createGroupLayer('g');
    add(doc, g);
    const m = add(doc, solidLayer(doc, 'm', 0, 0, 4, 4, [0.5, 0.5, 0.5, 1]), g);
    m.blendMode = 'multiply';
    g.blendMode = 'passThrough';
    // 0.5 is stored as 128/255 in 8-bit, so the product is (128/255)² ≈ 0.252.
    px(doc, 0, 0).forEach((v, i) => expect(v).toBeCloseTo([0.252, 0.252, 0.252, 1][i], 3));
    // Isolated: multiply inside an empty group has no backdrop → the layer shows as-is.
    g.blendMode = 'normal';
    px(doc, 0, 0).forEach((v, i) => expect(v).toBeCloseTo([0.502, 0.502, 0.502, 1][i], 3));
  });

  it('renders adjustment and fill layers non-destructively', () => {
    const doc = newDoc(4, 4);
    const bg = add(doc, solidLayer(doc, 'bg', 0, 0, 4, 4, [0.2, 0.4, 0.6, 1]));
    const inv = add(doc, createAdjustmentLayer(defaultAdjustment('invert'), 'Invert'));
    expect(px(doc, 0, 0)).toEqual([0.8, 0.6, 0.4, 1]);
    inv.visible = false;
    expect(px(doc, 0, 0)).toEqual([0.2, 0.4, 0.6, 1]);
    const fill = add(doc, createFillLayer({ type: 'solid', color: { r: 1, g: 0, b: 0 } }, 'Fill'));
    fill.opacity = 0.5;
    expect(px(doc, 0, 0)).toEqual([0.6, 0.2, 0.3, 1]);
    // The source pixels were never modified.
    expect(Array.from((bg as { raster: TiledRaster }).raster.readFloat({ x: 0, y: 0, w: 1, h: 1 })).map((v) => +v.toFixed(2))).toEqual([0.2, 0.4, 0.6, 1]);
  });

  it('pyramid levels give the same average colour', () => {
    const doc = newDoc(512, 512);
    add(doc, solidLayer(doc, 'bg', 0, 0, 512, 512, [0.25, 0.5, 0.75, 1]));
    const l1 = Array.from(compositeRegion(doc, { x: 10, y: 10, w: 1, h: 1 }, { level: 2 })).map((v) => +v.toFixed(2));
    expect(l1).toEqual([0.25, 0.5, 0.75, 1]);
  });
});

describe('Adjustments', () => {
  it('identity curve is the identity', () => {
    const lut = curveLUT([{ x: 0, y: 0 }, { x: 255, y: 255 }]);
    for (let i = 0; i < lut.length; i += 17) expect(lut[i]).toBeCloseTo(i / (lut.length - 1), 3);
  });

  it('default adjustments of every type are (near) identity, except inverting/thresholding ones', () => {
    const skip = new Set(['invert', 'threshold', 'posterize', 'gradientMap', 'blackWhite', 'photoFilter', 'colorLookup']);
    for (const t of ['brightnessContrast', 'levels', 'curves', 'exposure', 'vibrance', 'hueSaturation', 'colorBalance', 'channelMixer', 'selectiveColor'] as const) {
      if (skip.has(t)) continue;
      const buf = new Float32Array([0.2, 0.5, 0.8, 1, 0.9, 0.1, 0.3, 1]);
      applyAdjustmentToStraight(defaultAdjustment(t), buf, 2);
      const expected = [0.2, 0.5, 0.8, 1, 0.9, 0.1, 0.3, 1];
      buf.forEach((v, i) => expect(v, t).toBeCloseTo(expected[i], 2));
    }
  });
});

describe('Filters', () => {
  const base = { scale: 1, originX: 0, originY: 0, bounds: { x: 0, y: 0, w: 16, h: 16 }, foreground: [0, 0, 0] as [number, number, number], background: [1, 1, 1] as [number, number, number] };

  it('gaussian blur leaves a constant image unchanged', () => {
    const def = BUILTIN_FILTERS.find((f) => f.id === 'gaussianBlur')!;
    const img = { w: 16, h: 16, ch: 4 as const, data: new Float32Array(16 * 16 * 4) };
    for (let i = 0; i < 256; i++) img.data.set([0.3, 0.6, 0.9, 1], i * 4);
    const out = runFilterSync(def, { ...defaults(def), radius: 3 }, img, base);
    for (let i = 0; i < 256; i++) expect(out.data[i * 4 + 1]).toBeCloseTo(0.6, 4);
  });

  it('every built-in filter runs with default parameters and returns finite pixels', () => {
    for (const def of BUILTIN_FILTERS) {
      if (def.comingSoon) continue;
      const img = { w: 16, h: 16, ch: 4 as const, data: new Float32Array(16 * 16 * 4) };
      for (let i = 0; i < 256; i++) img.data.set([(i % 16) / 15, ((i >> 4) % 16) / 15, 0.5, 1], i * 4);
      const out = runFilterSync(def, defaults(def), img, base);
      expect(out.data.length, def.id).toBe(16 * 16 * 4);
      for (const v of out.data) expect(Number.isFinite(v), def.id).toBe(true);
    }
  });
});

describe('History', () => {
  it('undoes and redoes layer property changes and deletion', () => {
    const doc = newDoc(4, 4);
    const l = add(doc, solidLayer(doc, 'a', 0, 0, 4, 4, [1, 0, 0, 1]));
    const h = new History(doc);
    h.push(new SetLayerPropsCommand('Opacity', l.id, { opacity: 1 }, { opacity: 0.25 }));
    expect(doc.getLayer(l.id)!.opacity).toBe(0.25);
    h.push(new DeleteLayerCommand([l.id]));
    expect(doc.getLayer(l.id)).toBeFalsy();
    h.undo();
    expect(doc.getLayer(l.id)!.opacity).toBe(0.25);
    h.undo();
    expect(doc.getLayer(l.id)!.opacity).toBe(1);
    h.redo();
    h.redo();
    expect(doc.getLayer(l.id)).toBeFalsy();
  });
});

describe('Selection', () => {
  it('select all / invert / combine', () => {
    const s = new Selection();
    expect(s.isEmpty()).toBe(true);
    s.selectAll();
    expect(s.bounds({ x: 0, y: 0, w: 10, h: 10 })).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    s.invert();
    expect(s.isEmpty()).toBe(true);
    s.combine({ x: 2, y: 2, w: 3, h: 3 }, new Float32Array(9).fill(1), 'add');
    expect(s.bounds({ x: 0, y: 0, w: 10, h: 10 })).toEqual({ x: 2, y: 2, w: 3, h: 3 });
    s.combine({ x: 2, y: 2, w: 1, h: 3 }, new Float32Array(3).fill(1), 'subtract');
    expect(s.coverageAt(2, 3)).toBe(0);
    expect(s.coverageAt(3, 3)).toBe(1);
  });

  it('feather softens edges and contour tracing finds the outline', () => {
    const s = new Selection();
    s.combine({ x: 10, y: 10, w: 10, h: 10 }, new Float32Array(100).fill(1), 'replace');
    feather(s, { x: 0, y: 0, w: 40, h: 40 }, 2);
    const edge = s.coverageAt(10, 15);
    expect(edge).toBeGreaterThan(0.2);
    expect(edge).toBeLessThan(0.8);
    const v = new Float32Array(8 * 8);
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) v[y * 8 + x] = 1;
    const contours = traceContours(v, 8, 8);
    expect(contours.length).toBe(1);
  });
});

describe('Brush engine', () => {
  it('emits dabs at the configured spacing', () => {
    const b = { ...defaultBrush(), size: 20, spacing: 0.25, smoothing: 0, scatter: 0 };
    const e = new DabEmitter(b);
    const s = (x: number, t: number) => ({ x, y: 0, pressure: 1, tiltX: 0, tiltY: 0, twist: 0, time: t });
    const dabs = [...e.begin(s(0, 0)), ...e.move(s(100, 16)), ...e.end(s(100, 32))];
    // 100 px / (20 × 0.25) = 20 intervals → ~21 dabs.
    expect(dabs.length).toBeGreaterThanOrEqual(19);
    expect(dabs.length).toBeLessThanOrEqual(23);
  });
});

describe('Liquify', () => {
  it('identity field leaves pixels unchanged; forward warp moves content; reconstruct restores', () => {
    const w = 32, h = 32;
    const src = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src.set(x === 16 ? [1, 1, 1, 1] : [0, 0, 0, 1], (y * w + x) * 4);
    const mesh = new LiquifyMesh(w, h);
    const same = warpWithField(src, w, h, mesh, 1);
    expect(Array.from(same)).toEqual(Array.from(src));
    for (let i = 0; i < 4; i++) mesh.apply('forwardWarp', 16 + i, 16, { x: 15 + i, y: 16 }, { ...DEFAULT_LIQUIFY_BRUSH, size: 16, pressure: 1 });
    const warped = warpWithField(src, w, h, mesh, 1);
    // The white column moved right at the brush centre.
    const row = (arr: Float32Array, y: number) => Array.from({ length: w }, (_, x) => arr[(y * w + x) * 4]);
    const brightest = row(warped, 16).indexOf(Math.max(...row(warped, 16)));
    expect(brightest).toBeGreaterThan(16);
    // Far away from the brush nothing changed.
    expect(row(warped, 1)[16]).toBe(1);
    mesh.reconstructAll(1);
    expect(mesh.isIdentity()).toBe(true);
  });

  it('frozen areas are protected', () => {
    const mesh = new LiquifyMesh(16, 16);
    mesh.freeze.fill(1);
    mesh.apply('bloat', 8, 8, null, { ...DEFAULT_LIQUIFY_BRUSH, size: 10, pressure: 1, rate: 1 });
    expect(mesh.isIdentity()).toBe(true);
  });
});

describe('Transforms', () => {
  it('affine compose/decompose/invert round-trip', () => {
    const m = compose({ tx: 10, ty: -4, scaleX: 2, scaleY: 0.5, rotation: 0.5, skewX: 0 });
    const d = decompose(m);
    expect(d.scaleX).toBeCloseTo(2, 6);
    expect(d.scaleY).toBeCloseTo(0.5, 6);
    expect(d.rotation).toBeCloseTo(0.5, 6);
    const id = multiply(m, invert(m));
    [1, 0, 0, 1, 0, 0].forEach((v, i) => expect(id[i]).toBeCloseTo(v, 9));
  });

  it('identity warp reproduces the raster', () => {
    const r = new TiledRaster(4, 8, 0);
    const data = new Float32Array(8 * 8 * 4);
    for (let i = 0; i < 64; i++) data.set([i / 63, 0.5, 1 - i / 63, 1], i * 4);
    r.writeFloat({ x: 0, y: 0, w: 8, h: 8 }, data);
    const out = warpRaster(r, { x: 0, y: 0, w: 8, h: 8 }, [1, 0, 0, 0, 1, 0, 0, 0, 1], { x: 0, y: 0, w: 8, h: 8 }, 'bilinear');
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(r.readFloat({ x: 0, y: 0, w: 8, h: 8 })[i], 2);
  });
});
