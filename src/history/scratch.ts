/**
 * Scratch disk: pages history-only tiles out of memory.
 *
 * Tiles are immutable once a history snapshot references them. When the history holds more
 * tile data than the configured budget, tiles referenced only by old history steps (not by the
 * live document) are written to the scratch directory and their in-memory copy is dropped. A
 * paged tile is read back synchronously the first time its pixels are needed (undo, redo,
 * history jumps), so every command keeps working unchanged. Scratch files are deleted when the
 * tile is garbage-collected, and the directory is cleared on start-up.
 */
import type { CelenneDocument } from '../document/document';
import type { History } from './history';
import { setTilePager, Tile, TiledRaster } from '../image-engine/tiledRaster';
import { hasRaster } from '../document/types';

export interface ScratchBackend {
  write(key: string, data: Uint8Array): Promise<void>;
  readSync(key: string): Uint8Array | null;
  remove(key: string): void;
}

interface Settings {
  enabled: boolean;
  /** History tile data kept in memory before paging starts (bytes). */
  budgetBytes: number;
  /** Maximum scratch usage (bytes). */
  maxScratchBytes: number;
}

let backend: ScratchBackend | null = null;
let settings: Settings = { enabled: true, budgetBytes: 1024 * 1024 * 1024, maxScratchBytes: 20 * 1024 * 1024 * 1024 };
let seq = 0;
const stats = { pagedTiles: 0, pagedBytes: 0, readBacks: 0, failures: 0 };
const inFlight = new Set<Tile>();
const cleanup = typeof FinalizationRegistry !== 'undefined'
  ? new FinalizationRegistry<{ key: string; bytes: number }>((v) => { backend?.remove(v.key); stats.pagedTiles--; stats.pagedBytes -= v.bytes; })
  : null;

export function installScratch(b: ScratchBackend | null): void {
  backend = b;
  setTilePager(b ? { readSync: (k) => { stats.readBacks++; return b.readSync(k); } } : null);
}

export function configureScratch(s: Partial<Settings>): void {
  settings = { ...settings, ...s };
}

export function scratchAvailable(): boolean {
  return !!backend;
}

export function scratchStats(): Readonly<typeof stats> {
  return stats;
}

/** Tiles of the live document (never paged). */
function liveTiles(doc: CelenneDocument): Set<Tile> {
  const out = new Set<Tile>();
  const add = (r: TiledRaster | undefined | null) => { if (r) for (const t of r.tiles.values()) out.add(t); };
  for (const l of doc.walk()) {
    if (hasRaster(l)) add(l.raster);
    add(l.mask?.raster);
  }
  for (const c of doc.channels) add(c.raster);
  add(doc.selection.mask);
  for (const s of doc.smartSources.values()) add(s.decoded?.raster);
  for (const p of doc.patterns.values()) add(p.raster);
  return out;
}

/** Every Tile reachable from a history command (generic walk: commands keep snapshots, layer clones, states). */
function collectTiles(root: unknown, out: Set<Tile>, seen: Set<object>): void {
  const stack: unknown[] = [root];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== 'object' || seen.has(o)) continue;
    seen.add(o);
    if (o instanceof Tile) { out.add(o); continue; }
    if (ArrayBuffer.isView(o)) continue;
    if (o instanceof Map) { for (const v of o.values()) stack.push(v); continue; }
    if (Array.isArray(o)) { for (const v of o) stack.push(v); continue; }
    for (const [k, v] of Object.entries(o)) {
      // Up-links and live document objects are not history data.
      if (k === 'parent' || k === 'listeners' || k === 'doc') continue;
      if (v && typeof v === 'object') stack.push(v);
    }
  }
}

/** Pages out old history tiles when the history exceeds the memory budget. */
export function maybeOffload(doc: CelenneDocument, history: History): void {
  if (!backend || !settings.enabled) return;
  const live = liveTiles(doc);
  const seen = new Set<object>();
  // Oldest steps first; the few most recent steps stay resident for instant undo.
  const entries = history.entries.slice(1, Math.max(1, history.index - 2));
  const candidates: Tile[] = [];
  let historyBytes = 0;
  const all = new Set<Tile>();
  for (const e of history.entries) if (e.command) collectTiles(e.command, all, seen);
  for (const t of all) if (!live.has(t) && t.resident) historyBytes += t.data.byteLength;
  if (historyBytes <= settings.budgetBytes) return;
  const seen2 = new Set<object>();
  const old = new Set<Tile>();
  for (const e of entries) if (e.command) collectTiles(e.command, old, seen2);
  for (const t of old) if (!live.has(t) && t.resident && !inFlight.has(t)) candidates.push(t);
  let excess = historyBytes - settings.budgetBytes * 0.75;
  for (const t of candidates) {
    if (excess <= 0 || stats.pagedBytes >= settings.maxScratchBytes) break;
    const data = t.data;
    const bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    const key = `t${Date.now().toString(36)}${(seq++).toString(36)}`;
    inFlight.add(t);
    excess -= bytes.byteLength;
    backend.write(key, bytes).then(
      () => {
        inFlight.delete(t);
        t.evict(key);
        stats.pagedTiles++;
        stats.pagedBytes += bytes.byteLength;
        cleanup?.register(t, { key, bytes: bytes.byteLength });
      },
      () => { inFlight.delete(t); stats.failures++; },
    );
  }
}
