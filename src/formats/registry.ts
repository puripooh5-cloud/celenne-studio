/**
 * File format registry. Importers produce documents; exporters consume documents.
 * Plugins may register additional formats (see /plugins).
 */
import { imageSpace, rasterFromImage } from './decodedRaster';
import { CelenneDocument } from '../document/document';
import { createPixelLayer } from '../document/layerFactory';
import { TiledRaster } from '../image-engine/tiledRaster';
import type { BitDepth, PixelArray } from '../image-engine/pixels';
import type { ColorMode } from '../document/types';
import { encodeTiffImage } from './tiffWriter';
import { encodeJpegCmyk } from './jpegEncoder';
import { srgbToCmyk } from '../color/plates';
import { hasInkAppearance } from '../rendering/inkView';
import { decodeImageFile, embedJpegICC, encodePNG, encodeWithPlatform } from './codecs';
import { RAW_EXTENSIONS, sniffFormat } from './raster';
import { importPsd, PsdImportOptions } from '../psd/import';
import { exportPsd, PsdExportOptions } from '../psd/export';
import { flattenToPixels, hasTransparency } from '../rendering/flatten';
import { parseIccInfo, matchBuiltin, builtinProfileICC, BUILTIN_PROFILES } from '../color/icc';
import type { CompatibilityIssue } from '../document/types';
import { exportSVG } from './svg';
import { exportPDF } from './pdf';

export interface ImportOutcome {
  doc: CelenneDocument;
  warnings: string[];
  issues: CompatibilityIssue[];
}

export interface Importer {
  id: string;
  label: string;
  extensions: string[];
  available: boolean;
  note?: string;
  accepts(bytes: Uint8Array, name: string): boolean;
  import(bytes: Uint8Array, name: string, opts: PsdImportOptions): Promise<ImportOutcome>;
}

export interface ExportOptions {
  quality?: number;
  /** For JPEG: background matte (0..255). */
  matte?: [number, number, number];
  embedProfile?: boolean;
  psb?: boolean;
  maximizeCompatibility?: boolean;
  /** Export 8-bit even from deep documents (formats that support 16-bit only). */
  force8?: boolean;
  onProgress?: PsdExportOptions['onProgress'];
  /** Selected layers, stored in layered formats so the file reopens with the same selection. */
  selectedLayerIds?: string[];
}

export interface Exporter {
  id: string;
  label: string;
  extension: string;
  available: boolean;
  /** Keeps layers (editable format). */
  layered: boolean;
  supports16: boolean;
  /** Colour modes written natively (others are written as their sRGB appearance). */
  nativeModes?: ColorMode[];
  note?: string;
  export(doc: CelenneDocument, opts: ExportOptions): Promise<Uint8Array>;
}

/** How a document's colour mode is written by `e` (shown in Export As). */
export function exportModeNote(e: Exporter, doc: CelenneDocument): string {
  const mode = doc.canvas.colorMode;
  if (doc.canvas.duotone || mode === 'multichannel') {
    const label = doc.canvas.duotone ? 'Duotone' : 'Multichannel';
    return e.layered ? `Written as ${label}.` : `${e.label.split(' ')[0]} cannot hold ${label} inks, so the copy shows how they print, in sRGB.`;
  }
  if (mode !== 'cmyk' && mode !== 'lab') return '';
  const label = mode === 'cmyk' ? 'CMYK' : 'Lab';
  if (e.nativeModes?.includes(mode)) return `Written as ${label}${mode === 'cmyk' ? ' with the document profile' : ''}.`;
  return `${e.label.split(' ')[0]} cannot hold ${label}, so the copy is converted to sRGB.`;
}

/** The flattened document as stored plates (straight, at `depth`). */
function flatPlates(doc: CelenneDocument, depth: 8 | 16): { width: number; height: number; plates: PixelArray[] } {
  const n = doc.canvas.colorMode === 'cmyk' ? 2 : 1;
  const out: PixelArray[] = [];
  let width = 0, height = 0;
  for (let p = 0; p < n; p++) {
    const f = flattenToPixels(doc, { depth, plate: p });
    out.push(f.data);
    width = f.width; height = f.height;
  }
  return { width, height, plates: out };
}

function cmykIcc(doc: CelenneDocument): Uint8Array {
  return doc.profile.icc ?? builtinProfileICC(doc.profile.builtin && BUILTIN_PROFILES.find((b) => b.id === doc.profile.builtin)?.space === 'CMYK' ? doc.profile.builtin : 'celenneCMYK');
}

/** TIFF in the document's own mode: RGB, Gray, CMYK or CIE Lab, 8 or 16 bits, ICC-tagged. */
function exportTiff(doc: CelenneDocument, o: ExportOptions): Uint8Array {
  const depth: 8 | 16 = o.force8 || doc.canvas.bitDepth === 8 ? 8 : 16;
  const max = depth === 16 ? 65535 : 255;
  const mode = doc.canvas.colorMode;
  const embed = o.embedProfile !== false;
  if (mode === 'cmyk' || mode === 'lab') {
    const { width, height, plates } = flatPlates(doc, depth);
    const n = width * height;
    const p0 = plates[0], p1 = plates[1];
    let alpha = false;
    for (let i = 0; i < n && !alpha; i++) alpha = p0[i * 4 + 3] < max;
    const cc = mode === 'cmyk' ? 4 : 3, spp = cc + (alpha ? 1 : 0);
    const data = depth === 16 ? new Uint16Array(n * spp) : new Uint8Array(n * spp);
    for (let i = 0; i < n; i++) {
      const o2 = i * spp;
      if (mode === 'cmyk') {
        data[o2] = max - p0[i * 4]; data[o2 + 1] = max - p0[i * 4 + 1]; data[o2 + 2] = max - p0[i * 4 + 2]; data[o2 + 3] = max - p1[i * 4];
      } else {
        // CIELab: L 0..max, a / b signed (8-bit: int8; 16-bit: int16 × 256).
        data[o2] = p0[i * 4];
        for (let c = 1; c < 3; c++) {
          const v = (p0[i * 4 + c] / max) * 255 - 128;
          const s = depth === 16 ? Math.round(Math.max(-32768, Math.min(32767, v * 256))) : Math.round(Math.max(-128, Math.min(127, v)));
          data[o2 + c] = s < 0 ? s + (depth === 16 ? 65536 : 256) : s;
        }
      }
      if (alpha) data[o2 + cc] = p0[i * 4 + 3];
    }
    return encodeTiffImage({ width, height, model: mode, depth, data, alpha, icc: embed && mode === 'cmyk' ? cmykIcc(doc) : undefined, resolution: doc.canvas.resolution });
  }
  // Duotone and Multichannel are written as how they print (RGB); TIFF has no Duotone mode.
  const f = flattenToPixels(doc, { depth, inks: true });
  const n = f.width * f.height;
  const px = f.data;
  const gray = mode === 'grayscale' && !doc.canvas.duotone;
  const alpha = hasTransparency(px);
  const cc = gray ? 1 : 3, spp = cc + (alpha ? 1 : 0);
  const data = depth === 16 ? new Uint16Array(n * spp) : new Uint8Array(n * spp);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < cc; c++) data[i * spp + c] = px[i * 4 + c];
    if (alpha) data[i * spp + cc] = px[i * 4 + 3];
  }
  return encodeTiffImage({ width: f.width, height: f.height, model: gray ? 'gray' : 'rgb', depth, data, alpha, icc: embed ? iccFor(doc) : undefined, resolution: doc.canvas.resolution });
}

/** CMYK JPEG (Adobe convention) of a CMYK document; transparent areas show the matte (paper by default). */
function exportCmykJpeg(doc: CelenneDocument, o: ExportOptions): Uint8Array {
  const { width, height, plates } = flatPlates(doc, 8);
  const n = width * height;
  const [p0, p1] = plates;
  const m = o.matte ? srgbToCmyk({ r: o.matte[0] / 255, g: o.matte[1] / 255, b: o.matte[2] / 255 }, doc.profile) : [0, 0, 0, 0];
  const ink = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = p0[i * 4 + 3] / 255;
    ink[i * 4] = Math.round((255 - p0[i * 4]) * a + m[0] * 255 * (1 - a));
    ink[i * 4 + 1] = Math.round((255 - p0[i * 4 + 1]) * a + m[1] * 255 * (1 - a));
    ink[i * 4 + 2] = Math.round((255 - p0[i * 4 + 2]) * a + m[2] * 255 * (1 - a));
    ink[i * 4 + 3] = Math.round((255 - p1[i * 4]) * a + m[3] * 255 * (1 - a));
  }
  let out = encodeJpegCmyk(width, height, ink, Math.round((o.quality ?? 0.92) * 100));
  if (o.embedProfile !== false) out = embedJpegICC(out, cmykIcc(doc));
  return out;
}

export function documentFromImage(name: string, width: number, height: number, depth: BitDepth, data: import('../image-engine/pixels').PixelArray, icc?: Uint8Array, resolution?: number): CelenneDocument {
  const doc = new CelenneDocument(name.replace(/\.[^.]+$/, ''), { width, height, resolution: resolution ?? 72, colorMode: 'rgb', bitDepth: depth });
  const layer = createPixelLayer('Background', depth, TiledRaster.fromPixels(width, height, 4, depth, data));
  doc.insertLayer(layer);
  if (icc) {
    const info = parseIccInfo(icc);
    doc.profile = { name: info?.description ?? 'Embedded profile', icc, builtin: info ? matchBuiltin(info.description) : undefined };
  }
  return doc;
}

const rasterImporter = (id: string, label: string, extensions: string[], formats: string[], available = true, note?: string): Importer => ({
  id,
  label,
  extensions,
  available,
  note,
  accepts: (bytes, name) => formats.includes(sniffFormat(bytes, name) ?? ''),
  async import(bytes, name) {
    const img = await decodeImageFile(bytes, name);
    const issues: CompatibilityIssue[] = [
      ...(img.notes ?? []).map((m): CompatibilityIssue => ({ feature: label, status: 'editable', message: m })),
      ...img.warnings.map((w): CompatibilityIssue => ({ feature: label, status: 'converted', message: w })),
    ];
    const warnings = [...img.warnings];
    let doc: CelenneDocument;
    if (img.native) {
      // CMYK / Lab files open natively, in their own colour space.
      const space = imageSpace(img);
      doc = new CelenneDocument(name.replace(/\.[^.]+$/, ''), { width: img.width, height: img.height, resolution: img.resolution ?? 72, colorMode: space.mode, bitDepth: img.depth });
      doc.profile = space.profile;
      doc.insertLayer(createPixelLayer('Background', img.depth, rasterFromImage(img)));
      if (space.note) { issues.push({ feature: 'ICC profile', status: 'converted', message: space.note }); warnings.push(space.note); }
    } else {
      doc = documentFromImage(name, img.width, img.height, img.depth, img.data, img.icc, img.resolution);
      if (img.colorMode === 'grayscale') doc.canvas.colorMode = 'grayscale';
    }
    doc.fileFormat = id;
    return { doc, warnings, issues };
  },
});

export const importers: Importer[] = [
  {
    id: 'psd',
    label: 'Photoshop (PSD, PSB)',
    extensions: ['psd', 'psb'],
    available: true,
    accepts: (b, n) => ['psd', 'psb'].includes(sniffFormat(b, n) ?? ''),
    async import(bytes, name, opts) {
      const r = importPsd(bytes, name, opts);
      return { doc: r.doc, warnings: r.warnings, issues: r.issues };
    },
  },
  rasterImporter('png', 'PNG', ['png'], ['png']),
  rasterImporter('jpeg', 'JPEG', ['jpg', 'jpeg', 'jpe', 'jfif'], ['jpeg']),
  rasterImporter('tiff', 'TIFF', ['tif', 'tiff'], ['tiff']),
  rasterImporter('bmp', 'BMP', ['bmp'], ['bmp']),
  rasterImporter('gif', 'GIF', ['gif'], ['gif']),
  rasterImporter('webp', 'WebP', ['webp'], ['webp']),
  rasterImporter('avif', 'AVIF', ['avif'], ['avif']),
  rasterImporter('svg', 'SVG (rasterized)', ['svg'], ['svg']),
  rasterImporter('heif', 'HEIF / HEIC', ['heic', 'heif'], ['heif'], true, 'Requires a platform HEIF codec'),
  rasterImporter('raw', 'Camera RAW (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW and more)', RAW_EXTENSIONS, ['raw']),
];

async function flat8(doc: CelenneDocument, force8: boolean) {
  const f = flattenToPixels(doc, { depth: force8 ? 8 : doc.canvas.bitDepth === 32 ? 16 : doc.canvas.bitDepth, inks: true });
  return f;
}

function iccFor(doc: CelenneDocument): Uint8Array | undefined {
  // CMYK and Lab documents flatten to sRGB for RGB image formats (see flattenToPixels).
  if (doc.canvas.colorMode === 'cmyk' || doc.canvas.colorMode === 'lab' || hasInkAppearance(doc)) return builtinProfileICC('srgb');
  return doc.profile.icc ?? (doc.profile.builtin ? builtinProfileICC(doc.profile.builtin) : undefined);
}

export const exporters: Exporter[] = [
  {
    id: 'psd', label: 'Photoshop (*.psd)', extension: 'psd', available: true, layered: true, supports16: true, nativeModes: ['rgb', 'grayscale', 'cmyk', 'lab', 'indexed', 'bitmap'],
    async export(doc, o) { return exportPsd(doc, { psb: false, maximizeCompatibility: o.maximizeCompatibility, onProgress: o.onProgress, selectedLayerIds: o.selectedLayerIds }); },
  },
  {
    id: 'psb', label: 'Large Document Format (*.psb)', extension: 'psb', available: true, layered: true, supports16: true, nativeModes: ['rgb', 'grayscale', 'cmyk', 'lab', 'indexed', 'bitmap'],
    async export(doc, o) { return exportPsd(doc, { psb: true, maximizeCompatibility: o.maximizeCompatibility, onProgress: o.onProgress, selectedLayerIds: o.selectedLayerIds }); },
  },
  {
    id: 'png', label: 'PNG (*.png)', extension: 'png', available: true, layered: false, supports16: true,
    async export(doc, o) {
      const f = await flat8(doc, !!o.force8);
      return encodePNG(f.width, f.height, f.data as Uint8ClampedArray | Uint16Array, f.depth === 16 ? 16 : 8, { icc: o.embedProfile !== false ? iccFor(doc) : undefined, resolution: doc.canvas.resolution });
    },
  },
  {
    id: 'jpeg', label: 'JPEG (*.jpg)', extension: 'jpg', available: true, layered: false, supports16: false, nativeModes: ['rgb', 'cmyk'],
    async export(doc, o) {
      if (doc.canvas.colorMode === 'cmyk') return exportCmykJpeg(doc, o);
      const f = flattenToPixels(doc, { depth: 8, inks: true });
      let out = await encodeWithPlatform(f.width, f.height, f.data as Uint8ClampedArray, 'image/jpeg', o.quality ?? 0.92, o.matte);
      const icc = o.embedProfile !== false ? iccFor(doc) : undefined;
      if (icc) out = embedJpegICC(out, icc);
      return out;
    },
  },
  {
    id: 'webp', label: 'WebP (*.webp)', extension: 'webp', available: true, layered: false, supports16: false,
    async export(doc, o) {
      const f = flattenToPixels(doc, { depth: 8, inks: true });
      return encodeWithPlatform(f.width, f.height, f.data as Uint8ClampedArray, 'image/webp', o.quality ?? 0.9);
    },
  },
  {
    id: 'tiff', label: 'TIFF (*.tif)', extension: 'tif', available: true, layered: false, supports16: true, nativeModes: ['rgb', 'grayscale', 'cmyk', 'lab'], note: 'Flattened; RGB, Gray, CMYK or Lab, 8 or 16 bits, Deflate-compressed.',
    async export(doc, o) { return exportTiff(doc, o); },
  },
  {
    id: 'svg', label: 'SVG (*.svg)', extension: 'svg', available: true, layered: false, supports16: false, note: 'Shape layers as vectors, other layers embedded as images',
    async export(doc) { return exportSVG(doc); },
  },
  {
    id: 'pdf', label: 'PDF (*.pdf)', extension: 'pdf', available: true, layered: false, supports16: false, nativeModes: ['rgb', 'grayscale', 'cmyk', 'lab'], note: 'Flattened image page (ICC-tagged); quality below 100% uses JPEG compression',
    async export(doc, o) { return exportPDF(doc, { quality: o.quality }); },
  },
];

export function findImporter(bytes: Uint8Array, name: string): Importer | undefined {
  return importers.find((i) => i.accepts(bytes, name));
}

export function exporterFor(pathOrExt: string): Exporter | undefined {
  const ext = pathOrExt.toLowerCase().split('.').pop() ?? '';
  return exporters.find((e) => e.extension === ext || (ext === 'jpeg' && e.id === 'jpeg') || (ext === 'tiff' && e.id === 'tiff'));
}

export function openFilters(): { name: string; extensions: string[] }[] {
  const avail = importers.filter((i) => i.available);
  return [
    { name: 'All supported images', extensions: avail.flatMap((i) => i.extensions) },
    ...avail.map((i) => ({ name: i.label, extensions: i.extensions })),
    { name: 'All files', extensions: ['*'] },
  ];
}

export function registerImporter(i: Importer): void {
  const k = importers.findIndex((x) => x.id === i.id);
  if (k >= 0) importers.splice(k, 1);
  importers.splice(importers.length - 1, 0, i);
}

export function registerExporter(e: Exporter): void {
  const i = exporters.findIndex((x) => x.id === e.id);
  if (i >= 0) exporters.splice(i, 1);
  exporters.push(e);
}

/** Removes importers and exporters whose id starts with `prefix` (plugin deactivation). */
export function unregisterFormats(prefix: string): void {
  for (let i = importers.length - 1; i >= 0; i--) if (importers[i].id.startsWith(prefix)) importers.splice(i, 1);
  for (let i = exporters.length - 1; i >= 0; i--) if (exporters[i].id.startsWith(prefix)) exporters.splice(i, 1);
}
