/**
 * PSD / PSB import: file → editable CelenneDocument (never flattened).
 *
 * Pipeline:
 *  1. Container scan (validates structure, captures raw blocks ag-psd does not model,
 *     merged alpha channels, saved paths, ICC profile).
 *  2. Resource-limit checks (malicious/huge files fail with a clear message, never crash).
 *  3. ag-psd parse (layers, masks, text, adjustments, effects, vectors, smart objects).
 *  4. Mapping into the document model + compatibility report.
 */
import { contentCredentialsEnabled, DOC_METADATA_BLOCKS, DOC_METADATA_RESOURCES, generativeAiUsed } from './docMetadata';
import { readCelenneText } from './celenneXmp';
import { runsPerParagraph } from '../typography/types';
import { curvesFromCurv, levelsChannelFromLevl } from './adjustBlocks';
import { CELENNE_CMYK_NAME } from '../color/cmykProfile';
import { colorFromRecord, parseDuotone, type ColorRecord, type DuotoneSpec } from '../color/inks';
import { splitCmykContainer } from './cmyk';
import type { TextPath } from '../typography/pathText';
import { textPathFromPhotoshop } from '../typography/pathText';
import { readPsd } from 'ag-psd';
import { ensureAgPsd } from './agpsdSetup';
import type * as Ag from 'ag-psd';
import { infoHandlersMap } from 'ag-psd/dist/additionalInfo';
import { resourceHandlersMap } from 'ag-psd/dist/imageResources';
import { CelenneDocument } from '../document/document';
import type { AlphaChannel, BlendIf, BlendIfChannel, BlendIfRange, ColorMode, CompatibilityIssue, GroupLayer, Layer, LayerColorTag, SavedPath, ShapeStroke, SliceDef, SmartObjectSource } from '../document/types';
import { DEFAULT_BLEND_IF_RANGE } from '../document/types';
import { hasRaster } from '../document/types';
import {
  createAdjustmentLayer,
  createFillLayer,
  createGroupLayer,
  createPixelLayer,
  createShapeLayer,
  createSmartObjectLayer,
  createTextLayer,
  defaultStroke,
} from '../document/layerFactory';
import { newId } from '../document/ids';
import { TiledRaster } from '../image-engine/tiledRaster';
import type { BitDepth, PixelArray } from '../image-engine/pixels';
import { decodeMergedChannels, findResource, parseContainer, PsdContainer, serializeContainer } from './container';
import { applyTxt2Styles, parseTxt2, txt2Texts, type Txt2Text } from './txt2';
import { photoshopBreaks } from '../typography/engine/layout';
import type { CmykConverter } from './cmyk';
import { PsdFormatError } from './binary';
import { adjustmentFromPsd, blendFromPsd, colorFromPsd, effectsFromPsd, gradientFromPsd, gradientMapLocations, paintFromPsd, pathFromPsd, textFromPsd, unitPx } from './mapping';
import { parsePathRecords } from './paths';
import { parseIccInfo, matchBuiltin } from '../color/icc';
import type { ShapeOrigin } from '../vector/types';
import { parseCubeLUT } from '../adjustments/apply';
import { renderShapeLayer } from '../layers/appearance';
import { pathBounds } from '../vector/rasterize';
import { presetGrid, WARP_STYLES, WarpStyle } from '../image-engine/warp';
import type { Point } from '../image-engine/matrix';

export interface PsdImportOptions {
  /** Returns true when a font (by PostScript name / family) is installed. */
  fontAvailable?: (postScriptName: string, family: string) => boolean;
  /** Maximum decoded pixel memory in bytes (default 6 GB). */
  memoryLimit?: number;
  /** CMYK → RGB converter factory (given the embedded CMYK profile). Defaults to LittleCMS when loaded. */
  cmykConverter?: (icc: Uint8Array | undefined) => CmykConverter | null;
}

export interface PsdImportResult {
  doc: CelenneDocument;
  warnings: string[];
  issues: CompatibilityIssue[];
}

const COLOR_MODES: Record<number, ColorMode> = { 0: 'bitmap', 1: 'grayscale', 2: 'indexed', 3: 'rgb', 4: 'cmyk', 7: 'multichannel', 8: 'duotone', 9: 'lab' };
const PATH_RESOURCE_MIN = 2000, PATH_RESOURCE_MAX = 2997, WORK_PATH = 1025, CLIPPING_PATH_NAME = 2999;
/** Resources Celenne models itself (not blindly preserved). */
const OWNED_RESOURCES = new Set([1039, 1006, 1045, 1053, 1066, 1077, 1046, 1047, WORK_PATH, CLIPPING_PATH_NAME]);

type FlatEntry = { layer: Ag.Layer; divider: boolean };

function flattenRecords(children: Ag.Layer[]): FlatEntry[] {
  const out: FlatEntry[] = [];
  for (const c of children) {
    if (c.children) {
      out.push({ layer: c, divider: true });
      out.push(...flattenRecords(c.children));
      out.push({ layer: c, divider: false });
    } else out.push({ layer: c, divider: false });
  }
  return out;
}

function stripBitmaps(l: Ag.Layer | Ag.Psd): Record<string, unknown> {
  const { children: _c, canvas: _cv, imageData: _id, rawData: _rd, ...rest } = l as Ag.Layer & { rawData?: unknown };
  const out: Record<string, unknown> = { ...rest };
  if ((l as Ag.Layer).mask) {
    const { imageData: _m, canvas: _mc, ...m } = (l as Ag.Layer).mask!;
    out.mask = m;
  }
  if ((l as Ag.Layer).realMask) {
    const { imageData: _m, canvas: _mc, ...m } = (l as Ag.Layer).realMask!;
    out.realMask = m;
  }
  return out;
}

function toDepthArray(data: Ag.PixelArray, depth: BitDepth): PixelArray {
  if (depth === 8) return data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  return data as PixelArray;
}

function rasterFromImageData(img: Ag.PixelData | undefined, depth: BitDepth): TiledRaster {
  if (!img || !img.width || !img.height) return new TiledRaster(4, depth);
  return TiledRaster.fromPixels(img.width, img.height, 4, depth, toDepthArray(img.data, depth));
}

function maskRasterFromImageData(img: Ag.PixelData | undefined, depth: BitDepth, defaultColor: number, left: number, top: number): TiledRaster {
  const fill = defaultColor / 255;
  const r = new TiledRaster(1, 8, fill);
  if (!img || !img.width || !img.height) return r;
  const n = img.width * img.height;
  const d = new Uint8ClampedArray(n);
  const src = img.data;
  const k = depth === 8 ? 1 : depth === 16 ? 255 / 65535 : 255;
  for (let i = 0; i < n; i++) d[i] = src[i * 4] * k;
  r.writePixels({ x: left, y: top, w: img.width, h: img.height }, d);
  r.compact();
  return r;
}

function hasNonDefaultBlendIf(l: Ag.Layer): boolean {
  const br = l.blendingRanges;
  if (!br) return false;
  const def = (a: number[]) => a.length >= 4 && a[0] === 0 && a[1] === 0 && a[2] === 255 && a[3] === 255;
  if (!def(br.compositeGrayBlendSource) || !def(br.compositeGraphBlendDestinationRange)) return true;
  return br.ranges.some((r) => !def(r.sourceRange) || !def(r.destRange));
}

function shapeOriginFromPsd(l: Ag.Layer): ShapeOrigin | null {
  const k = l.vectorOrigination?.keyDescriptorList?.[0];
  const bb = k?.keyOriginShapeBoundingBox;
  if (!k || !bb) return null;
  const x = unitPx(bb.left), y = unitPx(bb.top), w = unitPx(bb.right) - x, h = unitPx(bb.bottom) - y;
  switch (k.keyOriginType) {
    case 1: return { kind: 'rectangle', x, y, w, h };
    case 2: {
      const r = k.keyOriginRRectRadii;
      return { kind: 'roundedRectangle', x, y, w, h, radii: r ? [unitPx(r.topLeft), unitPx(r.topRight), unitPx(r.bottomRight), unitPx(r.bottomLeft)] : [8, 8, 8, 8] };
    }
    case 4: return { kind: 'line', x, y, w, h };
    case 5: return { kind: 'ellipse', x, y, w, h };
    default: return { kind: 'custom', x, y, w, h };
  }
}

function strokeFromPsd(s: Ag.LayerAdditionalInfo['vectorStroke']): ShapeStroke {
  const st = defaultStroke();
  if (!s) return st;
  st.enabled = s.strokeEnabled !== false && !!s.content;
  st.paint = paintFromPsd(s.content);
  st.width = unitPx(s.lineWidth, 3);
  st.alignment = s.lineAlignment ?? 'center';
  st.cap = s.lineCapType ?? 'butt';
  st.join = s.lineJoinType ?? 'miter';
  st.miterLimit = s.miterLimit ?? 100;
  st.dash = (s.lineDashSet ?? []).map((d) => unitPx(d));
  st.dashOffset = unitPx(s.lineDashOffset, 0);
  st.opacity = s.opacity ?? 1;
  return st;
}

const LAYER_COLORS: LayerColorTag[] = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray'];

export function importPsd(bytes: Uint8Array, fileName: string, opts: PsdImportOptions = {}): PsdImportResult {
  const warnings: string[] = [];
  const issues: CompatibilityIssue[] = [];
  const issue = (feature: string, status: CompatibilityIssue['status'], message: string, layer?: Layer) => issues.push({ feature, status, message, layerId: layer?.id, layerName: layer?.name });

  // 1. Container scan -------------------------------------------------------------------------
  let container: PsdContainer;
  try {
    container = parseContainer(bytes);
  } catch (e) {
    throw new PsdFormatError(`This file is not a valid Photoshop document or is damaged: ${(e as Error).message}`);
  }
  // Photoshop's document-level text data (settings EngineData does not hold, e.g. the kerning mode).
  let txt2: Txt2Text[] | null = null;
  const txt2For = (index: number | undefined): Txt2Text | undefined => {
    if (txt2 === null) {
      txt2 = [];
      const blk = container.globalBlocks.find((b) => b.key === 'Txt2');
      if (blk) try { txt2 = txt2Texts(parseTxt2(blk.data)); } catch { /* unreadable: EngineData only */ }
    }
    return index === undefined ? undefined : txt2[index];
  };
  const depth = (container.depth === 1 ? 8 : container.depth) as BitDepth;
  const originalMode = COLOR_MODES[container.colorMode] ?? 'rgb';
  const originalIcc = findResource(container, 1039)?.data;
  // Native CMYK / Lab. ag-psd reads RGB-shaped data only, so CMYK is split into a C'M'Y' and a
  // K'K'K' container (plates 0 and 1), and Lab (whose channel encoding is Celenne's) is relabelled.
  let kBytes: Uint8Array | null = null;
  let kContainer: PsdContainer | null = null;
  if (container.colorMode === 4) {
    const split = splitCmykContainer(container);
    container = split.cmy;
    kContainer = split.k;
    bytes = serializeContainer(container);
    kBytes = serializeContainer(kContainer);
  } else if (container.colorMode === 9) {
    container = { ...container, colorMode: 3, resources: container.resources.filter((r) => r.id !== 1039) };
    bytes = serializeContainer(container);
  }
  // Duotone: Grayscale data plus an ink specification (colour-mode data). Multichannel: every
  // channel is an ink, no layers. Both are read as Grayscale by ag-psd and completed below.
  let duotone: DuotoneSpec | null = null;
  const multichannel = container.colorMode === 7;
  if (container.colorMode === 8) {
    duotone = parseDuotone(container.colorModeData, findResource(container, 1066)?.data);
    container = { ...container, colorMode: 1, colorModeData: new Uint8Array(0) };
    bytes = serializeContainer(container);
  } else if (multichannel) {
    container = { ...container, colorMode: 1, colorModeData: new Uint8Array(0) };
    bytes = serializeContainer(container);
  }

  // 2. Resource limits ------------------------------------------------------------------------
  const bps = depth / 8;
  let estimate = container.width * container.height * 4 * bps;
  for (const l of container.layers) estimate += Math.max(0, l.right - l.left) * Math.max(0, l.bottom - l.top) * 4 * bps;
  const limit = opts.memoryLimit ?? 6 * 1024 ** 3;
  if (estimate > limit) {
    throw new PsdFormatError(`This document needs about ${(estimate / 1024 ** 3).toFixed(1)} GB of memory to open, which exceeds the configured limit of ${(limit / 1024 ** 3).toFixed(1)} GB (Preferences › Performance).`);
  }

  // 3. High-level parse -------------------------------------------------------------------------
  ensureAgPsd();
  let psd: Ag.Psd;
  // The composite is only needed for flat 8-bit files; deep or layered composites are decoded by
  // the container reader when required (ag-psd cannot read deep composites with transparency).
  const skipComposite = container.layers.length > 0 || depth > 8;
  const baseOpts: Ag.ReadOptions = { useImageData: true, useRawThumbnail: true, skipThumbnail: true, skipCompositeImageData: skipComposite, logMissingFeatures: false, throwForMissingFeatures: false, totalMemoryLimit: limit };
  try {
    psd = readPsd(bytes, baseOpts);
  } catch (e) {
    warnings.push(`Layer data could not be fully decoded (${(e as Error).message}); retrying with the composite image only.`);
    try {
      psd = readPsd(bytes, { ...baseOpts, skipLayerImageData: true });
      issue('Layer pixels', 'dropped', 'Layer pixel data was damaged and could not be read; layer structure was kept.');
    } catch (e2) {
      throw new PsdFormatError(`Photoshop document could not be read: ${(e2 as Error).message}`);
    }
  }

  const res = psd.imageResources?.resolutionInfo;
  const resolution = res ? (res.horizontalResolutionUnit === 'PPCM' ? res.horizontalResolution * 2.54 : res.horizontalResolution) : 72;
  const docMode: ColorMode = originalMode === 'grayscale' || originalMode === 'duotone' || originalMode === 'multichannel' ? 'grayscale' : originalMode === 'cmyk' ? 'cmyk' : originalMode === 'lab' ? 'lab' : 'rgb';
  const doc = new CelenneDocument(fileName.replace(/\.(psd|psb)$/i, ''), { width: psd.width, height: psd.height, resolution: Math.round(resolution * 100) / 100 || 72, colorMode: docMode, bitDepth: depth });
  doc.fileFormat = container.version === 2 ? 'psb' : 'psd';
  doc.psd = { originalColorMode: originalMode, originalBitDepth: container.depth, isPsb: container.version === 2, source: stripBitmaps(psd) };
  if (originalMode === 'cmyk') {
    issue('Color mode', 'editable', 'CMYK document: edited natively (C, M, Y and K channels and values are kept) and saved as CMYK.');
  } else if (originalMode === 'lab') {
    issue('Color mode', 'editable', 'Lab document: edited natively (L, a and b are kept) and saved as Lab.');
  } else if (originalMode === 'duotone') {
    if (duotone) issue('Color mode', 'editable', `Duotone document (${duotone.inks.map((i) => i.name).join(', ')}): the Grayscale data is edited natively, the inks and curves are editable (Image ▸ Mode ▸ Duotone) and the file is saved as Duotone.`);
    else {
      issue('Color mode', 'converted', 'The duotone ink specification could not be read; the document opened as Grayscale.');
      warnings.push('The duotone ink specification could not be read; the document opened as Grayscale.');
    }
  } else if (originalMode === 'multichannel') {
    issue('Color mode', 'editable', 'Multichannel document: every channel is an ink, edited natively (select a channel to paint on it) and saved as Multichannel.');
  } else if (!['rgb', 'grayscale', 'indexed', 'bitmap'].includes(originalMode)) {
    issue('Color mode', 'converted', `${originalMode.toUpperCase()} document was converted to RGB for editing. Saving writes an RGB document (original mode recorded).`);
    warnings.push(`${originalMode.toUpperCase()} color mode is not editable natively; the document was converted to RGB.`);
  }
  if (container.depth === 1) issue('Bit depth', 'converted', '1-bit Bitmap data was expanded to 8-bit grayscale.');
  if (depth > 8) issue(`${depth}-bit color`, 'editable', `${depth}-bit data is kept at full precision.`);

  // Profile
  const icc = findResource(container, 1039)?.data;
  const originalInfo = originalMode === 'cmyk' && originalIcc ? parseIccInfo(originalIcc) : null;
  if (originalMode === 'cmyk') {
    if (originalInfo?.colorSpace === 'CMYK') doc.profile = { name: originalInfo.description || 'Embedded CMYK profile', icc: originalIcc!.slice() };
    else {
      doc.profile = { name: CELENNE_CMYK_NAME, builtin: 'celenneCMYK' };
      issue('ICC profile', 'converted', `The CMYK document has no embedded profile; it is displayed with ${CELENNE_CMYK_NAME}. Assign your press profile with Edit ▸ Assign Profile.`);
    }
  } else if (originalMode === 'lab') {
    doc.profile = { name: 'Lab Color (D50)', builtin: 'labD50' };
  } else if (icc && icc.length > 128 && parseIccInfo(icc)?.colorSpace !== 'CMYK') {
    const info = parseIccInfo(icc);
    doc.profile = { name: info?.description ?? 'Embedded profile', icc: icc.slice(), builtin: info ? matchBuiltin(info.description) : undefined };
  } else if (psd.imageResources?.iccUntaggedProfile) {
    doc.profile = { name: 'Untagged (working sRGB)', builtin: 'srgb', untagged: true };
  }

  // Guides / grid
  const gg = psd.imageResources?.gridAndGuidesInformation;
  if (gg?.guides) doc.guides = gg.guides.map((g) => ({ id: newId('guide'), orientation: g.direction === 'horizontal' ? 'horizontal' : 'vertical', position: g.location }));
  if (gg?.grid?.horizontal) doc.grid.spacing = Math.max(1, gg.grid.horizontal);
  const unit = res?.widthUnit;
  doc.rulerUnit = unit === 'Centimeters' ? 'cm' : unit === 'Inches' ? 'in' : unit === 'Points' ? 'pt' : unit === 'Picas' ? 'pica' : 'px';
  if (psd.imageResources?.globalAngle !== undefined) doc.globalLight.angle = psd.imageResources.globalAngle;
  if (psd.imageResources?.globalAltitude !== undefined) doc.globalLight.altitude = psd.imageResources.globalAltitude;

  // Metadata
  doc.metadata = {
    xmp: psd.imageResources?.xmpMetadata,
    copyrighted: psd.imageResources?.copyrighted,
    url: psd.imageResources?.url,
    description: psd.imageResources?.captionDigest,
  };
  const xmp = doc.metadata.xmp;
  if (xmp) {
    const m = (tag: string) => xmp.match(new RegExp(`<${tag}>\\s*<rdf:Alt>\\s*<rdf:li[^>]*>([^<]*)</rdf:li>`))?.[1];
    doc.metadata.title = m('dc:title');
    doc.metadata.description = doc.metadata.description ?? m('dc:description');
    doc.metadata.copyright = m('dc:rights');
    doc.metadata.author = xmp.match(/<dc:creator>\s*<rdf:Seq>\s*<rdf:li>([^<]*)<\/rdf:li>/)?.[1];
  }

  // Linked files (smart object sources)
  for (const lf of psd.linkedFiles ?? []) {
    const { data, ...rest } = lf;
    const src: SmartObjectSource = {
      id: lf.id,
      kind: lf.linkedFile || !data ? 'linked' : 'embedded',
      name: lf.name,
      fileType: (lf.type ?? lf.name.split('.').pop() ?? '').trim().toLowerCase().replace(/^8b/, ''),
      data,
      linkedPath: lf.linkedFile?.fullPath,
      preserved: rest,
    };
    doc.smartSources.set(lf.id, src);
  }

  // Patterns
  const patterns = (psd as Ag.Psd & { patterns?: Ag.PatternInfo[] }).patterns;
  for (const p of patterns ?? []) {
    try {
      const w = p.bounds.w, h = p.bounds.h;
      const n = w * h;
      const ch = p.data.length >= n * 4 ? 4 : 3;
      const d = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i++) {
        d[i * 4] = p.data[i * ch]; d[i * 4 + 1] = p.data[i * ch + 1]; d[i * 4 + 2] = p.data[i * ch + 2]; d[i * 4 + 3] = ch === 4 ? p.data[i * 4 + 3] : 255;
      }
      doc.patterns.set(p.id, { id: p.id, name: p.name, width: w, height: h, raster: TiledRaster.fromPixels(w, h, 4, 8, d), preserved: { name: p.name, id: p.id } });
    } catch {
      issue('Pattern', 'preserved', `Pattern "${p.name}" could not be decoded for rendering.`);
    }
  }

  // 4. Layers ----------------------------------------------------------------------------------
  const flat = flattenRecords(psd.children ?? []);
  const recordBlocks = new Map<Ag.Layer, { key: string; data: Uint8Array }[]>();
  // Channel blending restrictions read from the raw 'brst' block (ag-psd drops the last entry).
  const restrictionsFor = new Map<Ag.Layer, number[]>();
  // Knockout setting from the raw 'knko' block (0 none, 1 shallow, 2 deep; ag-psd reads a boolean).
  const knockoutFor = new Map<Ag.Layer, number>();
  // Raw Levels / Curves blocks (CMYK documents read the Black channel from them).
  const adjBlocks = new Map<Ag.Layer, { key: string; data: Uint8Array }>();
  // Celenne's own type-on-a-path data (private 'lmTP' block, JSON).
  const textPathFor = new Map<Ag.Layer, TextPath>();
  if (flat.length === container.layers.length) {
    flat.forEach((f, i) => {
      if (f.divider) return;
      const lmtp = container.layers[i].blocks.find((b) => b.key === 'lmTP');
      if (lmtp) {
        const tp = textPathFromBlock(lmtp.data);
        if (tp) textPathFor.set(f.layer, tp);
      }
      const adjBlock = container.layers[i].blocks.find((b) => b.key === 'levl' || b.key === 'curv' || b.key === 'grdm');
      if (adjBlock) adjBlocks.set(f.layer, adjBlock);
      const knko = container.layers[i].blocks.find((b) => b.key === 'knko');
      if (knko?.data.length) knockoutFor.set(f.layer, knko.data[0]);
      const brst = container.layers[i].blocks.find((b) => b.key === 'brst');
      if (brst) {
        const dv = new DataView(brst.data.buffer, brst.data.byteOffset, brst.data.byteLength);
        const ids: number[] = [];
        for (let o = 0; o + 4 <= brst.data.length; o += 4) ids.push(dv.getInt32(o));
        restrictionsFor.set(f.layer, ids);
      }
      const unknown = container.layers[i].blocks.filter((b) => b.key !== 'lmTP' && !(infoHandlersMap as Record<string, unknown>)[b.key]).map((b) => ({ key: b.key, data: b.data.slice() }));
      if (unknown.length) recordBlocks.set(f.layer, unknown);
    });
  } else if (container.layers.length) {
    warnings.push('Layer record order could not be matched exactly; unknown per-layer data may not be preserved.');
  }

  const fontOk = opts.fontAvailable ?? (() => true);
  const agOf = new Map<Layer, Ag.Layer>();

  const convert = (a: Ag.Layer): Layer => {
    let layer: Layer;
    const left = a.left ?? 0, top = a.top ?? 0;
    if (a.children) {
      const g = createGroupLayer(a.name ?? 'Group');
      g.expanded = a.opened !== false;
      for (const c of a.children) {
        const cl = convert(c);
        cl.parent = g;
        g.children.push(cl);
      }
      layer = g;
    } else if (a.adjustment) {
      const grdm = adjBlocks.get(a);
      const { adjustment, partial } = adjustmentFromPsd(a.adjustment, grdm?.key === 'grdm' ? gradientMapLocations(grdm.data) ?? undefined : undefined);
      if (adjustment.type === 'colorLookup' && a.adjustment.type === 'color lookup' && a.adjustment.lut3DFileData && (a.adjustment.lutFormat ?? 'cube') === 'cube') {
        try {
          adjustment.lut = parseCubeLUT(new TextDecoder().decode(a.adjustment.lut3DFileData));
        } catch {
          /* keep preserved */
        }
      }
      layer = createAdjustmentLayer(adjustment, a.name);
      if (partial) issue(layer.name, 'partial', partial, layer);
    } else if (a.text) {
      const t = createTextLayer(a.text.text ?? '', depth, 0, 0);
      t.name = a.name ?? t.name;
      t.text = textFromPsd(a.text);
      const t2 = txt2For(a.text.index);
      if (t2) {
        applyTxt2Styles(t.text, t2);
        t.text.firstBaseline = t2.firstBaseline;
        // Photoshop's own line breaks, kept while a paragraph is unchanged.
        t.text.psBreaks = photoshopBreaks(t.text, t2.lines);
      }
      t.raster = rasterFromImageData(a.imageData, depth);
      t.usingPreservedPixels = true;
      const missing = new Set<string>();
      for (const run of t.text.runs) {
        if (!fontOk(run.style.postScriptName ?? '', run.style.fontFamily)) missing.add(run.style.postScriptName ?? run.style.fontFamily);
      }
      t.missingFonts = [...missing];
      layer = t;
      if (t.missingFonts.length) issue('Missing font', 'partial', `Font not installed: ${t.missingFonts.join(', ')}. The layer shows Photoshop's rendering; editing will substitute a font.`, layer);
      if (t.text.warp) issue('Warped text', 'partial', "Text warp is shown from Photoshop's stored rendering and is editable (Type ▸ Warp Text…). After an edit Celenne re-renders the warp with its own curves, which approximate Photoshop's.", layer);
      if (t.text.orientation === 'vertical') issue('Vertical text', 'editable', "Vertical text is editable. After an edit Celenne lays it out as Photoshop does (upright characters, columns from right to left).", layer);
      const celennePath = textPathFor.get(a);
      if (celennePath) t.text.path = celennePath;
      else if (isRealTextPath(a.text.textPath)) {
        const tpd = a.text.textPath as { bezierCurve?: { controlPoints?: unknown }; data?: { textRange?: unknown; pathData?: { reversed?: unknown } } };
        const tp = textPathFromPhotoshop(tpd.bezierCurve?.controlPoints, tpd.data?.textRange, tpd.data?.pathData?.reversed);
        if (tp) {
          t.text.path = tp;
          issue('Text on path', 'editable', "Text on a path: the path, start / end markers and flip are read from the file. Photoshop's rendering is shown until you edit the text; Celenne then lays the glyphs out along the same path (spacing can differ slightly from Photoshop's composer).", layer);
        } else {
          t.psdPathText = true;
          issue('Text on path', 'rendered', "Text on a path whose path data could not be read: the stored rendering is shown and preserved. Editing the text lays it out as point text.", layer);
        }
      }
    } else if (a.placedLayer) {
      const p = a.placedLayer;
      const src = doc.smartSources.get(p.id);
      const w = p.width ?? Math.max(1, (a.right ?? 0) - left), h = p.height ?? Math.max(1, (a.bottom ?? 0) - top);
      const so = createSmartObjectLayer(a.name ?? src?.name ?? 'Smart Object', p.id, w, h, depth);
      const t = p.transform;
      if (t && t.length >= 8) so.quad = [{ x: t[0], y: t[1] }, { x: t[2], y: t[3] }, { x: t[4], y: t[5] }, { x: t[6], y: t[7] }];
      so.raster = rasterFromImageData(a.imageData, depth);
      so.usingPreservedPixels = true;
      layer = so;
      if (p.filter?.list?.length) {
        so.metadata.unsupported.push('Smart filters');
        issue('Smart filters', 'preserved', `${p.filter.list.length} Photoshop smart filter(s) preserved and displayed from the stored rendering.`, layer);
      }
      const warp = smartWarpFromPsd(p.warp, w, h);
      if (warp) {
        so.warp = warp;
        issue('Smart object warp', 'partial', "The warp is editable (Edit ▸ Transform ▸ Warp). Photoshop's stored rendering is shown until the smart object is edited; Celenne's re-rendering of preset warp styles approximates Photoshop's.", layer);
      }
      if (!src) issue('Smart object', 'partial', 'Smart object source data is missing from the file; the stored rendering is displayed.', layer);
      else if (src.kind === 'linked') issue('Linked smart object', 'partial', `Linked file "${src.name}" — relink to edit contents.`, layer);
    } else if (a.vectorFill && (!a.vectorMask?.paths?.length || (!a.vectorStroke && !a.vectorOrigination))) {
      // Fill layer (possibly with a vector mask). Shape layers carry stroke / live-shape data.
      const v = a.vectorFill;
      if (v.type === 'color') layer = createFillLayer({ type: 'solid', color: colorFromPsd(v.color) }, a.name);
      else if (v.type === 'pattern') layer = createFillLayer({ type: 'pattern', patternId: v.id, scale: 100, phaseX: v.phase?.x ?? 0, phaseY: v.phase?.y ?? 0 }, a.name);
      else {
        const g = v as Ag.EffectSolidGradient & Ag.ExtraGradientInfo;
        // Photoshop leaves Angl out of the descriptor when the angle is 0°.
        layer = createFillLayer({ type: 'gradient', gradient: gradientFromPsd(g, g.interpolationMethod), style: (g.style ?? 'linear') as never, angle: g.angle ?? 0, scale: (g.scale ?? 1) * 100, reverse: !!g.reverse, dither: !!g.dither, alignWithLayer: g.align ?? true, offsetX: g.offset?.x ?? 0, offsetY: g.offset?.y ?? 0 }, a.name);
      }
    } else if (a.vectorFill || (a.vectorMask && a.vectorStroke)) {
      const s = createShapeLayer(a.name ?? 'Shape', pathFromPsd(a.vectorMask?.paths ?? []), shapeOriginFromPsd(a), depth);
      s.fill = a.vectorStroke?.fillEnabled === false ? { type: 'none' } : paintFromPsd(a.vectorFill);
      s.stroke = strokeFromPsd(a.vectorStroke);
      s.raster = rasterFromImageData(a.imageData, depth);
      s.usingPreservedPixels = true;
      layer = s;
    } else {
      layer = createPixelLayer(a.name ?? 'Layer', depth, rasterFromImageData(a.imageData, depth));
      if (a.pixelSource) {
        layer.metadata.unsupported.push('Video');
        issue('Video layer', 'preserved', 'Video layer frames are preserved; the current frame is shown. [Video editing: Coming Soon]', layer);
      }
    }

    // Common properties.
    layer.name = a.name ?? layer.name;
    layer.visible = !a.hidden;
    layer.opacity = a.opacity ?? 1;
    layer.fillOpacity = a.fillOpacity ?? 1;
    layer.blendMode = blendFromPsd(a.blendMode, layer.kind === 'group' ? 'passThrough' : 'normal');
    layer.clipping = !!a.clipping;
    if (hasRaster(layer)) {
      // Layer pixels are stored at (0,0) locally and positioned by the layer offset.
      layer.x = left;
      layer.y = top;
    }
    layer.locks = {
      transparency: !!a.protected?.transparency || !!a.transparencyProtected,
      pixels: !!a.protected?.composite,
      position: !!a.protected?.position,
      artboard: !!a.protected?.artboards,
      all: !!(a.protected?.transparency && a.protected?.composite && a.protected?.position),
    };
    if (a.layerColor) layer.colorTag = LAYER_COLORS.includes(a.layerColor) ? a.layerColor : 'none';
    layer.advanced.blendClippedAsGroup = a.blendClippendElements ?? true;
    layer.advanced.blendInteriorAsGroup = a.blendInteriorElements ?? false;
    const ko = knockoutFor.get(a) ?? (a.knockout ? 1 : 0);
    layer.advanced.knockout = ko === 2 ? 'deep' : ko ? 'shallow' : 'none';
    layer.advanced.transparencyShapesLayer = a.transparencyShapesLayer ?? true;
    if (a.mask && (a.mask.imageData || a.mask.defaultColor !== undefined) && !a.mask.fromVectorData) {
      const m = a.mask;
      layer.mask = {
        raster: maskRasterFromImageData(m.imageData, depth, m.defaultColor ?? 0, m.left ?? 0, m.top ?? 0),
        // Mask pixels are stored in document coordinates (offset 0).
        x: 0,
        y: 0,
        enabled: !m.disabled,
        linked: true,
        density: m.userMaskDensity ?? 1,
        feather: m.userMaskFeather ?? 0,
      };
    }
    if (a.vectorMask && layer.kind !== 'shape' && a.vectorMask.paths?.length) {
      // Vector masks on non-shape layers (including fill layers).
      layer.vectorMask = { path: pathFromPsd(a.vectorMask.paths), enabled: !a.vectorMask.disable, invert: !!a.vectorMask.invert, linked: !a.vectorMask.notLink, density: a.mask?.vectorMaskDensity ?? 1, feather: a.mask?.vectorMaskFeather ?? 0 };
    }
    if (a.effects) layer.effects = effectsFromPsd(a.effects, resolution);
    if (a.effects?.patternOverlay && !doc.patterns.has(a.effects.patternOverlay.pattern?.id ?? '')) issue('Pattern overlay', 'partial', 'Pattern data is not embedded in a readable form; the effect is preserved but not rendered.', layer);
    const contours = [...(a.effects?.dropShadow ?? []), ...(a.effects?.innerShadow ?? [])].some((s) => !isLinearContour(s.contour));
    if (contours) issue('Effect contours', 'partial', "Custom effect contours are rendered with Celenne's curve interpolation, which can differ slightly from Photoshop's.", layer);
    if (hasNonDefaultBlendIf(a)) layer.advanced.blendIf = blendIfFromPsd(a.blendingRanges!);
    const restricted = restrictionsFor.get(a) ?? a.channelBlendingRestrictions;
    if (restricted?.length) {
      const off = new Set(restricted);
      layer.advanced.channels = [!off.has(0), !off.has(1), !off.has(2)];
    }
    if (a.artboard) {
      layer.metadata.unsupported.push('Artboard');
      issue('Artboard', 'preserved', 'Artboard settings are preserved; the artboard is edited as a group.', layer);
    }
    if (a.filterEffectsMasks?.length) issue('Smart filter masks', 'preserved', 'Filter effect masks are preserved.', layer);
    if (a.timeline || a.animationFrames?.length) issue('Timeline / animation', 'preserved', 'Timeline and animation data are preserved. [Animation editing: Coming Soon]', layer);
    const raw = recordBlocks.get(a);
    if (raw?.length) {
      layer.metadata.unsupported.push(`Unparsed data: ${raw.map((b) => b.key).join(', ')}`);
      issue('Additional layer data', 'preserved', `Photoshop data blocks ${raw.map((b) => `"${b.key}"`).join(', ')} are preserved byte-for-byte.`, layer);
    }
    layer.metadata.psd = { source: stripBitmaps(a), rawBlocks: raw, psdId: a.id, ...(layer.kind === 'text' ? { textAtOpen: JSON.stringify(layer.text) } : {}) };
    agOf.set(layer, a);
    return layer;
  };

  for (const c of psd.children ?? []) {
    const l = convert(c);
    doc.insertLayer(l, doc.root);
  }

  // Flat PSD (no layer records): the composite becomes the Background layer.
  let psdK: Ag.Psd | null = null;
  if (kBytes && kContainer) {
    try {
      psdK = readPsd(kBytes, baseOpts);
    } catch (e) {
      warnings.push(`The black (K) channel could not be read (${(e as Error).message}); it is shown as empty.`);
    }
  }
  if (!psd.children?.length) {
    // Celenne decodes Gray / RGB-shaped composites itself: ag-psd takes the first extra channel as
    // transparency even when it is an alpha or spot channel.
    const nNames = psd.imageResources?.alphaChannelNames?.length ?? 0;
    const composite = decodeFlatComposite(container, depth, nNames) ?? psd.imageData;
    const bg = createPixelLayer('Background', depth, rasterFromImageData(composite, depth));
    if (kContainer) {
      const kComposite = decodeFlatComposite(kContainer, depth, nNames) ?? psdK?.imageData;
      if (kComposite) bg.raster.companion = rasterFromImageData(kComposite, depth);
    }
    bg.locks.position = false;
    doc.insertLayer(bg, doc.root);
    if (!composite) warnings.push('The document contains no layer or composite image data.');
  }
  // CMYK: Levels / Curves Black channel (index 4), which ag-psd does not read.
  if (originalMode === 'cmyk') {
    for (const [l, ag] of agOf) {
      if (l.kind !== 'adjustment') continue;
      const blk = adjBlocks.get(ag);
      if (!blk) continue;
      if (l.adjustment.type === 'levels' && blk.key === 'levl') {
        const k = levelsChannelFromLevl(blk.data, 4);
        if (k) l.adjustment = { ...l.adjustment, black: k };
      } else if (l.adjustment.type === 'curves' && blk.key === 'curv') {
        const k = curvesFromCurv(blk.data).get(4);
        if (k?.length) l.adjustment = { ...l.adjustment, black: k };
      }
    }
  }
  // CMYK: every layer's K plate from the second container (same record order).
  if (psdK?.children?.length) {
    const a = flattenRecords(psd.children ?? []), b = flattenRecords(psdK.children);
    const kOf = new Map<Ag.Layer, Ag.Layer>();
    if (a.length === b.length) a.forEach((e, i) => { if (!e.divider) kOf.set(e.layer, b[i].layer); });
    for (const [l, ag] of agOf) {
      if (!hasRaster(l)) continue;
      const kl = kOf.get(ag);
      if (kl?.imageData) l.raster.companion = rasterFromImageData(kl.imageData, depth);
    }
  }

  // Shapes stored without pixel data (some non-Adobe writers omit it) are rendered from their vectors.
  for (const l of doc.allLayers()) {
    if (l.kind === 'shape' && l.usingPreservedPixels && !l.raster.contentBounds() && pathBounds(l.path)) renderShapeLayer(doc, l);
  }

  // 5. Channels (merged image data beyond color channels) -----------------------------------------
  try {
    const colorChannels = multichannel ? 0 : container.colorMode === 4 ? 4 : container.colorMode === 1 || container.colorMode === 0 || container.colorMode === 2 || container.colorMode === 8 ? 1 : 3;
    const extra = container.channels - colorChannels;
    if (extra > 0) {
      const names = psd.imageResources?.alphaChannelNames ?? [];
      const planes = decodeMergedChannels(container);
      // The first extra channel is the composite transparency when flagged (negative layer
      // count) — or, when channel names exist, whenever there is one more channel than names.
      const transparency = multichannel ? false : names.length ? extra > names.length : container.mergedAlphaIsTransparency;
      const alphaStart = colorChannels + (transparency ? 1 : 0);
      const display = parseDisplayInfo(findResource(container, 1077)?.data);
      for (let i = alphaStart; i < container.channels; i++) {
        const idx = i - alphaStart;
        const plane = planes[i];
        const n = container.width * container.height;
        // Multichannel inks keep the document's precision; alpha / spot channels are 8-bit.
        const chDepth: BitDepth = multichannel && container.depth === 16 ? 16 : 8;
        const px: PixelArray = chDepth === 16 ? new Uint16Array(n) : new Uint8ClampedArray(n);
        if (container.depth === 16) for (let k = 0; k < n; k++) { const v = (plane[k * 2] << 8) | plane[k * 2 + 1]; px[k] = chDepth === 16 ? v : v / 257; }
        else if (container.depth === 32) {
          const dv = new DataView(plane.buffer, plane.byteOffset, plane.byteLength);
          for (let k = 0; k < n; k++) px[k] = dv.getFloat32(k * 4) * 255;
        } else px.set(plane.subarray(0, n));
        const di = display[idx];
        const spot = multichannel || di?.kind === 2;
        const ch: AlphaChannel = {
          id: newId('ch'),
          name: (names[idx] ?? `${multichannel ? 'Channel' : 'Alpha'} ${idx + 1}`).replace(/\0+$/, ''),
          kind: spot ? 'spot' : 'alpha',
          raster: TiledRaster.fromPixels(container.width, container.height, 1, chDepth, px),
          // Spot inks print and show by default, like in Photoshop; alpha channels are hidden.
          visible: spot,
          color: di?.color ?? (multichannel ? { r: 0, g: 0, b: 0 } : { r: 1, g: 0, b: 0 }),
          opacity: di ? di.opacity / 100 : 0.5,
          indicatesSelected: di ? di.kind === 1 : false,
          solidity: spot ? (di?.kind === 2 ? di.opacity / 100 : 0) : undefined,
        };
        doc.channels.push(ch);
      }
      if (doc.channels.length) issue('Channels', 'editable', `${doc.channels.length} alpha/spot channel(s) imported.`);
      if (doc.channels.some((c) => c.kind === 'spot') && !multichannel) issue('Spot channels', 'editable', 'Spot channels are editable and shown printed over the image with their ink colour and solidity.');
    }
  } catch (e) {
    warnings.push(`Alpha channels could not be read: ${(e as Error).message}`);
  }

  // 6. Paths ----------------------------------------------------------------------------------
  const clipName = findResource(container, CLIPPING_PATH_NAME);
  for (const r of container.resources) {
    if ((r.id >= PATH_RESOURCE_MIN && r.id <= PATH_RESOURCE_MAX) || r.id === WORK_PATH) {
      try {
        const path = parsePathRecords(r.data, container.width, container.height);
        const sp: SavedPath = { id: newId('path'), name: r.id === WORK_PATH ? 'Work Path' : r.name || `Path ${doc.paths.length + 1}`, kind: r.id === WORK_PATH ? 'work' : 'saved', path };
        if (clipName && clipName.data.length > 1 && sp.name === String.fromCharCode(...clipName.data.subarray(1, 1 + clipName.data[0]))) sp.kind = 'clipping';
        doc.paths.push(sp);
      } catch {
        warnings.push(`Path "${r.name}" could not be read.`);
      }
    }
  }

  // 7. Preservation of unmodelled resources / global blocks ---------------------------------------------
  const handledRes = resourceHandlersMap as Record<number, unknown>;
  doc.psd.rawResources = container.resources
    .filter((r) => !handledRes[r.id] && !OWNED_RESOURCES.has(r.id) && !(r.id >= PATH_RESOURCE_MIN && r.id <= PATH_RESOURCE_MAX))
    .map((r) => ({ id: r.id, name: r.name, data: r.data.slice() }));
  const handledInfo = infoHandlersMap as Record<string, unknown>;
  if (container.depth === 32 && container.colorModeData.length) doc.psd.hdrColorModeData = container.colorModeData.slice();
  doc.psd.rawGlobalBlocks = container.globalBlocks.filter((b) => !handledInfo[b.key] && !['Lr16', 'Lr32', 'Layr'].includes(b.key)).map((b) => ({ key: b.key, data: b.data.slice() }));
  // Photoshop's document metadata is understood (and updated on save, see docMetadata.ts); only
  // blocks Celenne does not know are reported as preserved.
  const knownRes = doc.psd.rawResources.filter((r) => r.id in DOC_METADATA_RESOURCES);
  const knownBlk = doc.psd.rawGlobalBlocks.filter((b) => b.key in DOC_METADATA_BLOCKS);
  const otherRes = doc.psd.rawResources.length - knownRes.length;
  const otherBlk = doc.psd.rawGlobalBlocks.filter((b) => !(b.key in DOC_METADATA_BLOCKS));
  if (knownRes.length || knownBlk.length) {
    const names = [...new Set([...knownRes.map((r) => DOC_METADATA_RESOURCES[r.id]), ...knownBlk.map((b) => DOC_METADATA_BLOCKS[b.key])])];
    const ai = knownBlk.find((b) => b.key === 'GenI');
    const aiNote = ai && generativeAiUsed(ai.data) ? ' The file records that generative AI was used on it; this is kept.' : '';
    issue('Document metadata', 'editable', `Photoshop's document metadata (${names.join(', ')}) is kept. When you save, Celenne updates it as Photoshop does: EXIF size, resolution, colour space and date, and the print resolution.${aiNote}`);
  }
  const cai = knownBlk.find((b) => b.key === 'CAI ');
  if (cai && contentCredentialsEnabled(cai.data)) issue('Content Credentials', 'preserved', "Content Credentials are turned on for this document in Photoshop. Celenne keeps the setting, but it does not add its own edits to the document's Content Credentials.");
  if (otherRes) issue('Image resources', 'preserved', `${otherRes} document resource block(s) Celenne does not know are preserved byte-for-byte.`);
  if (otherBlk.length) issue('Document data', 'preserved', `Global Photoshop data ${otherBlk.map((b) => `"${b.key}"`).join(', ')} preserved byte-for-byte.`);
  doc.slices = slicesFromPsd(psd.imageResources?.slices);
  if (doc.slices.length) issue('Slices', 'editable', `${doc.slices.length} user slice(s) are editable with the Slice tool and exportable with File ▸ Export ▸ Export Slices.`);
  if (psd.imageResources?.layerComps?.list?.length) issue('Layer comps', 'preserved', 'Layer comps are preserved. [Layer comps panel: Coming Soon]');
  if (psd.annotations?.length) issue('Annotations', 'preserved', 'Notes/annotations are preserved.');
  if (psd.artboards) issue('Artboards', 'preserved', 'Artboard document settings are preserved.');

  // 8. Indexed Color / Bitmap: native single-layer modes ------------------------------------------
  if ((originalMode === 'indexed' || originalMode === 'bitmap') && doc.root.children.length === 1 && doc.root.children[0].kind === 'pixel' && !doc.channels.length) {
    const bg = doc.root.children[0];
    for (let i = issues.length - 1; i >= 0; i--) if (issues[i].feature === 'Color mode' || issues[i].feature === 'Bit depth') issues.splice(i, 1);
    for (let i = warnings.length - 1; i >= 0; i--) if (/color mode is not editable natively/.test(warnings[i])) warnings.splice(i, 1);
    if (originalMode === 'bitmap') {
      doc.canvas = { ...doc.canvas, colorMode: 'bitmap', bitDepth: 8 };
      if (!icc) doc.profile = { name: 'Gray Gamma 2.2', builtin: 'gray22' };
      issue('Color mode', 'editable', 'Bitmap (1-bit) document: edited natively, kept to black and white, and saved as a Bitmap PSD.');
    } else {
      const u16 = (id: number) => { const r = findResource(container, id)?.data; return r && r.length >= 2 ? (r[0] << 8) | r[1] : undefined; };
      const pal = psd.palette ?? [];
      const transparentIndex = u16(1047);
      const count = Math.min(pal.length, u16(1046) ?? pal.length);
      const table: number[] = [];
      for (let i = 0; i < count; i++) if (i !== transparentIndex) table.push(pal[i].r, pal[i].g, pal[i].b);
      if (transparentIndex !== undefined && transparentIndex < 256) {
        // ag-psd shows the transparent slot opaque: clear those pixels from the raw indices.
        try {
          const plane = decodeMergedChannels(container)[0];
          const f = bg.raster.readFloat(doc.bounds);
          for (let i = 0; i < doc.width * doc.height; i++) if (plane[i] === transparentIndex) f[i * 4] = f[i * 4 + 1] = f[i * 4 + 2] = f[i * 4 + 3] = 0;
          bg.raster.writeFloat(doc.bounds, f);
        } catch {
          warnings.push('The transparency of this Indexed Color file could not be read.');
        }
      }
      doc.canvas = { ...doc.canvas, colorMode: 'indexed', bitDepth: 8, colorTable: table.length ? table : [0, 0, 0, 255, 255, 255], colorTableTransparent: transparentIndex !== undefined };
      issue('Color mode', 'editable', `Indexed Color document (${table.length / 3} colors${transparentIndex !== undefined ? ' + transparency' : ''}): edited natively, kept to its color table, and saved as an Indexed Color PSD.`);
    }
  }

  // 9. Duotone / Multichannel ------------------------------------------------------------------
  if (duotone) doc.canvas = { ...doc.canvas, duotone };
  if (multichannel) {
    // Photoshop Multichannel files have no layers: the composite read above is channel 1 again.
    for (const l of [...doc.root.children]) doc.removeLayer(l);
    doc.canvas = { ...doc.canvas, colorMode: 'multichannel' };
    if (!doc.channels.length) warnings.push('This Multichannel file has no readable channels.');
  }

  doc.compatibility = issues;
  // Celenne-only paragraph settings from the XMP metadata (matched by layer id and paragraph runs).
  const extras = readCelenneText(doc.metadata.xmp);
  if (Object.keys(extras).length) {
    for (const l of doc.allLayers()) {
      if (l.kind !== 'text') continue;
      const runs = l.metadata.psd?.psdId !== undefined ? extras[l.metadata.psd.psdId] : undefined;
      const paras = runsPerParagraph(l.text);
      if (!runs || runs.length !== paras.length) continue;
      l.text.paragraphs = paras.map((p, i) => (runs[i] ? { ...p, style: { ...p.style, ...runs[i] } } : p));
      if (l.metadata.psd) l.metadata.psd.textAtOpen = JSON.stringify(l.text);
    }
  }
  return { doc, warnings, issues };
}

/** Decodes a 16/32-bit RGB or grayscale composite from merged image data (flat deep files). */
/**
 * Decodes a flat Gray or RGB-shaped composite (8/16/32-bit) from the merged image data. The first
 * channel after the colour channels is transparency only when Photoshop flags it (negative layer
 * count) — or, with channel names, when there is one more extra channel than names.
 */
function decodeFlatComposite(c: PsdContainer, depth: BitDepth, nNames: number): Ag.PixelData | undefined {
  if (!c.imageData.length || (c.colorMode !== 1 && c.colorMode !== 3) || c.depth === 1) return undefined;
  let planes: Uint8Array[];
  try { planes = decodeMergedChannels(c); } catch { return undefined; }
  const gray = c.colorMode === 1;
  const color = gray ? 1 : 3;
  if (planes.length < color) return undefined;
  const n = c.width * c.height;
  const data = depth === 8 ? new Uint8ClampedArray(n * 4) : depth === 16 ? new Uint16Array(n * 4) : new Float32Array(n * 4);
  const dvs = planes.map((p) => new DataView(p.buffer, p.byteOffset, p.byteLength));
  const extra = planes.length - color;
  const hasAlpha = extra > 0 && (nNames ? extra > nNames : c.mergedAlphaIsTransparency);
  const read = (ch: number, i: number) => (depth === 8 ? planes[ch][i] : depth === 16 ? dvs[ch].getUint16(i * 2) : dvs[ch].getFloat32(i * 4));
  const max = depth === 8 ? 255 : depth === 16 ? 65535 : 1;
  for (let i = 0; i < n; i++) {
    const a = hasAlpha ? read(color, i) : max;
    for (let k = 0; k < 3; k++) {
      let v = read(gray ? 0 : k, i);
      // Undo Photoshop's white matte on transparent composites.
      if (hasAlpha && a > 0 && a < max) v = (v - max * (1 - a / max)) / (a / max);
      data[i * 4 + k] = depth === 32 ? v : Math.max(0, Math.min(max, Math.round(v)));
    }
    data[i * 4 + 3] = a;
  }
  return { width: c.width, height: c.height, data };
}

interface DisplayInfo {
  color: { r: number; g: number; b: number };
  opacity: number;
  kind: number;
}

/** Parses resource 1077 (DisplayInfo) for channel colors, opacity and kind. */
function parseDisplayInfo(data: Uint8Array | undefined): DisplayInfo[] {
  if (!data || data.length < 4) return [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: DisplayInfo[] = [];
  let o = 4; // version
  // Records are 13 bytes: colour record (10), opacity / solidity (2), kind (1).
  while (o + 13 <= data.length) {
    const rec: ColorRecord = [dv.getUint16(o), dv.getUint16(o + 2), dv.getUint16(o + 4), dv.getUint16(o + 6), dv.getUint16(o + 8)];
    const opacity = Math.min(100, dv.getUint16(o + 10));
    const kind = data[o + 12];
    const c = colorFromRecord(rec);
    out.push({ color: c ? { r: c.r, g: c.g, b: c.b } : { r: 1, g: 0, b: 0 }, opacity, kind });
    o += 13;
  }
  return out;
}

export { parseDisplayInfo };
export type { GroupLayer };

/** True when a contour curve is the identity (missing, or only points on the diagonal). */
function isLinearContour(c: { name?: string; curve?: { x: number; y: number }[] } | undefined): boolean {
  if (!c?.curve?.length) return true;
  return c.curve.every((p) => Math.abs(p.x - p.y) < 1);
}

/**
 * Photoshop writes a text-path record on every text layer; `textRange: [-1, -1]` means the text
 * is not on a path. Only a record with a real range (or path data) is text on a path.
 */
/** Parses Celenne's private type-on-a-path block, validating every field. */
export function textPathFromBlock(data: Uint8Array): TextPath | null {
  try {
    if (data.length > 4 * 1024 * 1024) return null;
    const o = JSON.parse(new TextDecoder().decode(data).replace(/\0+$/, '')) as { v?: number; subpath?: { knots?: unknown[]; closed?: unknown }; start?: unknown; end?: unknown; flip?: unknown };
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    const knots = o.subpath?.knots;
    if (o.v !== 1 || !Array.isArray(knots) || knots.length < 1 || knots.length > 100000 || !num(o.start)) return null;
    const ks = knots.map((k) => {
      const q = k as Record<string, unknown>;
      if (!['x', 'y', 'inX', 'inY', 'outX', 'outY'].every((f) => num(q[f]))) throw new Error('bad knot');
      return { x: q.x as number, y: q.y as number, inX: q.inX as number, inY: q.inY as number, outX: q.outX as number, outY: q.outY as number, smooth: !!q.smooth };
    });
    return { subpath: { knots: ks, closed: !!o.subpath?.closed, op: 'combine' }, start: o.start as number, end: num(o.end) ? (o.end as number) : undefined, flip: !!o.flip };
  } catch {
    return null;
  }
}

function isRealTextPath(tp: unknown): boolean {
  const d = (tp as { data?: { textRange?: number[] } } | undefined)?.data;
  if (!d) return false;
  const r = d.textRange;
  return Array.isArray(r) ? r.some((v) => v >= 0) : false;
}

/** User slices from the PSD slices resource (auto-generated slices are derived, not stored). */
export function slicesFromPsd(res: Ag.ImageResources['slices']): SliceDef[] {
  const list = res?.[0]?.slices ?? [];
  return list
    .filter((s) => s.origin !== 'autoGenerated' && s.bounds.right > s.bounds.left && s.bounds.bottom > s.bounds.top)
    .map((s) => ({
      id: newId('slice'),
      name: s.name || `slice_${String(s.id).padStart(2, '0')}`,
      rect: { x: s.bounds.left, y: s.bounds.top, w: s.bounds.right - s.bounds.left, h: s.bounds.bottom - s.bounds.top },
      url: s.url || undefined,
      target: s.target || undefined,
      altTag: s.altTag || undefined,
      message: s.message || undefined,
      psdId: s.id,
      preserved: { ...s } as unknown as Record<string, unknown>,
    }));
}

function rangeOf(a: number[] | undefined): BlendIfRange {
  return a && a.length >= 4 ? [a[0], a[1], a[2], a[3]] : [...DEFAULT_BLEND_IF_RANGE];
}

/** Photoshop blending ranges → Blend If (gray from the composite ranges, then R, G, B). */
export function blendIfFromPsd(br: NonNullable<Ag.Layer['blendingRanges']>): BlendIf {
  const ch = (i: number): BlendIfChannel => ({ thisLayer: rangeOf(br.ranges[i]?.sourceRange), underlying: rangeOf(br.ranges[i]?.destRange) });
  return { gray: { thisLayer: rangeOf(br.compositeGrayBlendSource), underlying: rangeOf(br.compositeGraphBlendDestinationRange) }, red: ch(0), green: ch(1), blue: ch(2) };
}

/** Photoshop placed-layer warp → source-space envelope (custom mesh, or a preset fitted to a mesh). */
export function smartWarpFromPsd(wp: Ag.Warp | undefined, w: number, h: number): Point[] | undefined {
  if (!wp || !wp.style || wp.style === 'none') return undefined;
  const bx = wp.bounds ? unitPx(wp.bounds.left) : 0, by = wp.bounds ? unitPx(wp.bounds.top) : 0;
  const bw = wp.bounds ? unitPx(wp.bounds.right) - bx : w, bh = wp.bounds ? unitPx(wp.bounds.bottom) - by : h;
  // Mesh points are in the warp's bounds space; rescale to the declared source size.
  const sx = bw > 0 ? w / bw : 1, sy = bh > 0 ? h / bh : 1;
  const pts = wp.customEnvelopeWarp?.meshPoints;
  if (wp.style === 'custom') {
    if (!pts || pts.length !== 16) return undefined;
    return pts.map((p) => ({ x: (p.x - bx) * sx, y: (p.y - by) * sy }));
  }
  if (!WARP_STYLES.some((s) => s.id === wp.style)) return undefined;
  return presetGrid({ style: wp.style as WarpStyle, bend: wp.value ?? 0, horizontalDistortion: wp.perspective ?? 0, verticalDistortion: wp.perspectiveOther ?? 0, orientation: wp.rotate === 'vertical' ? 'vertical' : 'horizontal' }, { x: 0, y: 0, w, h });
}
