/**
 * ICC profile parsing (header + description) and generation of standard matrix/TRC profiles
 * (ICC v2.1 — the most widely compatible version for embedding).
 */
import { CELENNE_CMYK_NAME, celenneCmykProfile } from './cmykProfile';

export type BuiltinProfileId = 'srgb' | 'displayP3' | 'adobeRGB' | 'proPhotoRGB' | 'linearSRGB' | 'gray22' | 'grayGamma18' | 'dotGain20' | 'celenneCMYK' | 'labD50';

export interface IccInfo {
  description: string;
  colorSpace: string; // 'RGB ', 'CMYK', 'GRAY', 'Lab '
  profileClass: string; // 'mntr', 'prtr', 'scnr', 'spac', 'link', 'abst'
  version: string;
  size: number;
}

export function parseIccInfo(icc: Uint8Array): IccInfo | null {
  if (icc.length < 132) return null;
  const dv = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const str4 = (o: number) => String.fromCharCode(icc[o], icc[o + 1], icc[o + 2], icc[o + 3]);
  if (str4(36) !== 'acsp') return null;
  const size = dv.getUint32(0);
  const version = `${icc[8]}.${icc[9] >> 4}`;
  const profileClass = str4(12);
  const colorSpace = str4(16);
  let description = '';
  const count = dv.getUint32(128);
  for (let i = 0; i < Math.min(count, 200); i++) {
    const o = 132 + i * 12;
    if (o + 12 > icc.length) break;
    if (str4(o) !== 'desc') continue;
    const off = dv.getUint32(o + 4), len = dv.getUint32(o + 8);
    if (off + len > icc.length) break;
    const type = str4(off);
    if (type === 'desc') {
      const n = dv.getUint32(off + 8);
      description = new TextDecoder('latin1').decode(icc.subarray(off + 12, off + 12 + Math.max(0, n - 1)));
    } else if (type === 'mluc') {
      const recs = dv.getUint32(off + 8);
      if (recs > 0) {
        const l = dv.getUint32(off + 20), so = dv.getUint32(off + 24);
        const chars: number[] = [];
        for (let k = 0; k < l; k += 2) chars.push(dv.getUint16(off + so + k));
        description = String.fromCharCode(...chars);
      }
    }
  }
  return { description: description || 'Embedded profile', colorSpace, profileClass, version, size };
}

// ---------------------------------------------------------------------------------------------
// Profile generation
// ---------------------------------------------------------------------------------------------
interface XY { x: number; y: number }

const D65: XY = { x: 0.3127, y: 0.329 };
const D50: XY = { x: 0.3457, y: 0.3585 };

interface RGBSpace {
  name: string;
  red: XY;
  green: XY;
  blue: XY;
  white: XY;
  /** Gamma exponent, or 'srgb' for the piecewise sRGB curve, or 1 for linear. */
  trc: number | 'srgb';
}

export const RGB_SPACES: Record<'srgb' | 'displayP3' | 'adobeRGB' | 'proPhotoRGB' | 'linearSRGB', RGBSpace> = {
  srgb: { name: 'sRGB IEC61966-2.1', red: { x: 0.64, y: 0.33 }, green: { x: 0.3, y: 0.6 }, blue: { x: 0.15, y: 0.06 }, white: D65, trc: 'srgb' },
  displayP3: { name: 'Display P3', red: { x: 0.68, y: 0.32 }, green: { x: 0.265, y: 0.69 }, blue: { x: 0.15, y: 0.06 }, white: D65, trc: 'srgb' },
  adobeRGB: { name: 'Adobe RGB (1998)', red: { x: 0.64, y: 0.33 }, green: { x: 0.21, y: 0.71 }, blue: { x: 0.15, y: 0.06 }, white: D65, trc: 563 / 256 },
  proPhotoRGB: { name: 'ProPhoto RGB', red: { x: 0.7347, y: 0.2653 }, green: { x: 0.1596, y: 0.8404 }, blue: { x: 0.0366, y: 0.0001 }, white: D50, trc: 1.8 },
  linearSRGB: { name: 'sRGB (Linear)', red: { x: 0.64, y: 0.33 }, green: { x: 0.3, y: 0.6 }, blue: { x: 0.15, y: 0.06 }, white: D65, trc: 1 },
};

export const BUILTIN_PROFILES: { id: BuiltinProfileId; name: string; space: 'RGB' | 'GRAY' | 'CMYK' | 'LAB' }[] = [
  { id: 'srgb', name: 'sRGB IEC61966-2.1', space: 'RGB' },
  { id: 'displayP3', name: 'Display P3', space: 'RGB' },
  { id: 'adobeRGB', name: 'Adobe RGB (1998)', space: 'RGB' },
  { id: 'proPhotoRGB', name: 'ProPhoto RGB', space: 'RGB' },
  { id: 'linearSRGB', name: 'sRGB (Linear)', space: 'RGB' },
  { id: 'gray22', name: 'Gray Gamma 2.2', space: 'GRAY' },
  { id: 'grayGamma18', name: 'Gray Gamma 1.8', space: 'GRAY' },
  { id: 'dotGain20', name: 'Dot Gain 20% (approx.)', space: 'GRAY' },
  { id: 'celenneCMYK', name: CELENNE_CMYK_NAME, space: 'CMYK' },
  { id: 'labD50', name: 'Lab Color (D50)', space: 'LAB' },
];

type M3 = number[][];
const mul = (a: M3, b: M3): M3 => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
const mulv = (a: M3, v: number[]) => a.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
function inv3(m: M3): M3 {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
const xyToXYZ = (p: XY) => [p.x / p.y, 1, (1 - p.x - p.y) / p.y];

/** RGB → XYZ matrix for a space (in its own white). */
export function rgbToXYZMatrix(s: RGBSpace): M3 {
  const r = xyToXYZ(s.red), g = xyToXYZ(s.green), b = xyToXYZ(s.blue);
  const M = [[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]];
  const W = xyToXYZ(s.white);
  const S = mulv(inv3(M), W);
  return M.map((row) => row.map((v, j) => v * S[j]));
}

/** Linear RGB (space `from`) → linear RGB (space `to`), with Bradford adaptation between their whites. */
export function rgbConversionMatrix(from: keyof typeof RGB_SPACES, to: keyof typeof RGB_SPACES): M3 {
  const f = RGB_SPACES[from], t = RGB_SPACES[to];
  return mul(inv3(rgbToXYZMatrix(t)), mul(bradford(f.white, t.white), rgbToXYZMatrix(f)));
}

/** Bradford chromatic adaptation. */
function bradford(src: XY, dst: XY): M3 {
  const Bm: M3 = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
  const s = mulv(Bm, xyToXYZ(src)), d = mulv(Bm, xyToXYZ(dst));
  const D: M3 = [[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]];
  return mul(inv3(Bm), mul(D, Bm));
}

class IccWriter {
  bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 255); }
  u16(v: number) { this.u8(v >> 8); this.u8(v); }
  u32(v: number) { this.u8(v >>> 24); this.u8(v >>> 16); this.u8(v >>> 8); this.u8(v); }
  s15(v: number) { this.u32(Math.round(v * 65536) | 0); }
  sig(s: string) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
  pad4() { while (this.bytes.length % 4) this.u8(0); }
}

function tagDesc(text: string): number[] {
  const w = new IccWriter();
  w.sig('desc'); w.u32(0);
  w.u32(text.length + 1);
  for (const c of text) w.u8(c.charCodeAt(0));
  w.u8(0);
  w.u32(0); w.u32(0); // unicode
  w.u16(0); w.u8(0); for (let i = 0; i < 67; i++) w.u8(0); // scriptcode
  return w.bytes;
}
function tagText(text: string): number[] {
  const w = new IccWriter();
  w.sig('text'); w.u32(0);
  for (const c of text) w.u8(c.charCodeAt(0));
  w.u8(0);
  return w.bytes;
}
function tagXYZ(v: number[]): number[] {
  const w = new IccWriter();
  w.sig('XYZ '); w.u32(0);
  w.s15(v[0]); w.s15(v[1]); w.s15(v[2]);
  return w.bytes;
}
function tagCurve(trc: number | 'srgb'): number[] {
  const w = new IccWriter();
  w.sig('curv'); w.u32(0);
  if (trc === 'srgb') {
    const n = 1024;
    w.u32(n);
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      const y = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      w.u16(Math.round(y * 65535));
    }
  } else if (trc === 1) {
    w.u32(0);
  } else {
    w.u32(1);
    w.u16(Math.round(trc * 256));
  }
  return w.bytes;
}

function buildProfile(cls: string, space: string, tags: [string, number[]][], pcs = 'XYZ '): Uint8Array {
  const headerSize = 128;
  const tableSize = 4 + tags.length * 12;
  let offset = headerSize + tableSize;
  const placed: { sig: string; off: number; data: number[] }[] = [];
  const seen = new Map<string, number>();
  for (const [sig, data] of tags) {
    const key = data.join(',');
    if (seen.has(key)) {
      placed.push({ sig, off: seen.get(key)!, data });
      continue;
    }
    while (offset % 4) offset++;
    placed.push({ sig, off: offset, data });
    seen.set(key, offset);
    offset += data.length;
  }
  while (offset % 4) offset++;
  const out = new Uint8Array(offset);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, offset);
  out.set([...'lcms'].map((c) => c.charCodeAt(0)), 4);
  out[8] = 2; out[9] = 0x10; // v2.1
  out.set([...cls].map((c) => c.charCodeAt(0)), 12);
  out.set([...space].map((c) => c.charCodeAt(0)), 16);
  out.set([...pcs].map((c) => c.charCodeAt(0)), 20);
  const d = new Date();
  [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].forEach((v, i) => dv.setUint16(24 + i * 2, v));
  out.set([...'acsp'].map((c) => c.charCodeAt(0)), 36);
  out.set([...'MSFT'].map((c) => c.charCodeAt(0)), 40);
  dv.setUint32(64, 0); // perceptual
  dv.setInt32(68, Math.round(0.9642 * 65536)); dv.setInt32(72, 65536); dv.setInt32(76, Math.round(0.8249 * 65536));
  out.set([...'LUMN'].map((c) => c.charCodeAt(0)), 80);
  dv.setUint32(128, tags.length);
  placed.forEach((p, i) => {
    const o = 132 + i * 12;
    out.set([...p.sig].map((c) => c.charCodeAt(0)), o);
    dv.setUint32(o + 4, p.off);
    dv.setUint32(o + 8, p.data.length);
  });
  for (const p of placed) out.set(p.data, p.off);
  return out;
}

const cache = new Map<BuiltinProfileId, Uint8Array>();

/** Generates ICC bytes for a built-in profile. */
export function builtinProfileICC(id: BuiltinProfileId): Uint8Array {
  const hit = cache.get(id);
  if (hit) return hit;
  let icc: Uint8Array;
  if (id === 'celenneCMYK') icc = celenneCmykProfile();
  else if (id === 'labD50') {
    // CIE Lab identity (ColorSpace class, Lab → Lab), so Lab documents have a profile like any other.
    const idLut = (): number[] => {
      const w = new IccWriter();
      w.sig('mft2'); w.u32(0); w.u8(3); w.u8(3); w.u8(2); w.u8(0);
      for (let i = 0; i < 9; i++) w.s15(i % 4 === 0 ? 1 : 0);
      w.u16(2); w.u16(2);
      for (let c = 0; c < 3; c++) { w.u16(0); w.u16(65535); }
      for (let i = 0; i < 8; i++) { w.u16(i & 4 ? 65535 : 0); w.u16(i & 2 ? 65535 : 0); w.u16(i & 1 ? 65535 : 0); }
      for (let c = 0; c < 3; c++) { w.u16(0); w.u16(65535); }
      return w.bytes;
    };
    const lut = idLut();
    icc = buildProfile('spac', 'Lab ', [
      ['desc', tagDesc('Lab Color (D50)')],
      ['cprt', tagText('No copyright, use freely')],
      ['wtpt', tagXYZ([0.9642, 1, 0.8249])],
      ['A2B0', lut],
      ['B2A0', lut],
    ], 'Lab ');
  } else if (id === 'gray22' || id === 'grayGamma18' || id === 'dotGain20') {
    const gamma = id === 'grayGamma18' ? 1.8 : id === 'dotGain20' ? 2.35 : 2.2;
    const name = BUILTIN_PROFILES.find((p) => p.id === id)!.name;
    icc = buildProfile('mntr', 'GRAY', [
      ['desc', tagDesc(name)],
      ['cprt', tagText('No copyright, use freely')],
      ['wtpt', tagXYZ([0.9642, 1, 0.8249])],
      ['kTRC', tagCurve(gamma)],
    ]);
  } else {
    const s = RGB_SPACES[id];
    const M = mul(bradford(s.white, D50), rgbToXYZMatrix(s));
    icc = buildProfile('mntr', 'RGB ', [
      ['desc', tagDesc(s.name)],
      ['cprt', tagText('No copyright, use freely')],
      ['wtpt', tagXYZ([0.9642, 1, 0.8249])],
      ['rXYZ', tagXYZ([M[0][0], M[1][0], M[2][0]])],
      ['gXYZ', tagXYZ([M[0][1], M[1][1], M[2][1]])],
      ['bXYZ', tagXYZ([M[0][2], M[1][2], M[2][2]])],
      ['rTRC', tagCurve(s.trc)],
      ['gTRC', tagCurve(s.trc)],
      ['bTRC', tagCurve(s.trc)],
    ]);
  }
  cache.set(id, icc);
  return icc;
}

export function builtinProfileName(id: BuiltinProfileId): string {
  return BUILTIN_PROFILES.find((p) => p.id === id)?.name ?? id;
}

/** Recognizes an embedded profile as one of the built-ins by its description. */
export function matchBuiltin(description: string): BuiltinProfileId | undefined {
  const d = description.toLowerCase();
  if (d.includes('srgb') && d.includes('linear')) return 'linearSRGB';
  if (d.includes('srgb')) return 'srgb';
  if (d.includes('display p3') || d === 'p3') return 'displayP3';
  if (d.includes('adobe rgb')) return 'adobeRGB';
  if (d.includes('prophoto')) return 'proPhotoRGB';
  if (d.includes('gray gamma 2.2')) return 'gray22';
  if (d.includes('gray gamma 1.8')) return 'grayGamma18';
  if (d.includes('dot gain 20')) return 'dotGain20';
  if (d === CELENNE_CMYK_NAME.toLowerCase() || d === 'lumen coated cmyk (approximate)') return 'celenneCMYK'; // also the name used up to 0.1.0
  return undefined;
}
