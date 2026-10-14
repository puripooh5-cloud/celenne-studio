/** Cached geometric bounds of layers (document px). */
import type { Layer } from '../document/types';
import { hasRaster } from '../document/types';
import type { Rect } from '../image-engine/rect';
import { expand, translate, union } from '../image-engine/rect';
import type { TiledRaster } from '../image-engine/tiledRaster';
import { effectsExtent } from '../effects/render';
import { hasEnabledEffect } from '../effects/types';
import { pathBounds } from '../vector/rasterize';

const rasterCache = new WeakMap<TiledRaster, { version: number; bounds: Rect | null }>();

export function rasterContentBounds(r: TiledRaster): Rect | null {
  const hit = rasterCache.get(r);
  if (hit && hit.version === r.version) return hit.bounds;
  const bounds = r.contentBounds();
  rasterCache.set(r, { version: r.version, bounds });
  return bounds;
}

/**
 * Bounds of the layer's own content (document px). `null` = unbounded (adjustment / fill layers
 * without a mask) or empty.
 */
export function layerContentBounds(layer: Layer): Rect | null {
  if (hasRaster(layer)) {
    const b = rasterContentBounds(layer.raster);
    return b ? translate(b, layer.x, layer.y) : null;
  }
  if (layer.kind === 'group') {
    let u: Rect | null = null;
    for (const c of layer.children) if (c.visible) u = union(u, layerVisualBounds(c) ?? undefined);
    return u;
  }
  // Adjustment/fill layers: limited by their masks when present.
  if (layer.vectorMask?.enabled && !layer.vectorMask.invert) return pathBounds(layer.vectorMask.path);
  if (layer.mask?.enabled && layer.mask.raster.fill === 0) {
    const b = rasterContentBounds(layer.mask.raster);
    return b ? translate(b, layer.mask.x, layer.mask.y) : null;
  }
  return null;
}

/** Content bounds grown by layer effects. `null` means "whole canvas". */
export function layerVisualBounds(layer: Layer): Rect | null {
  const b = layerContentBounds(layer);
  if (!b) return null;
  return hasEnabledEffect(layer.effects) ? expand(b, effectsExtent(layer.effects)) : b;
}

export function isUnbounded(layer: Layer): boolean {
  return (layer.kind === 'adjustment' || layer.kind === 'fill') && layerContentBounds(layer) === null;
}
