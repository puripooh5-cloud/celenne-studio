/**
 * CMYK Black channel of Levels / Curves adjustment layers. ag-psd reads and writes only the
 * composite and three channels; these helpers read the fifth channel (index 4 = Black in CMYK
 * documents) from the raw 'levl' / 'curv' blocks and patch it back on export.
 *
 *  levl: u16 version (2), then 10-byte records — composite, channel 1, 2, 3, 4 …
 *        (shadowIn, highlightIn, shadowOut, highlightOut, midtone × 100; all int16).
 *  curv: u8 0, u16 version (1), u16 0, u16 channel bitmask, then one curve per set bit
 *        (u16 count, count × (int16 output, int16 input)), followed by the 'Crv ' extension
 *        (u16 version 4, u16 0, u16 count, count × (u16 channel index, curve)).
 */
import type { CurvePoint, LevelsChannel } from '../adjustments/types';

const i16 = (d: Uint8Array, o: number) => { const v = (d[o] << 8) | d[o + 1]; return v >= 0x8000 ? v - 0x10000 : v; };
const u16 = (d: Uint8Array, o: number) => (d[o] << 8) | d[o + 1];

export function levelsChannelFromLevl(data: Uint8Array, index: number): LevelsChannel | null {
  const o = 2 + index * 10;
  if (data.length < o + 10 || u16(data, 0) !== 2) return null;
  const ch = { inBlack: i16(data, o), inWhite: i16(data, o + 2), outBlack: i16(data, o + 4), outWhite: i16(data, o + 6), gamma: i16(data, o + 8) / 100 };
  if (ch.inWhite <= ch.inBlack || ch.gamma <= 0) return null;
  return ch;
}

export function patchLevlChannel(data: Uint8Array, index: number, ch: LevelsChannel): Uint8Array {
  const o = 2 + index * 10;
  if (data.length < o + 10) return data;
  const out = data.slice();
  const put = (at: number, v: number) => { const x = Math.round(v) & 0xffff; out[at] = x >> 8; out[at + 1] = x & 255; };
  put(o, ch.inBlack); put(o + 2, ch.inWhite); put(o + 4, ch.outBlack); put(o + 6, ch.outWhite); put(o + 8, ch.gamma * 100);
  return out;
}

/** All curves of a 'curv' block by channel index (0 = composite). */
export function curvesFromCurv(data: Uint8Array): Map<number, CurvePoint[]> {
  const out = new Map<number, CurvePoint[]>();
  if (data.length < 7 || u16(data, 1) !== 1) return out;
  const mask = u16(data, 5);
  let p = 7;
  for (let bit = 0; bit < 16 && p + 2 <= data.length; bit++) {
    if (!(mask & (1 << bit))) continue;
    const n = u16(data, p);
    p += 2;
    if (p + n * 4 > data.length) break;
    const pts: CurvePoint[] = [];
    for (let k = 0; k < n; k++) { pts.push({ y: i16(data, p), x: i16(data, p + 2) }); p += 4; }
    out.set(bit, pts);
  }
  return out;
}

/** Encodes a 'curv' block from curves by channel index (0 = composite, 1.. = channels). */
export function encodeCurv(curves: Map<number, CurvePoint[]>): Uint8Array {
  const b: number[] = [];
  const w16 = (v: number) => { const x = Math.round(v) & 0xffff; b.push(x >> 8, x & 255); };
  const entries = [...curves.entries()].filter(([, p]) => p.length).sort((a, c) => a[0] - c[0]);
  let mask = 0;
  for (const [i] of entries) mask |= 1 << i;
  b.push(0); w16(1); w16(0); w16(mask);
  const curve = (pts: CurvePoint[]) => { w16(pts.length); for (const p of pts) { w16(p.y); w16(p.x); } };
  for (const [, pts] of entries) curve(pts);
  for (const c of 'Crv ') b.push(c.charCodeAt(0));
  w16(4); w16(0); w16(entries.length);
  for (const [i, pts] of entries) { w16(i); curve(pts); }
  return new Uint8Array(b);
}
