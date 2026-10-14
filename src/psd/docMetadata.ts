/**
 * Photoshop's document metadata blocks: print settings, halftone screens and transfer curves,
 * print style, EXIF, the Content Credentials setting, colour-management settings and the
 * generative AI record. Photoshop 2025 writes all of them into every PSD.
 *
 * Celenne understands them instead of treating them as unknown data:
 * - Opening: they are recognised, so they are not reported as features Celenne cannot edit.
 *   Content Credentials turned on is reported, because Celenne does not add its edits to them.
 * - Saving: blocks that describe the document are updated as Photoshop updates them (EXIF size,
 *   resolution, colour space, app and date; print resolution; the halftone and transfer set for
 *   the colour mode). A document that has none (made in Celenne or another app) gets the same
 *   blocks Photoshop writes for a new document. The generative AI record is only kept, never
 *   created: Celenne does not know whether AI was used on a document from elsewhere.
 * Measured on Photoshop 2025 (26.5) new documents (tests/fixtures/photoshop/new-docs).
 */
import { item, readVersionedDescriptor, setItem, text, textOf, writeVersionedDescriptor, type Descriptor, type DValue } from './descriptor';
import { buildExif, patchExif, type ExifFields } from './exif';
import type { ColorMode } from '../document/types';

/** Image resources Celenne understands (beyond those it models directly). */
export const DOC_METADATA_RESOURCES: Record<number, string> = {
  1012: 'grayscale halftone screens', 1013: 'colour halftone screens', 1014: 'duotone halftone screens',
  1015: 'grayscale transfer curves', 1016: 'colour transfer curves', 1017: 'duotone transfer curves',
  1028: 'IPTC', 1058: 'EXIF', 1083: 'print style', 1092: 'Photoshop document setting', 10000: 'print flags',
};
/** Global blocks Celenne understands. */
export const DOC_METADATA_BLOCKS: Record<string, string> = {
  'CAI ': 'Content Credentials setting', OCIO: 'colour-management settings', GenI: 'generative AI record',
};

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

// Photoshop's defaults for a new document (identical in every Photoshop 2025 file measured).
const PRINT_FLAGS = '00010000000000000002';
const SCREEN_GRAY = '003500000001002d00000006000000000001';
const SCREENS_CMY = '002f66660001006c66660006000000000001002f6666000100a1999a0006000000000001003200000001005a00000006000000000001';
const TRANSFER = '0000' + 'ffff'.repeat(11) + '03e80000';
const DOC_SETTING_1092 = '00000002000002400000024000000000';

/** Halftone screens and transfer curves: one set per colour mode. */
function screenSet(mode: ColorMode): Record<number, string> {
  if (mode === 'grayscale' || mode === 'bitmap' || mode === 'multichannel') return { 1012: SCREEN_GRAY, 1015: TRANSFER };
  if (mode === 'duotone') return { 1014: SCREEN_GRAY + SCREENS_CMY, 1017: TRANSFER.repeat(4) };
  return { 1013: SCREENS_CMY + SCREEN_GRAY, 1016: TRANSFER.repeat(4) };
}

const NUL = '\u0000';
const bool = (v: boolean): DValue => ({ t: 'bool', v });
const unit = (u: string, v: number): DValue => ({ t: 'UntF', unit: u, v });

/** Photoshop's print style for a new document; `Rslt` is the document resolution. */
export function printStyle(resolution: number): Descriptor {
  const rgb: Descriptor = { name: NUL, classId: 'RGBC', items: [['Rd  ', { t: 'doub', v: 255 }], ['Grn ', { t: 'doub', v: 255 }], ['Bl  ', { t: 'doub', v: 255 }]] };
  return {
    name: NUL, classId: 'printOutputOptions', items: [
      ['Cptn', bool(false)], ['Clbr', bool(false)], ['RgsM', bool(false)], ['CrnC', bool(false)], ['CntC', bool(false)],
      ['Lbls', bool(false)], ['Ngtv', bool(false)], ['EmlD', bool(false)], ['Intr', bool(false)],
      ['Bckg', { t: 'Objc', v: rgb }], ['BrdT', unit('#Rlt', 0)], ['Bld ', unit('#Rlt', 0)], ['Rslt', unit('#Pxl', resolution)],
      ['vectorData', bool(true)], ['PgPs', { t: 'enum', type: 'PgPs', v: 'PgPC' }], ['Left', unit('#Rlt', 0)], ['Top ', unit('#Rlt', 0)],
      ['Scl ', unit('#Prc', 100)], ['cropWhenPrinting', bool(false)],
      ['cropRectBottom', { t: 'long', v: 0 }], ['cropRectLeft', { t: 'long', v: 0 }], ['cropRectRight', { t: 'long', v: 0 }], ['cropRectTop', { t: 'long', v: 0 }],
    ],
  };
}

/** Colour-management settings: `icc` for documents with an ICC profile, `none` for Lab. */
export function colorManagement(kind: 'icc' | 'none'): Descriptor {
  const view: Descriptor = { name: NUL, classId: 'viewColorManagementInfo', items: [['display', text('')], ['#view', text('')]] };
  return { name: NUL, classId: 'documentColorManagementInfo', items: [['Knd ', text(kind)], ['ocio_display_view', { t: 'Objc', v: view }]] };
}

/** The Content Credentials setting, turned off (Celenne does not create Content Credentials). */
export function contentCredentialsOff(): Uint8Array {
  const d = writeVersionedDescriptor({ name: NUL, classId: 'null', items: [['enab', bool(false)], ['generationalGuid', text('')]] });
  const out = new Uint8Array(4 + d.length + 8);
  out[3] = 3;
  out.set(d, 4);
  return out;
}

/** Whether Content Credentials are turned on in a CAI block (null if it cannot be read). */
export function contentCredentialsEnabled(cai: Uint8Array): boolean | null {
  try {
    if (cai.length < 8 || cai[0] !== 0 || cai[1] !== 0 || cai[2] !== 0 || cai[3] !== 3) return null;
    const v = item(readVersionedDescriptor(cai, 4).desc, 'enab');
    return v?.t === 'bool' ? v.v : null;
  } catch {
    return null;
  }
}

/** Whether the GenI block records generative AI use (null if it cannot be read). */
export function generativeAiUsed(geni: Uint8Array): boolean | null {
  try {
    const v = item(readVersionedDescriptor(geni).desc, 'isUsingGenTech');
    return v?.t === 'long' ? v.v !== 0 : null;
  } catch {
    return null;
  }
}

export interface MetadataTarget {
  width: number;
  height: number;
  resolution: number;
  colorMode: ColorMode;
  /** The ICC profile written is sRGB (EXIF ColorSpace 1). */
  srgb: boolean;
  software: string;
  date: Date;
}

interface Res { sig: string; id: number; name: string; data: Uint8Array }
interface Blk { sig: string; key: string; data: Uint8Array }

/** Brings the metadata resources and global blocks of a PSD being written up to date (in place). */
export function writeDocMetadata(resources: Res[], blocks: Blk[], t: MetadataTarget): void {
  const find = (id: number) => resources.find((r) => r.id === id);
  const set = (id: number, data: Uint8Array) => { const r = find(id); if (r) r.data = data; else resources.push({ sig: '8BIM', id, name: '', data }); };

  if (!find(10000)) set(10000, hex(PRINT_FLAGS));
  // Halftone screens and transfer curves: keep the set for the document's mode, Photoshop's
  // defaults when the mode changed or the document has none.
  const wanted = screenSet(t.colorMode);
  for (let i = resources.length - 1; i >= 0; i--) {
    const id = resources[i].id;
    if (id >= 1012 && id <= 1017 && !(id in wanted)) resources.splice(i, 1);
  }
  for (const [id, data] of Object.entries(wanted)) if (!find(Number(id))) set(Number(id), hex(data));
  if (!find(1092)) set(1092, hex(DOC_SETTING_1092));

  // Print style: the print resolution follows the document's.
  const style = find(1083);
  if (!style) set(1083, writeVersionedDescriptor(printStyle(t.resolution)));
  else {
    try {
      const { desc, end } = readVersionedDescriptor(style.data);
      const r = item(desc, 'Rslt');
      if (end === style.data.length && r?.t === 'UntF' && r.v !== t.resolution) {
        setItem(desc, 'Rslt', { ...r, v: t.resolution });
        style.data = writeVersionedDescriptor(desc);
      }
    } catch { /* kept as it was */ }
  }

  const exif: ExifFields = { width: t.width, height: t.height, resolution: t.resolution, colorSpace: t.colorMode === 'rgb' && t.srgb ? 1 : 0xffff, software: t.software, date: t.date };
  const ex = find(1058);
  set(1058, ex ? patchExif(ex.data, exif) : buildExif(exif));

  const block = (key: string) => blocks.find((b) => b.key === key);
  if (!block('CAI ')) blocks.push({ sig: '8BIM', key: 'CAI ', data: contentCredentialsOff() });
  const kind = t.colorMode === 'lab' ? 'none' : 'icc';
  const ocio = block('OCIO');
  if (!ocio) blocks.push({ sig: '8BIM', key: 'OCIO', data: writeVersionedDescriptor(colorManagement(kind)) });
  else {
    try {
      const { desc, end } = readVersionedDescriptor(ocio.data);
      const k = textOf(item(desc, 'Knd '));
      // Only the ICC / none choice follows the document; OpenColorIO configurations are kept.
      if (end === ocio.data.length && (k === 'icc' || k === 'none') && k !== kind) {
        setItem(desc, 'Knd ', text(kind));
        ocio.data = writeVersionedDescriptor(desc);
      }
    } catch { /* kept as it was */ }
  }
}
