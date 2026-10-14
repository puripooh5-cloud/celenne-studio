/**
 * TiledRaster — the storage primitive for every pixel buffer in a document
 * (layer pixels, masks, selections, alpha channels, render caches).
 *
 *  - Sparse: only tiles that were written exist; absent tiles read as `fill`.
 *  - Copy-on-write: tiles are immutable once a snapshot references them. `snapshot()` is O(tiles)
 *    reference copying, never pixel copying. This gives the history system tile-level deltas
 *    for free (only tiles modified after a snapshot are duplicated).
 *  - Bit depth aware: 8-bit (Uint8ClampedArray), 16-bit (Uint16Array), 32-bit float (Float32Array).
 *  - Pyramid: lazily built, cached mip levels (2× box reduction, premultiplied) used for
 *    zoomed-out viewport rendering. Cache entries are validated by child identity, so edits
 *    invalidate exactly the affected pyramid branches.
 */
import { allocPixels, BitDepth, fromFloat, maxValue, PixelArray, toFloat } from './pixels';
import { intersect, isEmpty, Rect } from './rect';

export const TILE_SIZE = 256;
const TS = TILE_SIZE;

let genCounter = 1;
/** Globally increasing generation counter (guarantees no accidental generation collisions). */
export function nextGen(): number {
  return ++genCounter;
}

/**
 * Pages tile data to the scratch disk (see history/scratch.ts). Installed by the app; absent in
 * tests and in the browser build, where every tile stays resident.
 */
export interface TilePager {
  /** Synchronously reads paged-out tile bytes back. */
  readSync(key: string): Uint8Array | null;
}
let pager: TilePager | null = null;
export function setTilePager(p: TilePager | null): void {
  pager = p;
}

export type TileStorage = 'u8' | 'u16' | 'f32';

export class Tile {
  private _data: PixelArray | null;
  /** Scratch key while the pixel data lives on disk only. */
  pagedKey: string | null = null;
  storage: TileStorage = 'u8';
  /** Increments whenever the tile is handed out for writing (in-place edits keep its identity). */
  rev = 0;
  constructor(
    data: PixelArray,
    public gen: number,
  ) {
    this._data = data;
  }

  /** Pixel data (loaded back from the scratch disk on first access after paging out). */
  get data(): PixelArray {
    if (!this._data) {
      const bytes = this.pagedKey && pager ? pager.readSync(this.pagedKey) : null;
      if (!bytes) throw new Error('A history tile could not be read back from the scratch disk.');
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      this._data = this.storage === 'u16' ? new Uint16Array(buf) : this.storage === 'f32' ? new Float32Array(buf) : new Uint8ClampedArray(buf);
    }
    return this._data;
  }

  get resident(): boolean {
    return !!this._data;
  }

  /** Drops the in-memory copy after its bytes were written to the scratch disk under `key`. */
  evict(key: string): void {
    const d = this._data;
    if (!d) return;
    this.storage = d instanceof Uint16Array ? 'u16' : d instanceof Float32Array ? 'f32' : 'u8';
    this.pagedKey = key;
    this._data = null;
  }
}

interface MipEntry {
  data: PixelArray;
  src: (Tile | MipEntry | undefined)[];
  /** Revisions of `src` when this entry was built (in-place edits change them, not identity). */
  srcRev: number[];
  /** Unique per build. */
  rev: number;
}

/** A tile's pixels at a pyramid level, with an identity + revision pair that changes on every edit. */
export interface LevelTile {
  data: PixelArray;
  obj: object;
  rev: number;
}

export interface RasterSnapshot {
  readonly tiles: ReadonlyMap<number, Tile>;
  readonly fill: number;
  /** Snapshot of the companion plate (CMYK documents). */
  readonly companion?: RasterSnapshot | null;
}

export function tileKey(tx: number, ty: number): number {
  return (ty + 32768) * 65536 + (tx + 32768);
}
export function keyToTile(k: number): [number, number] {
  return [(k % 65536) - 32768, Math.floor(k / 65536) - 32768];
}

export function tileRange(r: Rect, size = TS): { tx0: number; ty0: number; tx1: number; ty1: number } {
  return {
    tx0: Math.floor(r.x / size),
    ty0: Math.floor(r.y / size),
    tx1: Math.floor((r.x + r.w - 1) / size),
    ty1: Math.floor((r.y + r.h - 1) / size),
  };
}

export class TiledRaster {
  tiles = new Map<number, Tile>();
  /** Increments on every mutation; render caches key on this. */
  version = 0;
  private gen = nextGen();
  private mips: Map<number, MipEntry>[] = [];
  /**
   * CMYK documents: the black plate (K', K', K', A — inverted ink), kept alongside this raster
   * (which holds C', M', Y', A). Cloned, snapshotted and restored together with it.
   */
  companion: TiledRaster | null = null;

  constructor(
    readonly channels: 1 | 4,
    readonly depth: BitDepth,
    /** Normalized value (0..1) of every sample in tiles that do not exist. */
    public fill = 0,
  ) {}

  get tileLength(): number {
    return TS * TS * this.channels;
  }

  getTile(tx: number, ty: number): Tile | undefined {
    return this.tiles.get(tileKey(tx, ty));
  }

  /** Returns a tile safe to mutate (allocating or cloning as required by copy-on-write). */
  writableTile(tx: number, ty: number): Tile {
    const k = tileKey(tx, ty);
    let t = this.tiles.get(k);
    if (!t) {
      const data = allocPixels(this.depth, this.tileLength);
      if (this.fill !== 0) data.fill(this.fill * maxValue(this.depth));
      t = new Tile(data, this.gen);
      this.tiles.set(k, t);
    } else if (t.gen !== this.gen) {
      t = new Tile(t.data.slice() as PixelArray, this.gen);
      this.tiles.set(k, t);
    }
    t.rev++;
    this.version++;
    return t;
  }

  touch(): void {
    this.version++;
  }

  /** Freezes current tiles (future writes copy-on-write) and returns a cheap reference snapshot. */
  snapshot(): RasterSnapshot {
    this.gen = nextGen();
    return { tiles: new Map(this.tiles), fill: this.fill, companion: this.companion ? this.companion.snapshot() : null };
  }

  restore(s: RasterSnapshot): void {
    this.tiles = new Map(s.tiles);
    this.fill = s.fill;
    this.gen = nextGen();
    this.version++;
    if (s.companion) {
      if (!this.companion) this.companion = new TiledRaster(this.channels, this.depth, s.companion.fill);
      this.companion.restore(s.companion);
    } else if (s.companion === null) this.companion = null;
  }

  /** Shares tiles with the clone; both sides copy-on-write afterwards. */
  clone(): TiledRaster {
    const r = new TiledRaster(this.channels, this.depth, this.fill);
    r.tiles = new Map(this.tiles);
    this.gen = nextGen();
    if (this.companion) r.companion = this.companion.clone();
    return r;
  }

  clear(fill = this.fill): void {
    this.tiles = new Map();
    this.fill = fill;
    this.gen = nextGen();
    this.version++;
  }

  isEmpty(): boolean {
    return this.tiles.size === 0;
  }

  /** Coarse bounds: union of allocated tile rectangles. */
  tileBounds(): Rect | null {
    if (this.tiles.size === 0) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of this.tiles.keys()) {
      const [tx, ty] = keyToTile(k);
      x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty);
    }
    return { x: x0 * TS, y: y0 * TS, w: (x1 - x0 + 1) * TS, h: (y1 - y0 + 1) * TS };
  }

  /** Exact bounds of samples that differ from `fill` (alpha != 0 for 4-channel rasters). */
  contentBounds(): Rect | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const ch = this.channels;
    const fillRaw = ch === 4 ? 0 : this.fill * maxValue(this.depth);
    const eps = this.depth === 32 ? 1e-6 : 0.5;
    for (const [k, t] of this.tiles) {
      const [tx, ty] = keyToTile(k);
      const d = t.data;
      let tx0 = TS, ty0 = TS, tx1 = -1, ty1 = -1;
      for (let y = 0; y < TS; y++) {
        let row = y * TS * ch + (ch === 4 ? 3 : 0);
        for (let x = 0; x < TS; x++, row += ch) {
          if (Math.abs(d[row] - fillRaw) > eps) {
            if (x < tx0) tx0 = x;
            if (x > tx1) tx1 = x;
            if (y < ty0) ty0 = y;
            ty1 = y;
          }
        }
      }
      if (tx1 < 0) continue;
      x0 = Math.min(x0, tx * TS + tx0); y0 = Math.min(y0, ty * TS + ty0);
      x1 = Math.max(x1, tx * TS + tx1 + 1); y1 = Math.max(y1, ty * TS + ty1 + 1);
    }
    return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** Removes tiles whose every sample equals `fill` (keeps storage sparse after erasing). */
  compact(): void {
    const ch = this.channels;
    const fillRaw = this.fill * maxValue(this.depth);
    for (const [k, t] of this.tiles) {
      const d = t.data;
      let same = true;
      if (ch === 4 && this.fill === 0) {
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) { same = false; break; }
      } else {
        for (let i = 0; i < d.length; i++) if (d[i] !== fillRaw) { same = false; break; }
      }
      if (same) this.tiles.delete(k);
    }
    this.version++;
  }

  byteSize(): number {
    const bps = this.depth === 8 ? 1 : this.depth === 16 ? 2 : 4;
    let n = this.tiles.size * this.tileLength * bps;
    for (const m of this.mips) n += m.size * this.tileLength * bps;
    return n;
  }

  purgeMips(): void {
    this.mips = [];
  }

  // -------------------------------------------------------------------------------------------
  // Region IO
  // -------------------------------------------------------------------------------------------

  /** Reads a region (coordinates at the given pyramid level) as normalized floats. */
  readFloat(r: Rect, level = 0, out?: Float32Array): Float32Array {
    const ch = this.channels;
    const len = r.w * r.h * ch;
    const dst = out && out.length >= len ? out : new Float32Array(len);
    if (out || this.fill !== 0) dst.fill(this.fill, 0, len);
    if (this.fill !== 0 && ch === 4) {
      // 4-channel rasters with fill are not used; keep semantics simple: fill applies to all samples.
    }
    if (isEmpty(r)) return dst;
    const { tx0, ty0, tx1, ty1 } = tileRange(r);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const data = level === 0 ? this.tiles.get(tileKey(tx, ty))?.data : this.levelEntry(level, tx, ty)?.data;
        if (!data) continue;
        const tr = { x: tx * TS, y: ty * TS, w: TS, h: TS };
        const it = intersect(r, tr);
        if (isEmpty(it)) continue;
        for (let y = it.y; y < it.y + it.h; y++) {
          const so = ((y - tr.y) * TS + (it.x - tr.x)) * ch;
          const d0 = ((y - r.y) * r.w + (it.x - r.x)) * ch;
          toFloat(data, dst, so, d0, it.w * ch);
        }
      }
    }
    return dst;
  }

  /** Writes normalized floats into a region (level 0). */
  writeFloat(r: Rect, src: Float32Array): void {
    if (isEmpty(r)) return;
    const ch = this.channels;
    const { tx0, ty0, tx1, ty1 } = tileRange(r);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tr = { x: tx * TS, y: ty * TS, w: TS, h: TS };
        const it = intersect(r, tr);
        if (isEmpty(it)) continue;
        const t = this.writableTile(tx, ty);
        for (let y = it.y; y < it.y + it.h; y++) {
          const d0 = ((y - tr.y) * TS + (it.x - tr.x)) * ch;
          const so = ((y - r.y) * r.w + (it.x - r.x)) * ch;
          fromFloat(src, t.data, so, d0, it.w * ch);
        }
      }
    }
  }

  /** Reads raw samples at native depth (used by file export). */
  readPixels(r: Rect): PixelArray {
    const ch = this.channels;
    const out = allocPixels(this.depth, r.w * r.h * ch);
    if (this.fill !== 0) out.fill(this.fill * maxValue(this.depth));
    if (isEmpty(r)) return out;
    const { tx0, ty0, tx1, ty1 } = tileRange(r);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.tiles.get(tileKey(tx, ty));
        if (!t) continue;
        const tr = { x: tx * TS, y: ty * TS, w: TS, h: TS };
        const it = intersect(r, tr);
        if (isEmpty(it)) continue;
        for (let y = it.y; y < it.y + it.h; y++) {
          const so = ((y - tr.y) * TS + (it.x - tr.x)) * ch;
          const d0 = ((y - r.y) * r.w + (it.x - r.x)) * ch;
          copySamples(out, d0, t.data, so, it.w * ch);
        }
      }
    }
    return out;
  }

  /** Writes raw samples at native depth. `src` must match this raster's depth. */
  writePixels(r: Rect, src: PixelArray): void {
    if (isEmpty(r)) return;
    const ch = this.channels;
    const { tx0, ty0, tx1, ty1 } = tileRange(r);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tr = { x: tx * TS, y: ty * TS, w: TS, h: TS };
        const it = intersect(r, tr);
        if (isEmpty(it)) continue;
        const t = this.writableTile(tx, ty);
        for (let y = it.y; y < it.y + it.h; y++) {
          const d0 = ((y - tr.y) * TS + (it.x - tr.x)) * ch;
          const so = ((y - r.y) * r.w + (it.x - r.x)) * ch;
          copySamples(t.data, d0, src, so, it.w * ch);
        }
      }
    }
  }

  /** Builds a raster from a dense pixel array positioned at (ox, oy). Fully empty tiles are skipped. */
  static fromPixels(width: number, height: number, channels: 1 | 4, depth: BitDepth, data: PixelArray, ox = 0, oy = 0, fill = 0): TiledRaster {
    const r = new TiledRaster(channels, depth, fill);
    if (width > 0 && height > 0) {
      r.writePixels({ x: ox, y: oy, w: width, h: height }, data);
      r.compact();
    }
    return r;
  }

  // -------------------------------------------------------------------------------------------
  // Pyramid
  // -------------------------------------------------------------------------------------------

  /** The tile at (tx, ty) of a pyramid level (undefined = every sample is `fill`). */
  levelTile(level: number, tx: number, ty: number): LevelTile | undefined {
    const e = this.levelEntry(level, tx, ty);
    if (!e) return undefined;
    return { data: e.data, obj: e, rev: e.rev };
  }

  private levelEntry(level: number, tx: number, ty: number): Tile | MipEntry | undefined {
    if (level === 0) return this.tiles.get(tileKey(tx, ty));
    const c0 = this.levelEntry(level - 1, tx * 2, ty * 2);
    const c1 = this.levelEntry(level - 1, tx * 2 + 1, ty * 2);
    const c2 = this.levelEntry(level - 1, tx * 2, ty * 2 + 1);
    const c3 = this.levelEntry(level - 1, tx * 2 + 1, ty * 2 + 1);
    let cache = this.mips[level - 1];
    if (!cache) cache = this.mips[level - 1] = new Map();
    const k = tileKey(tx, ty);
    if (!c0 && !c1 && !c2 && !c3) {
      cache.delete(k);
      return undefined;
    }
    const hit = cache.get(k);
    const kids0 = [c0, c1, c2, c3];
    if (hit && kids0.every((c, i) => hit.src[i] === c && hit.srcRev[i] === (c?.rev ?? -1))) return hit;
    const data = allocPixels(this.depth, this.tileLength);
    const fillRaw = this.fill * maxValue(this.depth);
    const kids = [c0, c1, c2, c3];
    for (let q = 0; q < 4; q++) {
      const ox = (q & 1) * (TS / 2);
      const oy = (q >> 1) * (TS / 2);
      const kid = kids[q];
      if (!kid) {
        if (fillRaw !== 0) for (let y = 0; y < TS / 2; y++) data.fill(fillRaw, ((oy + y) * TS + ox) * this.channels, ((oy + y) * TS + ox + TS / 2) * this.channels);
        continue;
      }
      downsampleQuadrant(kid.data, data, ox, oy, this.channels, this.depth);
    }
    const e: MipEntry = { data, src: kids, srcRev: kids.map((c) => c?.rev ?? -1), rev: nextGen() };
    cache.set(k, e);
    return e;
  }
}

/** Copies samples between same-typed pixel arrays. */
function copySamples(dst: PixelArray, dOff: number, src: PixelArray, sOff: number, len: number): void {
  (dst as unknown as { set(a: ArrayLike<number>, o: number): void }).set(src.subarray(sOff, sOff + len), dOff);
}

function downsampleQuadrant(src: PixelArray, dst: PixelArray, ox: number, oy: number, ch: number, depth: BitDepth) {
  const H = TS / 2;
  // Uint16Array truncates on assignment (needs +0.5); Uint8ClampedArray and Float32Array do not.
  const round = depth === 16 ? 0.5 : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < H; x++) {
      const s0 = ((y * 2) * TS + x * 2) * ch;
      const s1 = s0 + ch;
      const s2 = s0 + TS * ch;
      const s3 = s2 + ch;
      const d = ((oy + y) * TS + ox + x) * ch;
      if (ch === 1) {
        dst[d] = (src[s0] + src[s1] + src[s2] + src[s3]) * 0.25 + round;
      } else {
        const a0 = src[s0 + 3], a1 = src[s1 + 3], a2 = src[s2 + 3], a3 = src[s3 + 3];
        const sa = a0 + a1 + a2 + a3;
        if (sa === 0) {
          dst[d] = dst[d + 1] = dst[d + 2] = dst[d + 3] = 0;
        } else {
          const inv = 1 / sa;
          dst[d] = (src[s0] * a0 + src[s1] * a1 + src[s2] * a2 + src[s3] * a3) * inv + round;
          dst[d + 1] = (src[s0 + 1] * a0 + src[s1 + 1] * a1 + src[s2 + 1] * a2 + src[s3 + 1] * a3) * inv + round;
          dst[d + 2] = (src[s0 + 2] * a0 + src[s1 + 2] * a1 + src[s2 + 2] * a2 + src[s3 + 2] * a3) * inv + round;
          dst[d + 3] = sa * 0.25 + round;
        }
      }
    }
  }
}
