/**
 * Photoshop action descriptors: a small reader / writer that keeps every key's order and type,
 * so a descriptor read and written again is byte-identical. Used for document metadata blocks
 * (print style, colour-management settings, Content Credentials setting, generative AI record).
 *
 * Safe parsing: every read is bounds-checked, nesting depth and item counts are limited, and
 * unsupported value types throw (the caller then keeps the original bytes).
 */

export type DValue =
  | { t: 'bool'; v: boolean }
  | { t: 'long'; v: number }
  | { t: 'comp'; v: bigint }
  | { t: 'doub'; v: number }
  | { t: 'UntF'; unit: string; v: number }
  | { t: 'TEXT'; v: string } // exactly as stored, including any trailing NUL
  | { t: 'enum'; type: string; v: string }
  | { t: 'Objc' | 'GlbO'; v: Descriptor }
  | { t: 'VlLs'; v: DValue[] }
  | { t: 'tdta'; v: Uint8Array };

/**
 * Keys are usually four characters stored with length 0; a few (such as `view`) are stored with an
 * explicit length 4. Such keys are kept with a leading '#' so they are written back the same way.
 */
export interface Descriptor { name: string; classId: string; items: [string, DValue][] }

const MAX_DEPTH = 32;
const MAX_ITEMS = 100_000;

class Reader {
  pos: number;
  private view: DataView;
  constructor(private b: Uint8Array, start = 0, private end = b.length) { this.pos = start; this.view = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  need(n: number): void { if (n < 0 || this.pos + n > this.end) throw new Error('descriptor: truncated'); }
  u8(): number { this.need(1); return this.b[this.pos++]; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
  i64(): bigint { this.need(8); const v = this.view.getBigInt64(this.pos); this.pos += 8; return v; }
  f64(): number { this.need(8); const v = this.view.getFloat64(this.pos); this.pos += 8; return v; }
  bytes(n: number): Uint8Array { this.need(n); const v = this.b.slice(this.pos, this.pos + n); this.pos += n; return v; }
  ascii(n: number): string { return String.fromCharCode(...this.bytes(n)); }
  id(): string { const n = this.u32(); if (n > 4096) throw new Error('descriptor: key too long'); const s = this.ascii(n || 4); return n === 4 ? `#${s}` : s; }
  unicode(): string {
    const n = this.u32();
    if (n > 1 << 20) throw new Error('descriptor: string too long');
    this.need(n * 2);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode((this.b[this.pos + 2 * i] << 8) | this.b[this.pos + 2 * i + 1]);
    this.pos += n * 2;
    return s;
  }
}

function readValue(r: Reader, type: string, depth: number): DValue {
  switch (type) {
    case 'bool': return { t: 'bool', v: r.u8() !== 0 };
    case 'long': return { t: 'long', v: r.i32() };
    case 'comp': return { t: 'comp', v: r.i64() };
    case 'doub': return { t: 'doub', v: r.f64() };
    case 'UntF': { const unit = r.ascii(4); return { t: 'UntF', unit, v: r.f64() }; }
    case 'TEXT': return { t: 'TEXT', v: r.unicode() };
    case 'enum': { const t = r.id(); return { t: 'enum', type: t, v: r.id() }; }
    case 'Objc': case 'GlbO': return { t: type, v: readDescriptorBody(r, depth + 1) };
    case 'VlLs': {
      const n = r.u32();
      if (n > MAX_ITEMS) throw new Error('descriptor: list too long');
      const v: DValue[] = [];
      for (let i = 0; i < n; i++) v.push(readValue(r, r.ascii(4), depth + 1));
      return { t: 'VlLs', v };
    }
    case 'tdta': return { t: 'tdta', v: r.bytes(r.u32()) };
    default: throw new Error(`descriptor: unsupported type ${JSON.stringify(type)}`);
  }
}

function readDescriptorBody(r: Reader, depth: number): Descriptor {
  if (depth > MAX_DEPTH) throw new Error('descriptor: nested too deeply');
  const name = r.unicode();
  const classId = r.id();
  const n = r.u32();
  if (n > MAX_ITEMS) throw new Error('descriptor: too many items');
  const items: [string, DValue][] = [];
  for (let i = 0; i < n; i++) { const key = r.id(); items.push([key, readValue(r, r.ascii(4), depth)]); }
  return { name, classId, items };
}

/** Reads a version-16 descriptor at `start`; returns it and the offset just after it. */
export function readVersionedDescriptor(b: Uint8Array, start = 0): { desc: Descriptor; end: number } {
  const r = new Reader(b, start);
  const version = r.u32();
  if (version !== 16) throw new Error(`descriptor: version ${version}`);
  return { desc: readDescriptorBody(r, 0), end: r.pos };
}

class Writer {
  private parts: number[] = [];
  u8(v: number): void { this.parts.push(v & 255); }
  u32(v: number): void { this.parts.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
  bytes(b: Uint8Array): void { for (const x of b) this.parts.push(x); }
  f64(v: number): void { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v); this.bytes(new Uint8Array(d.buffer)); }
  i64(v: bigint): void { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, v); this.bytes(new Uint8Array(d.buffer)); }
  ascii(s: string): void { for (let i = 0; i < s.length; i++) this.parts.push(s.charCodeAt(i) & 255); }
  /** Four-character keys are written with length 0, others with their length (as Photoshop does). */
  id(s: string): void {
    if (s.length === 5 && s[0] === '#') s = s.slice(1);
    else if (s.length === 4) { this.u32(0); this.ascii(s); return; }
    this.u32(s.length); this.ascii(s);
  }
  unicode(s: string): void { this.u32(s.length); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); this.parts.push(c >> 8, c & 255); } }
  result(): Uint8Array { return Uint8Array.from(this.parts); }
}

function writeValue(w: Writer, v: DValue): void {
  w.ascii(v.t);
  switch (v.t) {
    case 'bool': w.u8(v.v ? 1 : 0); break;
    case 'long': w.u32(v.v | 0); break;
    case 'comp': w.i64(v.v); break;
    case 'doub': w.f64(v.v); break;
    case 'UntF': w.ascii(v.unit); w.f64(v.v); break;
    case 'TEXT': w.unicode(v.v); break;
    case 'enum': w.id(v.type); w.id(v.v); break;
    case 'Objc': case 'GlbO': writeDescriptorBody(w, v.v); break;
    case 'VlLs': w.u32(v.v.length); for (const x of v.v) writeValue(w, x); break;
    case 'tdta': w.u32(v.v.length); w.bytes(v.v); break;
  }
}

function writeDescriptorBody(w: Writer, d: Descriptor): void {
  w.unicode(d.name);
  w.id(d.classId);
  w.u32(d.items.length);
  for (const [k, v] of d.items) { w.id(k); writeValue(w, v); }
}

export function writeVersionedDescriptor(d: Descriptor): Uint8Array {
  const w = new Writer();
  w.u32(16);
  writeDescriptorBody(w, d);
  return w.result();
}

/** A TEXT value as Photoshop stores it (with a trailing NUL). */
export const text = (s: string): DValue => ({ t: 'TEXT', v: `${s}\u0000` });
/** The string in a TEXT value, without the trailing NUL. */
export const textOf = (v: DValue | undefined): string | undefined => (v?.t === 'TEXT' ? v.v.replace(/\u0000+$/, '') : undefined);
const sameKey = (k: string, key: string) => k === key || k === `#${key}`;
export const item = (d: Descriptor, key: string): DValue | undefined => d.items.find(([k]) => sameKey(k, key))?.[1];
export function setItem(d: Descriptor, key: string, v: DValue): void {
  const i = d.items.findIndex(([k]) => sameKey(k, key));
  if (i >= 0) d.items[i] = [d.items[i][0], v];
  else d.items.push([key, v]);
}
