/** Duotone, Multichannel and spot channels, checked against Photoshop-saved files. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importPsd } from '../../src/psd/import';
import { exportPsd } from '../../src/psd/export';
import { findResource, parseContainer, decodeMergedChannels } from '../../src/psd/container';
import { defaultDuotone, duotoneLabTable, setSpotDotGain, editedDuotone, effectiveOverprints, encodeDuotone, overprintLabel, overprintSets, parseDuotone, remapOverprints } from '../../src/color/inks';
import { colorFromLab } from '../../src/color/plates';
import { flattenToPixels } from '../../src/rendering/flatten';
import { applyInkAppearance } from '../../src/rendering/inkView';
import { fromMultichannel, toMultichannel, duotoneToRgb, mergeSpotChannel, mergeSpotUnavailable } from '../../src/color/inkModes';
import { compositeRegion } from '../../src/rendering/compositor';
import { colorEngine } from '../../src/color/cms';
import { celenneCmykProfile } from '../../src/color/cmykProfile';
import { add, newDoc, solidLayer } from '../helpers/build';
import { TiledRaster } from '../../src/image-engine/tiledRaster';

const fixture = (f: string) => new Uint8Array(readFileSync(join(__dirname, '../fixtures/third-party', f)));
const dE = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('Duotone', () => {
  it('opens a Photoshop duotone with its inks, curves and rendering', () => {
    const { doc, issues } = importPsd(fixture('4x4_8bit_duotone.psd'), 'd.psd');
    expect(doc.canvas.colorMode).toBe('grayscale');
    const spec = doc.canvas.duotone!;
    expect(spec.inks.map((i) => i.name)).toEqual(['Black', 'PANTONE 327 CVC']);
    expect(spec.inks[0].curve[6]).toBe(400);
    expect(spec.inks[1].curve[9]).toBe(700);
    // The PANTONE ink's colour comes from Photoshop's alternate (Lab) colour: a dark teal.
    const p = spec.inks[1].color;
    expect(p.g).toBeGreaterThan(p.r + 0.2);
    expect(spec.rendering?.length).toBe(768);
    expect(issues.some((i) => i.feature === 'Color mode' && i.status === 'editable')).toBe(true);
  });

  it('models Photoshop’s duotone rendering of the psd-tools sample (saved with a 15 % spot dot gain)', () => {
    const c = parseContainer(fixture('4x4_8bit_duotone.psd'));
    const spec = parseDuotone(c.colorModeData, findResource(c, 1066)?.data)!;
    const photoshop = duotoneLabTable(spec);
    setSpotDotGain(15);
    const model = duotoneLabTable(editedDuotone(spec, {}));
    setSpotDotGain(20);
    // At the default 20 % the same inks print darker in the mid-tones.
    const dark = duotoneLabTable(editedDuotone(spec, {}));
    expect(dark[128 * 3]).toBeLessThan(model[128 * 3]);
    let sum = 0, max = 0;
    for (let g = 0; g < 256; g++) {
      const lab = (t: Uint8Array) => [t[g * 3] / 2.55, t[g * 3 + 1] - 128, t[g * 3 + 2] - 128];
      const e = dE(lab(photoshop), lab(model));
      sum += e; max = Math.max(max, e);
    }
    expect(sum / 256).toBeLessThan(1);
    expect(max).toBeLessThan(2);
  });

  it('matches Photoshop’s rendering of 73 more duotone specifications (1–4 inks, custom overprints)', () => {
    // Made-up inks, curves and overprint colours, re-saved by Photoshop 26.5 (tests/fixtures/photoshop).
    const ref = JSON.parse(readFileSync(join(__dirname, '../fixtures/photoshop/duotone-renderings.json'), 'utf8')) as { files: { name: string; colorModeData: string; rendering: string }[] };
    let sum = 0, count = 0, max = 0, custom = 0;
    for (const f of ref.files) {
      const spec = parseDuotone(new Uint8Array(Buffer.from(f.colorModeData, 'base64')))!;
      expect(spec, f.name).toBeTruthy();
      if (spec.overprints.some(Boolean)) custom++;
      const photoshop = new Uint8Array(Buffer.from(f.rendering, 'base64'));
      const model = duotoneLabTable(spec);
      let fileMax = 0;
      for (let g = 0; g < 256; g++) {
        const lab = (t: Uint8Array) => [t[g * 3] / 2.55, t[g * 3 + 1] - 128, t[g * 3 + 2] - 128];
        const e = dE(lab(photoshop), lab(model));
        sum += e; count++; fileMax = Math.max(fileMax, e);
      }
      expect(fileMax, f.name).toBeLessThan(2);
      max = Math.max(max, fileMax);
    }
    expect(ref.files.length).toBe(73);
    expect(custom).toBeGreaterThan(20);
    expect(sum / count).toBeLessThan(0.5);
    expect(max).toBeLessThan(1.5);
  });

  it('uses custom overprint colours in Photoshop’s slot order and keeps them when inks are added', () => {
    const black = { name: 'A', color: colorFromLab([40, 50, 30]), curve: [0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1000] };
    const zero = [0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0];
    const inks = [black, { ...black, name: 'B' }, { ...black, name: 'C', curve: zero }, { ...black, name: 'D' }];
    // Only inks 1, 2 and 4 print: the solid end is the 1+2+4 overprint (slot 7 in Photoshop's order).
    const overprints = overprintSets(4).map((_, k) => colorFromLab([20 + k * 6, 0, 0]));
    const spec = editedDuotone(defaultDuotone(), { inks, overprints });
    expect(overprintSets(4).map(overprintLabel)).toEqual(['1+2', '1+3', '2+3', '1+2+3', '1+4', '2+4', '3+4', '1+2+4', '1+3+4', '2+3+4', '1+2+3+4']);
    expect(duotoneLabTable(spec)[0] / 2.55).toBeCloseTo(20 + 7 * 6, 0);
    // Written and read back as Lab records.
    const back = parseDuotone(encodeDuotone(spec))!;
    expect(back.overprints.length).toBe(11);
    expect(back.overprints[7]!.r).toBeCloseTo(overprints[7].r, 2);
    // Quadtone → tritone keeps 1+2, 1+3, 2+3, 1+2+3; computed ones stay computed.
    const tri = remapOverprints(overprints, 4, 3);
    expect(tri).toEqual(overprints.slice(0, 4));
    expect(remapOverprints([null], 2, 3)).toEqual([null, null, null, null]);
    // Computed overprints are the inks multiplied as filters.
    const eff = effectiveOverprints(editedDuotone(spec, { overprints: [] }));
    expect(eff.length).toBe(11);
    expect(eff[10].r).toBeLessThan(eff[0].r);
  });

  it('saves Duotone files with the original specification and reopens them', () => {
    const src = fixture('4x4_8bit_duotone.psd');
    const { doc } = importPsd(src, 'd.psd');
    const bytes = exportPsd(doc);
    const c = parseContainer(bytes);
    expect(c.colorMode).toBe(8);
    expect([...c.colorModeData]).toEqual([...parseContainer(src).colorModeData]);
    expect(findResource(c, 1066)?.data.length).toBe(4 + 2 * 10 + 2 + 768);
    expect(findResource(c, 1039)).toBeUndefined();
    const back = importPsd(bytes, 'd2.psd').doc;
    expect(back.canvas.duotone?.inks.map((i) => i.name)).toEqual(['Black', 'PANTONE 327 CVC']);
    // Gray data unchanged.
    const a = (doc.root.children[0] as unknown as { raster: TiledRaster }).raster.readFloat(doc.bounds);
    const b = (back.root.children[0] as unknown as { raster: TiledRaster }).raster.readFloat(back.bounds);
    expect([...b].map((v) => Math.round(v * 255))).toEqual([...a].map((v) => Math.round(v * 255)));
  });

  it('writes edited inks as a Duotone Options record that reads back', () => {
    const c = parseContainer(fixture('4x4_8bit_duotone.psd'));
    const spec = parseDuotone(c.colorModeData, findResource(c, 1066)?.data)!;
    const edited = editedDuotone(spec, { inks: [spec.inks[0], { ...spec.inks[1], name: 'Teal', color: { r: 0, g: 0.5, b: 0.5 }, curve: [0, -1, -1, 200, -1, -1, 500, -1, -1, -1, -1, -1, 1000] }] });
    const bytes = encodeDuotone(edited);
    expect(bytes.length).toBe(524);
    const back = parseDuotone(bytes)!;
    expect(back.inks[1].name).toBe('Teal');
    expect(back.inks[1].curve).toEqual([0, -1, -1, 200, -1, -1, 500, -1, -1, -1, -1, -1, 1000]);
    expect(back.inks[1].color.g).toBeCloseTo(0.5, 1);
    // The untouched PANTONE-less black ink keeps its original colour record.
    expect([...bytes.subarray(4, 14)]).toEqual([...c.colorModeData.subarray(4, 14)]);
  });

  it('exports how the inks print and converts to RGB through them', async () => {
    await colorEngine.init();
    const { doc } = importPsd(fixture('4x4_8bit_duotone.psd'), 'd.psd');
    const gray = flattenToPixels(doc, { depth: 8 }).data;
    const inks = flattenToPixels(doc, { depth: 8, inks: true }).data;
    expect(gray[0]).toBe(gray[1]);
    // A mid tone of a black + teal duotone is a cool, green-leaning gray.
    const mid = [...Array(16).keys()].find((i) => gray[i * 4] > 60 && gray[i * 4] < 200);
    if (mid !== undefined) expect(inks[mid * 4 + 1]).toBeGreaterThan(inks[mid * 4]);
    duotoneToRgb(doc);
    expect(doc.canvas.colorMode).toBe('rgb');
    expect(doc.canvas.duotone).toBeUndefined();
    const rgb = flattenToPixels(doc, { depth: 8 }).data;
    // The file's gradient fill layer is converted through its stop colours, and blending mapped
    // stops differs slightly from mapping the blended gray (up to 2/255 here).
    for (let i = 0; i < rgb.length; i++) expect(Math.abs(rgb[i] - inks[i])).toBeLessThanOrEqual(2);
  });
});

describe('Multichannel', () => {
  it('opens a Photoshop multichannel file as ink channels at 16 bits', () => {
    const { doc } = importPsd(fixture('4x4_16bit_multichannel.psd'), 'm.psd');
    expect(doc.canvas.colorMode).toBe('multichannel');
    expect(doc.root.children.length).toBe(0);
    expect(doc.channels.length).toBe(3);
    expect(doc.channels.every((c) => c.kind === 'spot' && c.visible)).toBe(true);
    expect(doc.channels[0].raster.depth).toBe(16);
  });

  it('saves Multichannel files and reads the channels back exactly', () => {
    const src = fixture('4x4_16bit_multichannel.psd');
    const { doc } = importPsd(src, 'm.psd');
    const bytes = exportPsd(doc);
    const c = parseContainer(bytes);
    expect(c.colorMode).toBe(7);
    expect(c.channels).toBe(3);
    expect(c.depth).toBe(16);
    expect(c.layers.length).toBe(0);
    const orig = decodeMergedChannels(parseContainer(src));
    const now = decodeMergedChannels(c);
    for (let k = 0; k < 3; k++) expect([...now[k]]).toEqual([...orig[k]]);
  });

  it('turns CMYK into C M Y K ink channels and back exactly', async () => {
    await colorEngine.init();
    const doc = newDoc(6, 4);
    doc.canvas = { ...doc.canvas, colorMode: 'cmyk' };
    doc.profile = { name: 'Celenne CMYK', icc: celenneCmykProfile() };
    const l = solidLayer(doc, 'ink', 0, 0, 6, 4, [0.2, 0.6, 1, 1]);
    l.raster.companion = solidLayer(doc, 'k', 0, 0, 6, 4, [0.7, 0.7, 0.7, 1]).raster;
    add(doc, l);
    toMultichannel(doc);
    expect(doc.canvas.colorMode).toBe('multichannel');
    expect(doc.channels.map((c) => c.name)).toEqual(['Cyan', 'Magenta', 'Yellow', 'Black']);
    expect(Math.round(doc.channels[3].raster.readFloat({ x: 0, y: 0, w: 1, h: 1 })[0] * 255)).toBe(179);
    // Shown as inks on paper: dark blue, never transparent.
    const look = flattenToPixels(doc, { depth: 8, inks: true }).data;
    expect(look[3]).toBe(255);
    expect(look[2]).toBeGreaterThan(look[0]);
    expect(fromMultichannel(doc, 'cmyk')).toBe('cmyk');
    const r = (doc.root.children[0] as unknown as { raster: TiledRaster }).raster;
    expect(Math.round(r.readFloat({ x: 1, y: 1, w: 1, h: 1 })[1] * 255)).toBe(153);
    expect(Math.round(r.companion!.readFloat({ x: 1, y: 1, w: 1, h: 1 })[0] * 255)).toBe(179);
  });
});

describe('Spot channels', () => {
  it('reads 13-byte display info records (ink colours of every channel)', () => {
    const { doc } = importPsd(fixture('cmyk-spot.psd'), 's.psd');
    expect(doc.channels.map((c) => c.name)).toEqual(['blue', 'fluorescent pink', 'yellow']);
    expect(doc.channels.every((c) => c.kind === 'spot')).toBe(true);
    const pink = doc.channels[1].color;
    expect(Math.round(pink.r * 255)).toBe(255);
    expect(Math.round(pink.g * 255)).toBe(0x48);
    expect(Math.round(pink.b * 255)).toBe(0xb0);
    // Written back in the same 13-byte layout.
    const di = findResource(parseContainer(exportPsd(doc)), 1077)!.data;
    expect(di.length).toBe(4 + 3 * 13);
    expect(importPsd(exportPsd(doc), 's2.psd').doc.channels.map((c) => c.kind)).toEqual(['spot', 'spot', 'spot']);
  });

  it('prints visible spot inks over the image', () => {
    const doc = newDoc(2, 1);
    add(doc, solidLayer(doc, 'white', 0, 0, 2, 1, [1, 1, 1, 1]));
    const raster = TiledRaster.fromPixels(2, 1, 1, 8, Uint8ClampedArray.from([0, 255]));
    doc.channels.push({ id: 'c1', name: 'Red ink', kind: 'spot', raster, visible: true, color: { r: 1, g: 0, b: 0 }, opacity: 0, indicatesSelected: false, solidity: 0 });
    const buf = Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1]);
    applyInkAppearance(doc, buf, { x: 0, y: 0, w: 2, h: 1 }, 0, true);
    expect([...buf.subarray(0, 3)]).toEqual([1, 0, 0]); // full ink where the channel is black
    expect([...buf.subarray(4, 7)]).toEqual([1, 1, 1]); // no ink where it is white
  });
});

describe('Merge Spot Channel', () => {
  /** An RGB image (gradient + a translucent layer) with a spot channel ramping from no ink to full ink. */
  function spotDoc(solidity: number, depth: 8 | 16 = 16) {
    const W = 64, H = 8;
    const doc = newDoc(W, H, depth);
    add(doc, solidLayer(doc, 'base', 0, 0, W, H, [0.9, 0.7, 0.3, 1]));
    add(doc, solidLayer(doc, 'over', 10, 0, 30, H, [0.1, 0.4, 0.8, 0.6]));
    const v = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) v[y * W + x] = 1 - x / (W - 1);
    const raster = new TiledRaster(1, depth, 1);
    raster.writeFloat({ x: 0, y: 0, w: W, h: H }, v);
    doc.channels.push({ id: 'spot1', name: 'PANTONE Test', kind: 'spot', raster, visible: true, color: { r: 0.1, g: 0.6, b: 0.55 }, opacity: 0, indicatesSelected: false, solidity });
    return doc;
  }
  const straight = (doc: ReturnType<typeof newDoc>) => {
    const f = compositeRegion(doc, doc.bounds, { level: 0 });
    for (let i = 0; i < f.length; i += 4) { const a = f[i + 3]; if (a > 1e-7) { f[i] /= a; f[i + 1] /= a; f[i + 2] /= a; } }
    return f;
  };

  for (const solidity of [0, 0.4, 1]) {
    it(`looks the same after merging (solidity ${solidity * 100} %) and keeps the layers`, () => {
      const doc = spotDoc(solidity);
      const before = straight(doc);
      applyInkAppearance(doc, before, doc.bounds, 0, true);
      const layersBefore = doc.root.children.length;
      expect(mergeSpotUnavailable(doc, 'spot1')).toBeNull();
      const top = mergeSpotChannel(doc, 'spot1');
      expect(doc.channels.length).toBe(0);
      expect(doc.root.children.length).toBe(layersBefore + 1);
      expect(doc.root.children[layersBefore]).toBe(top);
      expect(top.kind).toBe(solidity > 0 && solidity < 1 ? 'group' : 'fill');
      const after = straight(doc);
      let max = 0;
      for (let i = 0; i < after.length; i++) if (i % 4 !== 3) max = Math.max(max, Math.abs(after[i] - before[i]));
      expect(max).toBeLessThan(1 / 255);
    });
  }

  it('exports with the image and round-trips as editable PSD layers', () => {
    const doc = spotDoc(0.4, 8);
    mergeSpotChannel(doc, 'spot1');
    const back = importPsd(exportPsd(doc), 'm.psd').doc;
    expect(back.channels.length).toBe(0);
    const g = back.root.children[back.root.children.length - 1];
    expect(g.kind).toBe('group');
    const fills = (g as unknown as { children: { kind: string; blendMode: string; mask: unknown }[] }).children;
    expect(fills.map((l) => [l.kind, l.blendMode, !!l.mask])).toEqual([['fill', 'multiply', true], ['fill', 'normal', true]]);
    const a = flattenToPixels(doc, { depth: 8 }).data, b = flattenToPixels(back, { depth: 8 }).data;
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(2);
  });

  it('merges into Grayscale documents as the ink’s gray', () => {
    const doc = newDoc(8, 2);
    doc.canvas = { ...doc.canvas, colorMode: 'grayscale' };
    add(doc, solidLayer(doc, 'paper', 0, 0, 8, 2, [1, 1, 1, 1]));
    const raster = new TiledRaster(1, 8, 1);
    raster.writeFloat({ x: 0, y: 0, w: 4, h: 2 }, new Float32Array(8).fill(0)); // full ink on the left half
    doc.channels.push({ id: 'g1', name: 'Gray ink', kind: 'spot', raster, visible: true, color: { r: 0.4, g: 0.4, b: 0.4 }, opacity: 0, indicatesSelected: false, solidity: 0 });
    mergeSpotChannel(doc, 'g1');
    const px = flattenToPixels(doc, { depth: 8 }).data;
    expect(Math.abs(px[0] - 102)).toBeLessThanOrEqual(1);
    expect(px[0]).toBe(px[1]);
    expect(px[7 * 4]).toBe(255);
  });

  it('merges into CMYK documents and is unavailable for Duotone, Multichannel and Lab', async () => {
    await colorEngine.init();
    const { doc } = importPsd(fixture('cmyk-spot.psd'), 's.psd');
    const id = doc.channels[1].id;
    const before = doc.allLayers().length;
    expect(mergeSpotUnavailable(doc, id)).toBeNull();
    mergeSpotChannel(doc, id);
    expect(doc.channels.map((c) => c.name)).toEqual(['blue', 'yellow']);
    expect(doc.allLayers().length).toBeGreaterThan(before);
    const duo = importPsd(fixture('4x4_8bit_duotone.psd'), 'd.psd').doc;
    duo.channels.push({ ...doc.channels[0], id: 'x' });
    expect(mergeSpotUnavailable(duo, 'x')).toMatch(/RGB, CMYK or Grayscale/);
    const lab = newDoc(4, 4);
    lab.canvas = { ...lab.canvas, colorMode: 'lab' };
    lab.channels.push({ ...doc.channels[0], id: 'y' });
    expect(mergeSpotUnavailable(lab, 'y')).toMatch(/Lab/);
    expect(mergeSpotUnavailable(lab, 'missing')).toMatch(/spot/);
  });
});
