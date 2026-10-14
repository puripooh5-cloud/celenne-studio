/** Features that replaced "Coming Soon" items: warp, Blend If, slices, gray PSD, PDF, JPEG, mixer, focus, guides. */
import { describe, expect, it } from 'vitest';
import { unzlibSync } from 'fflate';
import { add, newDoc, solidLayer } from '../helpers/build';
import { evalGrid, fitGrid, isIdentityGrid, meshWarpLayerRaster, presetGrid, presetMap, rectGrid, sampleMesh, dragSurface, inverseGrid } from '../../src/image-engine/warp';
import { TiledRaster } from '../../src/image-engine/tiledRaster';
import { compositeRegion } from '../../src/rendering/compositor';
import { applyBlendIf, restrictChannels } from '../../src/rendering/blendIf';
import { exportPsd } from '../../src/psd/export';
import { importPsd, textPathFromBlock } from '../../src/psd/import';
import { flattenTextPath, nearestDistance, pointAtDistance, textPathFromPhotoshop, distanceAtParam, paramAtDistance, spanOnFlat } from '../../src/typography/pathText';
import { knot } from '../../src/vector/types';
import { createTextLayer } from '../../src/document/layerFactory';
import { parseContainer, findResource } from '../../src/psd/container';
import { exportPDF } from '../../src/formats/pdf';
import { encodeJpeg } from '../../src/formats/jpegEncoder';
import { MixerOp } from '../../src/brush/paintOps';
import { focusMap, focusMask, autoRange, estimateNoise } from '../../src/selection/focusArea';
import { guideLayoutPositions } from '../../src/app/ops/viewOps';
import { transformDocument } from '../../src/app/ops/imageOps';
import { gaussianBlur } from '../../src/image-engine/blur';
import type { BlendIf } from '../../src/document/types';
import { filterById } from '../../src/filters/builtin';
import { runFilterSync } from '../../src/filters/runner';
import { defaults } from '../../src/filters/types';

describe('Warp envelope', () => {
  it('the identity envelope maps the unit square onto its rectangle and fitGrid reproduces a preset at the 4×4 sample points', () => {
    const r = { x: 10, y: 20, w: 200, h: 100 };
    const id = rectGrid(r);
    expect(isIdentityGrid(id, r)).toBe(true);
    const p = evalGrid(id, 0.25, 0.75);
    expect(p.x).toBeCloseTo(60, 6);
    expect(p.y).toBeCloseTo(95, 6);
    const preset = { style: 'arc' as const, bend: 50, horizontalDistortion: 0, verticalDistortion: 0, orientation: 'horizontal' as const };
    const g = presetGrid(preset, r);
    const m = presetMap(preset, r.h / r.w);
    for (const [u, v] of [[0, 0], [1 / 3, 2 / 3], [1, 1]]) {
      const a = evalGrid(g, u, v), q = m(u, v);
      expect(a.x).toBeCloseTo(r.x + q.x * r.w, 4);
      expect(a.y).toBeCloseTo(r.y + q.y * r.h, 4);
    }
  });

  it('surface dragging moves the grabbed point by exactly the drag, and inverseGrid finds it again', () => {
    const r = { x: 0, y: 0, w: 100, h: 100 };
    const g = dragSurface(rectGrid(r), 0.4, 0.6, 12, -7);
    const p = evalGrid(g, 0.4, 0.6);
    expect(p.x).toBeCloseTo(40 + 12, 6);
    expect(p.y).toBeCloseTo(60 - 7, 6);
    const uv = inverseGrid(g, r, p.x, p.y);
    expect(uv.u).toBeCloseTo(0.4, 3);
    expect(uv.v).toBeCloseTo(0.6, 3);
  });

  it('an identity mesh warp reproduces the raster; a translated envelope moves it', () => {
    const src = new TiledRaster(4, 32, 0);
    const b = { x: 0, y: 0, w: 40, h: 30 };
    const px = new Float32Array(b.w * b.h * 4);
    for (let i = 0; i < b.w * b.h; i++) { px[i * 4] = (i % b.w) / b.w; px[i * 4 + 1] = 0.5; px[i * 4 + 2] = 0.25; px[i * 4 + 3] = 1; }
    src.writeFloat(b, px);
    const same = meshWarpLayerRaster(src, 0, 0, b, sampleMesh((u, v) => ({ x: u * b.w, y: v * b.h })));
    const out = same.raster.readFloat({ x: -same.x, y: -same.y, w: b.w, h: b.h });
    let err = 0;
    for (let i = 0; i < out.length; i++) err = Math.max(err, Math.abs(out[i] - px[i]));
    expect(err).toBeLessThan(1e-3);
    const moved = meshWarpLayerRaster(src, 0, 0, b, sampleMesh((u, v) => ({ x: 7 + u * b.w, y: 5 + v * b.h })));
    expect(moved.x).toBe(7);
    expect(moved.y).toBe(5);
  });

  it('fitGrid of a bilinear map is exact everywhere', () => {
    const map = (u: number, v: number) => ({ x: 3 + 10 * u + 2 * v + 4 * u * v, y: -1 + 5 * v + u });
    const g = fitGrid(map);
    for (const [u, v] of [[0.1, 0.9], [0.5, 0.5], [0.77, 0.12]]) {
      const a = evalGrid(g, u, v), b = map(u, v);
      expect(a.x).toBeCloseTo(b.x, 6);
      expect(a.y).toBeCloseTo(b.y, 6);
    }
  });
});

describe('Blend If and channel restrictions', () => {
  const bi = (): BlendIf => {
    const c = () => ({ thisLayer: [0, 0, 255, 255] as [number, number, number, number], underlying: [0, 0, 255, 255] as [number, number, number, number] });
    return { gray: c(), red: c(), green: c(), blue: c() };
  };
  it('hides dark pixels of this layer and ramps across split handles', () => {
    const b = bi();
    b.gray.thisLayer = [100, 140, 255, 255];
    const src = new Float32Array([0.1, 0.1, 0.1, 1, 0.47, 0.47, 0.47, 1, 0.9, 0.9, 0.9, 1]);
    applyBlendIf(b, src, null, 3);
    expect(src[3]).toBe(0);
    expect(src[7]).toBeGreaterThan(0.3);
    expect(src[7]).toBeLessThan(0.7);
    expect(src[11]).toBe(1);
  });
  it('underlying ranges read the (premultiplied) backdrop, and the compositor applies them', () => {
    const doc = newDoc(2, 1);
    const bg = add(doc, solidLayer(doc, 'bg', 0, 0, 2, 1, [0, 0, 0, 1]));
    const px = bg as unknown as { raster: TiledRaster };
    px.raster.writeFloat({ x: 1, y: 0, w: 1, h: 1 }, new Float32Array([1, 1, 1, 1]));
    const top = add(doc, solidLayer(doc, 'top', 0, 0, 2, 1, [1, 0, 0, 1]));
    const b = bi();
    b.gray.underlying = [0, 0, 128, 128]; // only over dark pixels
    top.advanced.blendIf = b;
    const out = compositeRegion(doc, { x: 0, y: 0, w: 2, h: 1 }, { level: 0 });
    expect(out[0]).toBeCloseTo(1, 3); // red over black
    expect(out[4]).toBeCloseTo(1, 3); // white stays white
    expect(out[5]).toBeCloseTo(1, 3);
  });
  it('restricted channels keep the backdrop value', () => {
    const before = new Float32Array([0.2, 0.4, 0.6, 1]);
    const after = new Float32Array([1, 1, 1, 1]);
    restrictChannels(before, after, 1, [true, false, true]);
    expect(Array.from(after)).toEqual([1, 0.4000000059604645, 1, 1]);
  });
  it('Blend If and channel restrictions round-trip through PSD', () => {
    const doc = newDoc(8, 8);
    add(doc, solidLayer(doc, 'bg', 0, 0, 8, 8, [1, 1, 1, 1]));
    const l = add(doc, solidLayer(doc, 'l', 0, 0, 8, 8, [0.5, 0.2, 0.1, 1]));
    const b = bi();
    b.gray.thisLayer = [10, 30, 200, 240];
    b.blue.underlying = [0, 50, 255, 255];
    l.advanced.blendIf = b;
    l.advanced.channels = [true, false, true];
    const back = importPsd(exportPsd(doc), 'x.psd').doc;
    const r = back.allLayers().find((x) => x.name === 'l')!;
    expect(r.advanced.blendIf?.gray.thisLayer).toEqual([10, 30, 200, 240]);
    expect(r.advanced.blendIf?.blue.underlying).toEqual([0, 50, 255, 255]);
    expect(r.advanced.channels).toEqual([true, false, true]);
  });
});

describe('PSD: slices, thumbnail, grayscale', () => {
  it('writes user slices and a JPEG thumbnail, and reads the slices back', () => {
    const doc = newDoc(120, 80);
    add(doc, solidLayer(doc, 'bg', 0, 0, 120, 80, [0.2, 0.5, 0.9, 1]));
    doc.slices = [{ id: 's1', name: 'header', rect: { x: 0, y: 0, w: 120, h: 20 }, url: 'https://example.com' }, { id: 's2', name: 'body', rect: { x: 10, y: 30, w: 50, h: 40 } }];
    const bytes = exportPsd(doc);
    const back = importPsd(bytes, 'x.psd').doc;
    expect(back.slices.map((s) => [s.name, s.rect, s.url])).toEqual([['header', { x: 0, y: 0, w: 120, h: 20 }, 'https://example.com'], ['body', { x: 10, y: 30, w: 50, h: 40 }, undefined]]);
    const thumb = findResource(parseContainer(bytes), 1036);
    expect(thumb).toBeTruthy();
    const jpeg = thumb!.data.subarray(28);
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    // Unedited slices survive untouched.
    const again = exportPsd(back);
    expect(importPsd(again, 'y.psd').doc.slices.length).toBe(2);
  });
  it('writes Grayscale-mode files with one color channel per layer', () => {
    const doc = newDoc(16, 12);
    doc.canvas = { ...doc.canvas, colorMode: 'grayscale' };
    doc.profile = { name: 'Gray Gamma 2.2', builtin: 'gray22' };
    add(doc, solidLayer(doc, 'bg', 0, 0, 16, 12, [0.25, 0.25, 0.25, 1]));
    add(doc, solidLayer(doc, 'stripe', 4, 0, 4, 12, [1, 0, 0, 0.5]));
    const bytes = exportPsd(doc);
    const c = parseContainer(bytes);
    expect(c.colorMode).toBe(1);
    expect(c.layers.every((l) => l.channels.every((ch) => ch.id !== 1 && ch.id !== 2))).toBe(true);
    const back = importPsd(bytes, 'g.psd').doc;
    expect(back.canvas.colorMode).toBe('grayscale');
    const stripe = back.allLayers().find((l) => l.name === 'stripe') as unknown as { raster: TiledRaster; x: number };
    const v = stripe.raster.readFloat({ x: 0, y: 0, w: 1, h: 1 });
    expect(v[0]).toBeCloseTo(0.299, 1); // luminance of pure red
    expect(v[3]).toBeCloseTo(0.5, 1);
  });
});

describe('Export formats', () => {
  it('PDF has a valid cross-reference table and an ICC-tagged, soft-masked image', async () => {
    const doc = newDoc(30, 20);
    add(doc, solidLayer(doc, 'l', 5, 5, 10, 10, [1, 0, 0, 1]));
    doc.canvas = { ...doc.canvas, resolution: 144 };
    const pdf = await exportPDF(doc);
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text).toContain('/MediaBox [0 0 15.000 10.000]');
    expect(text).toContain('/ICCBased');
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    // Every xref offset points at "N 0 obj".
    const entries = [...text.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    entries.forEach((off, i) => expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(text).toContain('/SMask');
    // The image stream inflates to W×H×3 bytes.
    const img = /\/Subtype \/Image \/Width 30 \/Height 20 \/ColorSpace \[\/ICCBased 7 0 R\][^>]*\/Length (\d+) >>\nstream\n/.exec(text)!;
    const start = img.index + img[0].length;
    expect(unzlibSync(pdf.subarray(start, start + Number(img[1]))).length).toBe(30 * 20 * 3);
  });
  it('JPEG encoder writes a structurally valid baseline file', () => {
    const w = 17, h = 9;
    const px = new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256));
    const j = encodeJpeg(w, h, px, 75);
    expect([j[0], j[1]]).toEqual([0xff, 0xd8]);
    expect([j[j.length - 2], j[j.length - 1]]).toEqual([0xff, 0xd9]);
    const sof = j.findIndex((v, i) => v === 0xff && j[i + 1] === 0xc0);
    expect((j[sof + 5] << 8) | j[sof + 6]).toBe(h);
    expect((j[sof + 7] << 8) | j[sof + 8]).toBe(w);
  });
});

describe('Mixer Brush', () => {
  it('a loaded brush over another color deposits a mix of the two', () => {
    const raster = new TiledRaster(4, 32, 0);
    const r = { x: 0, y: 0, w: 4, h: 4 };
    raster.writeFloat(r, new Float32Array(16 * 4).map((_, i) => (i % 4 === 2 || i % 4 === 3 ? 1 : 0))); // blue
    const ctx = { target: { raster, x: 0, y: 0, channels: 4 as const }, original: raster.clone(), selection: null, canvas: r, lockAlpha: false };
    const op = new MixerOp(ctx, { r: 1, g: 0, b: 0 }, 0.5, 1, 0.5, 1, null);
    op.apply({ x: 2, y: 2, size: 4, angle: 0, roundness: 1, opacity: 1, flow: 1, pressure: 1 } as never, new Float32Array(16).fill(1), r);
    const out = raster.readFloat({ x: 1, y: 1, w: 1, h: 1 });
    expect(out[0]).toBeGreaterThan(0.1); // some red
    expect(out[2]).toBeGreaterThan(0.1); // some blue left
    expect(out[3]).toBeCloseTo(1, 3);
  });
});

describe('Focus Area', () => {
  it('selects the sharp half of an image whose other half is blurred', () => {
    const w = 160, h = 80;
    const px = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { const x = i % w, y = Math.floor(i / w); const v = ((x >> 2) + (y >> 2)) % 2; px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = 1; }
    const right = new Float32Array((w / 2) * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) for (let c = 0; c < 4; c++) right[(y * (w / 2) + x) * 4 + c] = px[(y * w + x + w / 2) * 4 + c];
    gaussianBlur(right, w / 2, h, 4, 5);
    for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) for (let c = 0; c < 4; c++) px[(y * w + x + w / 2) * 4 + c] = right[(y * (w / 2) + x) * 4 + c];
    expect(estimateNoise(px, w, h)).toBeLessThan(0.3);
    const fm = focusMap(px, w, h, 0);
    const m = focusMask(fm, autoRange(fm), false);
    expect(m[40 * w + 30]).toBe(1);
    expect(m[40 * w + 130]).toBe(0);
  });
});

describe('Guides and slices on the canvas', () => {
  it('New Guide Layout: 4 columns with gutters inside margins', () => {
    const g = guideLayoutPositions({ columns: { enabled: true, number: 4, width: null, gutter: 20 }, rows: { enabled: false, number: 1, height: null, gutter: 0 }, margin: { enabled: true, top: 10, left: 40, bottom: 10, right: 40 }, centerColumns: false, clearExisting: false }, 1000, 500);
    const xs = g.filter((x) => x.orientation === 'vertical').map((x) => x.position).sort((a, b) => a - b);
    expect(xs[0]).toBe(40);
    expect(xs[xs.length - 1]).toBe(960);
    // Column width = (920 - 3·20) / 4 = 215 → edges 40, 255, 275, 490, ...
    expect(xs).toContain(255);
    expect(xs).toContain(275);
  });
  it('cropping moves and clips slices', () => {
    const doc = newDoc(200, 100);
    add(doc, solidLayer(doc, 'bg', 0, 0, 200, 100, [1, 1, 1, 1]));
    doc.slices = [{ id: 'a', name: 'a', rect: { x: 50, y: 10, w: 100, h: 50 } }, { id: 'b', name: 'b', rect: { x: 0, y: 0, w: 20, h: 20 } }];
    transformDocument(doc, [1, 0, 0, 1, -40, 0], 100, 100, 'nearest', null);
    expect(doc.slices.map((s) => s.rect)).toEqual([{ x: 10, y: 10, w: 90, h: 50 }]);
  });
});

describe('Filter Gallery filters', () => {
  it('every gallery filter runs on RGBA and single-channel images without NaNs', () => {
    for (const id of ['cutout', 'dryBrush', 'filmGrain', 'posterEdges', 'watercolor', 'inkOutlines', 'spatter', 'diffuseGlow', 'halftonePattern', 'stamp', 'photocopy', 'glowingEdges', 'grain', 'mosaicTiles', 'texturizer']) {
      const def = filterById(id)!;
      expect(def?.gallery).toBe(true);
      for (const ch of [4, 1] as const) {
        const w = 24, h = 16;
        const data = new Float32Array(w * h * ch).map((_, i) => ((i * 37) % 100) / 100);
        if (ch === 4) for (let i = 3; i < data.length; i += 4) data[i] = 1;
        const out = runFilterSync(def, defaults(def), { w, h, ch, data }, { scale: 1, originX: 0, originY: 0, bounds: { x: 0, y: 0, w, h }, foreground: [0, 0, 0], background: [1, 1, 1] });
        expect(out.data.length).toBe(w * h * ch);
        expect(out.data.every((v) => Number.isFinite(v) && v >= -1e-6 && v <= 1 + 1e-6)).toBe(true);
      }
    }
  });
});

describe('Knockout', () => {
  it('shallow knockout with 0 % fill reveals the group backdrop, deep reveals the Background', () => {
    const doc = newDoc(1, 1);
    add(doc, solidLayer(doc, 'Background', 0, 0, 1, 1, [0, 0, 1, 1]));
    const mid = add(doc, solidLayer(doc, 'mid', 0, 0, 1, 1, [0, 1, 0, 1]));
    const top = add(doc, solidLayer(doc, 'ko', 0, 0, 1, 1, [1, 0, 0, 1]));
    top.fillOpacity = 0;
    top.advanced.knockout = 'deep';
    let out = compositeRegion(doc, { x: 0, y: 0, w: 1, h: 1 }, { level: 0 });
    expect([out[0], out[1], out[2]].map((v) => Math.round(v))).toEqual([0, 0, 1]);
    top.advanced.knockout = 'none';
    out = compositeRegion(doc, { x: 0, y: 0, w: 1, h: 1 }, { level: 0 });
    expect([out[0], out[1], out[2]].map((v) => Math.round(v))).toEqual([0, 1, 0]);
    void mid;
    top.advanced.knockout = 'deep';
    const back = importPsd(exportPsd(doc), 'k.psd').doc;
    expect(back.allLayers().find((l) => l.name === 'ko')!.advanced.knockout).toBe('deep');
  });
});

describe('Scratch disk', () => {
  it('pages history-only tiles out and reads them back on undo', async () => {
    const { installScratch, configureScratch, maybeOffload, scratchStats } = await import('../../src/history/scratch');
    const { History } = await import('../../src/history/history');
    const { editRaster } = await import('../../src/commands/rasterCommands');
    const store = new Map<string, Uint8Array>();
    installScratch({ write: async (k, d) => { store.set(k, d.slice()); }, readSync: (k) => store.get(k) ?? null, remove: (k) => store.delete(k) });
    configureScratch({ enabled: true, budgetBytes: 1, maxScratchBytes: 1e12 });
    const doc = newDoc(512, 512);
    const l = add(doc, solidLayer(doc, 'l', 0, 0, 512, 512, [0.2, 0.4, 0.6, 1])) as unknown as { raster: TiledRaster; id: string };
    const h = new History(doc);
    // Several full-layer edits so old tiles are only referenced by history.
    for (let k = 0; k < 5; k++) {
      const cmd = editRaster(doc, { kind: 'layer', layerId: l.id }, `Edit ${k}`, (raster) => {
        raster.writeFloat({ x: 0, y: 0, w: 512, h: 512 }, new Float32Array(512 * 512 * 4).fill(k / 10));
        return { x: 0, y: 0, w: 512, h: 512 };
      });
      h.push(cmd!, true);
    }
    maybeOffload(doc, h);
    await new Promise((r) => setTimeout(r, 20));
    expect(scratchStats().pagedTiles).toBeGreaterThan(0);
    expect(store.size).toBeGreaterThan(0);
    // Undo all the way back: the original color comes back from the scratch store.
    while (h.canUndo) h.undo();
    const v = l.raster.readFloat({ x: 10, y: 10, w: 1, h: 1 });
    expect(v[0]).toBeCloseTo(0.2, 2);
    expect(v[2]).toBeCloseTo(0.6, 2);
    expect(scratchStats().readBacks).toBeGreaterThan(0);
    installScratch(null);
  });
});

describe('Type on a path', () => {
  const line = { knots: [knot(0, 0), knot(100, 0)], closed: false, op: 'combine' as const };
  it('places points along the path and hides overflow on open paths', () => {
    const f = flattenTextPath(line)!;
    expect(f.length).toBeCloseTo(100, 5);
    expect(pointAtDistance(f, 25)).toMatchObject({ x: 25, y: 0, angle: 0 });
    expect(pointAtDistance(f, 120)).toBeNull();
    const flipped = flattenTextPath(line, true)!;
    expect(pointAtDistance(flipped, 25)!.x).toBeCloseTo(75, 5);
    expect(Math.abs(pointAtDistance(flipped, 25)!.angle)).toBeCloseTo(Math.PI, 5);
    expect(nearestDistance(f, 40, 7)).toEqual({ d: 40, dist: 7 });
  });
  it('wraps around closed paths', () => {
    const sq = { knots: [knot(0, 0), knot(10, 0), knot(10, 10), knot(0, 10)], closed: true, op: 'combine' as const };
    const f = flattenTextPath(sq)!;
    expect(f.length).toBeCloseTo(40, 5);
    expect(pointAtDistance(f, 45)).toMatchObject({ x: 5, y: 0 });
    expect(pointAtDistance(f, 15)).toMatchObject({ x: 10, y: 5 });
  });
  it("round-trips through PSD in Photoshop's text data (no private block) and rejects malformed private blocks", () => {
    const doc = newDoc(120, 60);
    const t = createTextLayer('Hello', 8, 0, 0);
    t.text.path = { subpath: line, start: 12, flip: true };
    add(doc, t);
    const bytes = exportPsd(doc);
    const back = importPsd(bytes, 'p.psd').doc;
    const bt = back.allLayers().find((l) => l.kind === 'text') as typeof t;
    // (The path's frame stores positions along it as Bezier parameters.)
    expect(bt.text.path).toMatchObject({ flip: true, subpath: { closed: false } });
    expect(bt.text.path!.start).toBeCloseTo(12, 2);
    expect(parseContainer(bytes).layers.flatMap((l) => l.blocks).some((b) => b.key === 'lmTP')).toBe(false);
    expect(bt.text.path!.subpath.knots.map((k) => [k.x, k.y])).toEqual([[0, 0], [100, 0]]);
    expect(bt.metadata.psd?.rawBlocks ?? []).not.toContainEqual(expect.objectContaining({ key: 'lmTP' }));
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(textPathFromBlock(enc({ v: 1, subpath: { knots: [{ x: 'a' }] }, start: 0 }))).toBeNull();
    expect(textPathFromBlock(enc({ v: 2, subpath: { knots: [] }, start: 0 }))).toBeNull();
    expect(textPathFromBlock(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('Photoshop text on a path', () => {
  // Real data from a Photoshop file (ag-psd test suite, test/read/text-path): "some text", Calibri 30.
  const cp = [0, 10.17448, 30, -13.99219, 63.5, 5.17448, 83, 13.17448, 83, 13.17448, 102.5, 21.17448, 138, 18.67448, 150, 3.17448];
  it('reads the Bézier segments, markers and flip', () => {
    const tp = textPathFromPhotoshop(cp, [0, 0.32983], undefined)!;
    expect(tp.subpath.closed).toBe(false);
    expect(tp.subpath.knots.map((k) => [k.x, k.y])).toEqual([[0, 10.17448], [83, 13.17448], [150, 3.17448]]);
    expect([tp.subpath.knots[0].outX, tp.subpath.knots[1].inX, tp.subpath.knots[1].outX, tp.subpath.knots[2].inX]).toEqual([30, 63.5, 102.5, 138]);
    expect(tp.subpath.knots[1].smooth).toBe(true); // collinear handles
    expect(tp.start).toBe(0);
    // End marker a third of the way along the first segment (curve parameter), not a third of the path.
    const f = flattenTextPath(tp.subpath)!;
    expect(tp.end!).toBeGreaterThan(25);
    expect(tp.end!).toBeLessThan(45);
    expect(f.length).toBeGreaterThan(150);
    expect(paramAtDistance(tp.subpath, distanceAtParam(tp.subpath, 1.4))).toBeCloseTo(1.4, 3);
    expect(textPathFromPhotoshop(cp, [0, 2], true)!.flip).toBe(true);
  });
  it('rejects malformed geometry', () => {
    expect(textPathFromPhotoshop(cp.slice(0, 12), [0, 1], false)).toBeNull();
    expect(textPathFromPhotoshop([...cp.slice(0, 8), 99, 99, ...cp.slice(10)], [0, 1], false)).toBeNull(); // discontinuous
    expect(textPathFromPhotoshop('x', [0, 1], false)).toBeNull();
  });
  it('detects closed paths and flips the span', () => {
    const sq = [0, 0, 0, 0, 10, 0, 10, 0, 10, 0, 10, 0, 10, 10, 10, 10, 10, 10, 10, 10, 0, 10, 0, 10, 0, 10, 0, 10, 0, 0, 0, 0];
    const tp = textPathFromPhotoshop(sq, [0.5, 2], false)!;
    expect(tp.subpath.closed).toBe(true);
    expect(tp.subpath.knots.length).toBe(4);
    const f = flattenTextPath(tp.subpath, true)!;
    expect(f.length).toBeCloseTo(40, 3);
    const span = spanOnFlat({ ...tp, flip: true }, f);
    expect(span.a).toBeCloseTo(40 - 20, 3);
    expect(span.b).toBeCloseTo(40 - 5, 3);
  });
});

