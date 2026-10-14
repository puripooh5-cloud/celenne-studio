/** Native CMYK / Lab in TIFF, JPEG and PDF, and ink-preserving content-aware fill. */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzlibSync } from 'fflate';
import { add, newDoc, solidLayer } from '../helpers/build';
import { celenneCmykProfile } from '../../src/color/cmykProfile';
import { colorEngine } from '../../src/color/cms';
import { exporterFor, findImporter } from '../../src/formats/registry';
import { decodeJpegCmyk, jpegComponents, jpegICC } from '../../src/formats/codecs';
import { encodeJpegCmyk } from '../../src/formats/jpegEncoder';
import { inpaintCarry } from '../../src/ai/inpaint';
import type { CelenneDocument } from '../../src/document/document';
import type { TiledRaster } from '../../src/image-engine/tiledRaster';
import { builtinProfileICC } from '../../src/color/icc';

const dump = (name: string, bytes: Uint8Array) => { if (process.env.CELENNE_DUMP) writeFileSync(join(process.env.CELENNE_DUMP, name), bytes); };

function cmykDoc(depth: 8 | 16 = 8): CelenneDocument {
  const doc = newDoc(10, 6, depth);
  doc.canvas = { ...doc.canvas, colorMode: 'cmyk' };
  doc.profile = { name: 'Celenne CMYK', icc: celenneCmykProfile() };
  const l = solidLayer(doc, 'ink', 0, 0, 10, 6, [0.2, 0.6, 1, 1]); // C 80 %, M 40 %, Y 0 %
  l.raster.companion = solidLayer(doc, 'k', 0, 0, 10, 6, [0.7, 0.7, 0.7, 1]).raster; // K 30 %
  add(doc, l);
  return doc;
}

function pixel(doc: CelenneDocument, x = 0, y = 0) {
  const r = (doc.root.children[0] as unknown as { raster: TiledRaster }).raster;
  const p0 = r.readFloat({ x, y, w: 1, h: 1 });
  const p1 = r.companion?.readFloat({ x, y, w: 1, h: 1 });
  return { p0: [...p0].map((v) => Math.round(v * 255)), k: p1 ? Math.round(p1[0] * 255) : null };
}

async function roundTrip(doc: CelenneDocument, ext: string, opts = {}) {
  const bytes = await exporterFor(ext)!.export(doc, opts);
  dump(`roundtrip-${doc.canvas.colorMode}-${doc.canvas.bitDepth}.${ext}`, bytes);
  const imp = findImporter(bytes, `x.${ext}`)!;
  return { bytes, out: await imp.import(bytes, `x.${ext}`, {}) };
}

describe('CMYK and Lab TIFF', () => {
  it('writes CMYK TIFF with the profile and reopens it as CMYK, exactly', async () => {
    const { out } = await roundTrip(cmykDoc(), 'tif');
    expect(out.doc.canvas.colorMode).toBe('cmyk');
    expect(out.doc.profile.icc?.length).toBe(celenneCmykProfile().length);
    expect(pixel(out.doc)).toEqual({ p0: [51, 153, 255, 255], k: 179 });
  });

  it('keeps 16-bit CMYK and transparency', async () => {
    const doc = cmykDoc(16);
    add(doc, solidLayer(doc, 'half', 2, 2, 3, 2, [1, 1, 1, 0])); // fully transparent layer: no change
    const r = (doc.root.children[0] as unknown as { raster: TiledRaster });
    r.raster.writeFloat({ x: 0, y: 0, w: 1, h: 1 }, Float32Array.from([0.25, 0.5, 0.75, 0.5]));
    r.raster.companion!.writeFloat({ x: 0, y: 0, w: 1, h: 1 }, Float32Array.from([0.4, 0.4, 0.4, 0.5]));
    const { out } = await roundTrip(doc, 'tif');
    expect(out.doc.canvas.bitDepth).toBe(16);
    const back = (out.doc.root.children[0] as unknown as { raster: TiledRaster }).raster;
    const a = back.readFloat({ x: 0, y: 0, w: 1, h: 1 });
    expect(a[0]).toBeCloseTo(0.25, 4);
    expect(a[3]).toBeCloseTo(0.5, 4);
    expect(back.companion!.readFloat({ x: 0, y: 0, w: 1, h: 1 })[0]).toBeCloseTo(0.4, 4);
  });

  it('writes and reads CIE Lab TIFF', async () => {
    const doc = newDoc(4, 4);
    doc.canvas = { ...doc.canvas, colorMode: 'lab' };
    doc.profile = { name: 'Lab Color (D50)', builtin: 'labD50' };
    add(doc, solidLayer(doc, 'lab', 0, 0, 4, 4, [0.6, 0.7, 0.3, 1]));
    const { out } = await roundTrip(doc, 'tif');
    expect(out.doc.canvas.colorMode).toBe('lab');
    expect(pixel(out.doc).p0).toEqual([153, 179, 77, 255]);
  });

  it('writes 16-bit RGB TIFF with its profile', async () => {
    const doc = newDoc(4, 4, 16);
    doc.profile = { name: 'Adobe RGB (1998)', builtin: 'adobeRGB' };
    add(doc, solidLayer(doc, 'c', 0, 0, 4, 4, [0.1, 0.5, 0.9, 1]));
    const { out } = await roundTrip(doc, 'tif');
    expect(out.doc.canvas.bitDepth).toBe(16);
    expect(out.doc.profile.icc?.length).toBe(builtinProfileICC('adobeRGB').length);
    const px = (out.doc.root.children[0] as unknown as { raster: TiledRaster }).raster.readFloat({ x: 1, y: 1, w: 1, h: 1 });
    expect(px[1]).toBeCloseTo(0.5, 4);
  });
});

describe('CMYK JPEG', () => {
  it('encodes Adobe CMYK JPEG and decodes the inks back', () => {
    const w = 16, h = 16;
    const ink = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) ink.set(i < 128 ? [204, 102, 0, 77] : [0, 0, 0, 255], i * 4);
    const jpg = encodeJpegCmyk(w, h, ink, 95);
    dump('cmyk-encoded.jpg', jpg);
    expect(jpegComponents(jpg)).toBe(4);
    const img = decodeJpegCmyk(jpg);
    const [p0, p1] = img.native!.plates;
    expect(Math.abs(255 - p0[0] - 204)).toBeLessThanOrEqual(3);
    expect(Math.abs(255 - p0[1] - 102)).toBeLessThanOrEqual(3);
    expect(Math.abs(255 - p1[0] - 77)).toBeLessThanOrEqual(3);
    expect(255 - p1[(w * h - 1) * 4]).toBeGreaterThanOrEqual(252);
  });

  it('exports a CMYK document as CMYK JPEG with its profile and reopens it as CMYK', async () => {
    const { bytes, out } = await roundTrip(cmykDoc(), 'jpg', { quality: 0.95 });
    expect(jpegComponents(bytes)).toBe(4);
    expect(jpegICC(bytes)?.length).toBe(celenneCmykProfile().length);
    expect(out.doc.canvas.colorMode).toBe('cmyk');
    const { p0, k } = pixel(out.doc, 4, 3);
    expect(Math.abs(p0[0] - 51)).toBeLessThanOrEqual(3);
    expect(Math.abs(p0[1] - 153)).toBeLessThanOrEqual(3);
    expect(Math.abs(k! - 179)).toBeLessThanOrEqual(3);
  });
});

describe('CMYK and Lab PDF', () => {
  const imageStream = (pdf: Uint8Array) => {
    const s = new TextDecoder('latin1').decode(pdf);
    const at = s.indexOf('/Subtype /Image');
    const dictEnd = s.indexOf('stream\n', at);
    const len = Number(/\/Length (\d+)/.exec(s.slice(at, dictEnd))![1]);
    return { dict: s.slice(s.lastIndexOf('obj', at), dictEnd), data: pdf.subarray(dictEnd + 7, dictEnd + 7 + len), text: s };
  };

  it('writes CMYK image data with the CMYK profile', async () => {
    const pdf = await exporterFor('pdf')!.export(cmykDoc(), {});
    dump('cmyk.pdf', pdf);
    const { dict, data, text } = imageStream(pdf);
    expect(text).toContain('/N 4 /Alternate /DeviceCMYK');
    expect(dict).toContain('/ICCBased');
    const px = unzlibSync(data);
    expect([...px.subarray(0, 4)]).toEqual([204, 102, 0, 76]);
  });

  it('writes Lab image data in a CIE Lab colour space', async () => {
    const doc = newDoc(4, 4);
    doc.canvas = { ...doc.canvas, colorMode: 'lab' };
    doc.profile = { name: 'Lab Color (D50)', builtin: 'labD50' };
    add(doc, solidLayer(doc, 'lab', 0, 0, 4, 4, [0.6, 0.7, 0.3, 1]));
    const pdf = await exporterFor('pdf')!.export(doc, {});
    dump('lab.pdf', pdf);
    const { dict, data } = imageStream(pdf);
    expect(dict).toContain('/Lab');
    expect([...unzlibSync(data).subarray(0, 3)]).toEqual([153, 179, 77]);
  });

  it('writes lossy CMYK as an inverted Adobe JPEG with a Decode array', async () => {
    const pdf = await exporterFor('pdf')!.export(cmykDoc(), { quality: 0.9 });
    dump('cmyk-lossy.pdf', pdf);
    const { dict, data } = imageStream(pdf);
    expect(dict).toContain('/DCTDecode');
    expect(dict).toContain('/Decode [1 0 1 0 1 0 1 0]');
    expect(jpegComponents(data)).toBe(4);
  });
});

describe('Ink-preserving content-aware fill', () => {
  const texture = (w: number, h: number) => {
    const g = new Float32Array(w * h * 4);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < w * h; i++) { const v = 0.15 + 0.3 * rnd(); g.set([v, v * 0.9, v * 0.8, 1], i * 4); }
    return g;
  };

  it('synthesises carried plates from exactly the patches used for the image', () => {
    const w = 64, h = 48, n = w * h;
    const guide = texture(w, h);
    // A plate that is a copy of the guide must come out identical to the inpainted guide.
    const copy = guide.slice();
    const hole = new Uint8Array(n);
    for (let y = 18; y < 30; y++) for (let x = 24; x < 38; x++) hole[y * w + x] = 1;
    const r = inpaintCarry(guide, w, h, hole, [copy]);
    let maxDiff = 0;
    for (let i = 0; i < n; i++) if (hole[i]) for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(r.carried[0][i * 4 + c] - r.image[i * 4 + c]));
    expect(maxDiff).toBeLessThan(1e-5);
  });

  it('keeps the black plate of the surroundings (no re-separation)', async () => {
    await colorEngine.init();
    const w = 64, h = 48, n = w * h;
    const guide = texture(w, h);
    // Dark tones built from 75 % K with light CMY: a separation of the RGB result would not give this.
    const p0 = new Float32Array(n * 4).fill(0.8), p1 = new Float32Array(n * 4).fill(0.25);
    for (let i = 0; i < n; i++) { p0[i * 4 + 3] = 1; p1[i * 4 + 3] = 1; }
    const hole = new Uint8Array(n);
    for (let y = 18; y < 30; y++) for (let x = 24; x < 38; x++) hole[y * w + x] = 1;
    const r = inpaintCarry(guide, w, h, hole, [p0, p1]);
    for (let i = 0; i < n; i++) {
      if (!hole[i]) continue;
      expect(r.carried[1][i * 4]).toBeCloseTo(0.25, 5);
      expect(r.carried[0][i * 4]).toBeCloseTo(0.8, 5);
      expect(r.carried[0][i * 4 + 3]).toBe(r.image[i * 4 + 3]);
    }
  });
});
