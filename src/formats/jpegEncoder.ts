/**
 * Baseline JPEG encoder (JFIF, YCbCr 4:4:4, standard Huffman tables). Synchronous and
 * platform-independent: used for PSD thumbnails (resource 1036) and anywhere a JPEG is needed
 * without the browser's canvas encoder.
 */

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

const STD_LUMA_Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const STD_CHROMA_Q = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];

// Standard Huffman specifications (ITU T.81 Annex K).
const DC_L_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_L_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_C_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_C_VALS = DC_L_VALS;
const AC_L_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_L_VALS = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];
const AC_C_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_C_VALS = [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];

type Huff = { code: Uint16Array; len: Uint8Array };

function buildHuff(bits: number[], vals: number[]): Huff {
  const code = new Uint16Array(256), len = new Uint8Array(256);
  let c = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < bits[l - 1]; i++) { code[vals[k]] = c; len[vals[k]] = l; c++; k++; }
    c <<= 1;
  }
  return { code, len };
}

function scaledTable(base: number[], quality: number): number[] {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const s = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.max(1, Math.min(255, Math.floor((v * s + 50) / 100))));
}

// Separable float DCT-II with precomputed cosines (fine for thumbnails and moderate images).
const COS = (() => {
  const t = new Float64Array(64);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) t[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1) * 0.5;
  return t;
})();

function fdct(block: Float64Array, out: Float64Array, tmp: Float64Array): void {
  for (let y = 0; y < 8; y++)
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += COS[u * 8 + x] * block[y * 8 + x];
      tmp[y * 8 + u] = s;
    }
  for (let u = 0; u < 8; u++)
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += COS[v * 8 + y] * tmp[y * 8 + u];
      out[v * 8 + u] = s;
    }
}

class BitWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private acc = 0;
  private n = 0;
  private push(byte: number): void {
    if (this.len === this.buf.length) { const g = new Uint8Array(this.buf.length * 2); g.set(this.buf); this.buf = g; }
    this.buf[this.len++] = byte;
  }
  bytes(b: number[]): void { for (const x of b) this.push(x); }
  bits(code: number, len: number): void {
    this.acc = (this.acc << len) | code;
    this.n += len;
    while (this.n >= 8) {
      const byte = (this.acc >>> (this.n - 8)) & 0xff;
      this.push(byte);
      if (byte === 0xff) this.push(0);
      this.n -= 8;
      this.acc &= (1 << this.n) - 1;
    }
  }
  flush(): void { if (this.n > 0) this.bits((1 << (8 - this.n)) - 1, 8 - this.n); }
  result(): Uint8Array { return this.buf.slice(0, this.len); }
}

/** Encodes straight RGBA8 (alpha composited over `matte`, default white) as a baseline JPEG. */
export function encodeJpeg(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray, quality = 85, matte: [number, number, number] = [255, 255, 255]): Uint8Array {
  return encodeBaseline(width, height, 'ycbcr', quality, (i, out) => {
    const a = rgba[i * 4 + 3] / 255;
    const r = rgba[i * 4] * a + matte[0] * (1 - a), g = rgba[i * 4 + 1] * a + matte[1] * (1 - a), b = rgba[i * 4 + 2] * a + matte[2] * (1 - a);
    out[0] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
    out[1] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    out[2] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  });
}

/**
 * Encodes CMYK as an Adobe CMYK JPEG (four components, APP14 "Adobe" marker, no colour
 * transform, inverted values as Photoshop writes them). `ink` holds C, M, Y, K amounts 0..255 per
 * pixel (paper already composited where the image was transparent).
 */
export function encodeJpegCmyk(width: number, height: number, ink: Uint8Array, quality = 85): Uint8Array {
  return encodeBaseline(width, height, 'cmyk', quality, (i, out) => {
    for (let c = 0; c < 4; c++) out[c] = 255 - ink[i * 4 + c] - 128;
  });
}

function encodeBaseline(width: number, height: number, model: 'ycbcr' | 'cmyk', quality: number, sample: (i: number, out: Float64Array) => void): Uint8Array {
  if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error('JPEG dimensions must be 1–65535 px');
  const cmyk = model === 'cmyk';
  const nc = cmyk ? 4 : 3;
  const qL = scaledTable(STD_LUMA_Q, quality), qC = scaledTable(STD_CHROMA_Q, quality);
  const dcL = buildHuff(DC_L_BITS, DC_L_VALS), acL = buildHuff(AC_L_BITS, AC_L_VALS);
  const dcC = buildHuff(DC_C_BITS, DC_C_VALS), acC = buildHuff(AC_C_BITS, AC_C_VALS);
  const w = new BitWriter();
  const seg = (marker: number, data: number[]) => w.bytes([0xff, marker, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff, ...data]);
  w.bytes([0xff, 0xd8]);
  if (cmyk) seg(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 0]);
  else seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  seg(0xdb, [0, ...ZIGZAG.map((z) => qL[z]), 1, ...ZIGZAG.map((z) => qC[z])]);
  // CMYK: every component uses the luminance tables (all four carry detail).
  const tbl = (c: number) => (cmyk || c === 0 ? 0 : 1);
  const comps: number[] = [];
  for (let c = 0; c < nc; c++) comps.push(c + 1, 0x11, tbl(c));
  seg(0xc0, [8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, nc, ...comps]);
  const dht = (cls: number, id: number, bits: number[], vals: number[]) => [(cls << 4) | id, ...bits, ...vals];
  seg(0xc4, [...dht(0, 0, DC_L_BITS, DC_L_VALS), ...dht(1, 0, AC_L_BITS, AC_L_VALS), ...dht(0, 1, DC_C_BITS, DC_C_VALS), ...dht(1, 1, AC_C_BITS, AC_C_VALS)]);
  const sos: number[] = [nc];
  for (let c = 0; c < nc; c++) sos.push(c + 1, tbl(c) ? 0x11 : 0x00);
  seg(0xda, [...sos, 0, 63, 0]);
  const blk = Array.from({ length: nc }, () => new Float64Array(64));
  const coef = new Float64Array(64), tmp = new Float64Array(64);
  const prev = new Array(nc).fill(0);
  const px = new Float64Array(4);
  const catOf = (v: number) => { let a = Math.abs(v), c = 0; while (a) { c++; a >>= 1; } return c; };
  const emit = (v: number, c: number) => { if (c) w.bits(v < 0 ? v + (1 << c) - 1 : v, c); };
  const encodeBlock = (b: Float64Array, q: number[], dc: Huff, ac: Huff, ci: number) => {
    fdct(b, coef, tmp);
    const zz = new Int32Array(64);
    for (let i = 0; i < 64; i++) zz[i] = Math.round(coef[ZIGZAG[i]] / q[ZIGZAG[i]]);
    const diff = zz[0] - prev[ci];
    prev[ci] = zz[0];
    const dcat = catOf(diff);
    w.bits(dc.code[dcat], dc.len[dcat]);
    emit(diff, dcat);
    let run = 0;
    for (let i = 1; i < 64; i++) {
      const v = zz[i];
      if (!v) { run++; continue; }
      while (run > 15) { w.bits(ac.code[0xf0], ac.len[0xf0]); run -= 16; }
      const c = catOf(v);
      const sym = (run << 4) | c;
      w.bits(ac.code[sym], ac.len[sym]);
      emit(v, c);
      run = 0;
    }
    if (run) w.bits(ac.code[0], ac.len[0]);
  };
  for (let by = 0; by < height; by += 8)
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const sx = Math.min(width - 1, bx + x), sy = Math.min(height - 1, by + y);
          sample(sy * width + sx, px);
          for (let c = 0; c < nc; c++) blk[c][y * 8 + x] = px[c];
        }
      for (let c = 0; c < nc; c++) encodeBlock(blk[c], tbl(c) ? qC : qL, tbl(c) ? dcC : dcL, tbl(c) ? acC : acL, c);
    }
  w.flush();
  w.bytes([0xff, 0xd9]);
  return w.result();
}
