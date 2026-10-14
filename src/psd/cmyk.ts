/**
 * CMYK → RGB transcoding at the PSD container level.
 *
 * Celenne edits in RGB/Gray. CMYK documents are converted on open (and reported, never silently):
 * the merged image and every layer's four color channels are converted to RGB, while transparency,
 * user/vector masks, extra alpha/spot channels, layer records and all additional-info blocks are
 * carried over byte-for-byte. The result is an RGB container that the regular importer reads.
 *
 * Conversion uses LittleCMS with the embedded CMYK profile when the color engine is loaded;
 * otherwise a simple device conversion (R = (1−C)(1−K) …) is used and reported as approximate.
 */
import { unzlibSync } from 'fflate';
import { Reader, PsdFormatError } from './binary';
import type { ChannelRecord, PsdContainer } from './container';
import { decodeMergedChannels, unpackBits } from './container';

/** Converts `n` CMYK samples (ink 0..1, interleaved) to RGB 0..1 (interleaved). */
export type CmykConverter = (cmyk: Float64Array, n: number) => Float64Array;

export const naiveCmykToRgb: CmykConverter = (cmyk, n) => {
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = 1 - cmyk[i * 4 + 3];
    out[i * 3] = (1 - cmyk[i * 4]) * k;
    out[i * 3 + 1] = (1 - cmyk[i * 4 + 1]) * k;
    out[i * 3 + 2] = (1 - cmyk[i * 4 + 2]) * k;
  }
  return out;
};

/** Decodes one channel payload (2-byte compression + data) into big-endian samples. */
export function decodeChannel(payload: Uint8Array, w: number, h: number, depth: number, large: boolean): Uint8Array {
  const bps = depth / 8;
  const rowBytes = w * bps;
  const size = rowBytes * h;
  if (w <= 0 || h <= 0) return new Uint8Array(0);
  const r = new Reader(payload);
  const comp = r.u16();
  const body = payload.subarray(2);
  if (comp === 0) return body.slice(0, size);
  if (comp === 1) {
    const counts: number[] = [];
    for (let y = 0; y < h; y++) counts.push(large ? r.u32() : r.u16());
    const out = new Uint8Array(size);
    let off = r.offset;
    for (let y = 0; y < h; y++) {
      unpackBits(payload.subarray(off, off + counts[y]), out, y * rowBytes, rowBytes);
      off += counts[y];
    }
    return out;
  }
  if (comp === 2 || comp === 3) {
    const raw = unzlibSync(body);
    if (raw.length < size) throw new PsdFormatError('Truncated ZIP channel data');
    const out = raw.subarray(0, size);
    if (comp === 3) {
      if (depth === 8) {
        for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) out[y * w + x] = (out[y * w + x] + out[y * w + x - 1]) & 255;
      } else if (depth === 16) {
        for (let y = 0; y < h; y++) {
          let prev = 0;
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 2;
            const v = (((out[i] << 8) | out[i + 1]) + prev) & 0xffff;
            out[i] = v >> 8; out[i + 1] = v & 255;
            prev = v;
          }
        }
      } else {
        // 32-bit: byte-wise delta over the row, then the row is stored as 4 byte planes.
        const row = new Uint8Array(rowBytes);
        for (let y = 0; y < h; y++) {
          const base = y * rowBytes;
          for (let i = 1; i < rowBytes; i++) out[base + i] = (out[base + i] + out[base + i - 1]) & 255;
          row.set(out.subarray(base, base + rowBytes));
          for (let x = 0; x < w; x++) for (let b = 0; b < 4; b++) out[base + x * 4 + b] = row[b * w + x];
        }
      }
    }
    return out.slice();
  }
  throw new PsdFormatError(`Unsupported channel compression ${comp}`);
}

function sampleReader(depth: number): (plane: Uint8Array, i: number) => number {
  if (depth === 8) return (p, i) => p[i] / 255;
  if (depth === 16) return (p, i) => ((p[i * 2] << 8) | p[i * 2 + 1]) / 65535;
  return (p, i) => new DataView(p.buffer, p.byteOffset + i * 4, 4).getFloat32(0);
}

function writeSamples(values: Float64Array, stride: number, offset: number, n: number, depth: number): Uint8Array {
  const bps = depth / 8;
  const out = new Uint8Array(n * bps);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(1, values[i * stride + offset]));
    if (depth === 8) out[i] = Math.round(v * 255);
    else if (depth === 16) dv.setUint16(i * 2, Math.round(v * 65535));
    else dv.setFloat32(i * 4, v);
  }
  return out;
}

/** Converts 4 planar CMYK planes (PSD stores ink inverted: max = no ink) to 3 RGB planes. */
function convertPlanes(planes: Uint8Array[], n: number, depth: number, convert: CmykConverter): Uint8Array[] {
  const read = sampleReader(depth);
  const CHUNK = 1 << 16;
  const rgb = new Float64Array(n * 3);
  const buf = new Float64Array(Math.min(n, CHUNK) * 4);
  for (let start = 0; start < n; start += CHUNK) {
    const m = Math.min(CHUNK, n - start);
    for (let i = 0; i < m; i++) for (let c = 0; c < 4; c++) buf[i * 4 + c] = planes[c] && planes[c].length ? 1 - read(planes[c], start + i) : 0;
    rgb.set(convert(buf.subarray(0, m * 4), m).subarray(0, m * 3), start * 3);
  }
  return [0, 1, 2].map((c) => writeSamples(rgb, 3, c, n, depth));
}

function rawPayload(samples: Uint8Array): Uint8Array {
  const out = new Uint8Array(samples.length + 2);
  out.set(samples, 2); // compression 0 = raw
  return out;
}

export interface CmykTranscodeResult {
  container: PsdContainer;
  approximate: boolean;
}

export function transcodeCmykToRgb(c: PsdContainer, convert: CmykConverter | null): CmykTranscodeResult {
  if (c.colorMode !== 4) return { container: c, approximate: false };
  if (c.depth === 1) throw new PsdFormatError('1-bit CMYK data is not valid');
  const conv = convert ?? naiveCmykToRgb;
  const large = c.version === 2;
  const depth = c.depth;

  // Merged image: first 4 planes are CMYK, the rest (transparency / alpha / spot) are kept.
  const merged = decodeMergedChannels(c);
  const n = c.width * c.height;
  const rgbPlanes = convertPlanes(merged.slice(0, 4), n, depth, conv);
  const planes = [...rgbPlanes, ...merged.slice(4)];
  const imageData = new Uint8Array(planes.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of planes) { imageData.set(p, off); off += p.length; }

  const layers = c.layers.map((l) => {
    const w = l.right - l.left, h = l.bottom - l.top;
    const byId = new Map(l.channels.map((ch) => [ch.id, ch]));
    if (![0, 1, 2, 3].some((id) => byId.has(id)) || w <= 0 || h <= 0) {
      return { ...l, channels: l.channels.filter((ch) => ch.id !== 3) };
    }
    const cmyk = [0, 1, 2, 3].map((id) => {
      const ch = byId.get(id);
      return ch ? decodeChannel(ch.data, w, h, depth, large) : new Uint8Array(0);
    });
    // A missing channel means "no ink" (all max), which decodeChannel can't express: fill it.
    const bps = depth / 8;
    for (let i = 0; i < 4; i++) if (!cmyk[i].length) {
      const p = new Uint8Array(w * h * bps);
      if (depth === 32) { const dv = new DataView(p.buffer); for (let k = 0; k < w * h; k++) dv.setFloat32(k * 4, 1); }
      else p.fill(255);
      cmyk[i] = p;
    }
    const rgb = convertPlanes(cmyk, w * h, depth, conv);
    const channels: ChannelRecord[] = [];
    for (const ch of l.channels) {
      if (ch.id === 3) continue;
      if (ch.id >= 0 && ch.id <= 2) channels.push({ id: ch.id, data: rawPayload(rgb[ch.id]) });
      else channels.push(ch);
    }
    return { ...l, channels };
  });

  const container: PsdContainer = {
    ...c,
    colorMode: 3,
    channels: c.channels - 1,
    colorModeData: new Uint8Array(0),
    // The CMYK ICC profile no longer describes the data; the importer keeps it separately.
    resources: c.resources.filter((r) => r.id !== 1039),
    layers,
    imageCompression: 0,
    imageData,
  };
  return { container, approximate: !convert };
}

/**
 * Native CMYK: splits a CMYK container into two RGB-shaped containers the regular reader can
 * parse. `cmy` carries C, M, Y as channels 0–2 (Photoshop stores ink inverted, which is exactly
 * Celenne's plate 0); `k` carries K in all three channels (plate 1). Transparency, masks, extra
 * channels, layer records and additional-info blocks are identical in both.
 */
export function splitCmykContainer(c: PsdContainer): { cmy: PsdContainer; k: PsdContainer } {
  if (c.colorMode !== 4) throw new PsdFormatError('Not a CMYK document');
  if (c.depth === 1) throw new PsdFormatError('1-bit CMYK data is not valid');
  const depth = c.depth;
  const noInk = (w: number, h: number) => {
    const p = new Uint8Array(w * h * (depth / 8));
    if (depth === 32) { const dv = new DataView(p.buffer); for (let k = 0; k < w * h; k++) dv.setFloat32(k * 4, 1); }
    else p.fill(255);
    return rawPayload(p);
  };
  const merged = decodeMergedChannels(c);
  const n = c.width * c.height;
  const pack = (planes: Uint8Array[]) => {
    const out = new Uint8Array(planes.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of planes) { out.set(p, o); o += p.length; }
    return out;
  };
  const kPlane = merged[3] ?? new Uint8Array(n * (depth / 8)).fill(255);
  const layersCmy = c.layers.map((l) => ({ ...l, channels: l.channels.filter((ch) => ch.id !== 3) }));
  const layersK = c.layers.map((l) => {
    const w = l.right - l.left, h = l.bottom - l.top;
    const k = l.channels.find((ch) => ch.id === 3);
    const hasColor = l.channels.some((ch) => ch.id >= 0 && ch.id <= 3);
    const kData = k ? k.data : hasColor && w > 0 && h > 0 ? noInk(w, h) : null;
    const channels: ChannelRecord[] = [];
    for (const ch of l.channels) {
      if (ch.id === 3) continue;
      if (ch.id >= 0 && ch.id <= 2) { if (kData) channels.push({ id: ch.id, data: kData }); }
      else channels.push(ch);
    }
    return { ...l, channels };
  });
  const base = { ...c, colorMode: 3, channels: c.channels - 1, colorModeData: new Uint8Array(0), resources: c.resources.filter((r) => r.id !== 1039), imageCompression: 0 };
  return {
    cmy: { ...base, layers: layersCmy, imageData: pack([merged[0], merged[1], merged[2], ...merged.slice(4)]) },
    k: { ...base, layers: layersK, imageData: pack([kPlane, kPlane, kPlane, ...merged.slice(4)]) },
  };
}
