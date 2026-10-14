/**
 * Decoded raster image — the neutral interchange type between file codecs and documents.
 */
import type { BitDepth, PixelArray } from '../image-engine/pixels';

export interface DecodedImage {
  width: number;
  height: number;
  depth: BitDepth;
  /** Interleaved RGBA at `depth`. */
  data: PixelArray;
  icc?: Uint8Array;
  /** Pixels per inch when the file declares it. */
  resolution?: number;
  warnings: string[];
  /** How the file was read (informational; listed in the Compatibility Report, not warned about). */
  notes?: string[];
  colorMode?: 'rgb' | 'grayscale' | 'cmyk' | 'lab' | 'indexed';
  /**
   * CMYK and Lab files: the pixels as Celenne stores them, so they open natively. CMYK = two plates
   * (C' M' Y' A and K' K' K' A, inverted ink as in Photoshop), Lab = one plate (L/100,
   * (a+128)/255, (b+128)/255, A), interleaved at `depth`. `data` then holds an RGB preview only.
   */
  native?: { mode: 'cmyk' | 'lab'; plates: PixelArray[] };
}

export const RAW_EXTENSIONS = ['dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'pef', 'srw', 'x3f', '3fr', 'iiq', 'erf', 'kdc', 'dcr', 'mrw', 'rwl'];

export function sniffFormat(bytes: Uint8Array, name = ''): string | null {
  const b = bytes;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (b.length >= 4 && b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53) return b[5] === 2 ? 'psb' : 'psd';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  // Camera RAW (most are TIFF-based, so check the extension before the TIFF signature).
  if (RAW_EXTENSIONS.includes(ext)) return 'raw';
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a))) return 'tiff';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^(heic|heix|hevc|mif1|msf1|heim|heis|avic)/.test(brand)) return 'heif';
    if (/^avif/.test(brand)) return 'avif';
  }
  const head = new TextDecoder().decode(b.subarray(0, Math.min(512, b.length))).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}
