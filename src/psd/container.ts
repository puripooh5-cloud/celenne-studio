/**
 * Low-level PSD/PSB container model.
 *
 * Parses the file skeleton — header, color mode data, every image resource block, every layer
 * record with its raw additional-info blocks and channel payloads, global layer-mask info,
 * global additional info and the merged image data — without interpreting content.
 *
 * Used to (1) capture data the high-level parser does not model so it can be written back
 * byte-exact, (2) read merged alpha channels and saved paths, and (3) post-process written
 * files (inject preserved blocks, ICC profile, alpha channels, 16/32-bit layer data).
 */
import { PsdFormatError, Reader, Writer } from './binary';

export interface ResourceBlock {
  sig: string;
  id: number;
  name: string;
  data: Uint8Array;
}

export interface InfoBlock {
  sig: string;
  key: string;
  data: Uint8Array;
}

export interface ChannelRecord {
  id: number;
  /** Raw channel payload including the 2-byte compression field. */
  data: Uint8Array;
}

export interface LayerRecord {
  top: number;
  left: number;
  bottom: number;
  right: number;
  channels: ChannelRecord[];
  blendSig: string;
  blendKey: string;
  opacity: number;
  clipping: number;
  flags: number;
  filler: number;
  maskData: Uint8Array;
  blendingRanges: Uint8Array;
  name: string;
  blocks: InfoBlock[];
}

export interface PsdContainer {
  version: 1 | 2;
  channels: number;
  width: number;
  height: number;
  depth: number;
  colorMode: number;
  colorModeData: Uint8Array;
  resources: ResourceBlock[];
  layers: LayerRecord[];
  /** Negative layer count flag: first merged alpha channel is the composite transparency. */
  mergedAlphaIsTransparency: boolean;
  /** Where layer records were stored: the layer info section or a global Lr16/Lr32/Layr block. */
  layerInfoLocation: 'section' | 'Lr16' | 'Lr32' | 'Layr';
  globalMaskInfo: Uint8Array;
  globalBlocks: InfoBlock[];
  imageCompression: number;
  imageData: Uint8Array;
}

/** Additional-info keys whose length is 8 bytes in PSB files. */
const LARGE_KEYS = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD']);

export const LIMITS = {
  maxDimension: 300000,
  maxLayers: 20000,
  maxChannels: 56,
};

function readInfoBlocks(r: Reader, end: number, large: boolean, pad: number): InfoBlock[] {
  const blocks: InfoBlock[] = [];
  while (r.offset + 12 <= end) {
    const sig = r.sig();
    if (sig !== '8BIM' && sig !== '8B64') {
      r.offset -= 4;
      break;
    }
    const key = r.sig();
    const len = r.len(large && LARGE_KEYS.has(key));
    const data = r.bytesN(Math.min(len, end - r.offset));
    blocks.push({ sig, key, data });
    // Tolerate writers that pad block data without counting the padding in the length.
    if (pad > 1 && len % pad !== 0) {
      const peek = r.offset + (pad - (len % pad));
      if (peek <= end) {
        const s = peek + 4 <= r.length ? String.fromCharCode(...r.bytes.subarray(peek, peek + 4)) : '';
        if (s === '8BIM' || s === '8B64' || peek === end) r.offset = peek;
      }
    }
  }
  r.offset = end;
  return blocks;
}

function readLayerInfo(r: Reader, end: number, large: boolean, c: PsdContainer): void {
  if (end - r.offset < 2) return;
  let count = r.i16();
  if (count < 0) {
    c.mergedAlphaIsTransparency = true;
    count = -count;
  }
  if (count > LIMITS.maxLayers) throw new PsdFormatError(`Too many layers (${count})`);
  const lens: number[][] = [];
  for (let i = 0; i < count; i++) {
    const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
    const nch = r.u16();
    if (nch > LIMITS.maxChannels) throw new PsdFormatError(`Layer ${i} declares ${nch} channels`);
    const chIds: number[] = [];
    const chLens: number[] = [];
    for (let k = 0; k < nch; k++) {
      chIds.push(r.i16());
      chLens.push(r.len(large));
    }
    const blendSig = r.sig();
    const blendKey = r.sig();
    const opacity = r.u8(), clipping = r.u8(), flags = r.u8(), filler = r.u8();
    const extraLen = r.u32();
    const extraEnd = r.offset + extraLen;
    const maskLen = r.u32();
    const maskData = r.bytesN(maskLen);
    const brLen = r.u32();
    const blendingRanges = r.bytesN(brLen);
    const name = r.pascal(4);
    const blocks = readInfoBlocks(r, extraEnd, large, 2);
    r.offset = extraEnd;
    c.layers.push({ top, left, bottom, right, channels: chIds.map((id) => ({ id, data: new Uint8Array(0) })), blendSig, blendKey, opacity, clipping, flags, filler, maskData, blendingRanges, name, blocks });
    lens.push(chLens);
  }
  for (let i = 0; i < count; i++) {
    const rec = c.layers[i];
    for (let k = 0; k < rec.channels.length; k++) {
      const n = lens[i][k];
      rec.channels[k].data = r.bytesN(Math.min(n, end - r.offset));
    }
  }
  r.offset = end;
}

export function parseContainer(bytes: Uint8Array): PsdContainer {
  const r = new Reader(bytes);
  if (r.sig() !== '8BPS') throw new PsdFormatError('Not a Photoshop document (missing 8BPS signature)');
  const version = r.u16();
  if (version !== 1 && version !== 2) throw new PsdFormatError(`Unsupported PSD version ${version}`);
  const large = version === 2;
  r.skip(6);
  const channels = r.u16();
  const height = r.u32();
  const width = r.u32();
  const depth = r.u16();
  const colorMode = r.u16();
  if (!width || !height || width > LIMITS.maxDimension || height > LIMITS.maxDimension) throw new PsdFormatError(`Invalid document size ${width}×${height}`);
  if (![1, 8, 16, 32].includes(depth)) throw new PsdFormatError(`Invalid bit depth ${depth}`);
  if (channels < 1 || channels > LIMITS.maxChannels) throw new PsdFormatError(`Invalid channel count ${channels}`);
  const c: PsdContainer = {
    version: version as 1 | 2,
    channels,
    width,
    height,
    depth,
    colorMode,
    colorModeData: new Uint8Array(0),
    resources: [],
    layers: [],
    mergedAlphaIsTransparency: false,
    layerInfoLocation: 'section',
    globalMaskInfo: new Uint8Array(0),
    globalBlocks: [],
    imageCompression: 0,
    imageData: new Uint8Array(0),
  };
  c.colorModeData = r.bytesN(r.u32());
  // Image resources
  const resLen = r.u32();
  const resEnd = r.offset + resLen;
  while (r.offset + 12 <= resEnd) {
    const sig = r.sig();
    const id = r.u16();
    const name = r.pascal(2);
    const size = r.u32();
    const data = r.bytesN(Math.min(size, resEnd - r.offset));
    if (size % 2 && r.offset < resEnd) r.skip(1);
    c.resources.push({ sig, id, name, data });
  }
  r.offset = resEnd;
  // Layer and mask information
  const lmLen = r.len(large);
  const lmEnd = r.offset + lmLen;
  if (lmLen > 0) {
    const liLen = r.len(large);
    const liEnd = r.offset + liLen;
    readLayerInfo(r, liEnd, large, c);
    r.offset = liEnd;
    if (r.offset + 4 <= lmEnd) {
      const gmLen = r.u32();
      c.globalMaskInfo = r.bytesN(Math.min(gmLen, lmEnd - r.offset));
    }
    c.globalBlocks = readInfoBlocks(r, lmEnd, large, 4);
    for (const b of c.globalBlocks) {
      if ((b.key === 'Lr16' || b.key === 'Lr32' || b.key === 'Layr') && c.layers.length === 0) {
        const sub = new Reader(b.data);
        readLayerInfo(sub, b.data.length, large, c);
        c.layerInfoLocation = b.key;
      }
    }
  }
  r.offset = lmEnd;
  if (r.remaining >= 2) {
    c.imageCompression = r.u16();
    c.imageData = r.bytes.subarray(r.offset);
  }
  return c;
}

function writeLayerInfo(w: Writer, c: PsdContainer, large: boolean) {
  const count = c.layers.length;
  w.i16(c.mergedAlphaIsTransparency ? -count : count);
  for (const l of c.layers) {
    w.i32(l.top); w.i32(l.left); w.i32(l.bottom); w.i32(l.right);
    w.u16(l.channels.length);
    for (const ch of l.channels) {
      w.i16(ch.id);
      w.len(ch.data.length, large);
    }
    w.sig(l.blendSig); w.sig(l.blendKey);
    w.u8(l.opacity); w.u8(l.clipping); w.u8(l.flags); w.u8(l.filler);
    w.section(false, 1, () => {
      w.u32(l.maskData.length);
      w.bytes(l.maskData);
      w.u32(l.blendingRanges.length);
      w.bytes(l.blendingRanges);
      w.pascal(l.name, 4);
      for (const b of l.blocks) writeInfoBlock(w, b, large, 2);
    });
  }
  for (const l of c.layers) for (const ch of l.channels) w.bytes(ch.data);
}

/** Layer records inside a global block: their length counts the padding. */
const LAYER_INFO_KEYS = new Set(['Layr', 'Lr16', 'Lr32']);

/**
 * `exactLength`: the length field holds the data length and the padding follows it, as Photoshop
 * writes document-level blocks (for example CAI with 77 bytes plus 3 bytes of padding).
 */
function writeInfoBlock(w: Writer, b: InfoBlock, large: boolean, pad: number, exactLength = false) {
  const isLarge = large && LARGE_KEYS.has(b.key);
  w.sig(isLarge ? '8B64' : b.sig === '8B64' && !large ? '8BIM' : b.sig);
  w.sig(b.key);
  const padded = Math.ceil(b.data.length / pad) * pad;
  w.len(exactLength && !LAYER_INFO_KEYS.has(b.key) ? b.data.length : padded, isLarge);
  w.bytes(b.data);
  w.zeros(padded - b.data.length);
}

export function serializeContainer(c: PsdContainer): Uint8Array {
  const large = c.version === 2;
  const w = new Writer(Math.max(1 << 20, c.imageData.length + 65536));
  w.sig('8BPS');
  w.u16(c.version);
  w.zeros(6);
  w.u16(c.channels);
  w.u32(c.height);
  w.u32(c.width);
  w.u16(c.depth);
  w.u16(c.colorMode);
  w.u32(c.colorModeData.length);
  w.bytes(c.colorModeData);
  w.section(false, 1, () => {
    for (const res of c.resources) {
      w.sig(res.sig);
      w.u16(res.id);
      w.pascal(res.name, 2);
      w.u32(res.data.length);
      w.bytes(res.data);
      if (res.data.length % 2) w.u8(0);
    }
  });
  w.section(large, 2, () => {
    const inBlock = c.layerInfoLocation !== 'section';
    w.section(large, 4, () => {
      if (!inBlock && c.layers.length) writeLayerInfo(w, c, large);
    });
    w.u32(c.globalMaskInfo.length);
    w.bytes(c.globalMaskInfo);
    const blocks = c.globalBlocks.filter((b) => !(inBlock && b.key === c.layerInfoLocation));
    if (inBlock) {
      const sub = new Writer();
      writeLayerInfo(sub, c, large);
      blocks.unshift({ sig: '8BIM', key: c.layerInfoLocation, data: sub.result() });
    }
    for (const b of blocks) writeInfoBlock(w, b, large, 4, true);
  });
  w.u16(c.imageCompression);
  w.bytes(c.imageData);
  return w.result();
}

// ---------------------------------------------------------------------------------------------
// Channel codecs (PackBits RLE / raw) for merged image data and 16/32-bit layer channels
// ---------------------------------------------------------------------------------------------

export function unpackBits(src: Uint8Array, dst: Uint8Array, dOff: number, len: number): void {
  let i = 0, o = 0;
  while (o < len && i < src.length) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) {
      const c = Math.min(n + 1, len - o, src.length - i);
      dst.set(src.subarray(i, i + c), dOff + o);
      i += n + 1;
      o += c;
    } else if (n !== -128) {
      const c = Math.min(1 - n, len - o);
      dst.fill(src[i++], dOff + o, dOff + o + c);
      o += c;
    }
  }
}

export function packBits(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    let run = 1;
    while (i + run < n && run < 128 && src[i + run] === src[i]) run++;
    if (run >= 3) {
      out.push((1 - run) & 255, src[i]);
      i += run;
      continue;
    }
    let lit = 0;
    const start = i;
    while (i < n && lit < 128) {
      if (i + 2 < n && src[i] === src[i + 1] && src[i] === src[i + 2]) break;
      i++;
      lit++;
    }
    out.push(lit - 1);
    for (let k = start; k < start + lit; k++) out.push(src[k]);
  }
  return new Uint8Array(out);
}

/** Decodes all merged-image channels (planar big-endian bytes per channel). */
export function decodeMergedChannels(c: PsdContainer): Uint8Array[] {
  const bpc = c.depth === 1 ? 0 : c.depth / 8;
  const rowBytes = c.depth === 1 ? Math.ceil(c.width / 8) : c.width * bpc;
  const plane = rowBytes * c.height;
  const out: Uint8Array[] = [];
  const data = c.imageData;
  if (c.imageCompression === 0) {
    for (let ch = 0; ch < c.channels; ch++) out.push(data.subarray(ch * plane, (ch + 1) * plane));
    return out;
  }
  if (c.imageCompression === 1) {
    const large = c.version === 2;
    const rows = c.channels * c.height;
    const counts: number[] = [];
    const r = new Reader(data);
    for (let i = 0; i < rows; i++) counts.push(large ? r.u32() : r.u16());
    let off = r.offset;
    for (let ch = 0; ch < c.channels; ch++) {
      const p = new Uint8Array(plane);
      for (let y = 0; y < c.height; y++) {
        const n = counts[ch * c.height + y];
        unpackBits(data.subarray(off, off + n), p, y * rowBytes, rowBytes);
        off += n;
      }
      out.push(p);
    }
    return out;
  }
  throw new PsdFormatError(`Unsupported merged image compression ${c.imageCompression}`);
}

/** Encodes planar channels as RLE (8-bit) merged image data. */
export function encodeMergedRLE(planes: Uint8Array[], width: number, height: number, bytesPerSample: number, large: boolean): Uint8Array {
  const rowBytes = width * bytesPerSample;
  const counts: number[] = [];
  const rows: Uint8Array[] = [];
  for (const p of planes) {
    for (let y = 0; y < height; y++) {
      const packed = packBits(p.subarray(y * rowBytes, (y + 1) * rowBytes));
      counts.push(packed.length);
      rows.push(packed);
    }
  }
  const w = new Writer(rows.reduce((n, r) => n + r.length, 0) + counts.length * 4 + 16);
  for (const n of counts) if (large) w.u32(n); else w.u16(n);
  for (const r of rows) w.bytes(r);
  return w.result();
}

export function findResource(c: PsdContainer, id: number): ResourceBlock | undefined {
  return c.resources.find((r) => r.id === id);
}
