/**
 * The TrueType 'kern' table (format 0 pair kerning, Windows version 0 and Apple version 1
 * headers). Photoshop's metrics kerning falls back to it when the font's GPOS does not kern Latin
 * pairs (Tahoma's GPOS has no Latin pairs; its 'kern' table does).
 */
export class KernTable {
  private pairs = new Map<number, number>();

  static parse(t: Uint8Array | undefined): KernTable | null {
    if (!t || t.length < 4) return null;
    const v = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const k = new KernTable();
    let off: number, n: number;
    const version = v.getUint16(0);
    if (version === 0) { n = v.getUint16(2); off = 4; }
    else if (v.getUint32(0) === 0x00010000) { n = v.getUint32(4); off = 8; }
    else return null;
    for (let s = 0; s < n && off + 6 <= t.length; s++) {
      let len: number, format: number, horizontal = true, cross = false, minimum = false;
      if (version === 0) {
        len = v.getUint16(off + 2);
        const cov = v.getUint16(off + 4);
        format = cov >> 8; horizontal = (cov & 1) === 1; minimum = (cov & 2) !== 0; cross = (cov & 4) !== 0;
        if (format === 0 && horizontal && !minimum && !cross) k.readPairs(v, off + 6);
      } else {
        len = v.getUint32(off);
        const cov = v.getUint16(off + 4);
        format = cov & 0xff; horizontal = (cov & 0x8000) === 0; cross = (cov & 0x4000) !== 0;
        if (format === 0 && horizontal && !cross) k.readPairs(v, off + 8);
      }
      if (!len) break;
      off += len;
    }
    return k.pairs.size ? k : null;
  }

  private readPairs(v: DataView, off: number) {
    const n = v.getUint16(off);
    let p = off + 8;
    for (let i = 0; i < n && p + 6 <= v.byteLength; i++, p += 6) this.pairs.set((v.getUint16(p) << 16) | v.getUint16(p + 2), v.getInt16(p + 4));
  }

  /** Adjustment in font units between two glyphs. */
  get(left: number, right: number): number { return this.pairs.get((left << 16) | right) ?? 0; }
}
