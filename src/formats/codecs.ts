/**
 * Raster codecs: PNG (8/16-bit, ICC), TIFF (8/16-bit), JPEG / WebP / GIF / BMP / SVG (platform
 * decoder), and encoders for PNG / JPEG / WebP / TIFF with ICC embedding where the format allows.
 */
import { decode as decodePng, encode as encodePng } from 'fast-png';
import { zlibSync, unzlibSync } from 'fflate';
import UTIF from 'utif2';
import type { DecodedImage } from './raster';
import { sniffFormat } from './raster';
import type { BitDepth } from '../image-engine/pixels';
import { decodeDng, embeddedJpegs, isDng } from './dng';
import { decodeCameraRaw } from './libraw';
import { builtinProfileICC } from '../color/icc';
import type { PixelArray } from '../image-engine/pixels';
import { JpegImage } from './vendor/jpegDecoder';

// ---------------------------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------------------------
export function decodePNG(bytes: Uint8Array): DecodedImage {
  const png = decodePng(bytes);
  const warnings: string[] = [];
  const n = png.width * png.height;
  const depth: BitDepth = png.depth === 16 ? 16 : 8;
  const ch = png.channels;
  let data: Uint8ClampedArray | Uint16Array;
  if (png.palette) {
    data = new Uint8ClampedArray(n * 4);
    const pal = png.palette;
    const trns = png.transparency;
    const src = png.data;
    for (let i = 0; i < n; i++) {
      const idx = src[i];
      const c = pal[idx] ?? [0, 0, 0];
      data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2];
      data[i * 4 + 3] = trns && idx < trns.length ? trns[idx] : c[3] ?? 255;
    }
  } else {
    const max = depth === 16 ? 65535 : 255;
    data = depth === 16 ? new Uint16Array(n * 4) : new Uint8ClampedArray(n * 4);
    const src = png.data;
    const scale = png.depth < 8 ? 255 / ((1 << png.depth) - 1) : 1;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (ch === 1 || ch === 2) {
        const g = src[i * ch] * scale;
        data[o] = data[o + 1] = data[o + 2] = g;
        data[o + 3] = ch === 2 ? src[i * ch + 1] : max;
      } else {
        data[o] = src[i * ch]; data[o + 1] = src[i * ch + 1]; data[o + 2] = src[i * ch + 2];
        data[o + 3] = ch === 4 ? src[i * ch + 3] : max;
      }
    }
  }
  let resolution: number | undefined;
  if (png.resolution && png.resolution.unit === 1) resolution = Math.round(png.resolution.x * 0.0254);
  return { width: png.width, height: png.height, depth, data, icc: png.iccEmbeddedProfile?.profile, resolution, warnings, colorMode: ch <= 2 && !png.palette ? 'grayscale' : png.palette ? 'indexed' : 'rgb' };
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Inserts chunks right after IHDR. */
function insertPngChunks(png: Uint8Array, chunks: Uint8Array[]): Uint8Array {
  const ihdrEnd = 8 + 12 + new DataView(png.buffer, png.byteOffset).getUint32(8);
  const extra = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(png.length + extra);
  out.set(png.subarray(0, ihdrEnd), 0);
  let o = ihdrEnd;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  out.set(png.subarray(ihdrEnd), o);
  return out;
}

export function encodePNG(width: number, height: number, data: Uint8Array | Uint8ClampedArray | Uint16Array, depth: 8 | 16, opts: { icc?: Uint8Array; resolution?: number; alpha?: boolean } = {}): Uint8Array {
  const alpha = opts.alpha ?? true;
  let px: Uint8Array | Uint16Array;
  if (alpha) px = depth === 16 ? (data as Uint16Array) : new Uint8Array(data.buffer, data.byteOffset, data.length);
  else {
    const n = width * height;
    px = depth === 16 ? new Uint16Array(n * 3) : new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { px[i * 3] = data[i * 4]; px[i * 3 + 1] = data[i * 4 + 1]; px[i * 3 + 2] = data[i * 4 + 2]; }
  }
  let png = encodePng({ width, height, data: px, depth, channels: alpha ? 4 : 3 }, { zlib: { level: 6 } });
  const chunks: Uint8Array[] = [];
  if (opts.icc) {
    const name = new TextEncoder().encode('ICC Profile');
    const comp = zlibSync(opts.icc);
    const d = new Uint8Array(name.length + 2 + comp.length);
    d.set(name, 0);
    d[name.length] = 0; // null separator
    d[name.length + 1] = 0; // compression method: deflate
    d.set(comp, name.length + 2);
    chunks.push(pngChunk('iCCP', d));
  }
  if (opts.resolution) {
    const d = new Uint8Array(9);
    const dv = new DataView(d.buffer);
    const ppm = Math.round(opts.resolution / 0.0254);
    dv.setUint32(0, ppm);
    dv.setUint32(4, ppm);
    d[8] = 1;
    chunks.push(pngChunk('pHYs', d));
  }
  if (chunks.length) png = insertPngChunks(png, chunks);
  return png;
}

/** Extracts an ICC profile from a PNG iCCP chunk (used when fast-png does not). */
export function pngICC(bytes: Uint8Array): Uint8Array | undefined {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  while (o + 8 < bytes.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (type === 'iCCP') {
      const d = bytes.subarray(o + 8, o + 8 + len);
      const z = d.indexOf(0);
      return unzlibSync(d.subarray(z + 2));
    }
    if (type === 'IDAT') break;
    o += 12 + len;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// JPEG ICC (APP2 "ICC_PROFILE" segments)
// ---------------------------------------------------------------------------------------------
export function jpegICC(bytes: Uint8Array): Uint8Array | undefined {
  const parts: { seq: number; data: Uint8Array }[] = [];
  let o = 2;
  while (o + 4 < bytes.length && bytes[o] === 0xff) {
    const marker = bytes[o + 1];
    const len = (bytes[o + 2] << 8) | bytes[o + 3];
    if (marker === 0xda) break;
    if (marker === 0xe2 && len > 16) {
      const sig = new TextDecoder().decode(bytes.subarray(o + 4, o + 15));
      if (sig === 'ICC_PROFILE') parts.push({ seq: bytes[o + 16], data: bytes.subarray(o + 18, o + 2 + len) });
    }
    o += 2 + len;
  }
  if (!parts.length) return undefined;
  parts.sort((a, b) => a.seq - b.seq);
  const total = parts.reduce((n, p) => n + p.data.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part.data, p); p += part.data.length; }
  return out;
}

export function jpegResolution(bytes: Uint8Array): number | undefined {
  // JFIF APP0 density
  if (bytes[2] === 0xff && bytes[3] === 0xe0 && new TextDecoder().decode(bytes.subarray(6, 10)) === 'JFIF') {
    const unit = bytes[13];
    const x = (bytes[14] << 8) | bytes[15];
    if (unit === 1) return x;
    if (unit === 2) return Math.round(x * 2.54);
  }
  return undefined;
}

export function embedJpegICC(jpeg: Uint8Array, icc: Uint8Array): Uint8Array {
  const max = 65519;
  const count = Math.ceil(icc.length / max);
  const segs: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = icc.subarray(i * max, (i + 1) * max);
    const seg = new Uint8Array(4 + 14 + chunk.length);
    seg[0] = 0xff; seg[1] = 0xe2;
    const len = 2 + 14 + chunk.length;
    seg[2] = len >> 8; seg[3] = len & 255;
    seg.set(new TextEncoder().encode('ICC_PROFILE'), 4);
    seg[15] = 0;
    seg[16] = i + 1;
    seg[17] = count;
    seg.set(chunk, 18);
    segs.push(seg);
  }
  // Insert after SOI (+ JFIF APP0 when present).
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  const total = segs.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(jpeg.length + total);
  out.set(jpeg.subarray(0, at), 0);
  let o = at;
  for (const s of segs) { out.set(s, o); o += s.length; }
  out.set(jpeg.subarray(at), o);
  return out;
}

// ---------------------------------------------------------------------------------------------
// TIFF
// ---------------------------------------------------------------------------------------------
export function decodeTIFF(bytes: Uint8Array): DecodedImage {
  const ifds = UTIF.decode(bytes);
  if (!ifds.length) throw new Error('TIFF contains no images');
  const img = ifds[0];
  UTIF.decodeImage(bytes, img, ifds);
  const warnings: string[] = [];
  const bps = ((img['t258'] as number[] | undefined) ?? [8])[0];
  const spp = ((img['t277'] as number[] | undefined) ?? [1])[0];
  const photometric = ((img['t262'] as number[] | undefined) ?? [2])[0];
  const icc = img['t34675'] ? new Uint8Array(img['t34675'] as number[]) : undefined;
  const w = img.width, h = img.height, n = w * h;
  const res = img['t282'] as number[] | undefined;
  const resUnit = ((img['t296'] as number[] | undefined) ?? [2])[0];
  const resolution = res ? Math.round(resUnit === 3 ? res[0] * 2.54 : res[0]) : undefined;
  if (bps === 16 && (photometric === 1 || photometric === 2) && img.data) {
    const le = bytes[0] === 0x49;
    const dv = new DataView(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    const out = new Uint16Array(n * 4);
    for (let i = 0; i < n; i++) {
      const g = (k: number) => dv.getUint16((i * spp + k) * 2, le);
      if (photometric === 1) {
        const v = g(0);
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
        out[i * 4 + 3] = spp > 1 ? g(1) : 65535;
      } else {
        out[i * 4] = g(0); out[i * 4 + 1] = g(1); out[i * 4 + 2] = g(2);
        out[i * 4 + 3] = spp > 3 ? g(3) : 65535;
      }
    }
    return { width: w, height: h, depth: 16, data: out, icc, resolution, warnings, colorMode: photometric === 1 ? 'grayscale' : 'rgb' };
  }
  const inkSet = ((img['t332'] as number[] | undefined) ?? [1])[0];
  const planar = ((img['t284'] as number[] | undefined) ?? [1])[0];
  if (((photometric === 5 && inkSet === 1 && spp >= 4) || ((photometric === 8 || photometric === 9) && spp >= 3)) && (bps === 8 || bps === 16) && img.data) {
    const nat = nativeTiff(img, bytes[0] === 0x49, photometric === 5 ? 'cmyk' : photometric === 8 ? 'cielab' : 'icclab', bps, spp, planar);
    return { width: w, height: h, depth: bps, data: nativePreview(nat.mode, nat.plates, bps, n), icc, resolution, warnings, colorMode: nat.mode, native: nat };
  }
  if (bps > 8) warnings.push(`${bps}-bit TIFF data of this layout was converted to 8-bit.`);
  if (photometric === 5) warnings.push('This CMYK TIFF uses an ink set or layout Celenne cannot read natively; it was converted to RGB.');
  const rgba = UTIF.toRGBA8(img);
  return { width: w, height: h, depth: 8, data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), icc, resolution, warnings, colorMode: photometric === 5 ? 'cmyk' : 'rgb' };
}

/**
 * CMYK (InkSet 1) and Lab (CIELab / ICCLab) TIFF samples → Celenne plates. Extra samples beyond the
 * colour channels: the first is alpha (associated alpha is un-premultiplied).
 */
function nativeTiff(img: import('utif2').IFD, le: boolean, kind: 'cmyk' | 'cielab' | 'icclab', bps: 8 | 16, spp: number, planar: number): { mode: 'cmyk' | 'lab'; plates: PixelArray[] } {
  const w = img.width, h = img.height, n = w * h;
  const max = bps === 16 ? 65535 : 255;
  const cc = kind === 'cmyk' ? 4 : 3;
  const extra = (img['t338'] as number[] | undefined) ?? [];
  const hasAlpha = spp > cc;
  const associated = hasAlpha && extra[0] === 1;
  const dv = new DataView(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const need = n * spp * (bps / 8);
  if (img.data.byteLength < need) throw new Error('TIFF image data is truncated');
  const get = (i: number, c: number): number => {
    const idx = planar === 2 ? c * n + i : i * spp + c;
    return bps === 16 ? dv.getUint16(idx * 2, le) : img.data[idx];
  };
  const mk = (): PixelArray => (bps === 16 ? new Uint16Array(n * 4) : new Uint8ClampedArray(n * 4));
  const p0 = mk();
  const p1 = kind === 'cmyk' ? mk() : null;
  for (let i = 0; i < n; i++) {
    const a = hasAlpha ? get(i, cc) : max;
    const un = (v: number) => (associated && a > 0 ? Math.min(max, Math.round((v * max) / a)) : v);
    if (kind === 'cmyk') {
      p0[i * 4] = max - un(get(i, 0)); p0[i * 4 + 1] = max - un(get(i, 1)); p0[i * 4 + 2] = max - un(get(i, 2));
      p1![i * 4] = p1![i * 4 + 1] = p1![i * 4 + 2] = max - un(get(i, 3));
      p0[i * 4 + 3] = p1![i * 4 + 3] = a;
    } else {
      // Stored Lab: L/100, (a+128)/255, (b+128)/255.
      const L = un(get(i, 0)) / max;
      let A: number, B: number;
      if (kind === 'icclab') { A = un(get(i, 1)) / max; B = un(get(i, 2)) / max; }
      else {
        const sg = (v: number) => (bps === 16 ? (v >= 32768 ? v - 65536 : v) / 256 : v >= 128 ? v - 256 : v);
        A = (sg(get(i, 1)) + 128) / 255; B = (sg(get(i, 2)) + 128) / 255;
      }
      p0[i * 4] = Math.round(L * max); p0[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, A)) * max); p0[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, B)) * max);
      p0[i * 4 + 3] = a;
    }
  }
  return { mode: kind === 'cmyk' ? 'cmyk' : 'lab', plates: p1 ? [p0, p1] : [p0] };
}

/** A rough RGB preview of native plates (no colour management; the document converts properly). */
function nativePreview(mode: 'cmyk' | 'lab', plates: PixelArray[], depth: 8 | 16, n: number): PixelArray {
  const max = depth === 16 ? 65535 : 255;
  const out = depth === 16 ? new Uint16Array(n * 4) : new Uint8ClampedArray(n * 4);
  const [p0, p1] = plates;
  for (let i = 0; i < n; i++) {
    if (mode === 'cmyk') {
      const k = p1[i * 4] / max;
      out[i * 4] = p0[i * 4] * k; out[i * 4 + 1] = p0[i * 4 + 1] * k; out[i * 4 + 2] = p0[i * 4 + 2] * k;
    } else out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = p0[i * 4];
    out[i * 4 + 3] = p0[i * 4 + 3];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// CMYK JPEG (Adobe): the platform decoder only returns RGB, so these are decoded here.
// ---------------------------------------------------------------------------------------------
/** Number of components in the JPEG frame header (0 when not found). */
export function jpegComponents(bytes: Uint8Array): number {
  let o = 2;
  while (o + 9 < bytes.length && bytes[o] === 0xff) {
    const m = bytes[o + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
    const len = (bytes[o + 2] << 8) | bytes[o + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return bytes[o + 9];
    if (m === 0xda) return 0;
    o += 2 + len;
  }
  return 0;
}

export function decodeJpegCmyk(bytes: Uint8Array): DecodedImage {
  const j = new JpegImage();
  j.opts = { colorTransform: undefined, tolerantDecoding: true, maxResolutionInMP: 400, maxMemoryUsageInMB: 2048 };
  JpegImage.resetMaxMemoryUsage(2048 * 1024 * 1024);
  j.parse(bytes);
  if (!j.adobe) throw new Error('This 4-channel JPEG has no Adobe marker, so its channels cannot be interpreted.');
  const w = j.width, h = j.height, n = w * h;
  const ink = j.getData(w, h); // C M Y K ink amounts (Adobe files are stored inverted)
  const p0 = new Uint8ClampedArray(n * 4), p1 = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    p0[i * 4] = 255 - ink[i * 4]; p0[i * 4 + 1] = 255 - ink[i * 4 + 1]; p0[i * 4 + 2] = 255 - ink[i * 4 + 2];
    p1[i * 4] = p1[i * 4 + 1] = p1[i * 4 + 2] = 255 - ink[i * 4 + 3];
    p0[i * 4 + 3] = p1[i * 4 + 3] = 255;
  }
  const plates = [p0, p1];
  return { width: w, height: h, depth: 8, data: nativePreview('cmyk', plates, 8, n), icc: jpegICC(bytes), resolution: jpegResolution(bytes), warnings: [], colorMode: 'cmyk', native: { mode: 'cmyk', plates } };
}

export function encodeTIFF(width: number, height: number, rgba8: Uint8Array | Uint8ClampedArray, opts: { resolution?: number } = {}): Uint8Array {
  const meta: Record<string, unknown> = {};
  if (opts.resolution) {
    meta.t282 = [opts.resolution];
    meta.t283 = [opts.resolution];
    meta.t296 = [2];
  }
  return new Uint8Array(UTIF.encodeImage(new Uint8Array(rgba8.buffer, rgba8.byteOffset, rgba8.byteLength), width, height, meta));
}

// ---------------------------------------------------------------------------------------------
// Platform decoder (browser/Electron renderer): JPEG, WebP, GIF, BMP, SVG, AVIF
// ---------------------------------------------------------------------------------------------
const MIME: Record<string, string> = { jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', heif: 'image/heic', png: 'image/png' };

export async function decodeWithPlatform(bytes: Uint8Array, format: string): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'undefined') throw new Error(`Decoding ${format.toUpperCase()} requires the application runtime`);
  const blob = new Blob([bytes as BlobPart], { type: MIME[format] ?? 'application/octet-stream' });
  let bitmap: ImageBitmap;
  try {
    if (format === 'svg') {
      bitmap = await rasterizeSvg(blob);
    } else {
      bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    }
  } catch (e) {
    if (format === 'heif') throw new Error('HEIF/HEIC decoding is not available on this platform (no system codec). Convert the file to JPEG/PNG/TIFF first. [Coming Soon]');
    throw new Error(`Could not decode ${format.toUpperCase()} image: ${(e as Error).message}`);
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const id = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  const warnings: string[] = [];
  let icc: Uint8Array | undefined;
  let resolution: number | undefined;
  if (format === 'jpeg') {
    icc = jpegICC(bytes);
    resolution = jpegResolution(bytes);
  }
  if (format === 'gif') warnings.push('Animated GIF frames beyond the first are not imported.');
  return { width: id.width, height: id.height, depth: 8, data: id.data, icc, resolution, warnings, colorMode: 'rgb' };
}

async function rasterizeSvg(blob: Blob): Promise<ImageBitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return c.transferToImageBitmap();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function decodeImageFile(bytes: Uint8Array, name: string): Promise<DecodedImage> {
  const fmt = sniffFormat(bytes, name);
  switch (fmt) {
    case 'png':
      return decodePNG(bytes);
    case 'tiff':
      return decodeTIFF(bytes);
    case 'jpeg':
      if (jpegComponents(bytes) === 4) return decodeJpegCmyk(bytes);
      return decodeWithPlatform(bytes, fmt);
    case 'webp':
    case 'gif':
    case 'bmp':
    case 'svg':
    case 'avif':
    case 'heif':
      return decodeWithPlatform(bytes, fmt);
    case 'raw':
      return decodeRaw(bytes, name);
    default:
      throw new Error(`Unrecognized image format: ${name}`);
  }
}

/**
 * Camera RAW: DNG is decoded from the sensor data; other RAW formats open the camera's
 * embedded full-size JPEG preview, which is reported clearly.
 */
async function decodeRaw(bytes: Uint8Array, name: string): Promise<DecodedImage> {
  const ext = (name.split('.').pop() ?? 'raw').toUpperCase();
  let error: string | null = null;
  const dng = isDng(bytes);
  if (dng) {
    try {
      const img = decodeDng(bytes);
      return { ...img, icc: builtinProfileICC('proPhotoRGB'), notes: ['Camera RAW (DNG) decoded by Celenne: as-shot white balance, baseline exposure and a neutral linear tone response, in 16-bit ProPhoto RGB.'] };
    } catch (e) {
      error = (e as Error).message;
    }
  } else {
    // Proprietary formats: LibRaw unpacks the sensor data, Celenne develops it.
    try {
      const img = await decodeCameraRaw(bytes);
      return { ...img, icc: builtinProfileICC('proPhotoRGB'), notes: [`Camera RAW (${img.camera.make} ${img.camera.model}) decoded by Celenne with LibRaw: as-shot white balance and a neutral linear tone response, in 16-bit ProPhoto RGB.`] };
    } catch (e) {
      error = (e as Error).message;
    }
  }
  for (const jpeg of embeddedJpegs(bytes)) {
    try {
      const img = await decodeWithPlatform(jpeg, 'jpeg');
      if (Math.max(img.width, img.height) < 1000) continue;
      const why = dng ? `This DNG could not be decoded (${error}).` : `The ${ext} sensor data could not be decoded (${error}).`;
      return { ...img, warnings: [`${why} Celenne opened the camera's embedded JPEG preview instead: 8-bit, camera-processed, ${img.width}×${img.height}.`, ...img.warnings] };
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(dng ? `This DNG could not be decoded: ${error}` : `This ${ext} file could not be decoded (${error}), and it has no usable embedded preview.`);
}

/** Encodes 8-bit RGBA with the platform encoder (JPEG / WebP). */
export async function encodeWithPlatform(width: number, height: number, rgba8: Uint8ClampedArray, mime: 'image/jpeg' | 'image/webp', quality: number, matte?: [number, number, number]): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  const data = new Uint8ClampedArray(rgba8);
  if (mime === 'image/jpeg') {
    // JPEG has no alpha: composite over the matte color.
    const [mr, mg, mb] = matte ?? [255, 255, 255];
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      data[i] = data[i] * a + mr * (1 - a);
      data[i + 1] = data[i + 1] * a + mg * (1 - a);
      data[i + 2] = data[i + 2] * a + mb * (1 - a);
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: mime, quality });
  return new Uint8Array(await blob.arrayBuffer());
}
