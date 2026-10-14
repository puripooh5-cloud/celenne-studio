/** Regressions for drag performance work and bugs found by the command/tool/undo sweeps. */
import { describe, expect, it } from 'vitest';
import { RenderEngine, liftPartition, DISPLAY_TILE } from '../../src/rendering/renderEngine';
import { compositeRegion } from '../../src/rendering/compositor';
import { translateLayerDeep } from '../../src/document/translate';
import { layerVisualBounds } from '../../src/rendering/bounds';
import { History, recordStateChange } from '../../src/history/history';
import { CreateLayerCommand } from '../../src/commands/layerCommands';
import { createAdjustmentLayer, createGroupLayer, createPixelLayer } from '../../src/document/layerFactory';
import type { GroupLayer } from '../../src/document/types';
import { defaultAdjustment } from '../../src/adjustments/types';
import { transformDocument } from '../../src/app/ops/imageOps';
import { add, newDoc, solidLayer } from '../helpers/build';

/** Straight RGBA8 source-over (what the viewport does with the three lift sets). */
function over(dst: Uint8ClampedArray, src: Uint8ClampedArray) {
  for (let i = 0; i < dst.length; i += 4) {
    const sa = src[i + 3] / 255, da = dst[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    for (let c = 0; c < 3; c++) dst[i + c] = oa > 0 ? (src[i + c] * sa + dst[i + c] * da * (1 - sa)) / oa : 0;
    dst[i + 3] = oa * 255;
  }
}

describe('Lifted layer drag', () => {
  it('the three lift sets stacked with the drag offset equal the exact render of the moved layer', () => {
    const doc = newDoc(512, 512);
    add(doc, solidLayer(doc, 'bg', 0, 0, 512, 512, [1, 1, 1, 1]));
    const moving = add(doc, solidLayer(doc, 'moving', 40, 40, 200, 150, [0.9, 0.2, 0.1, 0.8]));
    add(doc, solidLayer(doc, 'above', 150, 100, 120, 120, [0.1, 0.3, 0.9, 0.5]));
    const eng = new RenderEngine(doc);
    expect(eng.beginLift([moving.id], layerVisualBounds(moving))).toBe(true);
    eng.activateLift();
    // Drag by a whole tile so tile (1,0) of the moving set lands exactly on tile (1,0)+offset.
    const dx = DISPLAY_TILE, dy = 0;
    translateLayerDeep(moving, dx, dy);
    doc.emit({ type: 'pixels', layerId: moving.id, rect: layerVisualBounds(moving) });
    eng.setLiftOffset(dx, dy);
    expect(eng.lift?.active).toBe(true);
    // Viewport stacking for tile (1,0): below(1,0) + moving(0,0) shifted by one tile + above(1,0).
    const below = eng.liftTile('below', 0, 1, 0)!;
    const mov = eng.liftTile('moving', 0, 0, 0)!;
    const above = eng.liftTile('above', 0, 1, 0)!;
    const stack = new Uint8ClampedArray(below.data);
    over(stack, mov.data);
    over(stack, above.data);
    // Exact render at the moved position.
    const exact = compositeRegion(doc, { x: DISPLAY_TILE, y: 0, w: DISPLAY_TILE, h: DISPLAY_TILE }, { level: 0 });
    let max = 0;
    for (let i = 0; i < DISPLAY_TILE * DISPLAY_TILE; i++) {
      const a = exact[i * 4 + 3];
      for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs((a > 0 ? exact[i * 4 + c] / a : 0) * 255 - stack[i * 4 + c]));
    }
    expect(max).toBeLessThanOrEqual(2);
    // Moving-layer changes are absorbed while lifted; ending the lift re-renders exactly.
    eng.endLift(layerVisualBounds(moving));
    expect(eng.lift?.settling).toBe(true);
    eng.finishLift();
    expect(eng.lift).toBeNull();
  });

  it('refuses to lift when the stacking would not be exact', () => {
    const doc = newDoc(128, 128);
    add(doc, solidLayer(doc, 'bg', 0, 0, 128, 128, [1, 1, 1, 1]));
    const m = add(doc, solidLayer(doc, 'm', 0, 0, 64, 64, [1, 0, 0, 1]));
    const top = add(doc, solidLayer(doc, 'top', 0, 0, 64, 64, [0, 0, 1, 1]));
    expect(liftPartition(doc, [m.id])).not.toBeNull();
    top.blendMode = 'multiply'; // depends on what is below it
    expect(liftPartition(doc, [m.id])).toBeNull();
    top.blendMode = 'normal';
    add(doc, createAdjustmentLayer(defaultAdjustment('invert')));
    expect(liftPartition(doc, [m.id])).toBeNull();
  });

  it('lifts layers inside plain groups, exactly', () => {
    const doc = newDoc(512, 512);
    add(doc, solidLayer(doc, 'bg', 0, 0, 512, 512, [1, 1, 1, 1]));
    const outer = add(doc, createGroupLayer('outer'));
    const inner = createGroupLayer('inner');
    inner.blendMode = 'normal';
    add(doc, inner, outer as GroupLayer);
    const under = solidLayer(doc, 'under', 0, 60, 300, 100, [0.2, 0.8, 0.2, 1]);
    under.blendMode = 'multiply'; // below the moving layer: any blend mode is fine
    add(doc, under, inner);
    const moving = add(doc, solidLayer(doc, 'moving', 40, 40, 200, 150, [0.9, 0.2, 0.1, 0.8]), inner);
    add(doc, solidLayer(doc, 'sibling above', 150, 100, 120, 120, [0.1, 0.3, 0.9, 0.5]), inner);
    add(doc, solidLayer(doc, 'top', 100, 0, 120, 300, [0.9, 0.9, 0.1, 0.4]));
    const part = liftPartition(doc, [moving.id]);
    expect(part?.moving.map((l) => l.name)).toEqual(['moving']);
    expect(part?.below.map((l) => l.name)).toEqual(['bg', 'under']);
    expect(part?.above.map((l) => l.name)).toEqual(['sibling above', 'top']);
    const eng = new RenderEngine(doc);
    expect(eng.beginLift([moving.id], layerVisualBounds(moving))).toBe(true);
    eng.activateLift();
    translateLayerDeep(moving, DISPLAY_TILE, 0);
    doc.emit({ type: 'pixels', layerId: moving.id, rect: layerVisualBounds(moving) });
    eng.setLiftOffset(DISPLAY_TILE, 0);
    const stack = new Uint8ClampedArray(eng.liftTile('below', 0, 1, 0)!.data);
    over(stack, eng.liftTile('moving', 0, 0, 0)!.data);
    over(stack, eng.liftTile('above', 0, 1, 0)!.data);
    const exact = compositeRegion(doc, { x: DISPLAY_TILE, y: 0, w: DISPLAY_TILE, h: DISPLAY_TILE }, { level: 0 });
    let max = 0;
    for (let i = 0; i < DISPLAY_TILE * DISPLAY_TILE; i++) {
      const a = exact[i * 4 + 3];
      for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs((a > 0 ? exact[i * 4 + c] / a : 0) * 255 - stack[i * 4 + c]));
    }
    expect(max).toBeLessThanOrEqual(2);
  });

  it('does not look through groups that change how their contents composite', () => {
    const doc = newDoc(128, 128);
    add(doc, solidLayer(doc, 'bg', 0, 0, 128, 128, [1, 1, 1, 1]));
    const g = add(doc, createGroupLayer('g')) as GroupLayer;
    const m = add(doc, solidLayer(doc, 'm', 0, 0, 64, 64, [1, 0, 0, 1]), g);
    expect(liftPartition(doc, [m.id])).not.toBeNull();
    g.opacity = 0.5;
    expect(liftPartition(doc, [m.id])).toBeNull();
    g.opacity = 1;
    g.blendMode = 'multiply';
    expect(liftPartition(doc, [m.id])).toBeNull();
    g.blendMode = 'normal';
    const sib = add(doc, solidLayer(doc, 'screen sibling', 0, 0, 64, 64, [0, 0, 1, 1]), g);
    sib.blendMode = 'screen'; // above the moving layer inside the group
    expect(liftPartition(doc, [m.id])).toBeNull();
  });

  it('a Multiply layer above makes only the tiles it covers live; those render exactly while dragging', () => {
    const T = DISPLAY_TILE;
    const doc = newDoc(4 * T, 2 * T);
    add(doc, solidLayer(doc, 'bg', 0, 0, 4 * T, 2 * T, [1, 1, 1, 1]));
    const moving = add(doc, solidLayer(doc, 'moving', 10, 10, 3 * T, T, [0.9, 0.2, 0.1, 1]));
    const shade = add(doc, solidLayer(doc, 'shade', 3 * T, 0, T, 2 * T, [0.5, 0.5, 0.9, 1]));
    shade.blendMode = 'multiply';
    expect(liftPartition(doc, [moving.id])).toBeNull(); // not a plain stack…
    expect(liftPartition(doc, [moving.id], { live: true })?.live.map((l) => l.name)).toEqual(['shade']);
    const eng = new RenderEngine(doc);
    expect(eng.beginLift([moving.id], layerVisualBounds(moving))).toBe(true); // …but liftable with live tiles
    expect(eng.isLiveTile(0, 3, 0)).toBe(true);
    expect(eng.isLiveTile(0, 1, 0)).toBe(false);
    // Render the live tile once, then drag: it must be invalidated and re-rendered exactly.
    eng.request(0, 3, 0, 0);
    eng.process(1000);
    eng.activateLift();
    eng.process(1000); // finishes preparation → active
    expect(eng.lift?.active).toBe(true);
    translateLayerDeep(moving, 40, 30);
    doc.emit({ type: 'pixels', layerId: moving.id, rect: layerVisualBounds(moving) });
    eng.setLiftOffset(40, 30);
    expect(eng.getTile(0, 3, 0)?.stale).toBe(true);
    eng.request(0, 3, 0, 0);
    eng.request(0, 1, 0, 0); // not live: waits for the drop
    eng.process(1000);
    expect(eng.getTile(0, 3, 0)?.stale).toBe(false);
    const exact = compositeRegion(doc, { x: 3 * T, y: 0, w: T, h: T }, { level: 0 });
    const tile = eng.getTile(0, 3, 0)!.data;
    let max = 0;
    for (let i = 0; i < T * T; i++) {
      const a = exact[i * 4 + 3];
      for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs((a > 0 ? exact[i * 4 + c] / a : 0) * 255 - tile[i * 4 + c]));
    }
    expect(max).toBeLessThanOrEqual(1);
    expect(eng.hasPendingWork()).toBe(true); // tile (1,0) still queued for after the drop
  });

  it('a prepared (hover) lift is discarded by any document change', () => {
    const doc = newDoc(256, 256);
    add(doc, solidLayer(doc, 'bg', 0, 0, 256, 256, [1, 1, 1, 1]));
    const m = add(doc, solidLayer(doc, 'm', 0, 0, 64, 64, [1, 0, 0, 1]));
    const eng = new RenderEngine(doc);
    eng.beginLift([m.id], layerVisualBounds(m));
    expect(eng.preparedLift([m.id], -1)).toBe(true);
    // An edit of the layer itself (a filter, say) while the lift is only prepared.
    doc.emit({ type: 'pixels', layerId: m.id, rect: { x: 0, y: 0, w: 64, h: 64 } });
    expect(eng.lift).toBeNull();
  });

  it('a change to another layer during a lift discards it', () => {
    const doc = newDoc(256, 256);
    add(doc, solidLayer(doc, 'bg', 0, 0, 256, 256, [1, 1, 1, 1]));
    const m = add(doc, solidLayer(doc, 'm', 0, 0, 64, 64, [1, 0, 0, 1]));
    const eng = new RenderEngine(doc);
    eng.beginLift([m.id], layerVisualBounds(m));
    eng.activateLift();
    doc.emit({ type: 'structure' });
    expect(eng.lift).toBeNull();
  });
});

describe('Compositor bounds skipping', () => {
  it('renders identically to a full composite far away from a small layer', () => {
    const doc = newDoc(1024, 1024);
    add(doc, solidLayer(doc, 'bg', 0, 0, 1024, 1024, [0.3, 0.6, 0.9, 1]));
    const small = add(doc, solidLayer(doc, 'small', 900, 900, 40, 40, [1, 0, 0, 1]));
    small.blendMode = 'difference';
    const far = compositeRegion(doc, { x: 0, y: 0, w: 64, h: 64 }, { level: 0 });
    small.visible = false;
    const without = compositeRegion(doc, { x: 0, y: 0, w: 64, h: 64 }, { level: 0 });
    expect(Array.from(far)).toEqual(Array.from(without));
    small.visible = true;
    const near = compositeRegion(doc, { x: 910, y: 910, w: 1, h: 1 }, { level: 0 });
    expect(near[0]).toBeGreaterThan(0.6); // |0.3 − 1| → red channel 0.7
  });
});

describe('Undo integrity', () => {
  it('undoing "New Layer" after a whole-document step and its undo removes the layer (no duplicates on redo)', () => {
    const doc = newDoc(64, 64);
    add(doc, solidLayer(doc, 'bg', 0, 0, 64, 64, [1, 1, 1, 1]));
    const h = new History(doc);
    const l = createPixelLayer('Layer 1', 8);
    h.push(new CreateLayerCommand('New Layer', l, null, 1));
    recordStateChange(doc, h, 'Crop', () => { doc.canvas = { ...doc.canvas, width: 32 }; });
    h.undo(); // restores cloned layers
    h.undo(); // must remove the (cloned) Layer 1
    expect(doc.allLayers().map((x) => x.name)).toEqual(['bg']);
    h.redo();
    h.redo();
    const ids = doc.allLayers().map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.allLayers().map((x) => x.name)).toEqual(['bg', 'Layer 1']);
  });
});

describe('Selections outside the canvas', () => {
  it('a crop that leaves nothing selected on the canvas clears the selection', () => {
    const doc = newDoc(200, 200);
    add(doc, solidLayer(doc, 'bg', 0, 0, 200, 200, [1, 1, 1, 1]));
    doc.selection.combine({ x: 150, y: 150, w: 40, h: 40 }, new Float32Array(1600).fill(1), 'replace');
    // Crop to the top-left 100×100.
    transformDocument(doc, [1, 0, 0, 1, 0, 0], 100, 100, 'nearest', null);
    expect(doc.selection.isEmpty()).toBe(true);
  });
});
