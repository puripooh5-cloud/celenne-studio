/**
 * PSD / PSB export: CelenneDocument → Photoshop document.
 *
 * 1. Each layer is rebuilt from its preserved ag-psd record (fields we don't model survive),
 *    with every modelled property written from the document model.
 * 2. ag-psd serializes the layer structure.
 * 3. The container post-processor re-injects byte-exact blocks ag-psd cannot represent,
 *    the ICC profile, saved paths, alpha/spot channels and — for 16/32-bit documents —
 *    full-precision layer channels and composite (ag-psd itself only writes 8-bit).
 */
import type { AlphaChannel } from '../document/types';
import { alternateDuotoneResource, encodeDuotone } from '../color/inks';
import { applyInkAppearance, hasInkAppearance } from '../rendering/inkView';
import { encodeCurv, patchLevlChannel } from './adjustBlocks';
import { isCmykDoc, isLabDoc, platesToRgb } from '../color/plates';
import { writePsdUint8Array } from 'ag-psd';
import { ensureAgPsd } from './agpsdSetup';
import type * as Ag from 'ag-psd';
import { zlibSync } from 'fflate';
import type { CelenneDocument } from '../document/document';
import type { Layer, LayerMask, SliceDef, TextLayer } from '../document/types';
import { DEFAULT_BLEND_IF_RANGE } from '../document/types';
import { hasRaster } from '../document/types';
import { rasterContentBounds } from '../rendering/bounds';
import type { Rect } from '../image-engine/rect';
import type { BitDepth, PixelArray } from '../image-engine/pixels';
import { adjustmentToPsd, blendToPsd, colorToPsd, effectsToPsd, fontTypeFor, gradientToPsd, paintToPsd, pathToPsd, px, textToPsd } from './mapping';
import { patchTxt2, txt2ObjectCount, type Txt2Edit } from './txt2Patch';
import { txt2Template } from './txt2Template';
import { extrasOf, withCelenneText, type CelenneTextExtras } from './celenneXmp';
import type { TextData } from '../typography/types';
import { runsPerParagraph } from '../typography/types';
import { decodeMergedChannels, encodeMergedRLE, parseContainer, PsdContainer, serializeContainer } from './container';
import { writePathRecords } from './paths';
import { flattenToPixels, hasTransparency } from '../rendering/flatten';
import { builtinProfileICC, parseIccInfo } from '../color/icc';
import { hasAnyEffect } from '../effects/types';
import { Writer } from './binary';
import { slicesFromPsd, smartWarpFromPsd } from './import';
import { isIdentityGrid } from '../image-engine/warp';
import { compositeRegion, compositeRegionPlates } from '../rendering/compositor';
import { encodeJpeg } from '../formats/jpegEncoder';
import { NearestPalette } from '../color/indexed';
import { writeDocMetadata } from './docMetadata';

export interface PsdExportOptions {
  psb?: boolean;
  /** Write the flattened composite ("Maximize Compatibility"). */
  maximizeCompatibility?: boolean;
  onProgress?: (fraction: number, label: string) => void;
  /** Celenne ids of the selected layers, written as Photoshop's layer selection (resource 1069). */
  selectedLayerIds?: string[];
  /** Experiments: override whether edited text layers are flagged for Photoshop to redraw. */
  invalidateText?: boolean;
  /** The save time written to EXIF (tests); defaults to now. */
  now?: Date;
}

/** Lists what cannot be written exactly, shown to the user before saving. */
export function analyzePsdExport(doc: CelenneDocument, opts: PsdExportOptions = {}): string[] {
  const notes: string[] = [];
  if (!opts.psb && (doc.width > 30000 || doc.height > 30000)) notes.push('Documents larger than 30,000 px must be saved as PSB (Large Document Format).');
  const om = doc.psd.originalColorMode;
  // The mode the file is written in (Duotone = Grayscale data with inks).
  const cm = doc.canvas.duotone ? 'duotone' : doc.canvas.colorMode;
  const modeName: Record<string, string> = { rgb: 'RGB', grayscale: 'Grayscale', indexed: 'Indexed Color', bitmap: 'Bitmap', cmyk: 'CMYK', lab: 'Lab', duotone: 'Duotone', multichannel: 'Multichannel' };
  if (om && !['rgb', 'grayscale'].includes(om) && om !== cm) notes.push(`This document was opened from ${modeName[om] ?? om} mode and will be saved as ${modeName[cm] ?? cm}.`);
  if (cm === 'multichannel') notes.push('Multichannel files have no layers: the ink channels are saved as the image.');
  if (cm === 'indexed' || cm === 'bitmap') notes.push(`${cm === 'indexed' ? 'Indexed Color' : 'Bitmap'} files are flat: the document is saved as its single image layer${cm === 'indexed' ? ' with its color table' : ' at 1 bit per pixel'}.`);
  for (const l of doc.walk()) {
    if (l.kind === 'smartObject' && l.smartFilters.length) notes.push(`"${l.name}": Celenne smart filters are saved as the rendered result; the filter list is stored in Celenne metadata.`);
    if (l.kind === 'text' && l.text.runs.some((r) => r.style.openTypeFeatures.length || Object.keys(r.style.variationAxes ?? {}).length)) notes.push(`"${l.name}": OpenType features and variable-font settings cannot be written to Photoshop's text data yet; Photoshop asks to update the text layers when opening.`);
    if (l.kind === 'text' && l.text.paragraphs.some((p) => p.style.composer === 'celenne' || p.style.opticalMargins)) notes.push(`"${l.name}": laid out with Celenne's composer or optical margins. Photoshop lays this text out with its own Single-line composer, so its lines can break differently there. Celenne keeps the setting in the file for when it opens it again.`);
    if (l.kind === 'text' && l.missingFonts.length) notes.push(`"${l.name}": missing font ${l.missingFonts.join(', ')} — original font names are kept.`);
    if (l.effects?.patternOverlay && !doc.patterns.has(l.effects.patternOverlay.patternId)) notes.push(`"${l.name}": pattern overlay references a pattern that is not embedded.`);
  }
  if (doc.channels.some((c) => c.kind === 'spot')) notes.push('Spot channels are saved as alpha channels with spot display info.');
  return [...new Set(notes)];
}

const LAYER_COLORS = new Set(['none', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray']);

function to8(data: PixelArray): Uint8ClampedArray {
  if (data instanceof Uint8ClampedArray) return data;
  const out = new Uint8ClampedArray(data.length);
  if (data instanceof Uint16Array) for (let i = 0; i < data.length; i++) out[i] = data[i] / 257;
  else for (let i = 0; i < data.length; i++) out[i] = (data[i] as number) * 255;
  return out;
}

/** Encodes one channel of an interleaved buffer at 16/32-bit (big-endian, PSD compression 0 or 3). */
function encodeDeepChannel(data: PixelArray, w: number, h: number, stride: number, offset: number, depth: BitDepth): Uint8Array {
  const n = w * h;
  if (depth === 16) {
    // ZIP with prediction (Photoshop's default for 16-bit): per-row delta on 16-bit samples.
    const bytes = new Uint8Array(n * 2);
    for (let y = 0; y < h; y++) {
      let prev = 0;
      for (let x = 0; x < w; x++) {
        const v = (data as Uint16Array)[(y * w + x) * stride + offset];
        const d = (v - prev) & 0xffff;
        prev = v;
        const o = (y * w + x) * 2;
        bytes[o] = d >> 8;
        bytes[o + 1] = d & 255;
      }
    }
    const z = zlibSync(bytes, { level: 6 });
    const out = new Uint8Array(2 + z.length);
    out[1] = 3;
    out.set(z, 2);
    return out;
  }
  const out = new Uint8Array(2 + n * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) dv.setFloat32(2 + i * 4, (data as Float32Array)[i * stride + offset]);
  return out;
}

interface Built {
  ag: Ag.Layer;
  layer: Layer;
}

export function exportPsd(doc: CelenneDocument, opts: PsdExportOptions = {}): Uint8Array {
  ensureAgPsd();
  const depth = doc.canvas.bitDepth;
  const deep = depth !== 8;
  // Grayscale documents are written in Grayscale mode: RGB layer data is reduced to one gray channel in post-processing.
  const gray = doc.canvas.colorMode === 'grayscale';
  const progress = opts.onProgress ?? (() => {});
  const idMap = new Map<number, Layer>();
  const usedIds = new Set<number>();
  let nextId = 1;
  for (const l of doc.walk()) if (l.metadata.psd?.psdId) usedIds.add(l.metadata.psd.psdId);
  const allocId = (l: Layer) => {
    let id = l.metadata.psd?.psdId;
    if (!id || idMap.has(id)) {
      while (usedIds.has(nextId)) nextId++;
      id = nextId++;
      usedIds.add(id);
    }
    idMap.set(id, l);
    return id;
  };
  let textInvalidated = false;
  // Each text layer names its object in Txt2 (TextIndex). New layers, and copies of a layer that
  // share its object, get indexes after Photoshop's objects (they have no object of their own); in
  // a document without Txt2 every text layer gets a new object.
  const textOwners = new Set<number>();
  const newText: TextLayer[] = [];
  const engineData = (doc.psd.source as { engineData?: unknown } | undefined)?.engineData;
  const hasTxt2 = typeof engineData === 'string';
  let nextTextIndex = hasTxt2 ? txt2ObjectCount(fromBase64(engineData)) : 0;
  const built: Built[] = [];

  const rasterPayload = (ag: Ag.Layer, raster: import('../image-engine/tiledRaster').TiledRaster, ox: number, oy: number) => {
    const b = rasterContentBounds(raster);
    if (!b) {
      ag.left = ag.right = ox;
      ag.top = ag.bottom = oy;
      return;
    }
    ag.left = ox + b.x;
    ag.top = oy + b.y;
    ag.right = ag.left + b.w;
    ag.bottom = ag.top + b.h;
    const px = raster.readPixels(b);
    if (gray) toLuminance(px, depth);
    if (!deep) ag.imageData = { width: b.w, height: b.h, data: px as Uint8ClampedArray };
    else {
      ag.rawData = {
        colorMode: 3,
        bitsPerChannel: depth,
        large: !!opts.psb,
        channels: [
          { id: -1, compression: 0, data: encodeDeepChannel(px, b.w, b.h, 4, 3, depth).subarray(2) },
          { id: 0, compression: 0, data: encodeDeepChannel(px, b.w, b.h, 4, 0, depth).subarray(2) },
          { id: 1, compression: 0, data: encodeDeepChannel(px, b.w, b.h, 4, 1, depth).subarray(2) },
          { id: 2, compression: 0, data: encodeDeepChannel(px, b.w, b.h, 4, 2, depth).subarray(2) },
        ].map((c) => ({ ...c, compression: (depth === 16 ? 3 : 0) as Ag.LayerRawDataChannel['compression'] })),
      };
    }
  };

  const maskPayload = (ag: Ag.Layer, m: LayerMask) => {
    // A uniform mask still gets real bounds and pixels: Photoshop reads a mask with empty bounds
    // as "no mask", so an all-black (hide-all) mask would show the layer again.
    const b: Rect | null = rasterContentBounds(m.raster) ?? m.raster.tileBounds() ?? (m.raster.fill !== 1 ? { x: 0, y: 0, w: doc.width, h: doc.height } : null);
    const mask: Ag.LayerMaskData = {
      defaultColor: Math.round(m.raster.fill * 255),
      disabled: !m.enabled,
      userMaskDensity: m.density,
      userMaskFeather: m.feather,
      positionRelativeToLayer: false,
    };
    const src = ag.mask ? { ...ag.mask } : {};
    delete (src as { imageData?: unknown }).imageData;
    Object.assign(mask, { ...src, ...mask });
    if (b && b.w > 0 && b.h > 0) {
      // Mask bounds must be relative to document; include offset.
      mask.left = m.x + b.x;
      mask.top = m.y + b.y;
      mask.right = mask.left + b.w;
      mask.bottom = mask.top + b.h;
      const v = m.raster.readPixels(b) as Uint8ClampedArray;
      if (!deep) {
        const rgba = new Uint8ClampedArray(b.w * b.h * 4);
        for (let i = 0; i < v.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v[i]; rgba[i * 4 + 3] = 255; }
        mask.imageData = { width: b.w, height: b.h, data: rgba };
      } else if (ag.rawData) {
        const wide = depth === 16 ? new Uint16Array(v.length) : new Float32Array(v.length);
        for (let i = 0; i < v.length; i++) wide[i] = depth === 16 ? v[i] * 257 : v[i] / 255;
        const enc = encodeDeepChannel(wide, b.w, b.h, 1, 0, depth);
        ag.rawData.channels.push({ id: -2, compression: (depth === 16 ? 3 : 0) as Ag.LayerRawDataChannel['compression'], data: enc.subarray(2) });
      }
    } else {
      mask.left = mask.top = mask.right = mask.bottom = 0;
    }
    ag.mask = mask;
  };

  const convert = (l: Layer): Ag.Layer => {
    const src = (l.metadata.psd?.source ?? {}) as Ag.Layer;
    const ag: Ag.Layer = { ...src };
    // Fields rebuilt from the model.
    for (const k of ['imageData', 'canvas', 'children', 'mask', 'realMask', 'adjustment', 'text', 'vectorMask', 'vectorFill', 'vectorStroke', 'effects', 'placedLayer', 'rawData'] as const) delete (ag as Record<string, unknown>)[k];
    // Real (combined) masks are regenerated by Photoshop from the user mask + vector mask.
    delete ag.realMask;
    ag.name = l.name;
    ag.id = allocId(l);
    ag.hidden = !l.visible;
    ag.opacity = l.opacity;
    ag.fillOpacity = l.fillOpacity;
    ag.blendMode = blendToPsd(l.blendMode === 'passThrough' && l.kind !== 'group' ? 'normal' : l.blendMode);
    ag.clipping = l.clipping;
    ag.protected = { transparency: l.locks.transparency, composite: l.locks.pixels, position: l.locks.position, artboards: l.locks.artboard };
    if (l.locks.all) ag.protected = { transparency: true, composite: true, position: true, artboards: l.locks.artboard };
    ag.layerColor = (LAYER_COLORS.has(l.colorTag) ? l.colorTag : 'none') as Ag.LayerColor;
    ag.blendClippendElements = l.advanced.blendClippedAsGroup;
    ag.blendInteriorElements = l.advanced.blendInteriorAsGroup;
    ag.transparencyShapesLayer = l.advanced.transparencyShapesLayer;
    if (l.advanced.knockout !== 'none') ag.knockout = true;
    const bi = l.advanced.blendIf;
    if (bi) ag.blendingRanges = { compositeGrayBlendSource: [...bi.gray.thisLayer], compositeGraphBlendDestinationRange: [...bi.gray.underlying], ranges: [bi.red, bi.green, bi.blue].map((c) => ({ sourceRange: [...c.thisLayer], destRange: [...c.underlying] })) };
    else if (ag.blendingRanges) {
      const d = [...DEFAULT_BLEND_IF_RANGE];
      ag.blendingRanges = { compositeGrayBlendSource: d, compositeGraphBlendDestinationRange: d, ranges: ag.blendingRanges.ranges.map(() => ({ sourceRange: d, destRange: d })) };
    }
    const restricted = l.advanced.channels.map((on, i) => (on ? -1 : i)).filter((i) => i >= 0);
    if (restricted.length) ag.channelBlendingRestrictions = restricted;
    else delete ag.channelBlendingRestrictions;
    ag.left = ag.top = ag.right = ag.bottom = 0;

    switch (l.kind) {
      case 'group':
        ag.children = l.children.map(convert);
        ag.opened = l.expanded;
        ag.blendMode = blendToPsd(l.blendMode);
        break;
      case 'pixel':
      case 'video':
        rasterPayload(ag, l.raster, l.x, l.y);
        break;
      case 'text':
        ag.text = textToPsd(l.text, src.text);
        if (!hasTxt2 || src.text?.index === undefined || textOwners.has(src.text.index)) { ag.text.index = nextTextIndex++; newText.push(l); textInvalidated = true; }
        else textOwners.add(src.text.index);
        if (!l.usingPreservedPixels) textInvalidated = true;
        rasterPayload(ag, l.raster, l.x, l.y);
        break;
      case 'shape': {
        ag.vectorMask = { ...(src.vectorMask ?? {}), paths: pathToPsd(l.path) };
        const fill = paintToPsd(l.fill);
        ag.vectorFill = fill ?? { type: 'color', color: { r: 0, g: 0, b: 0 } };
        const st = l.stroke;
        ag.vectorStroke = {
          ...(src.vectorStroke ?? {}),
          strokeEnabled: st.enabled,
          fillEnabled: l.fill.type !== 'none',
          lineWidth: px(st.width),
          lineDashOffset: px(st.dashOffset),
          miterLimit: st.miterLimit,
          lineCapType: st.cap,
          lineJoinType: st.join,
          lineAlignment: st.alignment,
          lineDashSet: st.dash.map((d) => px(d)),
          blendMode: 'normal',
          opacity: st.opacity,
          content: paintToPsd(st.paint) ?? { type: 'color', color: { r: 0, g: 0, b: 0 } },
          resolution: doc.canvas.resolution,
        };
        if (l.origin && l.origin.kind !== 'custom') {
          const o = l.origin;
          const type = o.kind === 'rectangle' ? 1 : o.kind === 'roundedRectangle' ? 2 : o.kind === 'line' ? 4 : o.kind === 'ellipse' ? 5 : undefined;
          if (type) {
            ag.vectorOrigination = {
              keyDescriptorList: [
                {
                  keyOriginType: type,
                  keyOriginResolution: doc.canvas.resolution,
                  keyOriginShapeBoundingBox: { top: px(o.y), left: px(o.x), bottom: px(o.y + o.h), right: px(o.x + o.w) },
                  ...(o.radii ? { keyOriginRRectRadii: { topLeft: px(o.radii[0]), topRight: px(o.radii[1]), bottomRight: px(o.radii[2]), bottomLeft: px(o.radii[3]) } } : {}),
                },
              ],
            };
          }
        }
        rasterPayload(ag, l.raster, l.x, l.y);
        break;
      }
      case 'adjustment':
        ag.adjustment = adjustmentToPsd(l.adjustment);
        break;
      case 'fill': {
        const f = l.fill;
        if (f.type === 'solid') ag.vectorFill = { type: 'color', color: colorToPsd(f.color) };
        else if (f.type === 'gradient') ag.vectorFill = { ...gradientToPsd(f.gradient), style: f.style, angle: f.angle, scale: f.scale / 100, reverse: f.reverse, dither: f.dither, align: f.alignWithLayer, offset: { x: f.offsetX, y: f.offsetY }, interpolationMethod: f.gradient.interpolation };
        else ag.vectorFill = { type: 'pattern', name: doc.patterns.get(f.patternId)?.name ?? f.patternId, id: f.patternId, phase: { x: f.phaseX, y: f.phaseY } };
        break;
      }
      case 'smartObject': {
        const q = l.quad;
        const prev = src.placedLayer;
        ag.placedLayer = {
          ...(prev ?? {}),
          id: l.sourceId,
          type: prev?.type ?? 'raster',
          transform: [q[0].x, q[0].y, q[1].x, q[1].y, q[2].x, q[2].y, q[3].x, q[3].y],
          width: l.sourceWidth,
          height: l.sourceHeight,
        };
        // Warp: keep the file's record when the envelope is unchanged, else write a custom mesh.
        const wIdentity = !l.warp || isIdentityGrid(l.warp, { x: 0, y: 0, w: l.sourceWidth, h: l.sourceHeight });
        const fromFile = smartWarpFromPsd(prev?.warp, l.sourceWidth, l.sourceHeight);
        const unchanged = !!fromFile && !!l.warp && fromFile.every((p, i) => Math.abs(p.x - l.warp![i].x) < 1e-3 && Math.abs(p.y - l.warp![i].y) < 1e-3);
        if (wIdentity) delete ag.placedLayer.warp;
        else if (!unchanged) {
          const u = (v: number) => ({ units: 'Pixels' as const, value: v });
          ag.placedLayer.warp = {
            style: 'custom', value: 0, perspective: 0, perspectiveOther: 0, rotate: 'horizontal',
            bounds: { top: u(0), left: u(0), bottom: u(l.sourceHeight), right: u(l.sourceWidth) },
            uOrder: 4, vOrder: 4,
            customEnvelopeWarp: { meshPoints: l.warp!.map((p) => ({ x: p.x, y: p.y })) },
          };
        }
        rasterPayload(ag, l.raster, l.x, l.y);
        break;
      }
    }
    if (l.mask) maskPayload(ag, l.mask);
    if (l.vectorMask && l.kind !== 'shape') ag.vectorMask = { paths: pathToPsd(l.vectorMask.path), invert: l.vectorMask.invert, notLink: !l.vectorMask.linked, disable: !l.vectorMask.enabled };
    if (l.effects && hasAnyEffect(l.effects)) ag.effects = effectsToPsd(l.effects);
    else delete ag.effects;
    built.push({ ag, layer: l });
    return ag;
  };

  progress(0.05, 'Preparing layers');
  const children = doc.root.children.map(convert);

  // Top-level document object.
  const srcDoc = (doc.psd.source ?? {}) as unknown as Ag.Psd;
  const psd: Ag.Psd = {
    ...srcDoc,
    width: doc.width,
    height: doc.height,
    channels: 3,
    bitsPerChannel: 8,
    colorMode: 3,
    children,
  };
  delete psd.imageData;
  delete psd.canvas;
  delete psd.palette;
  const ir: Ag.ImageResources = { ...(srcDoc.imageResources ?? {}) };
  delete ir.thumbnail;
  delete ir.thumbnailRaw;
  ir.resolutionInfo = {
    horizontalResolution: doc.canvas.resolution,
    horizontalResolutionUnit: 'PPI',
    widthUnit: doc.rulerUnit === 'cm' || doc.rulerUnit === 'mm' ? 'Centimeters' : doc.rulerUnit === 'pt' ? 'Points' : doc.rulerUnit === 'pica' ? 'Picas' : 'Inches',
    verticalResolution: doc.canvas.resolution,
    verticalResolutionUnit: 'PPI',
    heightUnit: doc.rulerUnit === 'cm' || doc.rulerUnit === 'mm' ? 'Centimeters' : doc.rulerUnit === 'pt' ? 'Points' : doc.rulerUnit === 'pica' ? 'Picas' : 'Inches',
  };
  ir.gridAndGuidesInformation = {
    grid: { horizontal: doc.grid.spacing, vertical: doc.grid.spacing },
    guides: doc.guides.map((g) => ({ location: g.position, direction: g.orientation })),
  };
  ir.globalAngle = doc.globalLight.angle;
  ir.globalAltitude = doc.globalLight.altitude;
  if (doc.channels.length) ir.alphaChannelNames = doc.channels.map((c) => c.name);
  else delete ir.alphaChannelNames;
  delete ir.alphaIdentifiers;
  // Celenne-only paragraph settings travel in the XMP metadata (see celenneXmp.ts).
  const extras: CelenneTextExtras = {};
  for (const [id, l] of idMap) {
    if (l.kind !== 'text') continue;
    const runs = runsPerParagraph(l.text).map((p) => extrasOf(p.style));
    if (runs.some((r) => r)) extras[id] = runs;
  }
  const xmp = withCelenneText(doc.metadata.xmp, extras);
  if (xmp) ir.xmpMetadata = xmp;
  else delete ir.xmpMetadata;
  if (doc.metadata.copyrighted !== undefined) ir.copyrighted = doc.metadata.copyrighted;
  if (doc.metadata.url) ir.url = doc.metadata.url;
  // Layer selection: the editor's current selection, else the file's original selection when those
  // layers still exist. (Resource 1024, the legacy single-target index, is superseded by 1069.)
  delete ir.layerState;
  const lyidOf = new Map([...idMap].map(([psdId, l]) => [l.id, psdId]));
  const selected = opts.selectedLayerIds?.map((id) => lyidOf.get(id)).filter((v): v is number => v !== undefined)
    ?? (srcDoc.imageResources?.layerSelectionIds ?? []).filter((id) => idMap.has(id));
  if (selected.length) ir.layerSelectionIds = selected;
  else delete ir.layerSelectionIds;
  if (doc.profile.untagged && !doc.profile.icc) ir.iccUntaggedProfile = true;
  else delete ir.iccUntaggedProfile;
  // Slices: keep the file's resource untouched when the slices were not edited.
  const origSlices = srcDoc.imageResources?.slices;
  if (sliceKey(slicesFromPsd(origSlices)) !== sliceKey(doc.slices)) {
    if (doc.slices.length) ir.slices = slicesToPsd(doc);
    else delete ir.slices;
  }
  // Thumbnail (resource 1036): a JPEG of the composite, at most 160 px.
  const thumb = thumbnailJpeg(doc);
  if (thumb) ir.thumbnailRaw = thumb;
  psd.imageResources = ir;
  const linked: Ag.LinkedFile[] = [];
  for (const s of doc.smartSources.values()) {
    const base = (s.preserved ?? {}) as Partial<Ag.LinkedFile>;
    linked.push({ ...base, id: s.id, name: s.name, type: base.type ?? s.fileType, data: s.data } as Ag.LinkedFile);
  }
  if (linked.length) psd.linkedFiles = linked;
  else delete psd.linkedFiles;

  // Composite (8-bit for ag-psd; deep composites are written in post-processing).
  progress(0.2, 'Rendering composite');
  const maxCompat = opts.maximizeCompatibility !== false;
  // CMYK / Lab write their stored values (plate 0 = C'M'Y' or L a b; the K plate is added in post-processing).
  const native = doc.canvas.colorMode === 'cmyk' || doc.canvas.colorMode === 'lab';
  const composite = maxCompat || doc.canvas.colorMode === 'cmyk' ? flattenToPixels(doc, native ? { depth, plate: 0 } : { depth }) : null;
  if (composite && gray) toLuminance(composite.data, depth);
  if (composite && !deep) psd.imageData = { width: composite.width, height: composite.height, data: composite.data as Uint8ClampedArray };

  // Photoshop's Txt2 text data: kept and updated for edited layers when possible (Photoshop then
  // keeps its own text frames). Without it Photoshop asks to update every text layer on open, so a
  // document that has none gets one built on Photoshop's own template. When some text cannot be
  // written exactly the block is dropped and Photoshop rebuilds it from the layers.
  if (!hasTxt2 && newText.length && opts.invalidateText === undefined) {
    const built = patchTxt2(txt2Template(), [], newText.map((l) => ({ text: l.text, fontType: fontTypeFor })));
    if (built) { psd.engineData = toBase64(built); textInvalidated = false; }
  } else if (textInvalidated && typeof srcDoc.engineData === 'string' && opts.invalidateText === undefined) {
    const edits: Txt2Edit[] = [];
    for (const l of doc.walk()) {
      if (l.kind !== 'text' || newText.includes(l)) continue;
      const index = (l.metadata.psd?.source as Ag.Layer | undefined)?.text?.index as number;
      if (l.metadata.psd?.textAtOpen !== JSON.stringify(l.text)) edits.push({ index, text: l.text, fontType: fontTypeFor, sameLayout: sameLayout(l.metadata.psd?.textAtOpen, l.text) });
    }
    const patched = patchTxt2(fromBase64(srcDoc.engineData), edits, newText.map((l) => ({ text: l.text, fontType: fontTypeFor })));
    if (patched) { psd.engineData = toBase64(patched); textInvalidated = false; }
  }

  progress(0.55, 'Writing layers');
  const bottom = doc.root.children[0];
  const bytes = writePsdUint8Array(psd, {
    psb: !!opts.psb,
    noBackground: !(bottom && bottom.name === 'Background' && bottom.locks.position),
    invalidateTextLayers: opts.invalidateText ?? textInvalidated,
    trimImageData: false,
  });
  progress(0.75, 'Preserving Photoshop data');
  const out = postProcess(doc, bytes, idMap, composite, opts);
  progress(1, 'Done');
  return out;
}

function lyid(blocks: { key: string; data: Uint8Array }[]): number | null {
  const b = blocks.find((x) => x.key === 'lyid');
  if (!b || b.data.length < 4) return null;
  return new DataView(b.data.buffer, b.data.byteOffset, b.data.byteLength).getUint32(0);
}

function displayInfoResource(doc: CelenneDocument): Uint8Array {
  // 13-byte records: colour record (10), opacity / solidity (2), kind (1) — as Photoshop writes them.
  const w = new Writer(16 + doc.channels.length * 13);
  w.u32(1);
  for (const c of doc.channels) {
    w.u16(0);
    w.u16(Math.round(c.color.r * 65535)); w.u16(Math.round(c.color.g * 65535)); w.u16(Math.round(c.color.b * 65535)); w.u16(0);
    w.u16(Math.round((c.kind === 'spot' ? c.solidity ?? c.opacity : c.opacity) * 100));
    w.u8(c.kind === 'spot' ? 2 : c.indicatesSelected ? 1 : 0);
  }
  return w.result();
}

function postProcess(doc: CelenneDocument, bytes: Uint8Array, idMap: Map<number, Layer>, composite: { data: PixelArray; width: number; height: number } | null, opts: PsdExportOptions): Uint8Array {
  const c: PsdContainer = parseContainer(bytes);
  const depth = doc.canvas.bitDepth;

  // Per-layer raw blocks.
  for (const rec of c.layers) {
    const id = lyid(rec.blocks);
    const layer = id !== null ? idMap.get(id) : undefined;
    const raw = layer?.metadata.psd?.rawBlocks;
    if (!raw?.length) continue;
    const have = new Set(rec.blocks.map((b) => b.key));
    for (const b of raw) if (!have.has(b.key)) rec.blocks.push({ sig: '8BIM', key: b.key, data: b.data });
  }

  // Type on a path: Photoshop's text data (Txt2) holds the path when it is written. Otherwise
  // Celenne's private block keeps it (Photoshop asks to update text layers that carry this block,
  // so it is written only when Txt2 is not).
  const pathInTxt2 = c.globalBlocks.some((b) => b.key === 'Txt2');
  for (const rec of c.layers) {
    if (pathInTxt2) break;
    const id = lyid(rec.blocks);
    const layer = id !== null ? idMap.get(id) : undefined;
    if (layer?.kind !== 'text' || !layer.text.path) continue;
    const tp = layer.text.path;
    rec.blocks.push({ sig: '8BIM', key: 'lmTP', data: new TextEncoder().encode(JSON.stringify({ v: 1, subpath: { knots: tp.subpath.knots, closed: tp.subpath.closed }, start: tp.start, end: tp.end, flip: tp.flip })) });
  }

  // CMYK Levels / Curves: the Black channel (index 4), which ag-psd does not write.
  if (doc.canvas.colorMode === 'cmyk') {
    for (const rec of c.layers) {
      const id = lyid(rec.blocks);
      const layer = id !== null ? idMap.get(id) : undefined;
      if (layer?.kind !== 'adjustment') continue;
      const a = layer.adjustment;
      if (a.type === 'levels' && a.black) {
        const blk = rec.blocks.find((b) => b.key === 'levl');
        if (blk) blk.data = patchLevlChannel(blk.data, 4, a.black);
      } else if (a.type === 'curves' && a.black) {
        const blk = rec.blocks.find((b) => b.key === 'curv');
        const isId = (p: { x: number; y: number }[]) => p.length === 2 && p[0].x === 0 && p[0].y === 0 && p[1].x === 255 && p[1].y === 255;
        const m = new Map<number, { x: number; y: number }[]>();
        [a.rgb, a.red, a.green, a.blue, a.black].forEach((pts, i) => { if (pts && pts.length && !isId(pts)) m.set(i, pts); });
        if (blk) blk.data = encodeCurv(m);
      }
    }
  }

  // Knockout "deep" (ag-psd writes the knockout flag as 1 = shallow).
  for (const rec of c.layers) {
    const id = lyid(rec.blocks);
    const layer = id !== null ? idMap.get(id) : undefined;
    const knko = rec.blocks.find((b) => b.key === 'knko');
    if (layer?.advanced.knockout === 'deep' && knko?.data.length) { knko.data = knko.data.slice(); knko.data[0] = 2; }
    // Gradient Map method (Photoshop 2023+): version 3 'grdm' with the method code after the flags.
    const grdm = rec.blocks.find((b) => b.key === 'grdm');
    const method = layer?.kind === 'adjustment' && layer.adjustment.type === 'gradientMap' ? layer.adjustment.gradient.interpolation : undefined;
    const code = method ? ({ perceptual: 'Perc', linear: 'Lnr ', classic: 'Gcls', smooth: 'Smoo' } as const)[method] : undefined;
    if (grdm && code && grdm.data.length > 4 && grdm.data[0] === 0 && grdm.data[1] === 1) {
      const d = new Uint8Array(grdm.data.length + 4);
      d.set(grdm.data.subarray(0, 4));
      d[1] = 3;
      for (let k = 0; k < 4; k++) d[4 + k] = code.charCodeAt(k);
      d.set(grdm.data.subarray(4), 8);
      grdm.data = d;
    }
  }

  // Global blocks.
  const haveGlobal = new Set(c.globalBlocks.map((b) => b.key));
  for (const b of doc.psd.rawGlobalBlocks ?? []) if (!haveGlobal.has(b.key)) c.globalBlocks.push({ sig: '8BIM', key: b.key, data: b.data });

  // Resources: ICC, paths, display info, preserved blocks.
  const drop = new Set([1039, 1077, 1025, 2999]);
  c.resources = c.resources.filter((r) => !drop.has(r.id) && !(r.id >= 2000 && r.id <= 2997));
  // Untagged documents stay untagged: embedding the working profile would change their meaning.
  const icc = doc.profile.untagged ? undefined : doc.profile.icc ?? (doc.profile.builtin ? builtinProfileICC(doc.profile.builtin) : undefined);
  // A Grayscale-mode file needs a gray profile.
  const iccOut = icc && doc.canvas.colorMode === 'grayscale' && parseIccInfo(icc)?.colorSpace !== 'GRAY' ? builtinProfileICC('gray22') : icc;
  if (iccOut) c.resources.push({ sig: '8BIM', id: 1039, name: '', data: iccOut });
  if (doc.channels.length) c.resources.push({ sig: '8BIM', id: 1077, name: '', data: displayInfoResource(doc) });
  let pathId = 2000;
  for (const p of doc.paths) {
    const data = writePathRecords(p.path, doc.width, doc.height);
    if (p.kind === 'work') c.resources.push({ sig: '8BIM', id: 1025, name: '', data });
    else c.resources.push({ sig: '8BIM', id: pathId++, name: p.name, data });
    if (p.kind === 'clipping') {
      const w = new Writer(64);
      w.pascal(p.name, 1);
      w.zeros(6); // flatness (fixed) + fill rule
      c.resources.push({ sig: '8BIM', id: 2999, name: '', data: w.result() });
    }
  }
  const haveRes = new Set(c.resources.map((r) => r.id));
  for (const r of doc.psd.rawResources ?? []) if (!haveRes.has(r.id)) c.resources.push({ sig: '8BIM', id: r.id, name: r.name, data: r.data });
  // Photoshop's document metadata (EXIF, print settings, Content Credentials and colour-management
  // settings): updated for this document, or written as Photoshop writes them for a new one.
  writeDocMetadata(c.resources, c.globalBlocks, {
    width: doc.width, height: doc.height, resolution: doc.canvas.resolution,
    colorMode: doc.canvas.duotone ? 'duotone' : doc.canvas.colorMode,
    srgb: !doc.profile.untagged && (doc.profile.builtin === 'srgb' || /sRGB/i.test(doc.profile.name)),
    software: `Celenne Studio ${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''}`.trim(),
    date: opts.now ?? new Date(),
  });
  c.resources.sort((a, b) => a.id - b.id);

  // Merged image data: deep composite, alpha channels and/or Grayscale mode.
  const gray = doc.canvas.colorMode === 'grayscale';
  if (gray) {
    c.colorMode = 1;
    // One color channel per layer (R = G = B = gray, see toLuminance).
    for (const rec of c.layers) rec.channels = rec.channels.filter((ch) => ch.id !== 1 && ch.id !== 2);
    if (!composite && depth === 8 && !doc.channels.length) {
      const planes = decodeMergedChannels(c);
      const keep = [planes[0], ...planes.slice(3)];
      c.channels = keep.length;
      c.imageCompression = 1;
      c.imageData = encodeMergedRLE(keep, doc.width, doc.height, 1, c.version === 2);
    }
  }
  if (depth !== 8 || doc.channels.length || (gray && composite)) {
    const w = doc.width, h = doc.height, n = w * h;
    const bpsOut = depth / 8;
    const planes: Uint8Array[] = [];
    const comp = composite?.data;
    const withAlpha = comp ? hasTransparency(comp) : false;
    const srcChannels = [...(gray ? [0] : [0, 1, 2]), ...(withAlpha ? [3] : [])];
    for (const ch of srcChannels) {
      const p = new Uint8Array(n * bpsOut);
      if (comp) {
        const dv = new DataView(p.buffer);
        const max = depth === 8 ? 255 : depth === 16 ? 65535 : 1;
        for (let i = 0; i < n; i++) {
          let v = comp[i * 4 + ch];
          // Photoshop stores transparent composites matted against white.
          if (withAlpha && ch !== 3) {
            const a = comp[i * 4 + 3] / max;
            v = v * a + max * (1 - a);
            if (depth !== 32) v = Math.round(v);
          }
          if (depth === 8) p[i] = v;
          else if (depth === 16) dv.setUint16(i * 2, v);
          else dv.setFloat32(i * 4, v);
        }
      }
      planes.push(p);
    }
    for (const chn of doc.channels) planes.push(channelPlane(chn, w, h, depth));
    c.channels = planes.length;
    c.mergedAlphaIsTransparency = withAlpha;
    if (depth === 32) {
      c.imageCompression = 0;
      const all = new Uint8Array(planes.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of planes) { all.set(p, o); o += p.length; }
      c.imageData = all;
    } else {
      c.imageCompression = 1;
      c.imageData = encodeMergedRLE(planes, w, h, bpsOut, c.version === 2);
    }
  }
  if (depth !== 8) {
    c.depth = depth;
    // Photoshop stores deep layer records in a global Lr16 / Lr32 block.
    c.layerInfoLocation = depth === 16 ? 'Lr16' : 'Lr32';
  }
  // 32-bit: Photoshop refuses to open a file without its HDR toning block in the colour-mode data.
  if (depth === 32) c.colorModeData = doc.psd.hdrColorModeData?.slice() ?? defaultHdrColorModeData();
  if (doc.canvas.colorMode === 'indexed' || doc.canvas.colorMode === 'bitmap') writeSingleLayerMode(doc, c);
  if (doc.canvas.colorMode === 'multichannel') writeMultichannel(doc, c);
  if (gray && doc.canvas.duotone) {
    // Duotone: the Grayscale data with the ink specification; Duotone files carry no ICC profile.
    c.colorMode = 8;
    c.colorModeData = encodeDuotone(doc.canvas.duotone);
    c.resources = c.resources.filter((r) => r.id !== 1039 && r.id !== 1066);
    c.resources.push({ sig: '8BIM', id: 1066, name: '', data: alternateDuotoneResource(doc.canvas.duotone) });
    c.resources.sort((a, b) => a.id - b.id);
  }
  if (doc.canvas.colorMode === 'cmyk') writeCmyk(doc, c, idMap, composite);
  if (doc.canvas.colorMode === 'lab') {
    // Lab: the stored L a b channels are Photoshop's encoding; Lab files carry no ICC profile.
    c.colorMode = 9;
    c.resources = c.resources.filter((r) => r.id !== 1039);
  }
  void opts;
  return serializeContainer(c);
}

/** A channel as a merged-image plane at the file's depth (channels may be 8 or 16-bit rasters). */
function channelPlane(chn: AlphaChannel, w: number, h: number, depth: BitDepth): Uint8Array {
  const n = w * h;
  const v = chn.raster.readFloat({ x: 0, y: 0, w, h });
  const p = new Uint8Array(n * (depth / 8));
  const dv = new DataView(p.buffer);
  for (let i = 0; i < n; i++) {
    const f = v[i] < 0 ? 0 : v[i] > 1 ? 1 : v[i];
    if (depth === 8) p[i] = Math.round(f * 255);
    else if (depth === 16) dv.setUint16(i * 2, Math.round(f * 65535));
    else dv.setFloat32(i * 4, f);
  }
  return p;
}

/**
 * Multichannel files have no layers and no composite colour channels: the merged image is the
 * channels themselves (names in 1006 / 1045, ink colours in 1077).
 */
function writeMultichannel(doc: CelenneDocument, c: PsdContainer): void {
  const w = doc.width, h = doc.height;
  const depth = doc.canvas.bitDepth === 32 ? 16 : doc.canvas.bitDepth;
  c.layers = [];
  c.globalBlocks = c.globalBlocks.filter((b) => !['Lr16', 'Lr32', 'Layr', 'Txt2'].includes(b.key));
  c.layerInfoLocation = 'section';
  c.colorMode = 7;
  c.depth = depth;
  c.colorModeData = new Uint8Array(0);
  c.mergedAlphaIsTransparency = false;
  c.resources = c.resources.filter((r) => r.id !== 1039);
  const planes = doc.channels.map((chn) => channelPlane(chn, w, h, depth));
  if (!planes.length) planes.push(new Uint8Array(w * h * (depth / 8)).fill(255));
  c.channels = planes.length;
  c.imageCompression = 1;
  c.imageData = encodeMergedRLE(planes, w, h, depth / 8, c.version === 2);
}

/**
 * Indexed Color / Bitmap files are flat in Photoshop: no layer records, one merged channel of
 * palette indices (with the colour table in the colour-mode data) or packed 1-bit pixels.
 */
function writeSingleLayerMode(doc: CelenneDocument, c: PsdContainer): void {
  const w = doc.width, h = doc.height, n = w * h;
  const px = to8(flattenToPixels(doc, { depth: 8 }).data);
  c.layers = [];
  c.globalBlocks = c.globalBlocks.filter((b) => !['Lr16', 'Lr32', 'Layr', 'Txt2', 'Patt', 'Pat2', 'Pat3'].includes(b.key));
  c.layerInfoLocation = 'section';
  c.channels = 1;
  c.mergedAlphaIsTransparency = false;
  c.imageCompression = 1;
  c.resources = c.resources.filter((r) => r.id !== 1046 && r.id !== 1047 && r.id !== 1036);
  if (doc.canvas.colorMode === 'bitmap') {
    c.colorMode = 0;
    c.depth = 1;
    c.colorModeData = new Uint8Array(0);
    c.resources = c.resources.filter((r) => r.id !== 1039); // Bitmap files carry no profile.
    const rowBytes = Math.ceil(w / 8);
    const plane = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = px[i + 3] / 255;
      const l = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) * a + 255 * (1 - a);
      if (l < 127.5) plane[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7); // 1 = black
    }
    c.imageData = encodeMergedRLE([plane], rowBytes, h, 1, c.version === 2);
    return;
  }
  const table = doc.canvas.colorTable ?? [0, 0, 0, 255, 255, 255];
  const count = Math.min(256, Math.floor(table.length / 3));
  const transparent = !!doc.canvas.colorTableTransparent && count < 256;
  c.colorMode = 2;
  c.depth = 8;
  const cmd = new Uint8Array(768);
  for (let i = 0; i < count; i++) { cmd[i] = table[i * 3]; cmd[256 + i] = table[i * 3 + 1]; cmd[512 + i] = table[i * 3 + 2]; }
  c.colorModeData = cmd;
  const np = new NearestPalette(table.slice(0, count * 3));
  const lookup = new Map<number, number>();
  const plane = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (transparent && px[i * 4 + 3] < 128) { plane[i] = count; continue; }
    const k = (px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2];
    let v = lookup.get(k);
    if (v === undefined) { v = np.exact(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]); lookup.set(k, v); }
    plane[i] = v;
  }
  const u16 = (v: number) => new Uint8Array([v >> 8, v & 255]);
  c.resources.push({ sig: '8BIM', id: 1046, name: '', data: u16(count + (transparent ? 1 : 0)) });
  if (transparent) c.resources.push({ sig: '8BIM', id: 1047, name: '', data: u16(count) });
  c.resources.sort((a, b) => a.id - b.id);
  c.imageData = encodeMergedRLE([plane], w, h, 1, c.version === 2);
}

export function toPsdBytes8(data: PixelArray): Uint8ClampedArray {
  return to8(data);
}

function sliceKey(list: SliceDef[]): string {
  return JSON.stringify(list.map((s) => [s.name, s.rect.x, s.rect.y, s.rect.w, s.rect.h, s.url ?? '', s.target ?? '', s.altTag ?? '', s.message ?? '']));
}

function slicesToPsd(doc: CelenneDocument): NonNullable<Ag.ImageResources['slices']> {
  const whole = { left: 0, top: 0, right: doc.width, bottom: doc.height };
  type AgSlice = NonNullable<Ag.ImageResources['slices']>[number]['slices'][number];
  const base = (id: number, origin: AgSlice['origin'], bounds: typeof whole): AgSlice => ({
    id, groupId: 0, origin, associatedLayerId: 0, type: 'image', bounds, url: '', target: '', message: '', altTag: '',
    cellTextIsHTML: true, cellText: '', horizontalAlignment: 'default', verticalAlignment: 'default', backgroundColorType: 'none', backgroundColor: { r: 0, g: 0, b: 0, a: 0 },
  });
  const used = new Set<number>([0]);
  const slices: AgSlice[] = [base(0, 'autoGenerated', whole)];
  for (const s of doc.slices) {
    let id = s.psdId && !used.has(s.psdId) ? s.psdId : 1;
    while (used.has(id)) id++;
    used.add(id);
    const b = { left: s.rect.x, top: s.rect.y, right: s.rect.x + s.rect.w, bottom: s.rect.y + s.rect.h };
    slices.push({ ...base(id, 'userGenerated', b), ...(s.preserved as Partial<AgSlice> | undefined), id, origin: 'userGenerated', bounds: b, name: s.name, url: s.url ?? '', target: s.target ?? '', altTag: s.altTag ?? '', message: s.message ?? '' });
  }
  return [{ bounds: whole, groupName: doc.name.replace(/\.[^.]+$/, ''), slices }];
}

/** JPEG thumbnail of the composite (Photoshop's resource 1036), longest side ≤ 160 px. */
function thumbnailJpeg(doc: CelenneDocument): { width: number; height: number; data: Uint8Array } | null {
  if (doc.width < 1 || doc.height < 1) return null;
  const level = Math.max(0, Math.ceil(Math.log2(Math.max(doc.width, doc.height) / 160)));
  const ls = 1 << level;
  const r = { x: 0, y: 0, w: Math.max(1, Math.ceil(doc.width / ls)), h: Math.max(1, Math.ceil(doc.height / ls)) };
  let px = compositeRegion(doc, r, { level });
  if (isCmykDoc(doc) || isLabDoc(doc)) {
    // The thumbnail shows the appearance (sRGB).
    const n = r.w * r.h;
    const plates = compositeRegionPlates(doc, r, { level });
    for (const p of plates) for (let i = 0; i < n; i++) { const a = p[i * 4 + 3]; if (a > 1e-7) { p[i * 4] /= a; p[i * 4 + 1] /= a; p[i * 4 + 2] /= a; } }
    px = platesToRgb(doc, plates, n);
    for (let i = 0; i < n; i++) { const a = px[i * 4 + 3]; px[i * 4] *= a; px[i * 4 + 1] *= a; px[i * 4 + 2] *= a; }
  } else if (hasInkAppearance(doc)) {
    const n = r.w * r.h;
    for (let i = 0; i < n; i++) { const a = px[i * 4 + 3]; if (a > 1e-7) { px[i * 4] /= a; px[i * 4 + 1] /= a; px[i * 4 + 2] /= a; } }
    applyInkAppearance(doc, px, r, level, false);
    for (let i = 0; i < n; i++) { const a = px[i * 4 + 3]; px[i * 4] *= a; px[i * 4 + 1] *= a; px[i * 4 + 2] *= a; }
  }
  const k = Math.min(1, 160 / Math.max(r.w, r.h));
  const w = Math.max(1, Math.round(r.w * k)), h = Math.max(1, Math.round(r.h * k));
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (Math.min(r.h - 1, Math.floor(y / k)) * r.w + Math.min(r.w - 1, Math.floor(x / k))) * 4, o = (y * w + x) * 4;
      const a = px[i + 3];
      // Premultiplied → straight, then the encoder mattes against white.
      for (let c = 0; c < 3; c++) rgba[o + c] = a > 1e-6 ? (px[i + c] / a) * 255 : 0;
      rgba[o + 3] = a * 255;
    }
  return { width: w, height: h, data: encodeJpeg(w, h, rgba, 80) };
}

/** Sets R = G = B = luminance in place (interleaved RGBA; Grayscale-mode export). */
function toLuminance(px: PixelArray, depth: BitDepth): void {
  const round = depth !== 32;
  for (let i = 0; i < px.length; i += 4) {
    let g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (round) g = Math.round(g);
    px[i] = px[i + 1] = px[i + 2] = g;
  }
}

/** One channel payload (2-byte compression + data) from channel 0 of interleaved RGBA samples. */
function channelPayload(px: PixelArray, w: number, h: number, depth: BitDepth): Uint8Array {
  if (depth !== 8) return encodeDeepChannel(px, w, h, 4, 0, depth);
  const out = new Uint8Array(w * h + 2); // compression 0 = raw
  for (let i = 0; i < w * h; i++) out[i + 2] = px[i * 4] as number;
  return out;
}

/**
 * CMYK: ag-psd wrote plate 0 (C'M'Y', which is how Photoshop stores inverted ink) as RGB. Every
 * layer gets its K channel (id 3) from the companion plate, the merged image gets four colour
 * planes, and the colour mode becomes CMYK.
 */
function writeCmyk(doc: CelenneDocument, c: PsdContainer, idMap: Map<number, Layer>, composite: { data: PixelArray; width: number; height: number } | null): void {
  const depth = doc.canvas.bitDepth;
  const max = depth === 8 ? 255 : depth === 16 ? 65535 : 1;
  for (const rec of c.layers) {
    if (!rec.channels.some((ch) => ch.id >= 0 && ch.id <= 2)) continue;
    const w = rec.right - rec.left, h = rec.bottom - rec.top;
    if (w <= 0 || h <= 0) { rec.channels.push({ id: 3, data: new Uint8Array(2) }); continue; }
    const id = lyid(rec.blocks);
    const layer = id !== null ? idMap.get(id) : undefined;
    let px: PixelArray;
    if (layer && hasRaster(layer) && layer.raster.companion) {
      px = layer.raster.companion.readPixels({ x: rec.left - layer.x, y: rec.top - layer.y, w, h });
    } else {
      px = depth === 8 ? new Uint8ClampedArray(w * h * 4) : depth === 16 ? new Uint16Array(w * h * 4) : new Float32Array(w * h * 4);
      px.fill(max); // no black ink
    }
    const at = rec.channels.findIndex((ch) => ch.id === 2);
    rec.channels.splice(at + 1, 0, { id: 3, data: channelPayload(px, w, h, depth) });
  }
  // Merged image: C' M' Y' K' (+ transparency + alpha channels), matted on paper white.
  const w = doc.width, h = doc.height, n = w * h;
  const bps = depth / 8;
  const p0 = composite?.data ?? flattenToPixels(doc, { depth, plate: 0 }).data;
  const p1 = flattenToPixels(doc, { depth, plate: 1 }).data;
  const withAlpha = hasTransparency(p0);
  const plane = (src: PixelArray, ch: number, alpha: boolean) => {
    const out = new Uint8Array(n * bps);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < n; i++) {
      let v = src[i * 4 + ch] as number;
      if (alpha) { const a = (p0[i * 4 + 3] as number) / max; v = v * a + max * (1 - a); if (depth !== 32) v = Math.round(v); }
      if (depth === 8) out[i] = v;
      else if (depth === 16) dv.setUint16(i * 2, v);
      else dv.setFloat32(i * 4, v);
    }
    return out;
  };
  const planes = [plane(p0, 0, withAlpha), plane(p0, 1, withAlpha), plane(p0, 2, withAlpha), plane(p1, 0, withAlpha)];
  if (withAlpha) planes.push(plane(p0, 3, false));
  for (const chn of doc.channels) {
    const v = chn.raster.readPixels({ x: 0, y: 0, w, h }) as Uint8ClampedArray;
    const p = new Uint8Array(n * bps);
    const dv = new DataView(p.buffer);
    for (let i = 0; i < n; i++) {
      if (depth === 8) p[i] = v[i];
      else if (depth === 16) dv.setUint16(i * 2, v[i] * 257);
      else dv.setFloat32(i * 4, v[i] / 255);
    }
    planes.push(p);
  }
  c.colorMode = 4;
  c.channels = planes.length;
  c.mergedAlphaIsTransparency = withAlpha;
  if (depth === 32) {
    c.imageCompression = 0;
    const all = new Uint8Array(planes.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of planes) { all.set(p, o); o += p.length; }
    c.imageData = all;
  } else {
    c.imageCompression = 1;
    c.imageData = encodeMergedRLE(planes, w, h, bps, c.version === 2);
  }
}

/**
 * The colour-mode data Photoshop 26.5 writes for a new 32-bit document: its default HDR toning
 * settings ('hdrt', with the "Linear" preset name, and 'hdra'). Without a block like this,
 * Photoshop refuses the file ("the open options are incorrect").
 */
function defaultHdrColorModeData(): Uint8Array {
  return Uint8Array.from(atob('aGRydAAAAAM+a4UfAAAAAgAAAAcATABpAG4AZQBhAHIAAAACAAIAAAAAAP8A/wEBAAAAAAAAAABBgAAAAAAAAQAAAAA/gAAAaGRyYQAAAAYAAAAAQaAAAEHwAAAAAAAAAAAAAD+AAAAAAAAAAAA='), (c) => c.charCodeAt(0));
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Whether a text edit leaves the layout as it was (only colours or the transform changed). */
function sameLayout(atOpen: string | undefined, now: TextData): boolean {
  if (!atOpen) return false;
  const key = (t: TextData) => JSON.stringify({ ...t, transform: null, runs: t.runs.map((r) => ({ length: r.length, style: { ...r.style, color: null } })) });
  try { return key(JSON.parse(atOpen) as TextData) === key(now); } catch { return false; }
}
