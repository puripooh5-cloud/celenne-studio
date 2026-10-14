/** Commands that change pixel buffers. Before/after are tile snapshots (no pixel duplication). */
import type { Command, RecordedOp } from '../history/history';
import type { CelenneDocument } from '../document/document';
import type { RasterSnapshot } from '../image-engine/tiledRaster';
import type { Rect } from '../image-engine/rect';
import { emitTargetChange, RasterTarget, resolveTarget } from './rasterTarget';
import { ensureCompanion, isCmykDoc, isLabDoc, labRgbView } from '../color/plates';
import { union } from '../image-engine/rect';

function snapshotBytes(before: RasterSnapshot, after: RasterSnapshot, tileBytes: number): number {
  // Only tiles that differ between the two states are unique to this history entry.
  let n = 0;
  for (const [k, t] of after.tiles) if (before.tiles.get(k) !== t) n++;
  for (const [k, t] of before.tiles) if (after.tiles.get(k) !== t) n++;
  return n * tileBytes;
}

export class RasterEditCommand implements Command {
  constructor(
    readonly label: string,
    readonly target: RasterTarget,
    private before: RasterSnapshot,
    private after: RasterSnapshot,
    private dirty: Rect | null,
    readonly record?: RecordedOp,
    private tileBytes = 256 * 256 * 4,
  ) {}
  do(doc: CelenneDocument): void {
    const t = resolveTarget(doc, this.target);
    if (!t) return;
    t.raster.restore(this.after);
    emitTargetChange(doc, this.target, this.dirty);
  }
  undo(doc: CelenneDocument): void {
    const t = resolveTarget(doc, this.target);
    if (!t) return;
    t.raster.restore(this.before);
    emitTargetChange(doc, this.target, this.dirty);
  }
  memoryBytes(): number {
    return snapshotBytes(this.before, this.after, this.tileBytes);
  }
}

/** Filter application (destructive path; smart objects use SmartFilter commands instead). */
export class ApplyFilterCommand extends RasterEditCommand {}

/** Mask pixel edits. */
export class ModifyMaskCommand extends RasterEditCommand {}

/**
 * Helper that snapshots a target, lets `mutate` modify it and pushes the resulting command.
 * Returns null when the target does not exist.
 *
 * Layer pixels of CMYK documents are edited plate by plate: `mutate` runs for plate 0 (C'M'Y')
 * and plate 1 (K') with the same arguments plus `plate` — colour-free edits need no changes;
 * code that writes colours picks them with color/plates `editColor(doc, c, plate)`. Layer pixels
 * of Lab documents are edited through an exact RGB view (`labRaw` gives the stored L a b instead).
 */
export function editRaster(
  doc: CelenneDocument,
  target: RasterTarget,
  label: string,
  mutate: (raster: import('../image-engine/tiledRaster').TiledRaster, offsetX: number, offsetY: number, plate: number) => Rect | null,
  record?: RecordedOp,
  opts: { labRaw?: boolean } = {},
): RasterEditCommand | null {
  const t = resolveTarget(doc, target);
  if (!t) return null;
  const before = t.raster.snapshot();
  let dirty: Rect | null;
  if (t.channels === 4 && target.kind === 'layer' && isCmykDoc(doc)) {
    const k = ensureCompanion(t.raster);
    dirty = mutate(t.raster, t.x, t.y, 0);
    const d1 = mutate(k, t.x, t.y, 1);
    dirty = dirty && d1 ? union(dirty, d1) : dirty ?? d1;
  } else if (t.channels === 4 && target.kind === 'layer' && isLabDoc(doc) && !opts.labRaw) {
    dirty = mutate(labRgbView(t.raster), t.x, t.y, 0);
  } else dirty = mutate(t.raster, t.x, t.y, 0);
  const after = t.raster.snapshot();
  const bps = t.raster.depth === 8 ? 1 : t.raster.depth === 16 ? 2 : 4;
  const cmd = new RasterEditCommand(label, target, before, after, dirty, record, 256 * 256 * t.channels * bps);
  emitTargetChange(doc, target, dirty);
  return cmd;
}
