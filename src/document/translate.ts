/** Layer translation (a pure document-model operation shared by commands, tools and the renderer). */
import type { Layer } from './types';

/** Offsets a layer and everything it owns (masks, vector data, text/shape geometry, children). */
export function translateLayerDeep(l: Layer, dx: number, dy: number): void {
  l.x += dx;
  l.y += dy;
  if (l.mask && l.mask.linked) {
    l.mask.x += dx;
    l.mask.y += dy;
  }
  if (l.vectorMask && l.vectorMask.linked) translatePath(l.vectorMask.path, dx, dy);
  switch (l.kind) {
    case 'group':
      for (const c of l.children) translateLayerDeep(c, dx, dy);
      break;
    case 'text':
      l.text.transform[4] += dx;
      l.text.transform[5] += dy;
      break;
    case 'shape':
      if (l.path !== l.vectorMask?.path) translatePath(l.path, dx, dy);
      if (l.origin) {
        l.origin.x += dx;
        l.origin.y += dy;
      }
      break;
    case 'smartObject':
      for (const p of l.quad) {
        p.x += dx;
        p.y += dy;
      }
      break;
  }
  l.rev++;
}

function translatePath(p: { subpaths: { knots: { x: number; y: number; inX: number; inY: number; outX: number; outY: number }[] }[] }, dx: number, dy: number) {
  for (const s of p.subpaths)
    for (const k of s.knots) {
      k.x += dx; k.y += dy; k.inX += dx; k.inY += dy; k.outX += dx; k.outY += dy;
    }
}
