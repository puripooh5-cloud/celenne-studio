/**
 * Selection: a sparse single-channel coverage raster in document coordinates (0 = unselected,
 * 1 = selected, fractional = anti-aliased / feathered). "Select All" and "Invert" flip the
 * raster's fill value instead of allocating canvas-sized buffers, so even 16K documents keep
 * selections cheap.
 */
import { intersect, isEmpty, Rect } from '../image-engine/rect';
import { RasterSnapshot, TiledRaster } from '../image-engine/tiledRaster';

export type SelectionOp = 'replace' | 'add' | 'subtract' | 'intersect';

export class Selection {
  mask = new TiledRaster(1, 8, 0);
  private cachedBounds: { version: number; canvas: string; value: Rect | null } | null = null;
  /**
   * Set while selected pixels are being moved: the outline is the outline the mask had at
   * `baseVersion`, shifted by (dx, dy); the mask itself is that outline shifted by (mdx, mdy)
   * (during a drag it is written only when the drag ends). Valid while the mask's version is
   * `version`. Lets the marching ants follow a drag without re-tracing the outline every frame.
   */
  moved: { version: number; baseVersion: number; dx: number; dy: number; mdx: number; mdy: number } | null = null;

  /** The current outline as a shifted earlier one, or null. */
  movedOutline(): { baseVersion: number; dx: number; dy: number; mdx: number; mdy: number } | null {
    const m = this.moved;
    return m && m.version === this.mask.version ? m : null;
  }

  get version(): number {
    return this.mask.version;
  }

  isEmpty(): boolean {
    return this.mask.fill === 0 && this.mask.tiles.size === 0;
  }

  /** Bounds of the selected area, clipped to the canvas. */
  bounds(canvas: Rect): Rect | null {
    const ck = `${canvas.x},${canvas.y},${canvas.w},${canvas.h}`;
    if (this.cachedBounds && this.cachedBounds.version === this.mask.version && this.cachedBounds.canvas === ck) return this.cachedBounds.value;
    let value: Rect | null;
    if (this.mask.fill > 0) value = { ...canvas };
    else {
      const b = this.mask.contentBounds();
      value = b ? intersect(b, canvas) : null;
      if (value && isEmpty(value)) value = null;
    }
    this.cachedBounds = { version: this.mask.version, canvas: ck, value };
    return value;
  }

  snapshot(): RasterSnapshot {
    return this.mask.snapshot();
  }

  restore(s: RasterSnapshot): void {
    this.mask.restore(s);
  }

  clear(): void {
    this.mask.clear(0);
  }

  selectAll(): void {
    this.mask.clear(1);
  }

  invert(): void {
    const m = this.mask;
    for (const [k, t] of m.tiles) {
      const w = m.writableTile(...keyXY(k));
      const d = w.data;
      for (let i = 0; i < d.length; i++) d[i] = 255 - t.data[i];
    }
    m.fill = 1 - m.fill;
    m.touch();
  }

  /** Reads coverage (0..1) for a region. */
  read(r: Rect, out?: Float32Array): Float32Array {
    return this.mask.readFloat(r, 0, out);
  }

  coverageAt(x: number, y: number): number {
    return this.mask.readFloat({ x: Math.floor(x), y: Math.floor(y), w: 1, h: 1 })[0];
  }

  /**
   * Combines a coverage region with the current selection.
   * `coverage` covers `r`; everything outside `r` counts as 0 for the new shape.
   */
  combine(r: Rect, coverage: Float32Array, op: SelectionOp): void {
    if (op === 'replace') {
      this.mask.clear(0);
      this.mask.writeFloat(r, coverage);
      this.mask.compact();
      return;
    }
    if (op === 'intersect') {
      const old = this.mask.readFloat(r);
      for (let i = 0; i < old.length; i++) old[i] = Math.min(old[i], coverage[i]);
      this.mask.clear(0);
      this.mask.writeFloat(r, old);
      this.mask.compact();
      return;
    }
    const old = this.mask.readFloat(r);
    if (op === 'add') for (let i = 0; i < old.length; i++) old[i] = Math.max(old[i], coverage[i]);
    else for (let i = 0; i < old.length; i++) old[i] = old[i] * (1 - coverage[i]);
    this.mask.writeFloat(r, old);
    this.mask.compact();
  }

  /** Replaces the whole selection with a dense region (outside = unselected). */
  setRegion(r: Rect, coverage: Float32Array): void {
    this.mask.clear(0);
    this.mask.writeFloat(r, coverage);
    this.mask.compact();
  }
}

function keyXY(k: number): [number, number] {
  return [(k % 65536) - 32768, Math.floor(k / 65536) - 32768];
}
