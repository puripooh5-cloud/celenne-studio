/**
 * Proprietary camera raw formats (CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW and about 1,200
 * camera models) through LibRaw 0.22 (LGPL 2.1 / CDDL 1.0), compiled to WebAssembly in its own
 * replaceable module (src/formats/libraw/libraw.wasm, built by scripts/raw/build-libraw.ps1 from
 * third_party/libraw). LibRaw only unpacks the sensor data and reads the metadata; Celenne
 * develops the image with the same pipeline as its DNG decoder (rawDevelop.ts).
 *
 * Safe parsing: LibRaw runs inside WebAssembly (no file system, no threads); sizes are checked
 * before memory is read, and a file LibRaw rejects falls back to the embedded preview.
 */
import type { DecodedImage } from './raster';
import { cameraToSRGB, developSensor, MAX_RAW_PIXELS, type SensorData } from './rawDevelop';

interface LibRawModule {
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  HEAPF64: Float64Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _clr_decode(p: number, n: number): number;
  _clr_free(): void;
  _clr_string(which: number): number;
  _clr_version(): number;
  _clr_reference(quality: number): number;
  UTF8ToString(p: number): string;
}

// Indices of clr_decode's result (third_party/libraw/celenne_libraw.cpp; keep in sync).
const I = {
  ERROR: 0, RAW_W: 1, RAW_H: 2, SPP: 3, SAMPLES_PTR: 4, TOP: 5, LEFT: 6, WIDTH: 7, HEIGHT: 8, FLIP: 9,
  COLORS: 10, PAT_ROWS: 11, PAT_COLS: 12, PAT: 13, BLACK: 49, CBLACK: 50, CB_ROWS: 54, CB_COLS: 55, CB: 56,
  MAXIMUM: 92, CAM_MUL: 93, PRE_MUL: 97, CAM_XYZ: 101, CROP: 113, BASELINE_EXPOSURE: 117, PIXEL_ASPECT: 118, IS_RGB: 119, N: 120,
} as const;

let modPromise: Promise<LibRawModule> | null = null;

export function loadLibRaw(): Promise<LibRawModule> {
  modPromise ??= (async () => {
    const { default: create } = await import('./libraw/libraw.mjs');
    if (typeof window !== 'undefined' || typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
      const url = (await import('./libraw/libraw.wasm?url')).default;
      return (await create({ locateFile: () => url })) as LibRawModule;
    }
    // Node (tests and scripts run from the project folder).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const wasmBinary = fs.readFileSync(path.resolve('src/formats/libraw/libraw.wasm'));
    return (await create({ wasmBinary })) as LibRawModule;
  })();
  modPromise.catch(() => { modPromise = null; });
  return modPromise;
}

/** LibRaw's version, e.g. "0.22.2-Release" (shown in About). */
export async function libRawVersion(): Promise<string> {
  const m = await loadLibRaw();
  return m.UTF8ToString(m._clr_version());
}

const ERRORS: Record<number, string> = {
  [-1]: 'unknown error', [-2]: 'the file format is not supported', [-3]: 'the requested image is not in the file',
  [-4]: 'the file is too short or damaged', [-6]: 'the data could not be read', [-7]: 'out of memory', [-100009]: 'not enough memory',
  [-100008]: 'the file is damaged', [-100007]: 'too much memory needed', [-100011]: 'the file is too large',
};

export interface LibRawInfo {
  make: string;
  model: string;
  /** Visible sensor area, and the default crop inside it (before orientation). */
  width: number;
  height: number;
  crop: { x: number; y: number; w: number; h: number };
}

/** Longest a raw decode may take before it is stopped (a damaged file must not hang the app). */
const DECODE_TIMEOUT_MS = 120_000;

/**
 * Decodes a proprietary raw file: in a worker in the app (the worker is ended afterwards, which
 * also releases LibRaw's memory), directly elsewhere (tests, scripts).
 */
export function decodeCameraRaw(bytes: Uint8Array, opts: { exposure?: number } = {}): Promise<DecodedImage & { profile: 'proPhotoRGB'; camera: LibRawInfo }> {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return decodeLibRaw(bytes, opts);
  const worker = new Worker(new URL('./rawWorker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const done = (f: () => void) => { clearTimeout(timer); worker.terminate(); f(); };
    const timer = setTimeout(() => done(() => reject(new Error('Camera raw: decoding took too long and was stopped'))), DECODE_TIMEOUT_MS);
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'done') done(() => resolve(e.data.img));
      else done(() => reject(new Error(e.data.message)));
    };
    worker.onerror = (e) => done(() => reject(new Error(e.message || 'Camera raw worker failed')));
    worker.postMessage({ bytes, exposure: opts.exposure });
  });
}

/** Decodes a proprietary raw file to 16-bit ProPhoto RGB. Throws when LibRaw cannot read it. */
export async function decodeLibRaw(bytes: Uint8Array, opts: { exposure?: number } = {}): Promise<DecodedImage & { profile: 'proPhotoRGB'; camera: LibRawInfo }> {
  const m = await loadLibRaw();
  const p = m._malloc(bytes.length);
  if (!p) throw new Error('Camera raw: not enough memory to open this file');
  try {
    m.HEAPU8.set(bytes, p);
    const r = m._clr_decode(p, bytes.length) / 8;
    const v = Array.from(m.HEAPF64.subarray(r, r + I.N));
    if (v[I.ERROR] !== 0) throw new Error(`Camera raw: ${ERRORS[v[I.ERROR]] ?? `LibRaw error ${v[I.ERROR]}`}`);
    const camera: LibRawInfo = { make: m.UTF8ToString(m._clr_string(0)), model: m.UTF8ToString(m._clr_string(1)), width: v[I.WIDTH], height: v[I.HEIGHT], crop: defaultCrop(v) };
    if (!v[I.IS_RGB] || v[I.COLORS] !== 3) throw new Error(`Camera raw: the ${camera.make} ${camera.model} sensor is not RGB`);
    const spp = v[I.SPP];
    if (spp !== 1 && spp !== 3) throw new Error('Camera raw: unsupported sample layout');
    const W = v[I.RAW_W], H = v[I.RAW_H];
    if (!W || !H || W * H > MAX_RAW_PIXELS) throw new Error(`Camera raw: unsupported size ${W}×${H}`);
    const ptr = v[I.SAMPLES_PTR];
    if (ptr % 2 || ptr + W * H * spp * 2 > m.HEAPU8.length) throw new Error('Camera raw: invalid sample buffer');
    // Copied out: LibRaw's memory is released below.
    const samples = m.HEAPU16.slice(ptr / 2, ptr / 2 + W * H * spp);
    return { ...developLibRaw(v, samples, spp, opts), camera };
  } finally {
    m._clr_free();
    m._free(p);
  }
}

/** LibRaw's default crop, which is measured from the sensor's edge, relative to the visible area. */
function defaultCrop(v: number[]): { x: number; y: number; w: number; h: number } {
  const W = v[I.WIDTH], H = v[I.HEIGHT];
  if (!(v[I.CROP + 2] > 0 && v[I.CROP + 3] > 0)) return { x: 0, y: 0, w: W, h: H };
  const x = Math.max(0, Math.min(W - 1, v[I.CROP] - v[I.LEFT])), y = Math.max(0, Math.min(H - 1, v[I.CROP + 1] - v[I.TOP]));
  return { x, y, w: Math.min(W - x, v[I.CROP + 2]), h: Math.min(H - y, v[I.CROP + 3]) };
}

function developLibRaw(v: number[], samples: Uint16Array, spp: 1 | 3, opts: { exposure?: number }): DecodedImage & { profile: 'proPhotoRGB' } {
  const warnings: string[] = [];
  const W = v[I.RAW_W], H = v[I.RAW_H];
  const area = { top: v[I.TOP], left: v[I.LEFT], width: v[I.WIDTH], height: v[I.HEIGHT] };
  // Photosite colours relative to the visible area (LibRaw 3 = second green).
  const pr = v[I.PAT_ROWS], pc = v[I.PAT_COLS];
  const pat = v.slice(I.PAT, I.PAT + 36);
  const cfa = spp === 1;
  if (cfa && (!pr || !pc)) throw new Error('Camera raw: unknown colour filter pattern');
  const rawColor = (x: number, y: number) => pat[(y % pr) * pc + (x % pc)];
  const rgbOf = (c: number) => (c === 3 ? 1 : c);
  const colors = cfa ? pat.slice(0, pr * pc).map(rgbOf) : [];
  if (cfa && ![0, 1, 2].every((c) => colors.includes(c))) throw new Error('Camera raw: unsupported colour filter pattern');
  const bayer = cfa && pr === 2 && pc === 2 && colors.filter((c) => c === 1).length === 2;

  // Black: common + per colour + repeating pattern (relative to the visible area).
  const black = v[I.BLACK], cblack = v.slice(I.CBLACK, I.CBLACK + 4);
  const cbr = v[I.CB_ROWS], cbc = v[I.CB_COLS], cb = v.slice(I.CB, I.CB + 36);
  const blackAt = (x: number, y: number, s: number) =>
    black + cblack[cfa ? rawColor(x, y) : s] + (cbr && cbc ? cb[(y % cbr) * cbc + (x % cbc)] : 0);
  const white = v[I.MAXIMUM];

  // Colour: LibRaw's XYZ → camera matrix (Adobe's), as a DNG ColorMatrix.
  const camToSrgb = cameraToSRGB(v.slice(I.CAM_XYZ, I.CAM_XYZ + 9));
  if (!camToSrgb) warnings.push('LibRaw has no colour matrix for this camera; colours are shown in camera space.');
  // As-shot white balance (camera multipliers; daylight multipliers when the file has none).
  const mul = (base: number) => [v[base], v[base + 1], v[base + 2]];
  let wb = mul(I.CAM_MUL);
  if (!wb.every((x) => x > 0)) { wb = mul(I.PRE_MUL); warnings.push('The file has no as-shot white balance; daylight white balance is used.'); }
  if (!wb.every((x) => x > 0)) wb = [1, 1, 1];
  const minWb = Math.min(...wb);
  wb = wb.map((x) => x / minWb);

  const crop = defaultCrop(v);
  // Baseline exposure only comes with DNG files; LibRaw marks "none" as −999.
  const baseline = Math.abs(v[I.BASELINE_EXPOSURE]) < 20 ? v[I.BASELINE_EXPOSURE] : 0;
  // LibRaw flip → EXIF orientation.
  const orientation = ({ 0: 1, 3: 3, 5: 8, 6: 6 } as Record<number, number>)[v[I.FLIP]] ?? 1;
  if (Math.abs(v[I.PIXEL_ASPECT] - 1) > 0.01 && v[I.PIXEL_ASPECT] > 0) warnings.push('This camera records non-square pixels; the image is shown without stretching.');

  // Repeating tables for the fast path: black depends on the colour, so it repeats with both periods.
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const lcm = (a: number, b: number) => (a * b) / gcd(a, b);
  const tr = lcm(cfa ? pr : 1, cbr || 1), tc = lcm(cfa ? pc : 1, cbc || 1);
  const table = new Float32Array(tr * tc * spp);
  for (let y = 0; y < tr; y++) for (let x = 0; x < tc; x++) for (let k = 0; k < spp; k++) table[(y * tc + x) * spp + k] = blackAt(x, y, k);
  const sensor: SensorData = {
    width: W, height: H, spp, samples, area, blackAt, whiteOf: () => white,
    colorAt: cfa ? (x, y) => rgbOf(rawColor(x, y)) : null, bayer,
    pattern: cfa ? { rows: pr, cols: pc, colors } : undefined, blackTable: { rows: tr, cols: tc, values: table },
    camToSrgb, wb, exposure: baseline + (opts.exposure ?? 0), crop, orientation,
  };
  return developSensor(sensor, warnings);
}

/**
 * For tests: LibRaw's own development of a file (camera white balance, no auto brightness,
 * ProPhoto RGB, gamma 1.8, 16-bit RGB), as a reference for Celenne's development.
 */
export async function libRawReference(bytes: Uint8Array, quality = 3): Promise<{ width: number; height: number; data: Uint16Array }> {
  const m = await loadLibRaw();
  const p = m._malloc(bytes.length);
  try {
    m.HEAPU8.set(bytes, p);
    const r = m._clr_decode(p, bytes.length) / 8;
    if (m.HEAPF64[r] !== 0) throw new Error(`LibRaw error ${m.HEAPF64[r]}`);
    const q = m._clr_reference(quality) / 8;
    const [err, width, height, colors, bits, ptr] = Array.from(m.HEAPF64.subarray(q, q + 6));
    if (err || colors !== 3 || bits !== 16) throw new Error(`LibRaw reference failed (${err})`);
    return { width, height, data: m.HEAPU16.slice(ptr / 2, ptr / 2 + width * height * 3) };
  } finally {
    m._clr_free();
    m._free(p);
  }
}
