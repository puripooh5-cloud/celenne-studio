/**
 * Node only (tests and scripts): registers the fonts of a folder (default: the Windows font folder)
 * with the text engine. Names are read once and cached in node_modules/.celenne-fonts.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FontFace, faceCount, initShaper } from './face';
import type { FaceRegistry, FaceSource } from './registry';

interface Entry { file: string; mtime: number; faces: { ps: string; family: string; style: string; weight: number; italic: boolean }[] }

const weightOf = (b: ArrayBuffer, i: number): number => {
  // OS/2 usWeightClass via a light table read (no HarfBuzz needed).
  try {
    const v = new DataView(b);
    let off = 0;
    if (v.getUint32(0) === 0x74746366) off = v.getUint32(12 + i * 4);
    const n = v.getUint16(off + 4);
    for (let t = 0; t < n; t++) {
      const r = off + 12 + t * 16;
      if (v.getUint32(r) === 0x4f532f32) return v.getUint16(v.getUint32(r + 8) + 4);
    }
  } catch { /* malformed */ }
  return 400;
};

export async function registerFontFolder(reg: FaceRegistry, dir = process.env.CELENNE_FONT_DIR || 'C:/Windows/Fonts'): Promise<number> {
  if (!(await initShaper()) || !fs.existsSync(dir)) return 0;
  const cacheFile = path.resolve('node_modules/.celenne-fonts.json');
  let cache: Record<string, Entry> = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* first run */ }
  const out: Record<string, Entry> = {};
  const list: FaceSource[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(ttf|otf|ttc)$/i.test(name)) continue;
    const file = path.join(dir, name);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    let e = cache[file];
    if (!e || e.mtime !== mtime || !e.faces.length) {
      e = { file, mtime, faces: [] };
      try {
        const buf = fs.readFileSync(file);
        const b = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        for (let i = 0; i < faceCount(b); i++) {
          const f = new FontFace(b, i);
          e.faces.push({ ps: f.postScriptName, family: f.family, style: f.subfamily, weight: weightOf(b, i), italic: /italic|oblique/i.test(f.subfamily) });
        }
      } catch { /* unreadable font */ }
    }
    out[file] = e;
    for (const f of e.faces) {
      list.push({ postScriptName: f.ps, family: f.family, style: f.style, weight: f.weight, italic: f.italic, load: () => { const buf = fs.readFileSync(file); return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer; } });
    }
  }
  try { fs.writeFileSync(cacheFile, JSON.stringify(out)); } catch { /* read-only */ }
  reg.register(list);
  return list.length;
}
