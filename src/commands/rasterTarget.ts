/** Addresses any editable pixel buffer in a document (layer pixels, mask, alpha channel, selection). */
import type { CelenneDocument } from '../document/document';
import type { LayerId } from '../document/types';
import { hasRaster } from '../document/types';
import type { TiledRaster } from '../image-engine/tiledRaster';

export type RasterTarget =
  | { kind: 'layer'; layerId: LayerId }
  | { kind: 'mask'; layerId: LayerId }
  | { kind: 'channel'; channelId: string }
  | { kind: 'selection' };

export interface ResolvedTarget {
  raster: TiledRaster;
  /** Offset of raster local coordinates in document space. */
  x: number;
  y: number;
  channels: 1 | 4;
}

export function resolveTarget(doc: CelenneDocument, t: RasterTarget): ResolvedTarget | null {
  switch (t.kind) {
    case 'layer': {
      const l = doc.getLayer(t.layerId);
      if (!l || !hasRaster(l)) return null;
      return { raster: l.raster, x: l.x, y: l.y, channels: 4 };
    }
    case 'mask': {
      const l = doc.getLayer(t.layerId);
      if (!l?.mask) return null;
      return { raster: l.mask.raster, x: l.mask.x, y: l.mask.y, channels: 1 };
    }
    case 'channel': {
      const c = doc.channels.find((c) => c.id === t.channelId);
      return c ? { raster: c.raster, x: 0, y: 0, channels: 1 } : null;
    }
    case 'selection':
      return { raster: doc.selection.mask, x: 0, y: 0, channels: 1 };
  }
}

export function sameTarget(a: RasterTarget, b: RasterTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'layer' || a.kind === 'mask') return a.layerId === (b as typeof a).layerId;
  if (a.kind === 'channel') return a.channelId === (b as typeof a).channelId;
  return true;
}

/** Emits the right change notification for a target region (doc coords). */
export function emitTargetChange(doc: CelenneDocument, t: RasterTarget, rect: { x: number; y: number; w: number; h: number } | null): void {
  switch (t.kind) {
    case 'layer': {
      const l = doc.getLayer(t.layerId);
      if (l) l.rev++;
      doc.emit({ type: 'pixels', layerId: t.layerId, rect });
      break;
    }
    case 'mask': {
      const l = doc.getLayer(t.layerId);
      if (l) l.rev++;
      doc.emit({ type: 'mask', layerId: t.layerId, rect });
      break;
    }
    case 'channel':
      doc.emit({ type: 'channels' });
      break;
    case 'selection':
      doc.emit({ type: 'selection' });
      break;
  }
}
