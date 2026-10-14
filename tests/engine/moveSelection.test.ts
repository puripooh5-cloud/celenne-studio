/**
 * Moving selected pixels with the Move tool: the pixels stay floating between drags (as in
 * Photoshop), so moving them A → B → C leaves a hole only at A, and B shows what it showed before.
 */
import { describe, expect, it } from 'vitest';
import { MoveTool } from '../../src/tools/moveTool';
import type { ToolHost, ToolPointer } from '../../src/tools/tool';
import { DocumentSession } from '../../src/app/session';
import { editor } from '../../src/app/editor';
import { add, newDoc } from '../helpers/build';
import { createPixelLayer } from '../../src/document/layerFactory';
import { TiledRaster } from '../../src/image-engine/tiledRaster';
import type { PixelLayer } from '../../src/document/types';

const W = 64, H = 24;

/** A layer whose red channel encodes x, so every column is recognisable. */
function setup() {
  const doc = newDoc(W, H);
  const px = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; px[i] = x / (W - 1); px[i + 1] = 0.5; px[i + 3] = 1; }
  const r = new TiledRaster(4, 8);
  r.writeFloat({ x: 0, y: 0, w: W, h: H }, px);
  const l = add(doc, createPixelLayer('Layer', 8, r)) as PixelLayer;
  const s = new DocumentSession(doc);
  s.setActive(l.id);
  const h: ToolHost = { editor, session: s, redraw() {}, setCursor() {}, viewportSize: () => ({ w: 200, h: 100 }) };
  // Select an 8 × 8 square at A (x 4–11).
  doc.selection.combine({ x: 4, y: 8, w: 8, h: 8 }, new Float32Array(64).fill(1), 'replace');
  return { doc, s, l, h };
}

const pt = (x: number, y: number): ToolPointer => ({ x, y, sx: x, sy: y, pressure: 1, tiltX: 0, tiltY: 0, twist: 0, button: 0, buttons: 1, shift: false, alt: false, mod: false, pointerType: 'mouse', time: 0, clickCount: 1 });

function drag(t: MoveTool, h: ToolHost, from: [number, number], to: [number, number]) {
  t.down(h, pt(...from));
  for (let k = 1; k <= 4; k++) t.move(h, pt(from[0] + ((to[0] - from[0]) * k) / 4, from[1] + ((to[1] - from[1]) * k) / 4));
  t.up(h);
}

/** Red (column marker) and alpha of a pixel. */
const at = (l: PixelLayer, x: number, y: number) => { const p = l.raster.readFloat({ x, y, w: 1, h: 1 }); return { r: Math.round(p[0] * (W - 1)), a: p[3] }; };

describe('moving selected pixels', () => {
  it('keeps the moved pixels floating: A → B → C leaves a hole only at A', () => {
    const { l, h } = setup();
    const t = new MoveTool();
    drag(t, h, [8, 12], [28, 12]); // A → B (+20)
    expect(at(l, 6, 12).a).toBe(0); // hole at A
    expect(at(l, 26, 12)).toEqual({ r: 6, a: 1 }); // A's pixels at B
    drag(t, h, [28, 12], [48, 12]); // B → C (+20 more)
    expect(at(l, 6, 12).a).toBe(0); // still a hole at A
    expect(at(l, 26, 12)).toEqual({ r: 26, a: 1 }); // B shows what it showed before
    expect(at(l, 46, 12)).toEqual({ r: 6, a: 1 }); // A's pixels at C
  });

  it('moves the selection outline with the pixels, and each drag is one undo step', () => {
    const { doc, s, l, h } = setup();
    const t = new MoveTool();
    drag(t, h, [8, 12], [28, 12]);
    drag(t, h, [28, 12], [48, 12]);
    expect(doc.selection.bounds(doc.bounds)).toEqual({ x: 44, y: 8, w: 8, h: 8 });
    s.history.undo();
    expect(at(l, 26, 12)).toEqual({ r: 6, a: 1 }); // back to the pixels at B
    expect(doc.selection.bounds(doc.bounds)).toEqual({ x: 24, y: 8, w: 8, h: 8 });
    s.history.undo();
    expect(at(l, 6, 12)).toEqual({ r: 6, a: 1 }); // nothing moved
  });

  it('lifts afresh after the layer changed in another way', () => {
    const { l, h } = setup();
    const t = new MoveTool();
    drag(t, h, [8, 12], [28, 12]);
    // Another edit to the layer drops the float: the next drag cuts what is now at B.
    l.raster.writeFloat({ x: 0, y: 0, w: 1, h: 1 }, new Float32Array([0, 0, 0, 1]));
    drag(t, h, [28, 12], [48, 12]);
    expect(at(l, 26, 12).a).toBe(0);
    expect(at(l, 46, 12)).toEqual({ r: 6, a: 1 });
  });
});
