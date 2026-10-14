/** Big-endian binary reader/writer with bounds checking (safe parsing of untrusted files). */
export class PsdFormatError extends Error {}

export class Reader {
  readonly view: DataView;
  offset = 0;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number {
    return this.bytes.length;
  }
  get remaining(): number {
    return this.bytes.length - this.offset;
  }
  private need(n: number) {
    if (n < 0 || this.offset + n > this.bytes.length) throw new PsdFormatError(`Unexpected end of file at offset ${this.offset} (need ${n} bytes)`);
  }
  u8(): number { this.need(1); return this.bytes[this.offset++]; }
  u16(): number { this.need(2); const v = this.view.getUint16(this.offset); this.offset += 2; return v; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.offset); this.offset += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.offset); this.offset += 4; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.offset); this.offset += 4; return v; }
  u64(): number {
    this.need(8);
    const hi = this.view.getUint32(this.offset), lo = this.view.getUint32(this.offset + 4);
    this.offset += 8;
    const v = hi * 4294967296 + lo;
    if (!Number.isSafeInteger(v)) throw new PsdFormatError('Section length exceeds supported size');
    return v;
  }
  len(large: boolean): number { return large ? this.u64() : this.u32(); }
  sig(): string { this.need(4); const s = String.fromCharCode(...this.bytes.subarray(this.offset, this.offset + 4)); this.offset += 4; return s; }
  bytesN(n: number): Uint8Array { this.need(n); const b = this.bytes.subarray(this.offset, this.offset + n); this.offset += n; return b; }
  skip(n: number): void { this.need(n); this.offset += n; }
  pascal(pad: number): string {
    const start = this.offset;
    const n = this.u8();
    const s = String.fromCharCode(...this.bytesN(n));
    const used = this.offset - start;
    const total = Math.ceil(used / pad) * pad;
    this.skip(total - used);
    return s;
  }
}

export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  offset = 0;
  constructor(initial = 1 << 20) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }
  private ensure(n: number) {
    if (this.offset + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.offset + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.offset));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v: number) { this.ensure(1); this.buf[this.offset++] = v & 255; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.offset, v); this.offset += 2; }
  i16(v: number) { this.ensure(2); this.view.setInt16(this.offset, v); this.offset += 2; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.offset, v >>> 0); this.offset += 4; }
  i32(v: number) { this.ensure(4); this.view.setInt32(this.offset, v | 0); this.offset += 4; }
  u64(v: number) { this.u32(Math.floor(v / 4294967296)); this.u32(v % 4294967296); }
  len(v: number, large: boolean) { if (large) this.u64(v); else this.u32(v); }
  sig(s: string) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.offset); this.offset += b.length; }
  zeros(n: number) { this.ensure(n); this.buf.fill(0, this.offset, this.offset + n); this.offset += n; }
  pascal(s: string, pad: number) {
    const start = this.offset;
    const bytes = [...s].slice(0, 255).map((c) => c.charCodeAt(0) & 255);
    this.u8(bytes.length);
    for (const b of bytes) this.u8(b);
    const used = this.offset - start;
    this.zeros(Math.ceil(used / pad) * pad - used);
  }
  /** Writes a length-prefixed section; `fn` writes the body. Pads body to `round`. */
  section(large: boolean, round: number, fn: () => void) {
    const at = this.offset;
    this.len(0, large);
    const start = this.offset;
    fn();
    let size = this.offset - start;
    const padded = Math.ceil(size / round) * round;
    this.zeros(padded - size);
    size = padded;
    if (large) {
      this.view.setUint32(at, Math.floor(size / 4294967296));
      this.view.setUint32(at + 4, size % 4294967296);
    } else this.view.setUint32(at, size);
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.offset);
  }
}
