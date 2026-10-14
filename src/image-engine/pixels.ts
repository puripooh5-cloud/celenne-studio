/** Bit-depth aware pixel storage primitives. */
export type BitDepth = 8 | 16 | 32;
export type PixelArray = Uint8ClampedArray | Uint16Array | Float32Array;

export function allocPixels(depth: BitDepth, length: number): PixelArray {
  switch (depth) {
    case 8:
      return new Uint8ClampedArray(length);
    case 16:
      return new Uint16Array(length);
    case 32:
      return new Float32Array(length);
  }
}

export function maxValue(depth: BitDepth): number {
  return depth === 8 ? 255 : depth === 16 ? 65535 : 1;
}

export function bytesPerSample(depth: BitDepth): number {
  return depth === 8 ? 1 : depth === 16 ? 2 : 4;
}

export function depthOf(arr: PixelArray): BitDepth {
  return arr instanceof Float32Array ? 32 : arr instanceof Uint16Array ? 16 : 8;
}

/** 8-bit → float lookup table (avoids a division per sample in hot loops). */
export const U8_TO_FLOAT = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = i / 255;
  return t;
})();

/** Converts a typed pixel array into normalized floats (0..1; 32-bit data passes through). */
export function toFloat(src: PixelArray, dst: Float32Array, srcOffset = 0, dstOffset = 0, count = src.length): void {
  if (src instanceof Uint8ClampedArray) {
    for (let i = 0; i < count; i++) dst[dstOffset + i] = U8_TO_FLOAT[src[srcOffset + i]];
  } else if (src instanceof Uint16Array) {
    const k = 1 / 65535;
    for (let i = 0; i < count; i++) dst[dstOffset + i] = src[srcOffset + i] * k;
  } else {
    for (let i = 0; i < count; i++) dst[dstOffset + i] = src[srcOffset + i];
  }
}

/** Writes normalized floats into a typed pixel array with rounding and clamping. */
export function fromFloat(src: Float32Array, dst: PixelArray, srcOffset = 0, dstOffset = 0, count = src.length - srcOffset): void {
  if (dst instanceof Uint8ClampedArray) {
    // Uint8ClampedArray assignment already rounds to nearest; no +0.5 bias.
    for (let i = 0; i < count; i++) dst[dstOffset + i] = src[srcOffset + i] * 255;
  } else if (dst instanceof Uint16Array) {
    for (let i = 0; i < count; i++) {
      const v = src[srcOffset + i] * 65535 + 0.5;
      dst[dstOffset + i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
    }
  } else {
    for (let i = 0; i < count; i++) dst[dstOffset + i] = src[srcOffset + i];
  }
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
