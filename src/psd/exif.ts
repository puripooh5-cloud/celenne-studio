/**
 * EXIF in PSD files (image resource 1058, a TIFF structure).
 *
 * Photoshop writes EXIF into every PSD with the image size, resolution, colour space, the app and
 * the date it was saved, and updates them on each save. Celenne does the same:
 * - `patchExif` updates those fields in an existing EXIF block and leaves everything else (camera
 *   data, maker notes, GPS) byte-for-byte where it was. A longer value is appended at the end, so
 *   no other offset moves.
 * - `buildExif` writes a new block laid out exactly as Photoshop lays out its own.
 *
 * Safe parsing: every read is bounds-checked and entry counts are limited; a block that cannot be
 * read is kept unchanged.
 */

export interface ExifFields {
  width: number;
  height: number;
  /** Pixels per inch. */
  resolution: number;
  /** EXIF ColorSpace: 1 = sRGB, 0xFFFF = uncalibrated (anything else). */
  colorSpace: number;
  software: string;
  date: Date;
}

const T = { SHORT: 3, LONG: 4, RATIONAL: 5, ASCII: 2 } as const;
const TAG = {
  Orientation: 0x0112, XResolution: 0x011a, YResolution: 0x011b, ResolutionUnit: 0x0128, Software: 0x0131,
  DateTime: 0x0132, ExifIFD: 0x8769, ColorSpace: 0xa001, PixelX: 0xa002, PixelY: 0xa003,
  Compression: 0x0103, JPEGOffset: 0x0201, JPEGLength: 0x0202,
} as const;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const MAX_ENTRIES = 1000;

/** "YYYY:MM:DD HH:MM:SS" in local time, as EXIF and Photoshop write it. */
export function exifDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface Entry { tag: number; type: number; count: number; /** Offset of the 4-byte value field. */ field: number; /** Offset of the value (inline or not). */ at: number }

class Tiff {
  readonly le: boolean;
  private view: DataView;
  constructor(public b: Uint8Array) {
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length < 8) throw new Error('exif: too short');
    const order = String.fromCharCode(b[0], b[1]);
    if (order !== 'MM' && order !== 'II') throw new Error('exif: not TIFF');
    this.le = order === 'II';
    if (this.u16(2) !== 42) throw new Error('exif: not TIFF');
  }
  private check(o: number, n: number): void { if (o < 0 || o + n > this.b.length) throw new Error('exif: out of range'); }
  u16(o: number): number { this.check(o, 2); return this.view.getUint16(o, this.le); }
  u32(o: number): number { this.check(o, 4); return this.view.getUint32(o, this.le); }
  setU16(o: number, v: number): void { this.check(o, 2); this.view.setUint16(o, v, this.le); }
  setU32(o: number, v: number): void { this.check(o, 4); this.view.setUint32(o, v >>> 0, this.le); }
  ifd(o: number): Entry[] {
    const n = this.u16(o);
    if (n > MAX_ENTRIES) throw new Error('exif: too many entries');
    const out: Entry[] = [];
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      const type = this.u16(e + 2), count = this.u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      const at = size <= 4 ? e + 8 : this.u32(e + 8);
      if (size > 4) this.check(at, size);
      out.push({ tag: this.u16(e), type, count, field: e + 8, at });
    }
    return out;
  }
}

/** The EXIF fields Celenne updates on save, as currently stored (for display and tests). */
export function readExifFields(b: Uint8Array): Partial<ExifFields> | null {
  try {
    const t = new Tiff(b);
    const ifd0 = t.ifd(t.u32(4));
    const out: Partial<ExifFields> = {};
    const num = (e: Entry) => (e.type === T.SHORT ? t.u16(e.at) : t.u32(e.at));
    const ascii = (e: Entry) => String.fromCharCode(...b.subarray(e.at, e.at + e.count)).replace(/\0+$/, '');
    for (const e of ifd0) {
      if (e.tag === TAG.XResolution && e.type === T.RATIONAL) out.resolution = t.u32(e.at) / (t.u32(e.at + 4) || 1);
      if (e.tag === TAG.Software && e.type === T.ASCII) out.software = ascii(e);
      if (e.tag === TAG.ExifIFD) {
        for (const x of t.ifd(t.u32(e.at))) {
          if (x.tag === TAG.PixelX) out.width = num(x);
          if (x.tag === TAG.PixelY) out.height = num(x);
          if (x.tag === TAG.ColorSpace) out.colorSpace = t.u16(x.at);
        }
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Updates size, resolution, colour space, software and date in an existing EXIF block. Returns the
 * original bytes if the block cannot be read.
 */
export function patchExif(src: Uint8Array, f: ExifFields): Uint8Array {
  try {
    const extra: number[] = [];
    let out = src.slice();
    let t = new Tiff(out);
    const append = (bytes: number[]): number => {
      if ((out.length + extra.length) & 1) extra.push(0); // word-aligned, as TIFF requires
      const at = out.length + extra.length;
      extra.push(...bytes);
      return at;
    };
    const writes: (() => void)[] = [];
    const rational = (e: Entry) => {
      if (e.type !== T.RATIONAL || e.count !== 1) return;
      const r = Math.round(f.resolution * 10000);
      writes.push(() => { t.setU32(e.at, r); t.setU32(e.at + 4, 10000); });
    };
    const ascii = (e: Entry, s: string) => {
      if (e.type !== T.ASCII) return;
      const bytes = [...s].map((c) => c.charCodeAt(0) & 0x7f).concat(0);
      if (bytes.length <= 4) {
        writes.push(() => { t.setU32(e.field - 4, bytes.length); for (let i = 0; i < 4; i++) out[e.field + i] = bytes[i] ?? 0; });
      } else if (bytes.length <= e.count && e.count > 4) {
        writes.push(() => { t.setU32(e.field - 4, bytes.length); for (let i = 0; i < e.count; i++) out[e.at + i] = bytes[i] ?? 0; });
      } else {
        const at = append(bytes);
        writes.push(() => { t.setU32(e.field - 4, bytes.length); t.setU32(e.field, at); });
      }
    };
    const long = (e: Entry, v: number) => {
      if (e.count !== 1 || (e.type !== T.SHORT && e.type !== T.LONG)) return;
      // Both types fit inline; a size above 65535 needs LONG.
      writes.push(() => { t.setU16(e.field - 6, T.LONG); t.setU32(e.field, v); });
    };
    const short = (e: Entry, v: number) => {
      if (e.count !== 1 || e.type !== T.SHORT) return;
      writes.push(() => { t.setU16(e.field, v); t.setU16(e.field + 2, 0); });
    };

    const ifd0 = t.ifd(t.u32(4));
    for (const e of ifd0) {
      if (e.tag === TAG.XResolution || e.tag === TAG.YResolution) rational(e);
      else if (e.tag === TAG.ResolutionUnit) short(e, 2);
      else if (e.tag === TAG.Software) ascii(e, f.software);
      else if (e.tag === TAG.DateTime) ascii(e, exifDate(f.date));
      else if (e.tag === TAG.ExifIFD) {
        for (const x of t.ifd(t.u32(e.at))) {
          if (x.tag === TAG.PixelX) long(x, f.width);
          else if (x.tag === TAG.PixelY) long(x, f.height);
          else if (x.tag === TAG.ColorSpace) short(x, f.colorSpace);
        }
      }
    }
    if (extra.length) {
      const grown = new Uint8Array(out.length + extra.length);
      grown.set(out);
      grown.set(extra, out.length);
      out = grown;
      t = new Tiff(out);
    }
    for (const w of writes) w();
    return out;
  } catch {
    return src;
  }
}

type Value = { tag: number; type: number; count: number; data: number[] };

/** EXIF for a document that has none, laid out as Photoshop 2025 lays out its own. */
export function buildExif(f: ExifFields): Uint8Array {
  const r = Math.round(f.resolution * 10000);
  const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const u16 = (v: number) => [(v >> 8) & 255, v & 255];
  const str = (s: string) => [...s].map((c) => c.charCodeAt(0) & 0x7f).concat(0);
  const software = str(f.software), date = str(exifDate(f.date));
  const ifd0: Value[] = [
    { tag: TAG.Orientation, type: T.SHORT, count: 1, data: u16(1) },
    { tag: TAG.XResolution, type: T.RATIONAL, count: 1, data: [...u32(r), ...u32(10000)] },
    { tag: TAG.YResolution, type: T.RATIONAL, count: 1, data: [...u32(r), ...u32(10000)] },
    { tag: TAG.ResolutionUnit, type: T.SHORT, count: 1, data: u16(2) },
    { tag: TAG.Software, type: T.ASCII, count: software.length, data: software },
    { tag: TAG.DateTime, type: T.ASCII, count: date.length, data: date },
    { tag: TAG.ExifIFD, type: T.LONG, count: 1, data: [] }, // filled below
  ];
  const exif: Value[] = [
    { tag: TAG.ColorSpace, type: T.SHORT, count: 1, data: u16(f.colorSpace) },
    { tag: TAG.PixelX, type: T.LONG, count: 1, data: u32(f.width) },
    { tag: TAG.PixelY, type: T.LONG, count: 1, data: u32(f.height) },
  ];
  // The thumbnail directory Photoshop writes, with no thumbnail (length 0).
  const ifd1: Value[] = [
    { tag: TAG.Compression, type: T.SHORT, count: 1, data: u16(6) },
    { tag: TAG.XResolution, type: T.RATIONAL, count: 1, data: [...u32(72), ...u32(1)] },
    { tag: TAG.YResolution, type: T.RATIONAL, count: 1, data: [...u32(72), ...u32(1)] },
    { tag: TAG.ResolutionUnit, type: T.SHORT, count: 1, data: u16(2) },
    { tag: TAG.JPEGOffset, type: T.LONG, count: 1, data: [] }, // filled below
    { tag: TAG.JPEGLength, type: T.LONG, count: 1, data: u32(0) },
  ];
  const sizeOf = (ifd: Value[]) => 2 + ifd.length * 12 + 4 + ifd.reduce((n, v) => n + (v.data.length > 4 ? v.data.length : 0), 0);
  const align4 = (n: number) => (n + 3) & ~3;
  const at0 = 8, atExif = align4(at0 + sizeOf(ifd0)), at1 = align4(atExif + sizeOf(exif));
  ifd0[6].data = u32(atExif);
  ifd1[4].data = u32(at1 + sizeOf(ifd1));
  const out: number[] = [0x4d, 0x4d, 0, 42, ...u32(at0)];
  const put = (ifd: Value[], at: number, next: number) => {
    while (out.length < at) out.push(0);
    let data = at + 2 + ifd.length * 12 + 4;
    const tail: number[] = [];
    out.push(...u16(ifd.length));
    for (const v of ifd) {
      out.push(...u16(v.tag), ...u16(v.type), ...u32(v.count));
      if (v.data.length > 4) { out.push(...u32(data)); tail.push(...v.data); data += v.data.length; }
      else out.push(...v.data, ...new Array(4 - v.data.length).fill(0));
    }
    out.push(...u32(next), ...tail);
  };
  put(ifd0, at0, at1);
  put(exif, atExif, 0);
  put(ifd1, at1, 0);
  return Uint8Array.from(out);
}
