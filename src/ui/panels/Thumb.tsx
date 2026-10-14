/** Layer / mask / channel thumbnails computed from mip levels, cached by revision. */
import { rasterAppearance } from '../../color/plates';
import { useEffect, useRef } from 'react';
import type { CelenneDocument } from '../../document/document';
import type { Layer } from '../../document/types';
import { hasRaster } from '../../document/types';
import type { TiledRaster } from '../../image-engine/tiledRaster';
import { rasterContentBounds } from '../../rendering/bounds';
import { Icon } from '../icons';

const cache = new WeakMap<object, { key: string; data: ImageData }>();
const queue: (() => void)[] = [];
let scheduled = false;
function schedule(fn: () => void) {
  queue.push(fn);
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    const start = performance.now();
    while (queue.length && performance.now() - start < 8) queue.shift()!();
    if (queue.length) setTimeout(run, 16);
    else scheduled = false;
  };
  setTimeout(run, 30);
}

/** Renders a raster region into a small ImageData (fit into size×size, keeping aspect). */
function rasterThumb(raster: TiledRaster, region: { x: number; y: number; w: number; h: number }, size: number, gray: boolean, doc?: CelenneDocument): ImageData {
  const scale = Math.min(size / region.w, size / region.h, 1);
  const level = Math.max(0, Math.min(10, Math.floor(Math.log2(1 / Math.max(scale, 1e-6)))));
  const s = 1 << level;
  const r = { x: Math.floor(region.x / s), y: Math.floor(region.y / s), w: Math.max(1, Math.ceil(region.w / s)), h: Math.max(1, Math.ceil(region.h / s)) };
  // CMYK / Lab layers show their appearance.
  const px = doc && raster.channels === 4 && !gray ? rasterAppearance(doc, raster, r, level) : raster.readFloat(r, level);
  const tw = Math.max(1, Math.round(region.w * scale)), th = Math.max(1, Math.round(region.h * scale));
  const out = new ImageData(tw, th);
  const ch = raster.channels;
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(r.w - 1, Math.floor((x / tw) * r.w)), sy = Math.min(r.h - 1, Math.floor((y / th) * r.h));
      const i = (sy * r.w + sx) * ch, o = (y * tw + x) * 4;
      if (ch === 1 || gray) {
        const v = px[i] * 255;
        out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
        out.data[o + 3] = 255;
      } else {
        out.data[o] = px[i] * 255; out.data[o + 1] = px[i + 1] * 255; out.data[o + 2] = px[i + 2] * 255; out.data[o + 3] = px[i + 3] * 255;
      }
    }
  return out;
}

export function LayerThumb({ doc, layer, kind, size = 32, selected, onClick }: { doc: CelenneDocument; layer: Layer; kind: 'layer' | 'mask'; size?: number; selected?: boolean; onClick?: (e: React.MouseEvent) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const target = kind === 'mask' ? layer.mask?.raster : hasRaster(layer) ? layer.raster : null;
  const key = `${layer.rev}:${target?.version}:${target?.companion?.version ?? ''}:${doc.width}x${doc.height}:${doc.canvas.colorMode}`;
  useEffect(() => {
    if (!target) return;
    let alive = true;
    const draw = (img: ImageData) => {
      const c = ref.current;
      if (!c || !alive) return;
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d')!.putImageData(img, 0, 0);
    };
    const hit = cache.get(target);
    if (hit && hit.key === key) {
      draw(hit.data);
      return;
    }
    schedule(() => {
      if (!alive) return;
      // Thumbnails show the layer relative to the canvas (like professional editors).
      const region = kind === 'mask' ? { x: -layer.mask!.x, y: -layer.mask!.y, w: doc.width, h: doc.height } : { x: -layer.x, y: -layer.y, w: doc.width, h: doc.height };
      if (kind === 'layer' && !rasterContentBounds(target)) {
        const empty = new ImageData(Math.max(1, Math.round(size * Math.min(1, doc.width / doc.height))), Math.max(1, Math.round(size * Math.min(1, doc.height / doc.width))));
        cache.set(target, { key, data: empty });
        draw(empty);
        return;
      }
      const img = rasterThumb(target, region, size * 2, kind === 'mask', doc);
      cache.set(target, { key, data: img });
      draw(img);
    });
    return () => { alive = false; };
  }, [key, target, kind, size]);
  if (!target) {
    const icon = layer.kind === 'adjustment' ? 'adjust' : layer.kind === 'fill' ? 'fill' : layer.kind === 'group' ? 'folder' : 'newLayer';
    return (
      <div className={`thumb icon${selected ? ' target' : ''}`} onClick={onClick} style={{ width: size, height: size }}>
        {layer.kind === 'fill' && layer.fill.type === 'solid' ? <div style={{ width: '100%', height: '100%', background: `rgb(${layer.fill.color.r * 255},${layer.fill.color.g * 255},${layer.fill.color.b * 255})` }} /> : <Icon name={icon} size={18} />}
      </div>
    );
  }
  return (
    <div className={`thumb${kind === 'mask' ? ' mask' : ''}${selected ? ' target' : ''}`} onClick={onClick} style={{ width: size, height: size }}>
      <canvas ref={ref} width={1} height={1} />
    </div>
  );
}

export function RasterThumb({ raster, width, height, size = 32 }: { raster: TiledRaster; width: number; height: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const key = raster.version;
  useEffect(() => {
    schedule(() => {
      const c = ref.current;
      if (!c) return;
      const img = rasterThumb(raster, { x: 0, y: 0, w: width, h: height }, size * 2, true);
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d')!.putImageData(img, 0, 0);
    });
  }, [key, raster, width, height, size]);
  return (
    <div className="thumb mask" style={{ width: size, height: size }}>
      <canvas ref={ref} width={1} height={1} />
    </div>
  );
}
