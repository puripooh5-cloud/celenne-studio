/**
 * Font registry for the text engine: knows which faces exist (from the Local Font Access API in
 * the app, or a font folder in tests and scripts), loads their files on demand and picks
 * fallback faces for characters the requested font does not have.
 */
import { FontFace, faceCount } from './face';

export interface FaceSource {
  postScriptName: string;
  family: string;
  style: string;
  weight: number;
  italic: boolean;
  /** Font file bytes (sync for local files in tests, async for the Local Font Access API). */
  load(): ArrayBuffer | Promise<ArrayBuffer>;
}

export interface FaceRequest {
  postScriptName?: string;
  family: string;
  weight: number;
  italic: boolean;
}

/** Fallback families by script, tried in order (Windows fonts first). */
const FALLBACKS: [RegExp, string[]][] = [
  [/[฀-๿]/, ['Leelawadee UI', 'Leelawadee', 'Tahoma', 'Noto Sans Thai']],
  [/[぀-ヿㇰ-ㇿ]/, ['Yu Gothic UI', 'Yu Gothic', 'Meiryo', 'MS Gothic', 'Noto Sans JP']],
  [/[가-힯ᄀ-ᇿ]/, ['Malgun Gothic', 'Noto Sans KR']],
  [/[一-鿿㐀-䶿]/, ['Microsoft YaHei UI', 'Microsoft YaHei', 'SimSun', 'Yu Gothic', 'Noto Sans SC']],
  [/[؀-ۿ]/, ['Segoe UI', 'Arial', 'Tahoma', 'Noto Sans Arabic']],
  [/[֐-׿]/, ['Segoe UI', 'Arial', 'Noto Sans Hebrew']],
  [/[ऀ-ॿ]/, ['Nirmala UI', 'Mangal', 'Noto Sans Devanagari']],
  [/[\u{1f300}-\u{1faff}☀-➿]/u, ['Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji']],
];
const LAST_RESORT = ['Segoe UI', 'Arial', 'Segoe UI Symbol', 'Arial Unicode MS'];

export class FaceRegistry {
  private sources = new Map<string, FaceSource>();
  private byFamily = new Map<string, FaceSource[]>();
  private faces = new Map<string, FontFace | null>();
  private pending = new Map<string, Promise<FontFace | null>>();
  private listeners = new Set<() => void>();

  register(list: FaceSource[]) {
    for (const s of list) {
      const k = s.postScriptName.toLowerCase();
      if (!k || this.sources.has(k)) continue;
      this.sources.set(k, s);
      const f = s.family.toLowerCase();
      const arr = this.byFamily.get(f) ?? [];
      arr.push(s);
      this.byFamily.set(f, arr);
    }
  }

  get size() { return this.sources.size; }

  onLoaded(cb: () => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  /** The source that best matches a request: exact PostScript name, else the family's closest style. */
  resolve(r: FaceRequest): FaceSource | null {
    if (r.postScriptName) {
      const s = this.sources.get(r.postScriptName.toLowerCase());
      if (s) return s;
    }
    return this.closestInFamily(r.family, r.weight, r.italic);
  }

  closestInFamily(family: string, weight: number, italic: boolean): FaceSource | null {
    const list = this.byFamily.get(family.toLowerCase());
    if (!list?.length) return null;
    let best = list[0], bestScore = Infinity;
    for (const s of list) {
      const score = Math.abs(s.weight - weight) + (s.italic !== italic ? 1000 : 0) + (/condensed|narrow|compressed|expanded|wide/i.test(s.style) ? 300 : 0);
      if (score < bestScore) { best = s; bestScore = score; }
    }
    return best;
  }

  /** Loaded face for a source, or null while it loads (listeners are told when it arrives). */
  face(src: FaceSource): FontFace | null {
    const k = src.postScriptName.toLowerCase();
    if (this.faces.has(k)) return this.faces.get(k)!;
    if (!this.pending.has(k)) {
      const data = src.load();
      if (data instanceof ArrayBuffer) return this.open(k, data, src);
      this.pending.set(k, data.then((b) => this.open(k, b, src)).catch(() => { this.faces.set(k, null); return null; }).finally(() => { this.pending.delete(k); for (const l of this.listeners) l(); }));
    }
    return null;
  }

  /** Whether the face is still loading (false once loaded, or when it could not be read). */
  loading(src: FaceSource): boolean {
    return this.pending.has(src.postScriptName.toLowerCase());
  }

  /** Whether any face is still loading. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  /** Resolves when every listed request has finished loading. */
  async ensure(reqs: FaceRequest[]): Promise<void> {
    const ps: Promise<unknown>[] = [];
    for (const r of reqs) {
      const s = this.resolve(r);
      if (s && !this.face(s)) { const p = this.pending.get(s.postScriptName.toLowerCase()); if (p) ps.push(p); }
    }
    await Promise.all(ps);
  }

  private open(k: string, bytes: ArrayBuffer, src: FaceSource): FontFace | null {
    try {
      const n = faceCount(bytes);
      let f: FontFace | null = null;
      for (let i = 0; i < n; i++) {
        const cand = new FontFace(bytes, i);
        if (n === 1 || cand.postScriptName.toLowerCase() === src.postScriptName.toLowerCase()) { f = cand; break; }
      }
      f ??= new FontFace(bytes, 0);
      this.faces.set(k, f);
      return f;
    } catch {
      this.faces.set(k, null);
      return null;
    }
  }

  /** A loaded face that has a glyph for `cp`, preferring the script's usual families. */
  fallbackFor(cp: number, weight: number, italic: boolean): FontFace | null {
    const ch = String.fromCodePoint(cp);
    const fams = [...(FALLBACKS.find(([re]) => re.test(ch))?.[1] ?? []), ...LAST_RESORT];
    for (const fam of fams) {
      const s = this.closestInFamily(fam, weight, italic);
      if (!s) continue;
      const f = this.face(s);
      if (f?.hasGlyph(cp)) return f;
    }
    return null;
  }
}
