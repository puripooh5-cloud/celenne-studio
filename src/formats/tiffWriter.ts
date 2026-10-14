/**
 * Baseline TIFF writer for every Celenne colour mode: RGB, Gray, CMYK (separated, InkSet CMYK) and
 * CIE Lab, 8 or 16 bits per sample, optional unassociated alpha, ICC profile (tag 34675),
 * resolution, Adobe Deflate compression in strips of about 64 KB of uncompressed data.
 */
import { zlibSync } from 'fflate';

export type TiffModel = 'rgb' | 'gray' | 'cmyk' | 'lab';

export interface TiffImage {
  width: number;
  height: number;
  model: TiffModel;
  depth: 8 | 16;
  /**
   * Interleaved samples, colour channels then alpha when `alpha` is set: RGB(A), G(A),
   * C M Y K(A) as ink amounts (0 = no ink), or L a b(A) as TIFF CIELab (L 0..max, a/b signed).
   */
  data: Uint8Array | Uint16Array;
  alpha: boolean;
  icc?: Uint8Array;
  resolution?: number;
}

const COLOR_CHANNELS: Record<TiffModel, number> = { rgb: 3, gray: 1, cmyk: 4, lab: 3 };
const PHOTOMETRIC: Record<TiffModel, number> = { rgb: 2, gray: 1, cmyk: 5, lab: 8 };

export function encodeTiffImage(img: TiffImage): Uint8Array {
  const { width: w, height: h, depth } = img;
  if (w < 1 || h < 1) throw new Error('Empty image');
  const spp = COLOR_CHANNELS[img.model] + (img.alpha ? 1 : 0);
  if (img.data.length !== w * h * spp) throw new Error('TIFF sample data has the wrong length');
  const bytesPerRow = w * spp * (depth / 8);
  const rowsPerStrip = Math.max(1, Math.min(h, Math.floor(65536 / bytesPerRow)));
  const strips: Uint8Array[] = [];
  for (let y = 0; y < h; y += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, h - y);
    const raw = new Uint8Array(rows * bytesPerRow);
    if (depth === 8) raw.set((img.data as Uint8Array).subarray(y * w * spp, (y + rows) * w * spp));
    else {
      // Little-endian file: 16-bit samples low byte first.
      const src = img.data as Uint16Array;
      const base = y * w * spp;
      for (let i = 0; i < rows * w * spp; i++) { const v = src[base + i]; raw[i * 2] = v & 255; raw[i * 2 + 1] = v >> 8; }
    }
    strips.push(zlibSync(raw, { level: 6 }));
  }

  type Entry = { tag: number; type: number; values: number[] | Uint8Array };
  const SHORT = 3, LONG = 4, RATIONAL = 5, UNDEFINED = 7;
  const entries: Entry[] = [
    { tag: 256, type: LONG, values: [w] },
    { tag: 257, type: LONG, values: [h] },
    { tag: 258, type: SHORT, values: new Array(spp).fill(depth) },
    { tag: 259, type: SHORT, values: [8] },
    { tag: 262, type: SHORT, values: [PHOTOMETRIC[img.model]] },
    { tag: 273, type: LONG, values: strips.map(() => 0) },
    { tag: 277, type: SHORT, values: [spp] },
    { tag: 278, type: LONG, values: [rowsPerStrip] },
    { tag: 279, type: LONG, values: strips.map((s) => s.length) },
    { tag: 284, type: SHORT, values: [1] },
  ];
  if (img.resolution) {
    entries.push({ tag: 282, type: RATIONAL, values: [Math.round(img.resolution * 1000), 1000] });
    entries.push({ tag: 283, type: RATIONAL, values: [Math.round(img.resolution * 1000), 1000] });
    entries.push({ tag: 296, type: SHORT, values: [2] });
  }
  if (img.model === 'cmyk') entries.push({ tag: 332, type: SHORT, values: [1] });
  if (img.alpha) entries.push({ tag: 338, type: SHORT, values: [2] });
  if (img.icc) entries.push({ tag: 34675, type: UNDEFINED, values: img.icc });
  entries.sort((a, b) => a.tag - b.tag);

  const size = (e: Entry) => (e.type === SHORT ? 2 : e.type === LONG ? 4 : e.type === RATIONAL ? 4 : 1) * e.values.length;
  // Layout: header (8) · IFD · out-of-line values · strips.
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 0;
  for (const e of entries) if (size(e) > 4) extra += size(e) + (size(e) & 1);
  const stripStart = 8 + ifdSize + extra;
  let p = stripStart;
  const offsets = strips.map((s) => { const o = p; p += s.length; return o; });
  entries.find((e) => e.tag === 273)!.values = offsets;
  const out = new Uint8Array(p);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  let valueAt = 8 + ifdSize;
  entries.forEach((e, i) => {
    const at = 10 + i * 12;
    dv.setUint16(at, e.tag, true);
    dv.setUint16(at + 2, e.type, true);
    dv.setUint32(at + 4, e.type === RATIONAL ? e.values.length / 2 : e.values.length, true);
    const n = size(e);
    const write = (o: number) => {
      if (e.values instanceof Uint8Array) { out.set(e.values, o); return; }
      e.values.forEach((v, k) => {
        if (e.type === SHORT) dv.setUint16(o + k * 2, v, true);
        else dv.setUint32(o + k * 4, v, true);
      });
    };
    if (n <= 4) write(at + 8);
    else {
      dv.setUint32(at + 8, valueAt, true);
      write(valueAt);
      valueAt += n + (n & 1);
    }
  });
  dv.setUint32(10 + entries.length * 12, 0, true);
  strips.forEach((s, i) => out.set(s, offsets[i]));
  return out;
}
