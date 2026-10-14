/** Fills laid-out glyph outlines into a coverage raster (document space). */
import type { Affine } from '../../image-engine/matrix';
import { CoverageRaster } from '../../vector/coverage';
import type { VectorPath } from '../../vector/types';
import type { EngineLayout, PlacedGlyph } from './layout';

/** Faux italic slant (tan of the angle): 10°, measured against Photoshop's outlines (IoU 0.999). */
export const FAUX_ITALIC = { shear: Math.tan((10 * Math.PI) / 180) };

/** Draws one glyph through `m` (text space → raster space). Faux italic shears by FAUX_ITALIC. */
export function drawGlyph(r: CoverageRaster, g: PlacedGlyph, m: Affine) {
  const shear = g.style.fauxItalic ? FAUX_ITALIC.shear : 0;
  const c = g.rot ? Math.cos(g.rot) : 1, s = g.rot ? Math.sin(g.rot) : 0;
  const tx = (x: number, y: number) => {
    const lx = x * g.sx + y * g.sy * shear, ly = -y * g.sy;
    const ux = g.x + lx * c - ly * s, uy = g.y + lx * s + ly * c;
    return [m[0] * ux + m[2] * uy + m[4], m[1] * ux + m[3] * uy + m[5]] as const;
  };
  for (const c of g.face.outline(g.gid)) {
    if (c[0] === 'M') { const [x, y] = tx(c[1], c[2]); r.moveTo(x, y); }
    else if (c[0] === 'L') { const [x, y] = tx(c[1], c[2]); r.lineTo(x, y); }
    else if (c[0] === 'Q') { const [a, b] = tx(c[1], c[2]); const [x, y] = tx(c[3], c[4]); r.quadTo(a, b, x, y); }
    else if (c[0] === 'C') { const [a, b] = tx(c[1], c[2]); const [d, e] = tx(c[3], c[4]); const [x, y] = tx(c[5], c[6]); r.cubicTo(a, b, d, e, x, y); }
    else r.closePath();
  }
  r.closePath();
}

export function layoutCoverage(layout: EngineLayout, m: Affine, x0: number, y0: number, w: number, h: number): Float32Array {
  const r = new CoverageRaster(x0, y0, w, h);
  for (const ln of layout.lines) for (const g of ln.glyphs) drawGlyph(r, g, m);
  return r.coverage();
}

/** Coverage of a vector path (cubic knots in document space), e.g. Photoshop's converted text outlines. */
export function pathCoverage(p: VectorPath, x0: number, y0: number, w: number, h: number): Float32Array {
  const r = new CoverageRaster(x0, y0, w, h);
  for (const sp of p.subpaths) {
    const k = sp.knots;
    if (!k.length) continue;
    r.moveTo(k[0].x, k[0].y);
    const n = sp.closed ? k.length : k.length - 1;
    for (let i = 1; i <= n; i++) {
      const a = k[i - 1], b = k[i % k.length];
      r.cubicTo(a.outX, a.outY, b.inX, b.inY, b.x, b.y);
    }
    r.closePath();
  }
  return r.coverage();
}
