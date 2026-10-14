/**
 * Font service: enumerates installed fonts (Local Font Access API when permitted), resolves
 * PostScript names from PSD files to families/styles, and detects missing fonts.
 */
export interface FontFaceInfo {
  family: string;
  style: string;
  fullName: string;
  postScriptName: string;
  weight: number;
  italic: boolean;
}

const COMMON: string[] = [
  'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium',
  'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Microsoft Sans Serif', 'MS Gothic', 'Palatino Linotype',
  'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Emoji', 'Sitka Text', 'Sylfaen', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Yu Gothic',
  'Helvetica', 'Helvetica Neue', 'Myriad Pro', 'Minion Pro', 'Roboto', 'Open Sans', 'Noto Sans', 'Noto Serif', 'Inter', 'Source Sans Pro',
];

export const styleWeight = (s: string): number => {
  const v = s.toLowerCase();
  if (/black|heavy/.test(v)) return 900;
  if (/extra ?bold|ultra ?bold/.test(v)) return 800;
  if (/semi ?bold|demi ?bold/.test(v)) return 600;
  if (/bold/.test(v)) return 700;
  if (/medium/.test(v)) return 500;
  if (/extra ?light|ultra ?light/.test(v)) return 200;
  if (/light/.test(v)) return 300;
  if (/thin|hairline/.test(v)) return 100;
  return 400;
};

class FontService {
  faces: FontFaceInfo[] = [];
  families: string[] = [];
  private byPS = new Map<string, FontFaceInfo>();
  private probeCache = new Map<string, boolean>();
  loaded = false;
  localAccess: 'granted' | 'unavailable' | 'denied' | 'pending' = 'pending';
  private listeners = new Set<() => void>();

  on(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Loads the installed font list. Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.loaded) return;
    const q = (globalThis as unknown as { queryLocalFonts?: () => Promise<{ family: string; style: string; fullName: string; postscriptName: string; blob(): Promise<Blob> }[]> }).queryLocalFonts;
    if (q) {
      try {
        const list = await q();
        // Celenne's text engine reads the same fonts' files when a layer uses them.
        void import('./engine/appFonts').then((m) => m.registerLocalFonts(list, styleWeight)).catch(() => {});
        this.faces = list.map((f) => ({ family: f.family, style: f.style, fullName: f.fullName, postScriptName: f.postscriptName, weight: styleWeight(f.style), italic: /italic|oblique/i.test(f.style) }));
        this.localAccess = 'granted';
      } catch {
        this.localAccess = 'denied';
      }
    } else this.localAccess = 'unavailable';
    if (!this.faces.length) {
      for (const fam of COMMON) if (this.probe(fam)) this.faces.push({ family: fam, style: 'Regular', fullName: fam, postScriptName: fam.replace(/\s+/g, ''), weight: 400, italic: false });
    }
    this.byPS.clear();
    for (const f of this.faces) this.byPS.set(f.postScriptName.toLowerCase(), f);
    this.families = [...new Set(this.faces.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    this.loaded = true;
    for (const l of this.listeners) l();
  }

  stylesOf(family: string): FontFaceInfo[] {
    const s = this.faces.filter((f) => f.family === family);
    return s.length ? s : [{ family, style: 'Regular', fullName: family, postScriptName: family.replace(/\s+/g, ''), weight: 400, italic: false }];
  }

  byPostScript(ps: string): FontFaceInfo | undefined {
    return this.byPS.get(ps.toLowerCase());
  }

  /** True when the font can be rendered (exact face or at least the family). */
  isAvailable(postScriptName: string, family: string): boolean {
    if (postScriptName && this.byPS.has(postScriptName.toLowerCase())) return true;
    if (this.faces.some((f) => f.family.toLowerCase() === family.toLowerCase())) return true;
    return this.probe(family);
  }

  /** Canvas metrics probe: a family is present when it renders differently from fallbacks. */
  probe(family: string): boolean {
    const key = family.toLowerCase();
    const hit = this.probeCache.get(key);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : null;
      const g = c?.getContext('2d') as OffscreenCanvasRenderingContext2D | null | undefined;
      if (g) {
        const text = 'mmmmmmmmmmlliWWQ@#0123456789';
        const widths = (fallback: string) => {
          g.font = `72px ${fallback}`;
          const base = g.measureText(text).width;
          g.font = `72px "${family}", ${fallback}`;
          return [base, g.measureText(text).width];
        };
        for (const fb of ['monospace', 'serif', 'sans-serif']) {
          const [a, b] = widths(fb);
          if (Math.abs(a - b) > 0.5) { ok = true; break; }
        }
      }
    } catch {
      ok = false;
    }
    this.probeCache.set(key, ok);
    return ok;
  }

  /** Best substitute for a missing font. */
  substitute(family: string, weight: number): string {
    const f = family.toLowerCase();
    if (/mono|courier|consol|code/.test(f)) return this.firstAvailable(['Consolas', 'Courier New', 'monospace']);
    if (/serif|times|georgia|minion|garamond|roman/.test(f) && !/sans/.test(f)) return this.firstAvailable(['Georgia', 'Times New Roman', 'serif']);
    void weight;
    return this.firstAvailable(['Segoe UI', 'Arial', 'Helvetica', 'sans-serif']);
  }

  private firstAvailable(list: string[]): string {
    for (const f of list) if (['serif', 'sans-serif', 'monospace'].includes(f) || this.isAvailable('', f)) return f;
    return 'sans-serif';
  }
}

export const fonts = new FontService();
