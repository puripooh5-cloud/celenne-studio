/**
 * Camera raw development, shared by every raw format: Celenne's DNG decoder (dng.ts) and LibRaw's
 * unpacked sensor data for proprietary formats (libraw.ts) both describe the sensor here, so every
 * camera goes through one colour pipeline:
 *   samples → active area → linearization → black / white levels → white balance → demosaic
 *   (Malvar–He–Cutler for 2×2 Bayer, neighbourhood average for other patterns such as X-Trans)
 *   → camera → linear sRGB (dcraw-style normalised matrix) → ProPhoto RGB, 16 bits/channel
 *   → default crop → orientation.
 */
import type { DecodedImage } from './raster';
import { rgbConversionMatrix } from '../color/icc';

/** Largest raw image accepted (pixels). */
export const MAX_RAW_PIXELS = 200_000_000;

export interface SensorData {
  /** Size of the sample buffer. */
  width: number;
  height: number;
  /** Samples per pixel: 1 (colour filter array) or 3 (already full colour, e.g. LinearRaw, sRAW). */
  spp: 1 | 3;
  samples: Uint16Array;
  /** The area holding image data inside the buffer. */
  area: { top: number; left: number; width: number; height: number };
  /** Optional linearization table applied to raw values first. */
  linearization?: number[] | null;
  /** Black level of a sample at (x, y) of the area, sample s. */
  blackAt(x: number, y: number, s: number): number;
  /** White level of sample s. */
  whiteOf(s: number): number;
  /** Colour (0 = R, 1 = G, 2 = B) of the photosite at (x, y) of the area; null for full-colour data. */
  colorAt: ((x: number, y: number) => number) | null;
  /** True for a 2 × 2 Bayer pattern (gets the better demosaic). */
  bayer: boolean;
  /** The colour pattern as a repeating table (area-relative), for the fast path. */
  pattern?: { rows: number; cols: number; colors: number[] };
  /**
   * Black levels as a repeating table (area-relative; spp values per cell), for the fast path.
   * Leave out when black levels vary per row or column (blackAt is used then).
   */
  blackTable?: { rows: number; cols: number; values: Float32Array };
  /** Camera RGB → linear sRGB, or null (shown in camera space). */
  camToSrgb: number[][] | null;
  /** White-balance multipliers for R, G, B (smallest 1). */
  wb: number[];
  /** Exposure in stops (baseline + user). */
  exposure: number;
  /** Default crop, relative to the area. */
  crop: { x: number; y: number; w: number; h: number };
  /** EXIF orientation (1–8). */
  orientation: number;
}

const mul3 = (a: number[][], b: number[][]) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
function inv3(m: number[][]): number[][] {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error('Camera raw: singular color matrix');
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

/**
 * Camera → linear sRGB from an XYZ → camera matrix (DNG ColorMatrix, or LibRaw's cam_xyz, the
 * same Adobe matrices): dcraw's method, rows of cam·xyz_rgb normalised so white maps to white.
 */
export function cameraToSRGB(colorMatrix: number[] | null): number[][] | null {
  if (!colorMatrix || colorMatrix.length < 9 || colorMatrix.slice(0, 9).every((v) => v === 0)) return null;
  const cm = [colorMatrix.slice(0, 3), colorMatrix.slice(3, 6), colorMatrix.slice(6, 9)];
  const xyzRgb = [[0.412453, 0.35758, 0.180423], [0.212671, 0.71516, 0.072169], [0.019334, 0.119193, 0.950227]];
  const camRgb = mul3(cm, xyzRgb).map((r) => {
    const s = r[0] + r[1] + r[2];
    return s ? r.map((v) => v / s) : r;
  });
  return inv3(camRgb);
}

/** Develops sensor data to 16-bit ProPhoto RGB. */
export function developSensor(s: SensorData, warnings: string[] = []): DecodedImage & { profile: 'proPhotoRGB' } {
  const { width: W, spp, samples, area, colorAt } = s;
  const { top, left, width: AW, height: AH } = area;
  if (AW <= 0 || AH <= 0 || top + AH > s.height || left + AW > W) throw new Error('Camera raw: invalid image area');
  if (AW * AH > MAX_RAW_PIXELS) throw new Error(`Camera raw: unsupported size ${AW}×${AH}`);
  const cfa = !!colorAt;
  const lin = s.linearization;
  const pat = s.pattern;

  // Normalised, white-balanced, clipped plane(s) of the area.
  const n = AW * AH;
  const planes = cfa ? 1 : 3;
  const plane = new Float32Array(n * planes);
  const whites = [0, 1, 2].map((k) => s.whiteOf(k));
  const bt = s.blackTable;
  if (bt && (!cfa || pat) && !lin) {
    // Fast path: black levels and colours repeat in small tables.
    const wb = s.wb, white0 = whites[0];
    for (let y = 0; y < AH; y++) {
      const src = (y + top) * W + left;
      const bRow = (y % bt.rows) * bt.cols;
      const pRow = pat ? (y % pat.rows) * pat.cols : 0;
      const o = y * AW * planes;
      for (let x = 0; x < AW; x++) {
        if (cfa) {
          const black = bt.values[bRow + (x % bt.cols)];
          const c = pat!.colors[pRow + (x % pat!.cols)];
          const f = ((samples[src + x] - black) / Math.max(1, white0 - black)) * wb[c];
          plane[o + x] = f < 0 ? 0 : f > 1 ? 1 : f;
        } else {
          for (let k = 0; k < 3; k++) {
            const black = bt.values[(bRow + (x % bt.cols)) * 3 + k];
            const f = ((samples[(src + x) * 3 + k] - black) / Math.max(1, whites[k] - black)) * wb[k];
            plane[o + x * 3 + k] = f < 0 ? 0 : f > 1 ? 1 : f;
          }
        }
      }
    }
  } else {
    for (let y = 0; y < AH; y++) {
      for (let x = 0; x < AW; x++) {
        for (let k = 0; k < planes; k++) {
          let v = samples[((y + top) * W + x + left) * spp + k];
          if (lin) v = lin[Math.min(v, lin.length - 1)];
          const black = s.blackAt(x, y, k);
          const c = cfa ? colorAt(x, y) : k;
          const f = ((v - black) / Math.max(1, whites[cfa ? 0 : k] - black)) * s.wb[c];
          plane[(y * AW + x) * planes + k] = f < 0 ? 0 : f > 1 ? 1 : f;
        }
      }
    }
  }

  // Demosaic + colour → 16-bit ProPhoto.
  const toPro = rgbConversionMatrix('linearSRGB', 'proPhotoRGB');
  const M = s.camToSrgb ? mul3(toPro, s.camToSrgb) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const exposure = Math.pow(2, s.exposure);
  const m = M.flat().map((v) => v * exposure);
  const lut = new Uint16Array(4097);
  for (let i = 0; i <= 4096; i++) lut[i] = Math.round(Math.pow(i / 4096, 1 / 1.8) * 65535);
  const encode = (v: number) => {
    const k = (v < 0 ? 0 : v > 1 ? 1 : v) * 4096;
    const i = k | 0;
    return i >= 4096 ? 65535 : lut[i] + (lut[i + 1] - lut[i]) * (k - i);
  };
  const full = new Uint16Array(n * 4);
  const put = (o: number, r: number, g: number, b: number) => {
    full[o] = encode(m[0] * r + m[1] * g + m[2] * b);
    full[o + 1] = encode(m[3] * r + m[4] * g + m[5] * b);
    full[o + 2] = encode(m[6] * r + m[7] * g + m[8] * b);
    full[o + 3] = 65535;
  };
  const px = (x: number, y: number) => plane[(y < 0 ? -y : y >= AH ? 2 * AH - 2 - y : y) * AW + (x < 0 ? -x : x >= AW ? 2 * AW - 2 - x : x)];
  const rgb = [0, 0, 0];
  const generic = (x: number, y: number) => {
    if (!colorAt) { const i = (y * AW + x) * 3; rgb[0] = plane[i]; rgb[1] = plane[i + 1]; rgb[2] = plane[i + 2]; }
    else if (s.bayer) demosaicMHC(px, colorAt, x, y, rgb);
    else demosaicAverage(plane, AW, AH, colorAt, x, y, rgb);
    put((y * AW + x) * 4, rgb[0], rgb[1], rgb[2]);
  };
  const margin = 2;
  const fast = cfa && pat && AW > 2 * margin && AH > 2 * margin;
  const kernels = fast && !s.bayer ? averageKernels(pat, AW) : null;
  for (let y = 0; y < AH; y++) {
    const inner = fast && y >= margin && y < AH - margin;
    if (!inner) { for (let x = 0; x < AW; x++) generic(x, y); continue; }
    for (let x = 0; x < margin; x++) generic(x, y);
    const pRow = (y % pat.rows) * pat.cols;
    for (let x = margin; x < AW - margin; x++) {
      const i = y * AW + x;
      const c = pat.colors[pRow + (x % pat.cols)];
      if (s.bayer) {
        // Malvar–He–Cutler, as demosaicMHC, with direct indexing.
        const v = plane[i];
        const L1 = plane[i - 1], R1 = plane[i + 1], U1 = plane[i - AW], D1 = plane[i + AW];
        const diag = plane[i - AW - 1] + plane[i - AW + 1] + plane[i + AW - 1] + plane[i + AW + 1];
        const hFar = plane[i - 2] + plane[i + 2], vFar = plane[i - 2 * AW] + plane[i + 2 * AW];
        if (c === 1) {
          const h = (5 * v - hFar + 4 * (L1 + R1) - diag + 0.5 * vFar) / 8;
          const vv = (5 * v - vFar + 4 * (U1 + D1) - diag + 0.5 * hFar) / 8;
          const hq = h < 0 ? 0 : h, vq = vv < 0 ? 0 : vv;
          if (pat.colors[pRow + ((x + 1) % pat.cols)] === 0) put(i * 4, hq, v, vq); else put(i * 4, vq, v, hq);
        } else {
          const g = (4 * v + 2 * (L1 + R1 + U1 + D1) - (hFar + vFar)) / 8;
          const o = (6 * v + 2 * diag - 1.5 * (hFar + vFar)) / 8;
          const gq = g < 0 ? 0 : g, oq = o < 0 ? 0 : o;
          if (c === 0) put(i * 4, v, gq, oq); else put(i * 4, oq, gq, v);
        }
      } else {
        // Neighbourhood average, as demosaicAverage, from precomputed kernels.
        const k = kernels![(y % pat.rows) * pat.cols + (x % pat.cols)];
        let r = 0, g = 0, b = 0;
        const { offsets, colors, weights } = k;
        for (let j = 0; j < offsets.length; j++) {
          const q = plane[i + offsets[j]] * weights[j];
          if (colors[j] === 0) r += q; else if (colors[j] === 1) g += q; else b += q;
        }
        if (c === 0) r = plane[i]; else if (c === 1) g = plane[i]; else b = plane[i];
        put(i * 4, r, g, b);
      }
    }
    for (let x = AW - margin; x < AW; x++) generic(x, y);
  }

  // Default crop (relative to the area), then orientation.
  const cx = Math.max(0, Math.min(AW - 1, Math.round(s.crop.x))), cy = Math.max(0, Math.min(AH - 1, Math.round(s.crop.y)));
  const cw = Math.max(1, Math.min(AW - cx, Math.round(s.crop.w))), ch = Math.max(1, Math.min(AH - cy, Math.round(s.crop.h)));
  let img: { w: number; h: number; data: Uint16Array } = { w: cw, h: ch, data: new Uint16Array(cw * ch * 4) };
  for (let y = 0; y < ch; y++) img.data.set(full.subarray(((y + cy) * AW + cx) * 4, ((y + cy) * AW + cx + cw) * 4), y * cw * 4);
  img = orient(img, s.orientation);
  return { width: img.w, height: img.h, depth: 16, data: img.data, warnings, profile: 'proPhotoRGB' };
}

/**
 * demosaicAverage's weights for an interior pixel at each pattern position: the 5×5 neighbours
 * of each other colour, weighted 1 / (1 + |dx| + |dy|) and normalised per colour.
 */
function averageKernels(pat: { rows: number; cols: number; colors: number[] }, AW: number): { offsets: Int32Array; colors: Uint8Array; weights: Float32Array }[] {
  const out = [];
  for (let py = 0; py < pat.rows; py++)
    for (let pxi = 0; pxi < pat.cols; pxi++) {
      const own = pat.colors[py * pat.cols + pxi];
      const offs: number[] = [], cols: number[] = [], wts: number[] = [];
      const sum = [0, 0, 0];
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const c = pat.colors[(((py + dy) % pat.rows) + pat.rows) % pat.rows * pat.cols + ((((pxi + dx) % pat.cols) + pat.cols) % pat.cols)];
          if (c === own) continue;
          const w = 1 / (1 + Math.abs(dx) + Math.abs(dy));
          offs.push(dy * AW + dx); cols.push(c); wts.push(w); sum[c] += w;
        }
      out.push({ offsets: Int32Array.from(offs), colors: Uint8Array.from(cols), weights: Float32Array.from(wts.map((w, j) => w / sum[cols[j]])) });
    }
  return out;
}

/** Malvar–He–Cutler gradient-corrected bilinear demosaic (2×2 Bayer). */
function demosaicMHC(px: (x: number, y: number) => number, colorAt: (x: number, y: number) => number, x: number, y: number, out: number[]): void {
  const c = colorAt(x, y);
  const v = px(x, y);
  const cross = px(x - 1, y) + px(x + 1, y) + px(x, y - 1) + px(x, y + 1);
  const diag = px(x - 1, y - 1) + px(x + 1, y - 1) + px(x - 1, y + 1) + px(x + 1, y + 1);
  const far = px(x - 2, y) + px(x + 2, y) + px(x, y - 2) + px(x, y + 2);
  const clamp = (q: number) => (q < 0 ? 0 : q);
  if (c === 1) {
    // Green pixel: the colour of the horizontal neighbours vs the vertical ones.
    const hc = colorAt(x + 1, y);
    const hFar = px(x - 2, y) + px(x + 2, y), vFar = px(x, y - 2) + px(x, y + 2);
    const h = clamp((5 * v - hFar * 1 + 4 * (px(x - 1, y) + px(x + 1, y)) - diag + 0.5 * vFar) / 8);
    const vv = clamp((5 * v - vFar * 1 + 4 * (px(x, y - 1) + px(x, y + 1)) - diag + 0.5 * hFar) / 8);
    out[1] = v;
    if (hc === 0) { out[0] = h; out[2] = vv; } else { out[2] = h; out[0] = vv; }
  } else {
    const g = clamp((4 * v + 2 * cross - far) / 8);
    const o = clamp((6 * v + 2 * diag - 1.5 * far) / 8);
    out[1] = g;
    if (c === 0) { out[0] = v; out[2] = o; } else { out[2] = v; out[0] = o; }
  }
}

/** Generic demosaic (non-Bayer patterns such as X-Trans): distance-weighted 5×5 average per missing colour. */
function demosaicAverage(plane: Float32Array, W: number, H: number, colorAt: (x: number, y: number) => number, x: number, y: number, out: number[]): void {
  const sum = [0, 0, 0], cnt = [0, 0, 0];
  const own = colorAt(x, y);
  for (let dy = -2; dy <= 2; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= H) continue;
    for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= W) continue;
      const c = colorAt(xx, yy);
      const w = 1 / (1 + Math.abs(dx) + Math.abs(dy));
      sum[c] += plane[yy * W + xx] * w;
      cnt[c] += w;
    }
  }
  for (let c = 0; c < 3; c++) out[c] = c === own ? plane[y * W + x] : cnt[c] ? sum[c] / cnt[c] : 0;
}

function orient(img: { w: number; h: number; data: Uint16Array }, o: number): { w: number; h: number; data: Uint16Array } {
  if (o <= 1 || o > 8) return img;
  const { w, h, data } = img;
  const swap = o >= 5;
  const W = swap ? h : w, H = swap ? w : h;
  const out = new Uint16Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let X: number, Y: number;
      switch (o) {
        case 2: X = w - 1 - x; Y = y; break;
        case 3: X = w - 1 - x; Y = h - 1 - y; break;
        case 4: X = x; Y = h - 1 - y; break;
        case 5: X = y; Y = x; break;
        case 6: X = h - 1 - y; Y = x; break;
        case 7: X = h - 1 - y; Y = w - 1 - x; break;
        default: X = y; Y = w - 1 - x; break; // 8
      }
      const s = (y * w + x) * 4, d = (Y * W + X) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { w: W, h: H, data: out };
}
