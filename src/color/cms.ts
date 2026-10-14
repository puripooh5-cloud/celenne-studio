/**
 * Color management engine (LittleCMS via WebAssembly).
 *
 *  - Profiles: built-in working spaces (generated ICC), the built-in CMYK output profile, CIE Lab
 *    (D50), embedded document profiles, user CMYK profiles.
 *  - Display: document → monitor transform baked into a 33³ 3D LUT consumed by the GPU shader
 *    (RGB, Gray and Lab documents), or a CPU transform of the composite (CMYK documents).
 *  - Soft proofing: proofing transform (document → proof device → monitor).
 *  - Conversions between any two profiles (RGB, CMYK, Gray, Lab) with rendering intent and
 *    black point compensation.
 *
 * Pixel formats: lcms-wasm's wrapper exchanges 32-bit floats, so every float format here is the
 * FLT variant (bytes field = 4). Value ranges follow LittleCMS: RGB / Gray 0..1, CMYK 0..100 %,
 * Lab L 0..100 and a / b −128..127.
 */
import type * as L from 'lcms-wasm';
import type { ColorProfileRef } from '../document/types';
import { builtinProfileICC, BuiltinProfileId, parseIccInfo } from './icc';
import type { DisplayLUT } from '../rendering/viewportRenderer';

export type Intent = 'perceptual' | 'relative' | 'saturation' | 'absolute';
export type ProfileSpace = 'RGB' | 'CMYK' | 'GRAY' | 'Lab';
export type ProfileLike = ColorProfileRef | BuiltinProfileId;

let modPromise: Promise<{ lcms: L.LcmsModule; k: typeof L }> | null = null;

async function load(): Promise<{ lcms: L.LcmsModule; k: typeof L }> {
  if (!modPromise) {
    modPromise = (async () => {
      const k = await import('lcms-wasm');
      let opts: { locateFile?: (n: string) => string } | undefined;
      if (typeof window !== 'undefined') {
        const url = (await import('lcms-wasm/dist/lcms.wasm?url')).default;
        opts = { locateFile: () => url };
      }
      const lcms = await k.instantiate(opts);
      return { lcms, k };
    })();
  }
  return modPromise;
}

const LUT_SIZE = 33;

/** A cached pixel transform: packed input → packed output in LittleCMS value ranges. */
export interface Xform {
  run(input: Float32Array, n: number): Float32Array;
  inChannels: number;
  outChannels: number;
}

export class ColorEngine {
  private lcms: L.LcmsModule | null = null;
  private k: typeof L | null = null;
  private handles = new Map<string, number>();
  private luts = new Map<string, DisplayLUT>();
  private xforms = new Map<string, Xform>();
  private xforms8 = new Map<string, (input: Uint8Array, n: number) => Uint8Array>();
  status: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  error: string | null = null;

  async init(): Promise<boolean> {
    if (this.status === 'ready') return true;
    this.status = 'loading';
    try {
      const { lcms, k } = await load();
      this.lcms = lcms;
      this.k = k;
      this.status = 'ready';
      return true;
    } catch (e) {
      this.status = 'failed';
      this.error = (e as Error).message;
      return false;
    }
  }

  get ready(): boolean {
    return this.status === 'ready';
  }

  private intentOf(i: Intent): number {
    const k = this.k!;
    return i === 'perceptual' ? k.INTENT_PERCEPTUAL : i === 'saturation' ? k.INTENT_SATURATION : i === 'absolute' ? k.INTENT_ABSOLUTE_COLORIMETRIC : k.INTENT_RELATIVE_COLORIMETRIC;
  }

  profileKey(p: ProfileLike): string {
    if (typeof p === 'string') return `b:${p}`;
    if (p.icc) return `i:${p.icc.length}:${hash(p.icc)}`;
    return `b:${p.builtin ?? 'srgb'}`;
  }

  private builtinOf(p: ProfileLike): BuiltinProfileId | undefined {
    return typeof p === 'string' ? p : p.icc ? undefined : p.builtin ?? 'srgb';
  }

  private handle(p: ProfileLike): number {
    const key = this.profileKey(p);
    let h = this.handles.get(key);
    if (h) return h;
    const lcms = this.lcms!;
    const b = this.builtinOf(p);
    if (b === 'srgb') h = lcms.cmsCreate_sRGBProfile();
    else if (b === 'labD50') h = lcms.cmsCreateLab4Profile(null);
    else {
      const bytes = typeof p === 'string' ? builtinProfileICC(p) : p.icc ?? builtinProfileICC(p.builtin ?? 'srgb');
      h = lcms.cmsOpenProfileFromMem(bytes, bytes.length);
    }
    if (!h) throw new Error('Invalid or unsupported ICC profile');
    this.handles.set(key, h);
    return h;
  }

  /** Colour space of a profile. */
  spaceOf(p: ProfileLike): ProfileSpace {
    const b = this.builtinOf(p);
    if (b === 'labD50') return 'Lab';
    const bytes = typeof p === 'string' ? builtinProfileICC(p) : p.icc ?? builtinProfileICC(p.builtin ?? 'srgb');
    const s = parseIccInfo(bytes)?.colorSpace;
    return s === 'CMYK' ? 'CMYK' : s === 'GRAY' ? 'GRAY' : s === 'Lab ' ? 'Lab' : 'RGB';
  }

  /** Float32 channel format for a profile's colour space. */
  private formatOf(p: ProfileLike): { fmt: number; ch: number; space: ProfileSpace } {
    const k = this.k!;
    const space = this.spaceOf(p);
    // DBL formats have a zero bytes field; | 4 turns them into their 32-bit float variants.
    if (space === 'CMYK') return { fmt: k.TYPE_CMYK_DBL | 4, ch: 4, space };
    if (space === 'GRAY') return { fmt: k.TYPE_GRAY_DBL | 4, ch: 1, space };
    if (space === 'Lab') return { fmt: k.TYPE_Lab_DBL | 4, ch: 3, space };
    return { fmt: k.TYPE_RGB_DBL | 4, ch: 3, space };
  }

  sameProfile(a: ProfileLike, b: ProfileLike): boolean {
    return this.profileKey(a) === this.profileKey(b);
  }

  /** A cached float transform between two profiles. */
  transform(from: ProfileLike, to: ProfileLike, intent: Intent = 'relative', bpc = true): Xform {
    if (!this.ready) throw new Error('Color management is not available');
    const key = `${this.profileKey(from)}>${this.profileKey(to)}|${intent}|${bpc ? 1 : 0}`;
    const hit = this.xforms.get(key);
    if (hit) return hit;
    const lcms = this.lcms!, k = this.k!;
    const sf = this.formatOf(from), df = this.formatOf(to);
    const t = lcms.cmsCreateTransform(this.handle(from), sf.fmt, this.handle(to), df.fmt, this.intentOf(intent), bpc ? k.cmsFLAGS_BLACKPOINTCOMPENSATION : 0);
    if (!t) throw new Error('Could not create color transform between these profiles');
    const x: Xform = {
      inChannels: sf.ch,
      outChannels: df.ch,
      run: (input, n) => {
        const CHUNK = 1 << 16;
        if (n <= CHUNK) return lcms.cmsDoTransform(t, input.subarray(0, n * sf.ch), n) as unknown as Float32Array;
        const out = new Float32Array(n * df.ch);
        for (let s = 0; s < n; s += CHUNK) {
          const m = Math.min(CHUNK, n - s);
          out.set(lcms.cmsDoTransform(t, input.subarray(s * sf.ch, (s + m) * sf.ch), m) as unknown as Float32Array, s * df.ch);
        }
        return out;
      },
    };
    this.xforms.set(key, x);
    return x;
  }

  /** 8-bit CMYK (ink 0..255) → 8-bit RGB transform, optionally soft-proofed (fast path for display). */
  cmyk8ToRgb8(cmyk: ProfileLike, display: ProfileLike, proof?: { profile: ProfileLike; intent: Intent } | null): (input: Uint8Array, n: number) => Uint8Array {
    const key = `${this.profileKey(cmyk)}>${this.profileKey(display)}${proof ? `|p:${this.profileKey(proof.profile)}:${proof.intent}` : ''}`;
    const hit = this.xforms8.get(key);
    if (hit) return hit;
    const lcms = this.lcms!, k = this.k!;
    const TYPE_CMYK_8 = (k as unknown as { TYPE_CMYK_8: number }).TYPE_CMYK_8;
    const t = proof
      ? lcms.cmsCreateProofingTransform(this.handle(cmyk), TYPE_CMYK_8, this.handle(display), k.TYPE_RGB_8, this.handle(proof.profile), k.INTENT_RELATIVE_COLORIMETRIC, this.intentOf(proof.intent), k.cmsFLAGS_SOFTPROOFING | k.cmsFLAGS_BLACKPOINTCOMPENSATION)
      : lcms.cmsCreateTransform(this.handle(cmyk), TYPE_CMYK_8, this.handle(display), k.TYPE_RGB_8, k.INTENT_RELATIVE_COLORIMETRIC, k.cmsFLAGS_BLACKPOINTCOMPENSATION);
    if (!t) throw new Error('Could not create CMYK display transform');
    const f = (input: Uint8Array, n: number) => lcms.cmsDoTransform(t, input.subarray(0, n * 4), n) as Uint8Array;
    this.xforms8.set(key, f);
    return f;
  }

  /**
   * Builds (and caches) the display LUT: document profile → monitor, optionally soft-proofed.
   * The LUT is indexed by the document's stored channel values (0..1): RGB for RGB documents,
   * encoded L / a / b for Lab documents. With `gamut` (a CMYK output profile), colours the
   * output cannot reproduce are shown as neutral gray (View ▸ Gamut Warning).
   */
  displayLUT(doc: ColorProfileRef, display: BuiltinProfileId, proof?: { profile: ColorProfileRef; intent: Intent } | null, gamut?: ColorProfileRef | null): DisplayLUT | null {
    if (!this.ready) return null;
    if (!proof && !gamut && this.sameProfile(doc, display)) return null;
    const key = `${this.profileKey(doc)}→${display}${proof ? `|p:${this.profileKey(proof.profile)}:${proof.intent}` : ''}${gamut ? `|g:${this.profileKey(gamut)}` : ''}`;
    const hit = this.luts.get(key);
    if (hit) return hit;
    const lcms = this.lcms!, k = this.k!;
    const sf = this.formatOf(doc);
    if (sf.ch !== 3) return null;
    const src = this.handle(doc), dst = this.handle(display);
    const rgb = k.TYPE_RGB_DBL | 4;
    const t = proof
      ? lcms.cmsCreateProofingTransform(src, sf.fmt, dst, rgb, this.handle(proof.profile), k.INTENT_RELATIVE_COLORIMETRIC, this.intentOf(proof.intent), k.cmsFLAGS_SOFTPROOFING | k.cmsFLAGS_BLACKPOINTCOMPENSATION)
      : lcms.cmsCreateTransform(src, sf.fmt, dst, rgb, k.INTENT_RELATIVE_COLORIMETRIC, k.cmsFLAGS_BLACKPOINTCOMPENSATION);
    if (!t) return null;
    const n = LUT_SIZE;
    const grid = new Float32Array(n * n * n * 3);
    let o = 0;
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) { grid[o++] = r / (n - 1); grid[o++] = g / (n - 1); grid[o++] = b / (n - 1); }
    const input = sf.space === 'Lab' ? decodeLabGrid(grid) : grid;
    const out = lcms.cmsDoTransform(t, input, n * n * n) as unknown as Float32Array;
    lcms.cmsDeleteTransform(t);
    const data = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) data[i] = Math.round(Math.max(0, Math.min(1, out[i])) * 255);
    if (gamut) this.markOutOfGamut(doc, gamut, input, n * n * n, data);
    const lut: DisplayLUT = { size: n, data, id: key };
    this.luts.set(key, lut);
    return lut;
  }

  /** Round-trips LUT grid colours through the output profile; unreproducible ones become gray. */
  private markOutOfGamut(doc: ColorProfileRef, output: ColorProfileRef, input: Float32Array, n: number, data: Uint8Array): void {
    if (this.spaceOf(output) !== 'CMYK') return;
    const to = this.transform(doc, output, 'relative', false);
    const back = this.transform(output, doc, 'relative', false);
    const lab = this.spaceOf(doc) === 'Lab';
    const rt = back.run(to.run(input, n), n);
    for (let i = 0; i < n; i++) {
      const d = lab
        ? Math.hypot(input[i * 3] - rt[i * 3], input[i * 3 + 1] - rt[i * 3 + 1], input[i * 3 + 2] - rt[i * 3 + 2]) / 100 * 3
        : Math.max(Math.abs(input[i * 3] - rt[i * 3]), Math.abs(input[i * 3 + 1] - rt[i * 3 + 1]), Math.abs(input[i * 3 + 2] - rt[i * 3 + 2]));
      if (d > 0.035) data[i * 3] = data[i * 3 + 1] = data[i * 3 + 2] = 128;
    }
  }

  /**
   * Converts straight RGBA float pixels (in place) between RGB / Gray profiles.
   * Alpha is untouched.
   */
  convertRGBA(data: Float32Array, n: number, from: ColorProfileRef, to: ProfileLike, intent: Intent, bpc: boolean): void {
    if (!this.ready) throw new Error('Color management is not available');
    if (this.sameProfile(from, to)) return;
    const x = this.transform(from, to, intent, bpc);
    const CHUNK = 65536;
    const inp = new Float32Array(CHUNK * x.inChannels);
    for (let start = 0; start < n; start += CHUNK) {
      const m = Math.min(CHUNK, n - start);
      for (let i = 0; i < m; i++) {
        const o = (start + i) * 4;
        if (x.inChannels === 1) inp[i] = 0.3 * data[o] + 0.59 * data[o + 1] + 0.11 * data[o + 2];
        else { inp[i * 3] = data[o]; inp[i * 3 + 1] = data[o + 1]; inp[i * 3 + 2] = data[o + 2]; }
      }
      const out = x.run(inp, m);
      for (let i = 0; i < m; i++) {
        const o = (start + i) * 4;
        if (x.outChannels === 1) data[o] = data[o + 1] = data[o + 2] = out[i];
        else if (x.outChannels === 3) { data[o] = out[i * 3]; data[o + 1] = out[i * 3 + 1]; data[o + 2] = out[i * 3 + 2]; }
      }
    }
  }

  /**
   * Bulk CMYK → RGB converter for opening CMYK documents: ink values 0..1 in, RGB 0..1 out.
   * Uses the document's embedded CMYK profile when given, else returns null (caller falls back).
   */
  cmykConverter(cmykIcc: Uint8Array | undefined, to: BuiltinProfileId = 'srgb', intent: Intent = 'perceptual'): ((cmyk: Float64Array, n: number) => Float64Array) | null {
    if (!this.ready || !cmykIcc || parseIccInfo(cmykIcc)?.colorSpace !== 'CMYK') return null;
    let x: Xform;
    try {
      x = this.transform({ name: 'CMYK', icc: cmykIcc }, to, intent, true);
    } catch {
      return null;
    }
    return (cmyk, n) => {
      const inp = new Float32Array(n * 4);
      for (let i = 0; i < n * 4; i++) inp[i] = cmyk[i] * 100;
      return Float64Array.from(x.run(inp, n));
    };
  }

  /** RGB (document profile) → CMYK percentages using a CMYK profile, for Info/Color panels. */
  rgbToCmyk(rgb: [number, number, number], from: ColorProfileRef, cmyk: ProfileLike): [number, number, number, number] | null {
    if (!this.ready) return null;
    try {
      const out = this.transform(from, cmyk, 'relative', true).run(Float32Array.from(rgb), 1);
      return [out[0], out[1], out[2], out[3]];
    } catch {
      return null;
    }
  }
}

/** Encoded Lab grid (0..1 per channel, Photoshop's 8/16-bit layout) → L 0..100, a / b −128..127. */
function decodeLabGrid(g: Float32Array): Float32Array {
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i += 3) {
    out[i] = g[i] * 100;
    out[i + 1] = g[i + 1] * 255 - 128;
    out[i + 2] = g[i + 2] * 255 - 128;
  }
  return out;
}

function hash(b: Uint8Array): number {
  let h = 2166136261;
  const step = Math.max(1, Math.floor(b.length / 4096));
  for (let i = 0; i < b.length; i += step) h = Math.imul(h ^ b[i], 16777619);
  return h >>> 0;
}

export const colorEngine = new ColorEngine();
