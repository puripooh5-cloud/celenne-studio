/** Camera RAW: synthetic DNGs (uncompressed strips and lossless-JPEG tiles) decoded end to end. */
import { describe, expect, it } from 'vitest';
import { decodeDng, decodeLosslessJpeg, embeddedJpegs, isDng } from '../../src/formats/dng';
import { rgbConversionMatrix } from '../../src/color/icc';
import { findImporter } from '../../src/formats/registry';

// ---- Lossless JPEG encoder (test helper): predictor 1, one table of 5-bit codes for SSSS 0..16.
function encodeLJ92(samples: Uint16Array, X: number, Y: number, Nc: number, P = 16): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  const seg = (m: number, body: number[]) => out.push(0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255, ...body);
  const counts = new Array(16).fill(0);
  counts[4] = 17;
  seg(0xc4, [0x00, ...counts, ...Array.from({ length: 17 }, (_, i) => i)]);
  const comps: number[] = [];
  for (let c = 0; c < Nc; c++) comps.push(c + 1, 0x11, 0);
  seg(0xc3, [P, Y >> 8, Y & 255, X >> 8, X & 255, Nc, ...comps]);
  const sc: number[] = [];
  for (let c = 0; c < Nc; c++) sc.push(c + 1, 0x00);
  seg(0xda, [Nc, ...sc, 1, 0, 0]);
  let acc = 0, n = 0;
  const put = (v: number, bits: number) => {
    for (let b = bits - 1; b >= 0; b--) {
      acc = (acc << 1) | ((v >> b) & 1);
      n++;
      if (n === 8) {
        out.push(acc);
        if (acc === 0xff) out.push(0);
        acc = 0;
        n = 0;
      }
    }
  };
  const row = X * Nc;
  for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) for (let c = 0; c < Nc; c++) {
    const i = y * row + x * Nc + c;
    const pr = y === 0 && x === 0 ? 1 << (P - 1) : y === 0 ? samples[i - Nc] : x === 0 ? samples[i - row] : samples[i - Nc];
    let diff = (samples[i] - pr) & 0xffff;
    if (diff > 32768) diff -= 65536;
    const a = Math.abs(diff);
    const s = a === 32768 ? 16 : a ? 32 - Math.clz32(a) : 0;
    put(s, 5);
    if (s && s < 16) put(diff > 0 ? diff : diff + (1 << s) - 1, s);
  }
  if (n) put(0xff, 8 - n);
  out.push(0xff, 0xd9);
  return new Uint8Array(out);
}

// ---- Minimal little-endian TIFF / DNG writer (IFD0 + one raw SubIFD).
type Tag = [number, number, number[]]; // tag, type, values
function writeDng(ifd0: Tag[], raw: Tag[], data: Uint8Array[], dataTag: 'strip' | 'tile'): Uint8Array {
  const buf: number[] = [];
  const u16 = (v: number) => buf.push(v & 255, (v >> 8) & 255);
  const u32 = (v: number) => buf.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  buf.push(0x49, 0x49);
  u16(42);
  u32(8);
  const pending: { at: number; bytes: number[] }[] = [];
  let extraAt = 1024;
  let o = 4096;
  const offsets: number[] = [];
  for (const d of data) {
    offsets.push(o);
    o += d.length + (d.length & 1);
  }
  const writeIfd = (tags: Tag[]) => {
    tags.sort((a, b) => a[0] - b[0]);
    u16(tags.length);
    for (const [tag, type, vals] of tags) {
      u16(tag);
      u16(type);
      u32(vals.length);
      const bytes: number[] = [];
      for (const v of vals) {
        if (type === 3) bytes.push(v & 255, (v >> 8) & 255);
        else if (type === 4) bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
        else if (type === 5 || type === 10) {
          const den = 1000000, num = Math.round(v * den);
          for (const q of [num, den]) bytes.push(q & 255, (q >>> 8) & 255, (q >>> 16) & 255, (q >>> 24) & 255);
        } else bytes.push(v & 255);
      }
      if (bytes.length <= 4) {
        while (bytes.length < 4) bytes.push(0);
        buf.push(...bytes);
      } else {
        u32(extraAt);
        pending.push({ at: extraAt, bytes });
        extraAt += bytes.length + (bytes.length & 1);
      }
    }
    u32(0);
  };
  const rawTags: Tag[] = [...raw, [dataTag === 'strip' ? 273 : 324, 4, offsets], [dataTag === 'strip' ? 279 : 325, 4, data.map((d) => d.length)]];
  const ifd0Tags: Tag[] = [...ifd0];
  const rawAt = 8 + 2 + (ifd0Tags.length + 1) * 12 + 4;
  ifd0Tags.push([330, 4, [rawAt]]);
  writeIfd(ifd0Tags);
  writeIfd(rawTags);
  const bytes = new Uint8Array(o);
  bytes.set(buf);
  for (const p of pending) bytes.set(p.bytes, p.at);
  data.forEach((d, i) => bytes.set(d, offsets[i]));
  return bytes;
}

// sRGB → XYZ (dcraw's), so a camera "space" equal to linear sRGB has ColorMatrix = its inverse.
const XYZ_RGB = [[0.412453, 0.35758, 0.180423], [0.212671, 0.71516, 0.072169], [0.019334, 0.119193, 0.950227]];
function inv(m: number[][]): number[][] {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
const CM = inv(XYZ_RGB).flat();

/** A smooth test image (linear sRGB) mosaiced to RGGB. */
function scene(W: number, H: number) {
  const rgb = (x: number, y: number) => [0.15 + 0.5 * (x / W), 0.2 + 0.4 * (y / H), 0.5 - 0.3 * (x / W)];
  const cfa = new Uint16Array(W * H);
  const black = 256, white = 16383;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = (y & 1) === 0 ? ((x & 1) === 0 ? 0 : 1) : ((x & 1) === 0 ? 1 : 2);
    cfa[y * W + x] = Math.round(black + rgb(x, y)[c] * (white - black));
  }
  return { rgb, cfa, black, white };
}

const pro = rgbConversionMatrix('linearSRGB', 'proPhotoRGB');
const expected = (c: number[]) => pro.map((r) => Math.round(Math.pow(Math.max(0, r[0] * c[0] + r[1] * c[1] + r[2] * c[2]), 1 / 1.8) * 65535));

function baseTags(W: number, H: number, black: number, white: number): { ifd0: Tag[]; raw: Tag[] } {
  return {
    ifd0: [[254, 4, [1]], [256, 4, [32]], [257, 4, [24]], [50706, 1, [1, 4, 0, 0]], [50721, 10, CM], [50778, 3, [21]], [50728, 5, [1, 1, 1]]],
    raw: [[254, 4, [0]], [256, 4, [W]], [257, 4, [H]], [258, 3, [16]], [262, 3, [32803]], [277, 3, [1]], [33421, 3, [2, 2]], [33422, 1, [0, 1, 1, 2]], [50714, 4, [black]], [50717, 4, [white]]],
  };
}

describe('Camera RAW (DNG)', () => {
  it.skipIf(!process.env.BENCH)('bench 24 MP', () => {
    const W = 6000, H = 4000;
    const { cfa, black, white } = scene(W, H);
    const { ifd0, raw } = baseTags(W, H, black, white);
    const dng = writeDng(ifd0, [...raw, [259, 3, [1]], [278, 4, [H]]], [new Uint8Array(cfa.buffer.slice(0))], 'strip');
    const t0 = performance.now();
    decodeDng(dng);
    console.log('24MP decode ms', Math.round(performance.now() - t0));
  }, 120000);

  it('decodes lossless JPEG streams exactly', () => {
    const s = new Uint16Array(64 * 3 * 2);
    for (let i = 0; i < s.length; i++) s[i] = (i * 977 + (i >> 3) * 31) & 0x3fff;
    const d = decodeLosslessJpeg(encodeLJ92(s, 64, 3, 2));
    expect([d.width, d.height, d.components]).toEqual([64, 3, 2]);
    expect(Array.from(d.samples)).toEqual(Array.from(s));
  });

  it('decodes an uncompressed CFA DNG with black level, white balance and colour matrix', () => {
    const W = 64, H = 48;
    const { rgb, cfa, black, white } = scene(W, H);
    const { ifd0, raw } = baseTags(W, H, black, white);
    const dng = writeDng(ifd0, [...raw, [259, 3, [1]], [278, 4, [H]]], [new Uint8Array(cfa.buffer.slice(0))], 'strip');
    expect(isDng(dng)).toBe(true);
    const img = decodeDng(dng);
    expect([img.width, img.height, img.depth]).toEqual([W, H, 16]);
    for (const [x, y] of [[10, 10], [33, 20], [50, 40]]) {
      const o = (y * W + x) * 4;
      const e = expected(rgb(x, y));
      for (let c = 0; c < 3; c++) expect(Math.abs(img.data[o + c] - e[c])).toBeLessThan(120); // < 1.4 %
    }
  });

  it('decodes lossless-JPEG tiles, default crop and orientation', () => {
    const W = 64, H = 48, TW = 32, TH = 24;
    const { rgb, cfa, black, white } = scene(W, H);
    const tiles: Uint8Array[] = [];
    for (let ty = 0; ty < H / TH; ty++) for (let tx = 0; tx < W / TW; tx++) {
      const t = new Uint16Array(TW * TH);
      for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) t[y * TW + x] = cfa[(ty * TH + y) * W + tx * TW + x];
      tiles.push(encodeLJ92(t, TW / 2, TH, 2));
    }
    const { ifd0, raw } = baseTags(W, H, black, white);
    ifd0.push([274, 3, [6]]); // rotate 90° clockwise
    const dng = writeDng(ifd0, [...raw, [259, 3, [7]], [322, 4, [TW]], [323, 4, [TH]], [50719, 4, [4, 2]], [50720, 4, [56, 40]]], tiles, 'tile');
    const img = decodeDng(dng);
    expect([img.width, img.height]).toEqual([40, 56]);
    // Orientation 6: output (X, Y) shows cropped source (x = Y, y = h - 1 - X).
    for (const [X, Y] of [[5, 10], [20, 30], [35, 50]]) {
      const sx = Y + 4, sy = 40 - 1 - X + 2;
      const e = expected(rgb(sx, sy));
      const o = (Y * 40 + X) * 4;
      for (let c = 0; c < 3; c++) expect(Math.abs(img.data[o + c] - e[c])).toBeLessThan(120);
    }
  });

  it('opens as a 16-bit ProPhoto document through the importer registry', async () => {
    const W = 32, H = 24;
    const { cfa, black, white } = scene(W, H);
    const { ifd0, raw } = baseTags(W, H, black, white);
    const dng = writeDng(ifd0, [...raw, [259, 3, [1]], [278, 4, [H]]], [new Uint8Array(cfa.buffer.slice(0))], 'strip');
    const imp = findImporter(dng, 'photo.dng');
    expect(imp?.id).toBe('raw');
    const r = await imp!.import(dng, 'photo.dng', {});
    expect([r.doc.width, r.doc.height, r.doc.canvas.bitDepth]).toEqual([W, H, 16]);
    expect(r.doc.profile.builtin).toBe('proPhotoRGB');
    // How it was decoded is a note in the Compatibility Report, not a warning.
    expect(r.issues.find((i) => /DNG/.test(i.message))?.status).toBe('editable');
    expect(r.warnings).toEqual([]);
  });

  it('rejects files that are not DNG and finds embedded JPEG previews', () => {
    expect(isDng(new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 4, 0, 0, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0, 4, 0xff, 0xd9];
    const file = new Uint8Array([1, 2, 3, ...jpeg, 9, 9, ...jpeg.slice(0, 10)]);
    const found = embeddedJpegs(file);
    expect(found.length).toBe(1);
    expect(found[0].length).toBe(jpeg.length);
  });
});
