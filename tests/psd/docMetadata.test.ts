/**
 * Photoshop's document metadata blocks (print settings, halftone / transfer, print style, EXIF,
 * Content Credentials setting, colour-management settings, generative AI record): read, kept,
 * updated and created as Photoshop does. Reference: new documents made by Photoshop 2025
 * (tests/fixtures/photoshop/new-docs: rgb72, rgb300, gray150, lab72).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseContainer } from '../../src/psd/container';
import { importPsd } from '../../src/psd/import';
import { exportPsd } from '../../src/psd/export';
import { readVersionedDescriptor, writeVersionedDescriptor } from '../../src/psd/descriptor';
import { buildExif, patchExif, readExifFields } from '../../src/psd/exif';
import { colorManagement, contentCredentialsEnabled, contentCredentialsOff, printStyle } from '../../src/psd/docMetadata';
import { CelenneDocument } from '../../src/document/document';
import type { ColorMode } from '../../src/document/types';
import { add, solidLayer } from '../helpers/build';

const NEW = path.resolve('tests/fixtures/photoshop/new-docs');
const CORPUS = path.resolve('tests/fixtures/photoshop/corpus');
const read = (p: string) => new Uint8Array(fs.readFileSync(p));
const hex = (d: Uint8Array | undefined) => (d ? Buffer.from(d).toString('hex') : 'missing');
const META_RES = [10000, 1012, 1013, 1014, 1015, 1016, 1017, 1083, 1092];

function blocks(bytes: Uint8Array) {
  const c = parseContainer(bytes);
  return {
    res: (id: number) => c.resources.find((r) => r.id === id)?.data,
    glb: (key: string) => c.globalBlocks.find((b) => b.key === key)?.data,
    ids: c.resources.map((r) => r.id),
  };
}

function celenneDoc(w: number, h: number, ppi: number, mode: ColorMode): CelenneDocument {
  const doc = new CelenneDocument('x', { width: w, height: h, resolution: ppi, colorMode: mode, bitDepth: 8 });
  if (mode === 'grayscale') doc.profile = { name: 'Dot Gain 20%', builtin: 'dotGain20' };
  if (mode === 'lab') doc.profile = { name: 'Lab Color (D50)', builtin: 'labD50' };
  add(doc, solidLayer(doc, 'Layer 1', 0, 0, w, h, [1, 1, 1, 1]));
  return doc;
}

describe('descriptors', () => {
  it('reads and writes every metadata descriptor in the corpus byte for byte', () => {
    let n = 0;
    for (const f of fs.readdirSync(CORPUS).filter((x) => x.endsWith('.psd'))) {
      const b = blocks(read(path.join(CORPUS, f)));
      for (const [d, off] of [[b.res(1083), 0], [b.res(1082), 0], [b.glb('OCIO'), 0], [b.glb('GenI'), 0], [b.glb('CAI '), 4]] as const) {
        if (!d) continue;
        const { desc, end } = readVersionedDescriptor(d, off);
        expect(hex(writeVersionedDescriptor(desc))).toBe(hex(d.subarray(off, end)));
        n++;
      }
    }
    expect(n).toBeGreaterThan(500);
  });

  it('rejects malformed data instead of reading past the end', () => {
    const d = writeVersionedDescriptor(printStyle(72));
    for (const cut of [3, 10, 40, d.length - 1]) expect(() => readVersionedDescriptor(d.subarray(0, cut))).toThrow();
    const huge = new Uint8Array(d); huge[10] = 0xff; // a class-id length far past the end
    expect(() => readVersionedDescriptor(huge)).toThrow();
  });
});

describe("Celenne writes Photoshop's metadata for a new document", () => {
  const cases: [string, number, number, number, ColorMode][] = [
    ['rgb72', 128, 128, 72, 'rgb'], ['rgb300', 640, 480, 300, 'rgb'], ['gray150', 200, 100, 150, 'grayscale'], ['lab72', 100, 100, 72, 'lab'],
  ];
  for (const [name, w, h, ppi, mode] of cases) {
    it(`${name}: the same blocks as Photoshop's own new document`, () => {
      const ps = blocks(read(path.join(NEW, `${name}.psd`)));
      const ours = blocks(exportPsd(celenneDoc(w, h, ppi, mode)));
      for (const id of META_RES) expect(`${id} ${hex(ours.res(id))}`).toBe(`${id} ${hex(ps.res(id))}`);
      for (const key of ['CAI ', 'OCIO']) expect(`${key} ${hex(ours.glb(key))}`).toBe(`${key} ${hex(ps.glb(key))}`);
      // EXIF: Photoshop's layout exactly; only the app name and the save time differ.
      const psExif = ps.res(1058)!;
      const f = readExifFields(psExif)!;
      const date = /(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(Buffer.from(psExif).toString('latin1'))!;
      const when = new Date(+date[1], +date[2] - 1, +date[3], +date[4], +date[5], +date[6]);
      expect(hex(buildExif({ width: w, height: h, resolution: ppi, colorSpace: f.colorSpace!, software: f.software!, date: when }))).toBe(hex(psExif));
      expect(readExifFields(ours.res(1058)!)).toEqual({ width: w, height: h, resolution: ppi, colorSpace: f.colorSpace, software: expect.stringMatching(/^Celenne Studio/) });
    });
  }

  it('builders match the decoded Photoshop blocks', () => {
    const ps = blocks(read(path.join(NEW, 'rgb300.psd')));
    expect(hex(writeVersionedDescriptor(printStyle(300)))).toBe(hex(ps.res(1083)));
    expect(hex(writeVersionedDescriptor(colorManagement('icc')))).toBe(hex(ps.glb('OCIO')));
    expect(hex(contentCredentialsOff())).toBe(hex(ps.glb('CAI ')));
    expect(contentCredentialsEnabled(ps.glb('CAI ')!)).toBe(false);
  });
});

describe('Photoshop files keep their metadata, updated on save', () => {
  it('opening reports no unknown data for a plain Photoshop file', () => {
    const r = importPsd(read(path.join(NEW, 'rgb72.psd')), 'rgb72');
    expect(r.issues.filter((i) => ['preserved', 'rendered', 'partial', 'converted', 'dropped'].includes(i.status))).toEqual([]);
    expect(r.issues.some((i) => i.feature === 'Document metadata' && i.status === 'editable')).toBe(true);
  });

  it('EXIF size, resolution, app and date follow the document; everything else stays', () => {
    const src = read(path.join(NEW, 'rgb72.psd'));
    const doc = importPsd(src, 'x').doc;
    doc.canvas.resolution = 300;
    const out = blocks(exportPsd(doc, { now: new Date(2026, 9, 5, 12, 0, 0) }));
    const before = blocks(src).res(1058)!, after = out.res(1058)!;
    expect(readExifFields(after)).toEqual({ width: 128, height: 128, resolution: 300, colorSpace: 1, software: expect.stringMatching(/^Celenne Studio/) });
    expect(Buffer.from(after).toString('latin1')).toContain('2026:10:05 12:00:00');
    // The app name is shorter than Photoshop's, so it is rewritten in place: nothing moves.
    expect(after.length).toBe(before.length);
    // Print resolution follows too; the other print settings are unchanged.
    const style = readVersionedDescriptor(out.res(1083)!).desc;
    expect(hex(writeVersionedDescriptor(style))).toBe(hex(writeVersionedDescriptor(printStyle(300))));
    for (const id of [10000, 1013, 1016, 1092]) expect(hex(out.res(id))).toBe(hex(blocks(src).res(id)));
    for (const key of ['CAI ', 'OCIO', 'GenI']) expect(hex(out.glb(key))).toBe(hex(blocks(src).glb(key)));
  });

  it('a longer app name is appended without moving other EXIF data', () => {
    const src = blocks(read(path.join(NEW, 'rgb72.psd'))).res(1058)!;
    const long = 'Celenne Studio 0.3.0 with a much longer name than Photoshop';
    const out = patchExif(src, { width: 9, height: 8, resolution: 72, colorSpace: 1, software: long, date: new Date() });
    expect(readExifFields(out)).toEqual({ width: 9, height: 8, resolution: 72, colorSpace: 1, software: long });
    expect(out.length).toBeGreaterThan(src.length);
  });

  it('broken EXIF is kept as it was', () => {
    const junk = Uint8Array.from([0x4d, 0x4d, 0, 42, 0xff, 0xff, 0xff, 0xff, 1, 2, 3]);
    expect(patchExif(junk, { width: 1, height: 1, resolution: 72, colorSpace: 1, software: 'x', date: new Date() })).toBe(junk);
    expect(readExifFields(junk)).toBeNull();
  });

  it('converting to Grayscale writes the grayscale halftone and transfer set', () => {
    const doc = importPsd(read(path.join(NEW, 'rgb72.psd')), 'x').doc;
    const ps = blocks(read(path.join(NEW, 'gray150.psd')));
    doc.canvas.colorMode = 'grayscale';
    const out = blocks(exportPsd(doc));
    expect(out.ids).not.toContain(1013);
    expect(out.ids).not.toContain(1016);
    expect(hex(out.res(1012))).toBe(hex(ps.res(1012)));
    expect(hex(out.res(1015))).toBe(hex(ps.res(1015)));
  });

  it('Content Credentials turned on are reported, since Celenne does not add its edits to them', () => {
    const bytes = read(path.join(NEW, 'rgb72.psd'));
    const c = parseContainer(bytes);
    const cai = c.globalBlocks.find((b) => b.key === 'CAI ')!;
    // Flip the enab flag (the byte after 'enab' + 'bool').
    const at = Buffer.from(cai.data).indexOf('enabbool') + 8;
    const on = cai.data.slice(); on[at] = 1;
    expect(contentCredentialsEnabled(on)).toBe(true);
    const doc = importPsd(bytes, 'x').doc;
    doc.psd.rawGlobalBlocks = (doc.psd.rawGlobalBlocks ?? []).map((b) => (b.key === 'CAI ' ? { ...b, data: on } : b));
    const r = importPsd(exportPsd(doc), 'y');
    expect(r.issues.find((i) => i.feature === 'Content Credentials')?.status).toBe('preserved');
  });
});
