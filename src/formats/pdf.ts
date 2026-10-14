/**
 * PDF export (File ▸ Export As ▸ PDF): one page sized from the document's resolution with the
 * flattened image as an ICC-tagged image XObject (Flate, or DCT/JPEG when a quality below 1 is
 * requested) and a soft mask for transparency. Document metadata goes into the Info dictionary.
 * Layers are not preserved (like Photoshop PDF without "Preserve Editing Capabilities").
 * CMYK documents are written as CMYK (ICCBased, N 4, with the document profile) and Lab documents
 * as a CIE Lab colour space, so print values reach the PDF unchanged.
 */
import { zlibSync } from 'fflate';
import type { CelenneDocument } from '../document/document';
import { flattenToPixels } from '../rendering/flatten';
import { builtinProfileICC } from '../color/icc';
import { encodeWithPlatform } from './codecs';
import { encodeJpegCmyk } from './jpegEncoder';
import { BUILTIN_PROFILES } from '../color/icc';
import { hasInkAppearance } from '../rendering/inkView';

export interface PdfOptions {
  /** 0..1; 1 = lossless (Flate). Below 1 the color data is JPEG-compressed. */
  quality?: number;
}

const enc = new TextEncoder();

function pdfString(s: string): string {
  // UTF-16BE with BOM as a hex string: safe for any characters.
  let hex = 'FEFF';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c > 0xffff) {
      const v = c - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else hex += c.toString(16).padStart(4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}

function pdfDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `(D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z)`;
}

export async function exportPDF(doc: CelenneDocument, opts: PdfOptions = {}): Promise<Uint8Array> {
  const mode = doc.canvas.colorMode;
  const cmyk = mode === 'cmyk', lab = mode === 'lab';
  // Duotone / Multichannel: how the inks print, in sRGB.
  const f = flattenToPixels(doc, { depth: 8, plate: cmyk || lab ? 0 : undefined, inks: true });
  const k = cmyk ? flattenToPixels(doc, { depth: 8, plate: 1 }).data : null;
  const W = f.width, H = f.height;
  const px = f.data as Uint8ClampedArray | Uint8Array;
  const n = W * H;
  const nc = cmyk ? 4 : 3;
  // Colour samples: RGB, C M Y K ink (DeviceCMYK convention) or Lab as stored (L/100, (a+128)/255, (b+128)/255).
  const color = new Uint8Array(n * nc);
  const alpha = new Uint8Array(n);
  let hasAlpha = false;
  for (let i = 0; i < n; i++) {
    if (cmyk) {
      color[i * 4] = 255 - px[i * 4]; color[i * 4 + 1] = 255 - px[i * 4 + 1]; color[i * 4 + 2] = 255 - px[i * 4 + 2]; color[i * 4 + 3] = 255 - k![i * 4];
    } else { color[i * 3] = px[i * 4]; color[i * 3 + 1] = px[i * 4 + 1]; color[i * 3 + 2] = px[i * 4 + 2]; }
    alpha[i] = px[i * 4 + 3];
    if (alpha[i] !== 255) hasAlpha = true;
  }
  const q = opts.quality ?? 1;
  let colorData: Uint8Array;
  let colorFilter: string;
  let decode = '';
  if (q < 1 && cmyk) {
    // Paper (no ink) under transparent areas, like the white matte of RGB JPEG data.
    const ink = color.slice();
    for (let i = 0; i < n; i++) { const a = alpha[i] / 255; for (let c = 0; c < 4; c++) ink[i * 4 + c] = Math.round(ink[i * 4 + c] * a); }
    colorData = encodeJpegCmyk(W, H, ink, Math.round(q * 100));
    colorFilter = '/DCTDecode';
    decode = ' /Decode [1 0 1 0 1 0 1 0]'; // Adobe CMYK JPEG data is stored inverted
  } else if (q < 1 && !lab) {
    colorData = await encodeWithPlatform(W, H, px as Uint8ClampedArray, 'image/jpeg', q, [255, 255, 255]);
    colorFilter = '/DCTDecode';
  } else {
    // Lab is always lossless (the JPEG encoders work on RGB / CMYK).
    colorData = zlibSync(color, { level: 6 });
    colorFilter = '/FlateDecode';
  }
  const cmykProfile = () => doc.profile.icc ?? builtinProfileICC(doc.profile.builtin && BUILTIN_PROFILES.find((b) => b.id === doc.profile.builtin)?.space === 'CMYK' ? doc.profile.builtin : 'celenneCMYK');
  const icc = lab ? null : cmyk ? cmykProfile() : hasInkAppearance(doc) || mode === 'grayscale' ? builtinProfileICC('srgb') /* gray data is written as RGB samples */ : doc.profile.untagged ? null : doc.profile.icc ?? builtinProfileICC(doc.profile.builtin ?? 'srgb');
  const res = doc.canvas.resolution > 0 ? doc.canvas.resolution : 72;
  const pw = (W * 72) / res, ph = (H * 72) / res;

  // Objects: 1 catalog, 2 pages, 3 page, 4 contents, 5 image, 6 info, [7 icc], [8 smask]
  const objs: (Uint8Array | string)[][] = [];
  const add = (parts: (Uint8Array | string)[]) => { objs.push(parts); return objs.length; };
  const stream = (dict: string, data: Uint8Array) => [`${dict.replace(/>>$/, '')} /Length ${data.length} >>\nstream\n`, data, '\nendstream'];
  const catalog = add(['<< /Type /Catalog /Pages 2 0 R >>']);
  const pages = add(['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
  void catalog; void pages;
  const page = add([`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(3)} ${ph.toFixed(3)}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`]);
  void page;
  const content = enc.encode(`q ${pw.toFixed(3)} 0 0 ${ph.toFixed(3)} 0 0 cm /Im0 Do Q`);
  add(stream('<<>>', content));
  const iccObj = icc ? 7 : 0;
  const smaskObj = hasAlpha ? (icc ? 8 : 7) : 0;
  const cs = lab ? '[/Lab << /WhitePoint [0.9642 1 0.8249] /Range [-128 127 -128 127] >>]' : icc ? `[/ICCBased ${iccObj} 0 R]` : '/DeviceRGB';
  add(stream(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace ${cs} /BitsPerComponent 8 /Filter ${colorFilter}${decode}${smaskObj ? ` /SMask ${smaskObj} 0 R` : ''} >>`, colorData));
  const m = doc.metadata;
  const info = [`/Producer ${pdfString('Celenne Studio')}`, `/CreationDate ${pdfDate()}`, `/Title ${pdfString(m.title || doc.name)}`];
  if (m.author) info.push(`/Author ${pdfString(m.author)}`);
  if (m.description) info.push(`/Subject ${pdfString(m.description)}`);
  if (m.keywords?.length) info.push(`/Keywords ${pdfString(m.keywords.join(', '))}`);
  add([`<< ${info.join(' ')} >>`]);
  if (icc) add(stream(cmyk ? '<< /N 4 /Alternate /DeviceCMYK /Filter /FlateDecode >>' : '<< /N 3 /Alternate /DeviceRGB /Filter /FlateDecode >>', zlibSync(icc)));
  // JPEG color data is pre-blended with white / paper: /Matte tells readers to un-blend it at the edges.
  const matte = q < 1 && !lab ? (cmyk ? ' /Matte [0 0 0 0]' : ' /Matte [1 1 1]') : '';
  if (hasAlpha) add(stream(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode${matte} >>`, zlibSync(alpha, { level: 6 })));

  // Serialize with a cross-reference table.
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (x: Uint8Array | string) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); offset += b.length; };
  push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  const offsets: number[] = [];
  objs.forEach((parts, i) => {
    offsets.push(offset);
    push(`${i + 1} 0 obj\n`);
    for (const p of parts) push(p);
    push('\nendobj\n');
  });
  const xref = offset;
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
  for (const o of offsets) push(`${String(o).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
