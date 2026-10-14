/**
 * Compares Celenne's render of a PSD with the composite Photoshop stored in it (files saved with
 * Maximize Compatibility). Values are compared in the document's own channels (RGB, Gray,
 * C M Y K as stored inverted ink, or Photoshop's L a b encoding), in 8-bit units.
 */
import { importPsd } from '../../src/psd/import';
import { parseContainer, decodeMergedChannels, type PsdContainer } from '../../src/psd/container';
import { flattenToPixels } from '../../src/rendering/flatten';
import type { CelenneDocument } from '../../src/document/document';

export interface DiffStats {
  /** Largest per-pixel difference (max over channels), 0..255. */
  max: number;
  /** Mean absolute difference over all channels. */
  mean: number;
  /** 99th percentile of the per-pixel difference. */
  p99: number;
  /** Share of pixels whose difference exceeds 2/255. */
  over2: number;
  /** Per-pixel differences (for diff images). */
  perPixel: Float32Array;
}

/** Photoshop's merged image as 0..255 floats per channel (planar). */
export function photoshopPlanes(c: PsdContainer): Float32Array[] {
  const planes = decodeMergedChannels(c);
  const n = c.width * c.height;
  return planes.map((p) => {
    const out = new Float32Array(n);
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    for (let i = 0; i < n; i++) out[i] = c.depth === 8 ? p[i] : c.depth === 16 ? dv.getUint16(i * 2) / 257 : dv.getFloat32(i * 4) * 255;
    return out;
  });
}

/** Celenne's flattened render in the same channels as the merged image. */
export function celennePlanes(doc: CelenneDocument): Float32Array[] {
  const depth = doc.canvas.bitDepth;
  const scale = depth === 8 ? 1 : depth === 16 ? 1 / 257 : 255;
  const n = doc.width * doc.height;
  const mode = doc.canvas.colorMode;
  const native = mode === 'cmyk' || mode === 'lab';
  const p0 = flattenToPixels(doc, native ? { depth, plate: 0 } : { depth }).data;
  const take = (src: ArrayLike<number>, ch: number) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = src[i * 4 + ch] * scale; return o; };
  if (mode === 'grayscale') return [take(p0, 0)];
  const out = [take(p0, 0), take(p0, 1), take(p0, 2)];
  if (mode === 'cmyk') out.push(take(flattenToPixels(doc, { depth, plate: 1 }).data, 0));
  return out;
}

export function diffPlanes(a: Float32Array[], b: Float32Array[], n: number): DiffStats {
  const per = new Float32Array(n);
  let sum = 0, max = 0, over2 = 0;
  const k = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < k; c++) { const v = Math.abs(a[c][i] - b[c][i]); sum += v; if (v > d) d = v; }
    per[i] = d;
    if (d > max) max = d;
    if (d > 2) over2++;
  }
  const sorted = Float32Array.from(per).sort();
  return { max: +max.toFixed(2), mean: +(sum / (n * k)).toFixed(3), p99: +sorted[Math.floor(0.99 * (n - 1))].toFixed(2), over2: +(over2 / n).toFixed(4), perPixel: per };
}

/** Opens a Photoshop-saved PSD and compares Celenne's render with Photoshop's composite. */
export function compareWithPhotoshop(bytes: Uint8Array, name = 'file.psd') {
  const c = parseContainer(bytes);
  const opened = importPsd(bytes, name);
  const ps = photoshopPlanes(c);
  const celenne = celennePlanes(opened.doc);
  return { doc: opened.doc, issues: opened.issues, container: c, stats: diffPlanes(celenne, ps, c.width * c.height) };
}
