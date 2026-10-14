/**
 * The text engine's fonts inside the app: installed fonts from the Local Font Access API, loaded
 * on demand (a font file is read the first time a layer uses it). Until HarfBuzz and the font
 * list are ready, or while a face is loading, text is drawn with the browser's text renderer.
 */
import { initShaper, shaperReady } from './face';
import { FaceRegistry } from './registry';

/** The registry the app's text rendering uses. */
export const appFaces = new FaceRegistry();

interface LocalFontData {
  family: string;
  style: string;
  postscriptName: string;
  blob(): Promise<Blob>;
}

let ready = false;

/** True once the shaper runs and installed fonts are registered. */
export function engineFontsReady(): boolean {
  return ready && shaperReady() && appFaces.size > 0;
}

/** Registers the faces the Local Font Access API listed (called by the font service). */
export async function registerLocalFonts(list: LocalFontData[], weightOf: (style: string) => number): Promise<void> {
  if (!list.length || typeof list[0]?.blob !== 'function') return;
  if (!(await initShaper())) return;
  appFaces.register(list.map((f) => ({
    postScriptName: f.postscriptName,
    family: f.family,
    style: f.style,
    weight: weightOf(f.style),
    italic: /italic|oblique/i.test(f.style),
    load: () => f.blob().then((b) => b.arrayBuffer()),
  })));
  ready = true;
  for (const l of readyListeners) l();
}

const readyListeners = new Set<() => void>();

/** Called when the engine becomes ready and whenever a face finishes loading. */
export function onEngineFonts(cb: () => void): () => void {
  readyListeners.add(cb);
  const off = appFaces.onLoaded(cb);
  return () => { readyListeners.delete(cb); off(); };
}
