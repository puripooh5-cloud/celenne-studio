/**
 * Cheap structural cloning of layers and whole document states.
 * Rasters are cloned copy-on-write (tile references are shared), everything else is deep-copied.
 */
import type { CelenneDocument } from './document';
import type { AlphaChannel, CanvasInfo, ColorProfileRef, GroupLayer, Guide, Layer, SavedPath, SliceDef } from './types';
import type { RasterSnapshot } from '../image-engine/tiledRaster';
import { newId } from './ids';

function cloneValue<T>(v: T): T {
  return v === undefined || v === null ? v : structuredClone(v);
}

/** Deep clone of a layer (and children). `freshIds` gives the copy new ids (duplicate layer). */
export function cloneLayer<T extends Layer>(layer: T, freshIds = false): T {
  const { parent: _parent, metadata, mask, raster: _r, children: _c, ...rest } = layer as Layer & { raster?: unknown; children?: unknown };
  const out = cloneValue(rest) as unknown as T;
  out.parent = null;
  out.metadata = { unsupported: [...metadata.unsupported], psd: metadata.psd, custom: metadata.custom ? { ...metadata.custom } : undefined };
  out.mask = mask ? { ...mask, raster: mask.raster.clone() } : null;
  if ('raster' in layer) (out as unknown as { raster: unknown }).raster = (layer as { raster: { clone(): unknown } }).raster.clone();
  if (layer.kind === 'group') {
    const g = out as unknown as GroupLayer;
    g.children = layer.children.map((c) => {
      const cc = cloneLayer(c, freshIds);
      cc.parent = g;
      return cc;
    });
  }
  if (freshIds) {
    out.id = newId('layer');
    if (out.metadata.psd) out.metadata = { ...out.metadata, psd: { ...out.metadata.psd, psdId: undefined } };
  }
  return out;
}

export interface DocumentState {
  canvas: CanvasInfo;
  profile: ColorProfileRef;
  root: GroupLayer;
  channels: AlphaChannel[];
  paths: SavedPath[];
  guides: Guide[];
  slices: SliceDef[];
  selection: RasterSnapshot;
  smartSources: CelenneDocument['smartSources'];
  patterns: CelenneDocument['patterns'];
}

function cloneChannels(ch: AlphaChannel[]): AlphaChannel[] {
  return ch.map((c) => ({ ...c, color: { ...c.color }, raster: c.raster.clone() }));
}

export function captureState(doc: CelenneDocument): DocumentState {
  return {
    canvas: { ...doc.canvas },
    profile: { ...doc.profile },
    root: cloneLayer(doc.root),
    channels: cloneChannels(doc.channels),
    paths: structuredClone(doc.paths),
    guides: structuredClone(doc.guides),
    slices: structuredClone(doc.slices),
    selection: doc.selection.snapshot(),
    smartSources: new Map(doc.smartSources),
    patterns: new Map(doc.patterns),
  };
}

export function restoreState(doc: CelenneDocument, s: DocumentState): void {
  doc.canvas = { ...s.canvas };
  doc.profile = { ...s.profile };
  doc.root = cloneLayer(s.root);
  doc.root.parent = null;
  bumpRevs(doc.root);
  doc.channels = cloneChannels(s.channels);
  doc.paths = structuredClone(s.paths);
  doc.guides = structuredClone(s.guides);
  doc.slices = structuredClone(s.slices ?? []);
  doc.selection.restore(s.selection);
  doc.smartSources = new Map(s.smartSources);
  doc.patterns = new Map(s.patterns);
}

function bumpRevs(g: GroupLayer) {
  g.rev++;
  for (const c of g.children) {
    c.rev++;
    if (c.kind === 'group') bumpRevs(c);
  }
}
