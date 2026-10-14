/**
 * Photoshop path records (image resources 2000-2997 saved paths, 1025 work path, 2999 clipping
 * path name). 26-byte records with 8.24 fixed-point coordinates relative to the canvas size.
 */
import { Reader, Writer } from './binary';
import type { PathKnot, PathOperation, SubPath, VectorPath } from '../vector/types';

const OPS: PathOperation[] = ['exclude', 'combine', 'subtract', 'intersect'];

function readFixed(r: Reader): number {
  return r.i32() / 16777216;
}
function writeFixed(w: Writer, v: number) {
  w.i32(Math.round(v * 16777216));
}

export function parsePathRecords(data: Uint8Array, width: number, height: number): VectorPath {
  const r = new Reader(data);
  const path: VectorPath = { subpaths: [], fillRule: 'nonzero' };
  let current: SubPath | null = null;
  let remaining = 0;
  while (r.remaining >= 26) {
    const start = r.offset;
    const sel = r.u16();
    if (sel === 0 || sel === 3) {
      remaining = r.u16();
      const op = r.u16();
      current = { knots: [], closed: sel === 0, op: OPS[op] ?? 'combine' };
      path.subpaths.push(current);
    } else if (sel === 1 || sel === 2 || sel === 4 || sel === 5) {
      const iy = readFixed(r) * height, ix = readFixed(r) * width;
      const y = readFixed(r) * height, x = readFixed(r) * width;
      const oy = readFixed(r) * height, ox = readFixed(r) * width;
      if (current && remaining > 0) {
        current.knots.push({ x, y, inX: ix, inY: iy, outX: ox, outY: oy, smooth: sel === 1 || sel === 4 });
        remaining--;
      }
    } else if (sel === 6) {
      // path fill rule record
    } else if (sel === 8) {
      path.fillRule = 'nonzero';
    }
    r.offset = start + 26;
  }
  return path;
}

export function writePathRecords(path: VectorPath, width: number, height: number): Uint8Array {
  const w = new Writer(26 * (2 + path.subpaths.reduce((n, s) => n + s.knots.length + 1, 0)));
  // Path fill rule record.
  w.u16(6);
  w.zeros(24);
  for (const sp of path.subpaths) {
    w.u16(sp.closed ? 0 : 3);
    w.u16(sp.knots.length);
    w.u16(Math.max(0, OPS.indexOf(sp.op)));
    w.zeros(20);
    for (const k of sp.knots) {
      w.u16(sp.closed ? (k.smooth ? 1 : 2) : k.smooth ? 4 : 5);
      writeFixed(w, k.inY / height); writeFixed(w, k.inX / width);
      writeFixed(w, k.y / height); writeFixed(w, k.x / width);
      writeFixed(w, k.outY / height); writeFixed(w, k.outX / width);
    }
  }
  return w.result();
}

export function knotFromPsd(points: number[], linked: boolean): PathKnot {
  return { inX: points[0], inY: points[1], x: points[2], y: points[3], outX: points[4], outY: points[5], smooth: linked };
}

export function knotToPsd(k: PathKnot): { linked: boolean; points: number[] } {
  return { linked: k.smooth, points: [k.inX, k.inY, k.x, k.y, k.outX, k.outY] };
}
