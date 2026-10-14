/**
 * Camera RAW: DNG decoding, and embedded-preview extraction (the fallback for raw files that
 * cannot be decoded).
 *
 * DNG pipeline (the open, documented RAW format):
 *   TIFF IFDs → raw IFD (CFA or LinearRaw) → samples (uncompressed or lossless JPEG, strips or
 *   tiles) → active area → linearization table → black / white levels → white balance
 *   (AsShotNeutral) → demosaic (Malvar–He–Cutler for 2×2 Bayer, neighbourhood average for other
 *   patterns) → camera → linear sRGB (ColorMatrix, dcraw-style normalisation) → ProPhoto RGB,
 *   16 bits/channel → default crop → orientation. The development stages are shared with the
 *   proprietary formats (rawDevelop.ts).
 * Not applied: DNG opcode lists (lens corrections, gain maps), camera profiles (DCP), lossy DNG
 * and floating-point DNG. They are reported as warnings.
 *
 * Proprietary formats (CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW, …) are unpacked by LibRaw
 * (libraw.ts) and developed by the same stages.
 */
import type { DecodedImage } from './raster';
import { cameraToSRGB, developSensor, MAX_RAW_PIXELS } from './rawDevelop';

// ---------------------------------------------------------------------------------------------
// TIFF
// ---------------------------------------------------------------------------------------------
interface Entry { type: number; count: number; offset: number }
type Ifd = Map<number, Entry>;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

class Tiff {
  readonly dv: DataView;
  readonly le: boolean;
  constructor(readonly bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const b0 = bytes[0], b1 = bytes[1];
    if (!((b0 === 0x49 && b1 === 0x49) || (b0 === 0x4d && b1 === 0x4d))) throw new Error('Not a TIFF-based file');
    this.le = b0 === 0x49;
  }
  u16(o: number) { return this.dv.getUint16(o, this.le); }
  u32(o: number) { return this.dv.getUint32(o, this.le); }
  firstIfd(): number { return this.u32(4); }

  readIfd(off: number): { ifd: Ifd; next: number } {
    if (off <= 0 || off + 2 > this.bytes.length) throw new Error('Invalid IFD offset');
    const n = this.u16(off);
    if (n > 4096 || off + 2 + n * 12 + 4 > this.bytes.length) throw new Error('Invalid IFD');
    const ifd: Ifd = new Map();
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const tag = this.u16(e), type = this.u16(e + 2), count = this.u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      const offset = size <= 4 ? e + 8 : this.u32(e + 8);
      if (offset + size > this.bytes.length) continue; // truncated value: ignore the tag
      ifd.set(tag, { type, count, offset });
    }
    return { ifd, next: this.u32(off + 2 + n * 12) };
  }

  nums(ifd: Ifd, tag: number): number[] | null {
    const e = ifd.get(tag);
    if (!e) return null;
    const out: number[] = [];
    const cap = Math.min(e.count, 1 << 20);
    for (let i = 0; i < cap; i++) {
      const o = e.offset + i * (TYPE_SIZE[e.type] ?? 1);
      switch (e.type) {
        case 1: case 2: case 7: out.push(this.bytes[o]); break;
        case 6: out.push(this.dv.getInt8(o)); break;
        case 3: out.push(this.u16(o)); break;
        case 8: out.push(this.dv.getInt16(o, this.le)); break;
        case 4: case 13: out.push(this.u32(o)); break;
        case 9: out.push(this.dv.getInt32(o, this.le)); break;
        case 5: { const d = this.u32(o + 4); out.push(d ? this.u32(o) / d : 0); break; }
        case 10: { const d = this.dv.getInt32(o + 4, this.le); out.push(d ? this.dv.getInt32(o, this.le) / d : 0); break; }
        case 11: out.push(this.dv.getFloat32(o, this.le)); break;
        case 12: out.push(this.dv.getFloat64(o, this.le)); break;
        default: out.push(this.bytes[o]);
      }
    }
    return out;
  }

  num(ifd: Ifd, tag: number, dflt: number): number {
    return this.nums(ifd, tag)?.[0] ?? dflt;
  }

  /** IFD0 chain plus all SubIFDs (tag 330), depth-first. */
  allIfds(): Ifd[] {
    const out: Ifd[] = [];
    const seen = new Set<number>();
    const visit = (off: number, depth: number) => {
      while (off && !seen.has(off) && depth < 4 && out.length < 64) {
        seen.add(off);
        const { ifd, next } = this.readIfd(off);
        out.push(ifd);
        for (const s of this.nums(ifd, 330) ?? []) visit(s, depth + 1);
        off = next;
      }
    };
    visit(this.firstIfd(), 0);
    return out;
  }
}

const T = {
  NewSubFileType: 254, Width: 256, Height: 257, BitsPerSample: 258, Compression: 259, Photometric: 262,
  StripOffsets: 273, Orientation: 274, SamplesPerPixel: 277, RowsPerStrip: 278, StripByteCounts: 279,
  PlanarConfig: 284, TileWidth: 322, TileLength: 323, TileOffsets: 324, TileByteCounts: 325, SampleFormat: 339,
  CFARepeatPatternDim: 33421, CFAPattern: 33422, DNGVersion: 50706, CFAPlaneColor: 50710,
  LinearizationTable: 50712, BlackLevelRepeatDim: 50713, BlackLevel: 50714, BlackLevelDeltaH: 50715, BlackLevelDeltaV: 50716,
  WhiteLevel: 50717, DefaultCropOrigin: 50719, DefaultCropSize: 50720, ColorMatrix1: 50721, ColorMatrix2: 50722,
  AnalogBalance: 50727, AsShotNeutral: 50728, AsShotWhiteXY: 50729, BaselineExposure: 50730,
  CalibrationIlluminant1: 50778, CalibrationIlluminant2: 50779, ActiveArea: 50829,
  OpcodeList1: 51008, OpcodeList2: 51009, OpcodeList3: 51022,
};

export function isDng(bytes: Uint8Array): boolean {
  try {
    const t = new Tiff(bytes);
    return t.readIfd(t.firstIfd()).ifd.has(T.DNGVersion);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Lossless JPEG (ITU-T T.81 process 14, SOF3) — the compression DNG uses.
// ---------------------------------------------------------------------------------------------
interface Huff { lut: Uint32Array }

function buildHuff(counts: number[], symbols: number[]): Huff {
  // 16-bit lookup: entry = (length << 8) | symbol; 0 = invalid code.
  const lut = new Uint32Array(65536);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) {
      const sym = symbols[k++];
      const shift = 16 - len;
      const base = code << shift;
      for (let j = 0; j < 1 << shift; j++) lut[base + j] = (len << 8) | sym;
      code++;
    }
    code <<= 1;
  }
  return { lut };
}

/** Decodes one lossless JPEG stream into samples (row-major, components interleaved). */
export function decodeLosslessJpeg(d: Uint8Array): { width: number; height: number; components: number; precision: number; samples: Uint16Array } {
  let p = 0;
  const u16 = (o: number) => (d[o] << 8) | d[o + 1];
  if (d[0] !== 0xff || d[1] !== 0xd8) throw new Error('Lossless JPEG: missing SOI');
  p = 2;
  const tables: (Huff | undefined)[] = [];
  let X = 0, Y = 0, Nc = 0, P = 0, restart = 0;
  let compIds: number[] = [];
  for (;;) {
    while (p < d.length && d[p] !== 0xff) p++;
    while (p < d.length && d[p] === 0xff) p++;
    if (p >= d.length) throw new Error('Lossless JPEG: unexpected end');
    const m = d[p++];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xd9) throw new Error('Lossless JPEG: no scan');
    const len = u16(p);
    const seg = p + 2, end = p + len;
    if (end > d.length) throw new Error('Lossless JPEG: truncated segment');
    if (m === 0xc4) {
      let q = seg;
      while (q < end) {
        const id = d[q] & 15;
        const counts = Array.from(d.subarray(q + 1, q + 17));
        const total = counts.reduce((a, b) => a + b, 0);
        tables[id] = buildHuff(counts, Array.from(d.subarray(q + 17, q + 17 + total)));
        q += 17 + total;
      }
    } else if (m === 0xc3) {
      P = d[seg]; Y = u16(seg + 1); X = u16(seg + 3); Nc = d[seg + 5];
      compIds = Array.from({ length: Nc }, (_, i) => d[seg + 6 + i * 3]);
      if (!X || !Y || !Nc || Nc > 4 || P < 2 || P > 16) throw new Error('Lossless JPEG: unsupported frame');
    } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw new Error('Not a lossless JPEG stream');
    } else if (m === 0xdd) {
      restart = u16(seg);
    } else if (m === 0xda) {
      const Ns = d[seg];
      const tbl: Huff[] = [];
      for (let i = 0; i < Ns; i++) {
        const cs = d[seg + 1 + i * 2];
        const ci = compIds.indexOf(cs);
        const h = tables[d[seg + 2 + i * 2] >> 4];
        if (!h) throw new Error('Lossless JPEG: missing Huffman table');
        tbl[ci >= 0 ? ci : i] = h;
      }
      const pred = d[seg + 1 + Ns * 2];
      const pt = d[seg + 3 + Ns * 2] & 15;
      if (Ns !== Nc) throw new Error('Lossless JPEG: non-interleaved scans are not supported');
      return { width: X, height: Y, components: Nc, precision: P, samples: decodeScan(d, end, X, Y, Nc, P, pred, pt, tbl, restart) };
    }
    p = end;
  }
}

function decodeScan(d: Uint8Array, start: number, X: number, Y: number, Nc: number, P: number, pred: number, pt: number, tbl: Huff[], restart: number): Uint16Array {
  const out = new Uint16Array(X * Y * Nc);
  let pos = start, buf = 0, bits = 0, marker = false;
  const fill = () => {
    while (bits <= 24) {
      let b = 0;
      if (!marker && pos < d.length) {
        b = d[pos];
        if (b === 0xff) {
          const n = d[pos + 1];
          if (n === 0) pos += 2;
          else { marker = true; b = 0; }
        } else pos++;
      }
      buf = ((buf << 8) | b) >>> 0;
      bits += 8;
    }
  };
  const bitsFor = (n: number) => {
    if (!n) return 0;
    if (bits < n) fill();
    const v = (buf >>> (bits - n)) & ((1 << n) - 1);
    bits -= n;
    return v;
  };
  const decodeDiff = (h: Huff) => {
    if (bits < 16) fill();
    const e = h.lut[(buf >>> (bits - 16)) & 0xffff];
    if (!e) throw new Error('Lossless JPEG: corrupt data');
    bits -= e >> 8;
    const s = e & 255;
    if (s === 0) return 0;
    if (s === 16) return 32768;
    const v = bitsFor(s);
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  };
  const initial = 1 << (P - pt - 1);
  const row = X * Nc;
  // Restart intervals are supported when they cover whole rows (as DNG writers produce).
  if (restart && restart % X !== 0) throw new Error('Lossless JPEG: unsupported restart interval');
  const restartRows = restart ? restart / X : 0;
  let resetRow = 0;
  for (let y = 0; y < Y; y++) {
    if (restartRows && y && y % restartRows === 0) {
      // Restart marker: realign to the byte stream and reset prediction as for a first row.
      bits = 0; buf = 0; marker = false;
      while (pos < d.length - 1 && !(d[pos] === 0xff && d[pos + 1] >= 0xd0 && d[pos + 1] <= 0xd7)) pos++;
      pos += 2;
      resetRow = y;
    }
    for (let x = 0; x < X; x++) {
      for (let c = 0; c < Nc; c++) {
        const i = y * row + x * Nc + c;
        let pr: number;
        const first = y === resetRow;
        if (first && x === 0) pr = initial;
        else if (first) pr = out[i - Nc];
        else if (x === 0) pr = out[i - row];
        else {
          const ra = out[i - Nc], rb = out[i - row], rc = out[i - row - Nc];
          switch (pred) {
            case 1: pr = ra; break;
            case 2: pr = rb; break;
            case 3: pr = rc; break;
            case 4: pr = ra + rb - rc; break;
            case 5: pr = ra + ((rb - rc) >> 1); break;
            case 6: pr = rb + ((ra - rc) >> 1); break;
            case 7: pr = (ra + rb) >> 1; break;
            default: pr = ra;
          }
        }
        out[i] = (pr + decodeDiff(tbl[c])) & 0xffff;
      }
    }
  }
  if (pt) for (let i = 0; i < out.length; i++) out[i] <<= pt;
  return out;
}

// ---------------------------------------------------------------------------------------------
// DNG
// ---------------------------------------------------------------------------------------------
function readSamples(t: Tiff, ifd: Ifd, W: number, H: number, spp: number, bps: number): Uint16Array {
  const comp = t.num(ifd, T.Compression, 1);
  const tiled = ifd.has(T.TileOffsets);
  const offsets = t.nums(ifd, tiled ? T.TileOffsets : T.StripOffsets) ?? [];
  const counts = t.nums(ifd, tiled ? T.TileByteCounts : T.StripByteCounts) ?? [];
  const tw = tiled ? t.num(ifd, T.TileWidth, W) : W;
  const th = tiled ? t.num(ifd, T.TileLength, H) : t.num(ifd, T.RowsPerStrip, H);
  if (!offsets.length || tw <= 0 || th <= 0) throw new Error('DNG: no image data');
  const across = tiled ? Math.ceil(W / tw) : 1;
  const out = new Uint16Array(W * H * spp);
  const rowLen = tw * spp;
  const place = (idx: number, samples: ArrayLike<number>, perRow: number) => {
    const ox = tiled ? (idx % across) * tw : 0, oy = Math.floor(idx / across) * th;
    const rows = Math.min(th, Math.floor(samples.length / perRow));
    for (let r = 0; r < rows && oy + r < H; r++) {
      const n = Math.min(perRow, (W - ox) * spp);
      const dst = ((oy + r) * W + ox) * spp;
      for (let k = 0; k < n; k++) out[dst + k] = samples[r * perRow + k];
    }
  };
  for (let i = 0; i < offsets.length; i++) {
    const off = offsets[i], len = counts[i] ?? t.bytes.length - off;
    if (off + len > t.bytes.length) throw new Error('DNG: image data is truncated');
    const chunk = t.bytes.subarray(off, off + len);
    if (comp === 7) {
      const j = decodeLosslessJpeg(chunk);
      place(i, j.samples, rowLen);
    } else if (comp === 1) {
      const rowsInChunk = tiled ? th : Math.min(th, H - i * th);
      const samples = new Uint16Array(rowLen * rowsInChunk);
      const rowBytes = Math.ceil((rowLen * bps) / 8);
      for (let r = 0; r < rowsInChunk; r++) {
        const base = r * rowBytes;
        if (bps === 16) for (let k = 0; k < rowLen; k++) samples[r * rowLen + k] = t.dv.getUint16(off + base + k * 2, t.le);
        else if (bps === 8) for (let k = 0; k < rowLen; k++) samples[r * rowLen + k] = chunk[base + k];
        else {
          // Packed, MSB first; rows start on byte boundaries.
          let bit = 0;
          for (let k = 0; k < rowLen; k++) {
            let v = 0;
            for (let b = 0; b < bps; b++, bit++) v = (v << 1) | ((chunk[base + (bit >> 3)] >> (7 - (bit & 7))) & 1);
            samples[r * rowLen + k] = v;
          }
        }
      }
      place(i, samples, rowLen);
    } else if (comp === 8) {
      throw new Error('Deflate-compressed (floating-point) DNG is not supported');
    } else if (comp === 34892) {
      throw new Error('Lossy DNG (JPEG-compressed raw data) is not supported');
    } else {
      throw new Error(`DNG compression ${comp} is not supported`);
    }
  }
  return out;
}

export interface RawDecodeOptions {
  /** Exposure adjustment in stops, added to the file's baseline exposure. */
  exposure?: number;
}

/** Decodes a DNG to 16-bit ProPhoto RGB. */
export function decodeDng(bytes: Uint8Array, opts: RawDecodeOptions = {}): DecodedImage & { profile: 'proPhotoRGB' } {
  const t = new Tiff(bytes);
  const ifds = t.allIfds();
  const ifd0 = ifds[0];
  if (!ifd0?.has(T.DNGVersion)) throw new Error('Not a DNG file');
  const warnings: string[] = [];
  // The raw IFD: full resolution (NewSubFileType 0), CFA (32803) or LinearRaw (34892).
  const raw = ifds
    .filter((f) => t.num(f, T.NewSubFileType, 0) === 0 && [32803, 34892].includes(t.num(f, T.Photometric, 0)))
    .sort((a, b) => t.num(b, T.Width, 0) * t.num(b, T.Height, 0) - t.num(a, T.Width, 0) * t.num(a, T.Height, 0))[0];
  if (!raw) throw new Error('DNG: no raw image found');
  const W = t.num(raw, T.Width, 0), H = t.num(raw, T.Height, 0);
  if (!W || !H || W * H > MAX_RAW_PIXELS) throw new Error(`DNG: unsupported size ${W}×${H}`);
  const cfa = t.num(raw, T.Photometric, 0) === 32803;
  const spp = t.num(raw, T.SamplesPerPixel, 1);
  if ((cfa && spp !== 1) || (!cfa && spp !== 3)) throw new Error('DNG: unsupported sample layout');
  if (t.num(raw, T.SampleFormat, 1) === 3) throw new Error('Floating-point DNG is not supported');
  const bps = t.num(raw, T.BitsPerSample, 16);
  if (bps < 1 || bps > 16) throw new Error(`DNG: ${bps}-bit samples are not supported`);
  if (raw.has(T.OpcodeList1) || raw.has(T.OpcodeList2) || raw.has(T.OpcodeList3)) warnings.push('DNG opcode lists (lens corrections, gain maps) are not applied.');

  const samples = readSamples(t, raw, W, H, spp, bps);

  // Active area (top, left, bottom, right).
  const aa = t.nums(raw, T.ActiveArea);
  const top = aa ? aa[0] : 0, left = aa ? aa[1] : 0;
  const AW = (aa ? aa[3] - aa[1] : W), AH = (aa ? aa[2] - aa[0] : H);
  if (AW <= 0 || AH <= 0 || top + AH > H || left + AW > W) throw new Error('DNG: invalid active area');

  // Levels.
  const lin = t.nums(raw, T.LinearizationTable);
  const bRep = t.nums(raw, T.BlackLevelRepeatDim) ?? [1, 1];
  const blackAll = t.nums(raw, T.BlackLevel) ?? [0];
  const bdh = t.nums(raw, T.BlackLevelDeltaH), bdv = t.nums(raw, T.BlackLevelDeltaV);
  const whites = t.nums(raw, T.WhiteLevel) ?? [(1 << bps) - 1];
  const br = Math.max(1, bRep[0]), bc = Math.max(1, bRep[1]);
  const blackAt = (x: number, y: number, s: number) => (blackAll[((y % br) * bc + (x % bc)) * spp + s] ?? blackAll[0] ?? 0) + (bdh?.[x] ?? 0) + (bdv?.[y] ?? 0);

  // Colour.
  const ill1 = t.num(ifd0, T.CalibrationIlluminant1, 0), ill2 = t.num(ifd0, T.CalibrationIlluminant2, 0);
  const cm1 = t.nums(ifd0, T.ColorMatrix1), cm2 = t.nums(ifd0, T.ColorMatrix2);
  // Prefer the matrix calibrated for daylight (D65 = 21, D55 = 20, daylight = 1).
  const daylight = (i: number) => i === 21 || i === 20 || i === 1 || i === 23;
  const cm = cm2 && daylight(ill2) ? cm2 : cm1 && daylight(ill1) ? cm1 : cm2 ?? cm1;
  const camSrgb = cameraToSRGB(cm);
  if (!camSrgb) warnings.push('The DNG has no colour matrix; colours are shown in camera space.');
  const neutral = t.nums(ifd0, T.AsShotNeutral);
  let wb = [1, 1, 1];
  if (neutral && neutral.length >= 3 && neutral.every((v) => v > 0)) wb = neutral.slice(0, 3).map((v) => 1 / v);
  else if (t.nums(ifd0, T.AsShotWhiteXY)) warnings.push('White balance from AsShotWhiteXY is not supported; using the camera neutral of 1:1:1.');
  const minWb = Math.min(...wb);
  wb = wb.map((v) => v / minWb);

  // CFA pattern (colour index 0 = R, 1 = G, 2 = B per CFAPlaneColor).
  const rep = t.nums(raw, T.CFARepeatPatternDim) ?? [2, 2];
  const pr = rep[0], pc = rep[1];
  const planeColor = t.nums(raw, T.CFAPlaneColor) ?? [0, 1, 2];
  const pattern = (t.nums(raw, T.CFAPattern) ?? [0, 1, 1, 2]).map((c) => planeColor.indexOf(c) >= 0 ? planeColor.indexOf(c) : c);
  if (cfa && (pr * pc !== pattern.length || pattern.some((c) => c < 0 || c > 2))) throw new Error('DNG: unsupported CFA pattern (only RGB sensors are supported)');

  // Default crop (relative to the active area).
  const co = t.nums(raw, T.DefaultCropOrigin) ?? [0, 0];
  const cs = t.nums(raw, T.DefaultCropSize) ?? [AW, AH];
  const bayer = cfa && pr === 2 && pc === 2 && [0, 1, 2].every((c) => pattern.includes(c)) && pattern.filter((c) => c === 1).length === 2;
  return developSensor({
    width: W, height: H, spp: cfa ? 1 : 3, samples, area: { top, left, width: AW, height: AH }, linearization: lin,
    blackAt, whiteOf: (s) => whites[s] ?? whites[0],
    colorAt: cfa ? (x, y) => pattern[(((y + top) % pr) * pc) + ((x + left) % pc)] : null, bayer,
    pattern: cfa ? { rows: pr, cols: pc, colors: Array.from({ length: pr * pc }, (_, i) => pattern[(((Math.floor(i / pc) + top) % pr) * pc) + ((i % pc + left) % pc)]) } : undefined,
    blackTable: bdh || bdv ? undefined : { rows: br, cols: bc, values: Float32Array.from({ length: br * bc * spp }, (_, i) => blackAll[i] ?? blackAll[0] ?? 0) },
    camToSrgb: camSrgb, wb, exposure: t.num(ifd0, T.BaselineExposure, 0) + (opts.exposure ?? 0),
    crop: { x: co[0], y: co[1], w: cs[0], h: cs[1] }, orientation: t.num(ifd0, T.Orientation, 1),
  }, warnings);
}

// ---------------------------------------------------------------------------------------------
// Embedded previews (proprietary RAW)
// ---------------------------------------------------------------------------------------------
/** JPEG streams embedded in the file (baseline or progressive), largest first. */
export function embeddedJpegs(bytes: Uint8Array): Uint8Array[] {
  const found: Uint8Array[] = [];
  for (let i = 0; i + 4 < bytes.length && found.length < 32; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xd8 || bytes[i + 2] !== 0xff) continue;
    const end = jpegEnd(bytes, i);
    if (end > 0) {
      found.push(bytes.subarray(i, end));
      i = end - 1;
    }
  }
  return found.sort((a, b) => b.length - a.length);
}

/** End offset of a baseline/progressive JPEG starting at `s`, or -1. */
function jpegEnd(b: Uint8Array, s: number): number {
  let p = s + 2;
  let frame = false;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return -1;
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd9) return frame ? p + 2 : -1;
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2) return -1;
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) frame = true;
    else if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return -1; // lossless / arithmetic
    p += 2 + len;
    if (m === 0xda) {
      // Entropy-coded data: scan to the next marker that is not a restart or stuffing.
      while (p + 1 < b.length) {
        if (b[p] === 0xff && b[p + 1] !== 0 && !(b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7)) break;
        p++;
      }
    }
  }
  return -1;
}
