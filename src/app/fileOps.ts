/**
 * File operations: new / open / save / save as / save a copy / export / close / recent / place.
 */
import { TiledRaster } from '../image-engine/tiledRaster';
import { encodeColor } from '../color/plates';
import { workingCmykProfile } from './colorSettings';
import { editor } from './editor';
import { ui, useApp } from './store';
import { platform } from './platform/platform';
import { CelenneDocument } from '../document/document';
import { createPixelLayer, createSmartObjectLayer } from '../document/layerFactory';
import { exporterFor, exporters, findImporter, openFilters } from '../formats/registry';
import { analyzePsdExport } from '../psd/export';
import { fonts } from '../typography/fonts';
import { commitTextEdit, textEditState } from '../tools/typeTool';
import type { BitDepth } from '../image-engine/pixels';
import type { ColorMode, SmartObjectSource } from '../document/types';
import type { DocumentSession } from './session';
import { newId, uuid } from '../document/ids';
import { CreateLayerCommand } from '../commands/layerCommands';
import { decodeSmartSource, renderSmartObject } from '../layers/smartObjects';
import { quadFromRect } from '../image-engine/matrix';
import { builtinProfileName, BuiltinProfileId } from '../color/icc';

export interface NewDocumentSpec {
  name: string;
  width: number;
  height: number;
  resolution: number;
  colorMode: ColorMode;
  bitDepth: BitDepth;
  background: 'white' | 'black' | 'transparent' | 'background';
  profile: BuiltinProfileId | import('../document/types').ColorProfileRef;
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function newDocument(spec: NewDocumentSpec): DocumentSession {
  const doc = new CelenneDocument(spec.name || 'Untitled-1', { width: spec.width, height: spec.height, resolution: spec.resolution, colorMode: spec.colorMode, bitDepth: spec.bitDepth });
  doc.profile = spec.colorMode === 'cmyk' ? (typeof spec.profile === 'object' ? spec.profile : workingCmykProfile())
    : spec.colorMode === 'lab' ? { name: 'Lab Color (D50)', builtin: 'labD50' }
      : typeof spec.profile === 'object' ? spec.profile : { name: builtinProfileName(spec.profile), builtin: spec.profile };
  applyGridPrefs(doc);
  const layer = createPixelLayer(spec.background === 'transparent' ? 'Layer 1' : 'Background', spec.bitDepth);
  if (spec.background !== 'transparent') {
    const c = spec.background === 'white' ? { r: 1, g: 1, b: 1, exact: { r: 1, g: 1, b: 1, cmyk: [0, 0, 0, 0] as [number, number, number, number] } } : spec.background === 'black' ? { r: 0, g: 0, b: 0 } : useApp.getState().bg;
    // Stored values per plate (CMYK: C'M'Y' + K'; Lab: L a b; RGB / Gray: as is).
    const plates = encodeColor(doc, c);
    const targets = plates.map((_, p) => (p === 0 ? layer.raster : (layer.raster.companion = new TiledRaster(4, spec.bitDepth))));
    const n = 256;
    plates.forEach((pc, p) => {
      const tile = new Float32Array(n * n * 4);
      for (let i = 0; i < n * n; i++) { tile[i * 4] = pc[0]; tile[i * 4 + 1] = pc[1]; tile[i * 4 + 2] = pc[2]; tile[i * 4 + 3] = 1; }
      for (let y = 0; y < spec.height; y += n)
        for (let x = 0; x < spec.width; x += n) {
          const w = Math.min(n, spec.width - x), h = Math.min(n, spec.height - y);
          const buf = w === n && h === n ? tile : tile.subarray(0, w * h * 4);
          targets[p].writeFloat({ x, y, w, h }, buf);
        }
    });
  }
  doc.insertLayer(layer);
  return editor.addDocument(doc, 'New');
}

/** New and flat-image documents take the grid from Preferences (PSD files keep their own grid). */
function applyGridPrefs(doc: CelenneDocument): void {
  doc.grid.spacing = Math.max(1, editor.prefs.guides.gridSpacing);
  doc.grid.subdivisions = Math.max(1, editor.prefs.guides.gridSubdivisions);
}

export function untitledName(): string {
  let i = 1;
  const names = new Set(editor.sessions.map((s) => s.doc.name));
  while (names.has(`Untitled-${i}`)) i++;
  return `Untitled-${i}`;
}

export async function openDialog(): Promise<void> {
  const files = await platform().openFiles(openFilters(), true);
  for (const f of files) await openBytes(f.name, f.path, f.data);
}

export async function openPath(path: string): Promise<void> {
  const existing = editor.sessions.find((s) => s.doc.filePath && s.doc.filePath.toLowerCase() === path.toLowerCase());
  if (existing) {
    editor.activate(existing.id);
    return;
  }
  try {
    const f = await platform().readPath(path);
    await openBytes(f.name, f.path, f.data);
  } catch (e) {
    ui.toast('error', `Could not open "${basename(path)}"`, errMsg(e));
    removeRecent(path);
  }
}

export async function openBytes(name: string, path: string | null, bytes: Uint8Array): Promise<DocumentSession | null> {
  const importer = findImporter(bytes, name);
  if (!importer) {
    ui.toast('error', `"${name}" is not a supported file format.`, 'Supported: PSD, PSB, PNG, JPEG, TIFF, BMP, GIF, WebP, SVG, AVIF.');
    return null;
  }
  if (!importer.available) {
    ui.toast('warning', `${importer.label} import is not available yet.`, importer.note);
    return null;
  }
  const p = ui.progress(`Opening ${name}…`);
  try {
    await fonts.load().catch(() => {});
    // Yield so the progress indicator paints before heavy parsing.
    await new Promise((r) => setTimeout(r, 16));
    const memLimit = await memoryLimitBytes();
    const r = await importer.import(bytes, name, { fontAvailable: (ps, fam) => fonts.isAvailable(ps, fam), memoryLimit: memLimit });
    r.doc.filePath = path;
    if (!/^ps[db]$/.test(importer.id)) applyGridPrefs(r.doc);
    r.doc.name = name.replace(/\.[^.]+$/, '');
    const s = editor.addDocument(r.doc, 'Open');
    if (path) {
      addRecent(path);
      fileStamps.set(s.id, await statMtime(path));
    }
    const notEditable = r.issues.filter((i) => ['preserved', 'rendered', 'partial', 'converted', 'dropped'].includes(i.status));
    if (notEditable.length) {
      if (/^ps[db]$/.test(importer.id)) ui.toast('warning', 'Some Photoshop features in this document are not currently editable. They have been preserved where possible.', 'See Window › Compatibility Report for details.', 9000);
      else ui.toast('warning', `Some parts of ${name} were converted when it was opened.`, `${notEditable[0].message}${notEditable.length > 1 ? ' See Window › Compatibility Report for more.' : ''}`, 9000);
    }
    const missingFonts = [...new Set(r.doc.allLayers().flatMap((l) => (l.kind === 'text' ? l.missingFonts : [])))];
    if (missingFonts.length) ui.openDialog('missingFonts', { sessionId: s.id, fonts: missingFonts });
    for (const w of r.warnings) console.warn(`[import] ${w}`);
    return s;
  } catch (e) {
    ui.toast('error', `Could not open "${name}"`, errMsg(e), 10000);
    return null;
  } finally {
    p.done();
  }
}

async function memoryLimitBytes(): Promise<number> {
  const mem = await platform().memory().catch(() => null);
  const frac = editor.prefs.performance.ramFraction;
  if (!mem) return 4 * 1024 ** 3;
  return Math.max(512 * 1024 ** 2, mem.totalBytes * frac);
}

// ---------------------------------------------------------------------------------------------
// Recent files
// ---------------------------------------------------------------------------------------------
export function addRecent(path: string): void {
  const limit = editor.prefs.general.recentLimit;
  ui.set((s) => ({ recentFiles: [path, ...s.recentFiles.filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, limit) }));
}
export function removeRecent(path: string): void {
  ui.set((s) => ({ recentFiles: s.recentFiles.filter((p) => p !== path) }));
}
export function clearRecent(): void {
  ui.set({ recentFiles: [] });
}

const fileStamps = new Map<string, number>();
async function statMtime(path: string): Promise<number> {
  const b = platform().bridge;
  if (!b) return 0;
  try {
    return (await b.stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------------------------
const PSD_FILTERS = [
  { name: 'Photoshop (*.psd)', extensions: ['psd'] },
  { name: 'Large Document Format (*.psb)', extensions: ['psb'] },
];

function saveFilters() {
  return [...PSD_FILTERS, ...exporters.filter((e) => !e.layered && e.available).map((e) => ({ name: e.label, extensions: [e.extension] }))];
}

function isLayeredFormat(path: string) {
  return /\.(psd|psb)$/i.test(path);
}

/** Shows pre-save notes; resolves false when the user cancels. */
async function confirmPsdNotes(s: DocumentSession, psb: boolean): Promise<boolean> {
  const notes = analyzePsdExport(s.doc, { psb });
  if (!notes.length) return true;
  return new Promise((resolve) => ui.openDialog('saveCompat', { notes, resolve }));
}

async function writeDocument(s: DocumentSession, path: string, asCopy: boolean): Promise<boolean> {
  // Text being typed is committed first, as Photoshop does (an unfinished, empty layer is never saved).
  if (textEditState()?.sessionId === s.id) commitTextEdit();
  const exporter = exporterFor(path);
  if (!exporter) {
    ui.toast('error', 'Unknown file format', path);
    return false;
  }
  const psb = exporter.id === 'psb';
  if (exporter.layered) {
    if (!psb && (s.doc.width > 30000 || s.doc.height > 30000)) {
      ui.toast('error', 'Document exceeds 30,000 px — save as PSB (Large Document Format).');
      return false;
    }
    if (!(await confirmPsdNotes(s, psb))) return false;
  } else if (!asCopy) {
    // Never silently flatten: flat formats are always saved as a copy.
    asCopy = true;
  }
  const p = ui.progress(`Saving ${basename(path)}…`);
  try {
    await new Promise((r) => setTimeout(r, 16));
    const bytes = await exporter.export(s.doc, { maximizeCompatibility: true, psb, selectedLayerIds: s.selectedLayers().map((l) => l.id), onProgress: (f, label) => p.update(f, `Saving ${basename(path)} — ${label}`) });
    await platform().writePath(path, bytes);
    if (!asCopy) {
      s.doc.filePath = path;
      s.doc.fileFormat = exporter.id;
      s.doc.name = basename(path).replace(/\.[^.]+$/, '');
      s.markSaved();
      fileStamps.set(s.id, await statMtime(path));
      await clearRecovery(s);
    }
    if (platform().kind === 'electron') addRecent(path);
    editor.syncSessions();
    ui.toast('success', `Saved ${basename(path)}`, `${(bytes.length / 1024 / 1024).toFixed(2)} MB`, 2500);
    return true;
  } catch (e) {
    ui.toast('error', `Could not save "${basename(path)}"`, errMsg(e), 10000);
    return false;
  } finally {
    p.done();
  }
}

export async function save(s: DocumentSession | null = editor.active): Promise<boolean> {
  if (!s) return false;
  const path = s.doc.filePath;
  if (!path || !isLayeredFormat(path) || !platform().canWriteInPlace) {
    if (path && !isLayeredFormat(path)) ui.toast('info', 'Saving as PSD to keep layers and editability.', `"${basename(path)}" is a flat format; the original file is left unchanged.`);
    return saveAs(s);
  }
  // Prevent accidental overwrite of a file changed by another program.
  const before = fileStamps.get(s.id) ?? 0;
  const now = await statMtime(path);
  if (editor.prefs.general.confirmOverwrite && before && now && Math.abs(now - before) > 1) {
    const r = await platform().confirm(`"${basename(path)}" was changed by another program since it was opened.`, 'Overwrite the file with this document?', ['Overwrite', 'Save As…', 'Cancel']);
    if (r === 1) return saveAs(s);
    if (r !== 0) return false;
  }
  return writeDocument(s, path, false);
}

export async function saveAs(s: DocumentSession | null = editor.active, asCopy = false): Promise<boolean> {
  if (!s) return false;
  const base = s.doc.filePath ? basename(s.doc.filePath).replace(/\.[^.]+$/, '') : s.doc.name;
  const suggestedExt = s.doc.width > 30000 || s.doc.height > 30000 ? 'psb' : 'psd';
  const path = await platform().chooseSavePath(`${base}${asCopy ? ' copy' : ''}.${suggestedExt}`, saveFilters());
  if (!path) return false;
  const exp = exporterFor(path);
  if (exp && !exp.layered) {
    const ok = await platform().confirm(`${exp.label} does not support layers.`, 'A flattened copy will be written; your document stays layered and unchanged.', ['Save Flattened Copy', 'Cancel']);
    if (ok !== 0) return false;
    return writeDocument(s, path, true);
  }
  return writeDocument(s, path, asCopy);
}

export async function saveCopy(s: DocumentSession | null = editor.active): Promise<boolean> {
  return saveAs(s, true);
}

/** Export As: flattened export to a web/raster format with options. */
export async function exportAs(s: DocumentSession | null = editor.active, formatId?: string, opts: import('../formats/registry').ExportOptions = {}): Promise<boolean> {
  if (!s) return false;
  const exp = exporters.find((e) => e.id === (formatId ?? 'png'));
  if (!exp || !exp.available) {
    ui.toast('warning', `${exp?.label ?? formatId} export is not available yet.`, exp?.note);
    return false;
  }
  const path = await platform().chooseSavePath(`${s.doc.name}.${exp.extension}`, [{ name: exp.label, extensions: [exp.extension] }]);
  if (!path) return false;
  const p = ui.progress(`Exporting ${basename(path)}…`);
  try {
    await new Promise((r) => setTimeout(r, 16));
    if (s.doc.canvas.bitDepth > 8 && !exp.supports16) ui.toast('info', `${exp.label} is 8-bit only; the export is converted from ${s.doc.canvas.bitDepth}-bit. Your document keeps its bit depth.`);
    const bytes = await exp.export(s.doc, opts);
    await platform().writePath(path, bytes);
    ui.toast('success', `Exported ${basename(path)}`, undefined, 2500);
    return true;
  } catch (e) {
    ui.toast('error', 'Export failed', errMsg(e));
    return false;
  } finally {
    p.done();
  }
}

// ---------------------------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------------------------
export async function closeSession(s: DocumentSession | null = editor.active, force = false): Promise<boolean> {
  if (!s) return true;
  if (s.modified && !force) {
    editor.activate(s.id);
    const r = await platform().confirm(`Save changes to "${s.doc.name}" before closing?`, 'Your changes will be lost if you don’t save them.', ['Save', 'Don’t Save', 'Cancel']);
    if (r === 2 || r < 0) return false;
    if (r === 0 && !(await save(s))) return false;
  }
  await clearRecovery(s);
  fileStamps.delete(s.id);
  editor.removeSession(s.id);
  return true;
}

export async function closeAll(except?: string): Promise<boolean> {
  for (const s of [...editor.sessions]) {
    if (s.id === except) continue;
    if (!(await closeSession(s))) return false;
  }
  return true;
}

export async function revert(s: DocumentSession | null = editor.active): Promise<void> {
  if (!s?.doc.filePath) return;
  const ok = await platform().confirm(`Revert "${s.doc.name}" to the saved version?`, 'All changes since the last save will be discarded.', ['Revert', 'Cancel']);
  if (ok !== 0) return;
  const path = s.doc.filePath;
  await closeSession(s, true);
  await openPath(path);
}

// ---------------------------------------------------------------------------------------------
// Duplicate / place
// ---------------------------------------------------------------------------------------------
export async function duplicateDocument(s: DocumentSession | null = editor.active): Promise<void> {
  if (!s) return;
  const { exportPsd } = await import('../psd/export');
  const { importPsd } = await import('../psd/import');
  const r = importPsd(exportPsd(s.doc, { maximizeCompatibility: false }), `${s.doc.name} copy.psd`);
  r.doc.filePath = null;
  r.doc.profile = { ...s.doc.profile };
  editor.addDocument(r.doc, 'Duplicate');
}

/** Places a file as an embedded (or linked) smart object. */
export async function placeFile(linked: boolean): Promise<void> {
  const s = editor.active;
  if (!s) return;
  const files = await platform().openFiles(openFilters(), false);
  const f = files[0];
  if (!f) return;
  const ext = (f.name.split('.').pop() ?? '').toLowerCase();
  const src: SmartObjectSource = { id: uuid(), kind: linked && f.path ? 'linked' : 'embedded', name: f.name, fileType: ext === 'jpeg' ? 'jpg' : ext, data: linked ? undefined : f.data, linkedPath: linked ? f.path ?? undefined : undefined };
  try {
    const dec = await decodeSmartSource(src, f.data);
    src.decoded = dec;
    s.doc.smartSources.set(src.id, src);
    // Fit inside the canvas like "Place Embedded".
    const scale = Math.min(1, s.doc.width / dec.width, s.doc.height / dec.height);
    const w = dec.width * scale, h = dec.height * scale;
    const layer = createSmartObjectLayer(f.name.replace(/\.[^.]+$/, ''), src.id, dec.width, dec.height, s.doc.canvas.bitDepth);
    layer.quad = quadFromRect((s.doc.width - w) / 2, (s.doc.height - h) / 2, w, h);
    renderSmartObject(s.doc, layer);
    const parent = s.activeLayer()?.parent ?? s.doc.root;
    const idx = s.activeLayer() ? parent.children.indexOf(s.activeLayer()!) + 1 : parent.children.length;
    s.push(new CreateLayerCommand(linked ? 'Place Linked' : 'Place Embedded', layer, parent.id, idx));
    s.setActive(layer.id);
    if (linked && f.path) platform().bridge?.watchFile(f.path);
  } catch (e) {
    ui.toast('error', `Could not place "${f.name}"`, errMsg(e));
  }
}

// ---------------------------------------------------------------------------------------------
// Recovery (auto-save)
// ---------------------------------------------------------------------------------------------
export async function clearRecovery(s: DocumentSession): Promise<void> {
  await platform().recovery.remove(s.id).catch(() => {});
}

export { newId };
