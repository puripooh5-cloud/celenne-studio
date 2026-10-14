/**
 * Lossless reading and writing of Photoshop's Txt2 syntax (the document-level text data; the same
 * syntax as EngineData with numeric keys). Unlike parseTxt2 (txt2.ts), which decodes values for
 * reading, this keeps every token's kind (name, string, integer, real, boolean) so a block can be
 * edited and written back exactly as Photoshop wrote the parts Celenne did not change.
 */
export type TNode =
  | { k: 'dict'; v: [string, TNode][] }
  | { k: 'arr'; v: TNode[] }
  | { k: 'name'; v: string }
  | { k: 'str'; v: string }
  | { k: 'int'; v: number }
  | { k: 'real'; v: number; raw?: string }
  | { k: 'bool'; v: boolean };

/** The block: a sequence of top-level /key value pairs. */
export type TBlock = [string, TNode][];

export function readTxt2Lossless(bytes: Uint8Array): TBlock {
  let p = 0;
  const n = bytes.length;
  const ws = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 0;
  const delim = (c: number) => ws(c) || c === 0x2f || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x28;
  const skip = () => { while (p < n && ws(bytes[p])) p++; };
  const word = () => { const s = p; while (p < n && !delim(bytes[p])) p++; return String.fromCharCode(...bytes.subarray(s, p)); };
  const str = (): string => {
    p++;
    const out: number[] = [];
    while (p < n && bytes[p] !== 0x29) {
      let c = bytes[p++];
      if (c === 0x5c && p < n) c = bytes[p++]; // escaped byte (\( \) \\)
      out.push(c);
    }
    p++;
    if (out[0] === 0xfe && out[1] === 0xff) {
      let s = '';
      for (let i = 2; i + 1 < out.length; i += 2) s += String.fromCharCode((out[i] << 8) | out[i + 1]);
      return s;
    }
    return String.fromCharCode(...out);
  };
  const value = (): TNode => {
    skip();
    const c = bytes[p];
    if (c === 0x3c && bytes[p + 1] === 0x3c) {
      p += 2;
      const v: [string, TNode][] = [];
      for (;;) {
        skip();
        if (p >= n || (bytes[p] === 0x3e && bytes[p + 1] === 0x3e)) { p += 2; return { k: 'dict', v }; }
        if (bytes[p] !== 0x2f) { p++; continue; }
        p++;
        const key = word();
        v.push([key, value()]);
      }
    }
    if (c === 0x5b) {
      p++;
      const v: TNode[] = [];
      for (;;) {
        skip();
        if (p >= n || bytes[p] === 0x5d) { p++; return { k: 'arr', v }; }
        v.push(value());
      }
    }
    if (c === 0x28) return { k: 'str', v: str() };
    if (c === 0x2f) { p++; return { k: 'name', v: word() }; }
    const w = word();
    if (!w) { p++; return { k: 'name', v: '' }; }
    if (w === 'true' || w === 'false') return { k: 'bool', v: w === 'true' };
    if (/^-?\d+$/.test(w)) return { k: 'int', v: Number(w) };
    return { k: 'real', v: Number(w), raw: w };
  };
  const out: TBlock = [];
  while (p < n) {
    skip();
    if (p >= n) break;
    if (bytes[p] === 0x2f) { p++; const k = word(); out.push([k, value()]); }
    else p++;
  }
  return out;
}

/** Reals as Photoshop writes them: up to 5 decimals, "12.0", "0.0", ".5", "-.03". */
function real(x: number): string {
  let s = x.toFixed(5).replace(/0+$/, '').replace(/\.$/, '.0');
  if (s === '-0.0') s = '0.0';
  if (s.startsWith('0.') && s !== '0.0') s = s.slice(1);
  else if (s.startsWith('-0.')) s = '-' + s.slice(2);
  return s;
}

/** Strings as Photoshop writes them in Txt2: always UTF-16BE with a byte-order mark. */
function strBytes(s: string, out: number[]) {
  out.push(0x28, 0xfe, 0xff);
  for (let i = 0; i < s.length; i++) {
    const hi = s.charCodeAt(i) >> 8, lo = s.charCodeAt(i) & 0xff;
    for (const b of [hi, lo]) { if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c); out.push(b); }
  }
  out.push(0x29);
}

export function writeTxt2Lossless(block: TBlock): Uint8Array {
  const out: number[] = [];
  const ascii = (s: string) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
  // Photoshop's layout: one line, every token preceded by a space.
  const node = (x: TNode) => {
    switch (x.k) {
      case 'dict':
        ascii('<<');
        for (const [k, v] of x.v) { ascii(` /${k} `); node(v); }
        ascii(' >>');
        break;
      case 'arr':
        ascii('[');
        for (const e of x.v) { ascii(' '); node(e); }
        ascii(' ]');
        break;
      case 'name': ascii('/' + x.v); break;
      case 'str': strBytes(x.v, out); break;
      case 'int': ascii(String(x.v)); break;
      case 'real': ascii(x.raw && Number(x.raw) === x.v ? x.raw : real(x.v)); break;
      case 'bool': ascii(x.v ? 'true' : 'false'); break;
    }
  };
  for (const [k, v] of block) { ascii(` /${k} `); node(v); }
  return new Uint8Array(out);
}

// --- small helpers for editing -----------------------------------------------------------------
export function tget(x: TNode | undefined, ...path: (string | number)[]): TNode | undefined {
  let cur = x;
  for (const key of path) {
    if (!cur) return undefined;
    if (cur.k === 'dict' && typeof key === 'string') cur = cur.v.find(([k]) => k === key)?.[1];
    else if (cur.k === 'arr' && typeof key === 'number') cur = cur.v[key];
    else return undefined;
  }
  return cur;
}

export function tset(d: TNode, key: string, value: TNode): void {
  if (d.k !== 'dict') return;
  const e = d.v.find(([k]) => k === key);
  if (e) e[1] = value;
  else d.v.push([key, value]);
}

export function tdel(d: TNode, key: string): void {
  if (d.k === 'dict') d.v = d.v.filter(([k]) => k !== key);
}
