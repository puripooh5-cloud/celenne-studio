/**
 * Keeps text layers drawn by Celenne's text engine: fonts that text layers use start loading as
 * soon as a document opens, and layers drawn by the browser while the engine or a font was still
 * loading are redrawn by the engine once it arrives (a display refresh, not an undoable edit).
 */
import { editor } from './editor';
import { appFaces, engineFontsReady, onEngineFonts } from '../typography/engine/appFonts';
import { engineHandles } from '../typography/engineRender';
import { renderTextLayer } from '../layers/appearance';
import type { DocumentSession } from './session';
import type { TextLayer } from '../document/types';
import type { CharacterStyle } from '../typography/types';
import { fonts } from '../typography/fonts';
import { setFontTypeResolver, setPostScriptNameResolver } from '../psd/mapping';

function textLayers(s: DocumentSession): TextLayer[] {
  return s.doc.allLayers().filter((l): l is TextLayer => l.kind === 'text');
}

/** Starts loading the faces a document's text uses (so the first edit is drawn by the engine). */
function preload(s: DocumentSession) {
  if (!engineFontsReady()) return;
  for (const l of textLayers(s))
    for (const r of l.text.runs) {
      const src = appFaces.resolve({ postScriptName: r.style.postScriptName, family: r.style.fontFamily, weight: r.style.fontWeight, italic: r.style.italic });
      if (src) appFaces.face(src);
    }
}

let timer: ReturnType<typeof setTimeout> | null = null;

function refresh() {
  timer = null;
  for (const s of editor.sessions) {
    preload(s);
    for (const l of textLayers(s)) {
      if (l.usingPreservedPixels || !l.browserRendered || !engineHandles(l.text)) continue;
      renderTextLayer(s.doc, l);
      if (!l.browserRendered) s.doc.emit({ type: 'layer', layerId: l.id });
    }
  }
}

/** The installed face a style uses: its own PostScript name, else the family's face with that style name, else the nearest weight. */
function postScriptNameOf(s: CharacterStyle): string | undefined {
  const fam = s.fontFamily.toLowerCase();
  const named = fonts.faces.find((f) => f.family.toLowerCase() === fam && f.style === s.fontStyleName);
  if (named && fonts.localAccess === 'granted') return named.postScriptName;
  return appFaces.resolve({ family: s.fontFamily, weight: s.fontWeight, italic: s.italic })?.postScriptName;
}

/** TrueType (1) or PostScript / CFF (0) outlines, once the face has been read. */
function fontTypeOf(postScriptName: string): number | undefined {
  const src = appFaces.resolve({ postScriptName, family: '', weight: 400, italic: false });
  const f = src && src.postScriptName.toLowerCase() === postScriptName.toLowerCase() ? appFaces.face(src) : null;
  return f ? (f.trueType ? 1 : 0) : undefined;
}

export function installTextEngine(): void {
  // Saved PSDs name each font as Photoshop does (its PostScript name and outline type).
  setPostScriptNameResolver(postScriptNameOf);
  setFontTypeResolver(fontTypeOf);
  editor.documentAdded.add(preload);
  onEngineFonts(() => { timer ??= setTimeout(refresh, 30); });
}

/** Inspection hook for smoke tests (no effect on the app). */
(globalThis as unknown as { __celenneText?: unknown }).__celenneText = {
  ready: engineFontsReady,
  render: (s: DocumentSession, l: TextLayer) => { renderTextLayer(s.doc, l); s.doc.emit({ type: 'layer', layerId: l.id }); return !l.browserRendered; },
};
