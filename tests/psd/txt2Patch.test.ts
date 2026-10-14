/**
 * Photoshop's Txt2 block on save: read and written back byte for byte, patched for text edited in
 * Celenne, and extended with objects (and frames) for text layers added in Celenne, so a Photoshop
 * file keeps its own text data. (Photoshop's behaviour with these files was checked with
 * scripts/photoshop/open-probe.ps1 and retype.ps1: no prompt, and its re-layout equals Celenne's.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importPsd } from '../../src/psd/import';
import { exportPsd } from '../../src/psd/export';
import { parseContainer } from '../../src/psd/container';
import { readTxt2Lossless, writeTxt2Lossless, tget, type TNode } from '../../src/psd/txt2Write';
import { patchTxt2, txt2ObjectCount } from '../../src/psd/txt2Patch';
import { readCelenneText } from '../../src/psd/celenneXmp';
import { runsPerParagraph } from '../../src/typography/types';
import { createTextLayer } from '../../src/document/layerFactory';
import { cloneLayer } from '../../src/document/clone';
import type { TextLayer } from '../../src/document/types';

const dir = path.resolve('tests/fixtures/photoshop/text');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.psd')).sort() : [];
const bytesOf = (f: string) => new Uint8Array(fs.readFileSync(path.join(dir, f)));
const txt2Of = (psd: Uint8Array) => parseContainer(psd).globalBlocks.find((b) => b.key === 'Txt2')?.data;
const rootOf = (b: Uint8Array): TNode => ({ k: 'dict', v: readTxt2Lossless(b) });
const textLayers = (doc: ReturnType<typeof importPsd>['doc']) => doc.allLayers().filter((l): l is TextLayer => l.kind === 'text');
const objText = (b: Uint8Array, i: number) => (tget(rootOf(b), '1', '1', i, '0', '0') as { v: string } | undefined)?.v;
const indexOf = (l: TextLayer) => (l.metadata.psd?.source as { text?: { index?: number } } | undefined)?.text?.index;

function setText(l: TextLayer, text: string) {
  const d = text.length - l.text.text.length;
  l.text.text = text;
  l.text.runs[l.text.runs.length - 1].length += d;
  l.text.paragraphs[l.text.paragraphs.length - 1].length += d;
  l.usingPreservedPixels = false;
}

describe.skipIf(!files.length)('Txt2', () => {
  it('reads and writes every corpus block byte for byte', () => {
    let n = 0;
    for (const f of files) {
      const b = txt2Of(bytesOf(f));
      if (!b) continue;
      expect(Buffer.from(writeTxt2Lossless(readTxt2Lossless(b))).equals(Buffer.from(b)), f).toBe(true);
      n++;
    }
    expect(n).toBeGreaterThan(40);
  });

  it('patches an edited object: text, run lengths, colour, and an emptied layout', () => {
    const { doc } = importPsd(bytesOf('text-para-paragraphs.psd'), 'x');
    const l = textLayers(doc)[0];
    setText(l, l.text.text + ' Added in Celenne.');
    l.text.runs = l.text.runs.map((r) => ({ ...r, style: { ...r.style, color: { r: 0.5, g: 0.25, b: 0, a: 1 } } }));
    const out = txt2Of(exportPsd(doc))!;
    expect(out).toBeDefined();
    expect(objText(out, indexOf(l)!)?.replace(/\r/g, '\n')).toBe(l.text.text + '\n');
    const obj = tget(rootOf(out), '1', '1', indexOf(l)!);
    const runs = tget(obj, '0', '6', '0');
    const total = runs?.k === 'arr' ? runs.v.reduce((s, r) => s + ((tget(r, '1') as { v: number }).v), 0) : -1;
    expect(total).toBe(l.text.text.length + 1);
    const paint = tget(runs?.k === 'arr' ? runs.v[0] : undefined, '0', '0', '6', '53', '0', '1');
    expect(paint?.k === 'arr' && paint.v.map((x) => (x as { v: number }).v)).toEqual([1, 0.5, 0.25, 0]);
    const layout = tget(obj, '1', '2');
    expect(layout?.k === 'arr' && layout.v.length).toBe(0);
    // One view entry per paragraph, with the paragraph's length (closing "\r" included).
    const paras = tget(obj, '1', '1', '0');
    expect(paras?.k === 'arr' && paras.v.map((e) => (tget(e, '1') as { v: number }).v)).toEqual(l.text.text.split('\n').map((p) => p.length + 1));
  });

  it('adds an object and a frame for each new text layer, and a new object for a copy', () => {
    const src = bytesOf('text-para-left.psd');
    const before = txt2ObjectCount(txt2Of(src)!);
    const { doc } = importPsd(src, 'x');
    const point = createTextLayer('New point text', 8, 10, 30);
    const box = createTextLayer('ข้อความใหม่ในกรอบ', 8, 10, 60, { kind: 'paragraph', box: { x: 0, y: 0, w: 200, h: 80 } });
    const copy = cloneLayer(textLayers(doc)[0], true);
    setText(copy, 'Copied ' + copy.text.text);
    for (const l of [point, box, copy]) doc.insertLayer(l, doc.root);
    const psd = exportPsd(doc);
    const out = txt2Of(psd)!;
    expect(out).toBeDefined();
    expect(txt2ObjectCount(out)).toBe(before + 3);
    const back = textLayers(importPsd(psd, 'y').doc);
    // Every layer names its own object, and each object holds that layer's text.
    const idx = back.map(indexOf);
    expect(new Set(idx).size).toBe(back.length);
    for (const l of back) expect(objText(out, indexOf(l)!)).toBe(l.text.text.replace(/\n/g, '\r') + '\r');
    // Frames: a point frame, and a box frame with the box outline and a cap-height first line.
    const root = rootOf(out);
    const frameOf = (l: TextLayer) => {
      const fi = tget(root, '1', '1', indexOf(l)!, '1', '0', 0, '0') as { v: number };
      return tget(root, '0', '8', '0', fi.v);
    };
    const boxBack = back.find((l) => l.text.text === box.text.text)!;
    const fb = frameOf(boxBack);
    const outline = tget(fb, '0', '1', '0');
    expect(outline?.k === 'arr' && outline.v.map((x) => (x as { v: number }).v).slice(0, 8)).toEqual([0, 0, 0, 0, 200, 0, 200, 0]);
    expect((tget(fb, '0', '2', '10', '0') as { v: number }).v).toBe(2);
    expect(tget(frameOf(back.find((l) => l.text.text === point.text.text)!), '0', '1')).toBeUndefined();
  });

  it('gives a document made in Celenne a Txt2 block, so Photoshop does not ask to update its text', () => {
    // A new document has no Photoshop text data: built from Photoshop's own template plus one
    // object and frame per text layer (an empty layer included).
    const doc = importPsd(exportPsd(importPsd(bytesOf('text-point-arial.psd'), 'x').doc, { invalidateText: true }), 'y').doc;
    for (const l of textLayers(doc)) doc.removeLayer(l);
    const point = createTextLayer('Point', 8, 10, 30);
    const box = createTextLayer('ข้อความในกรอบ', 8, 10, 60, { kind: 'paragraph', box: { x: 0, y: 0, w: 120, h: 50 } });
    const empty = createTextLayer('', 8, 10, 90);
    for (const l of [point, box, empty]) doc.insertLayer(l, doc.root);
    (doc.psd.source as { engineData?: unknown }).engineData = undefined;
    const psd = exportPsd(doc);
    const out = txt2Of(psd)!;
    expect(out).toBeDefined();
    expect(txt2ObjectCount(out)).toBe(3);
    const back = textLayers(importPsd(psd, 'z').doc);
    expect(back.map(indexOf).sort()).toEqual([0, 1, 2]);
    for (const l of back) expect(objText(out, indexOf(l)!)).toBe(l.text.text.replace(/\n/g, '\r') + '\r');
    // Photoshop's style sheets came with the template.
    expect(tget(rootOf(out), '0', '6', '0')?.k).toBe('arr');
  });

  it('writes vertical and path text frames as Photoshop does, and one paragraph run per paragraph', () => {
    const doc = importPsd(exportPsd(importPsd(bytesOf('text-point-arial.psd'), 'x').doc, { invalidateText: true }), 'y').doc;
    for (const l of textLayers(doc)) doc.removeLayer(l);
    (doc.psd.source as { engineData?: unknown }).engineData = undefined;
    const v = createTextLayer('Vertical\nSecond paragraph', 8, 40, 10);
    v.text.orientation = 'vertical';
    const onPath = createTextLayer('On a path', 8, 0, 0);
    onPath.text.path = { subpath: { knots: [{ x: 10, y: 50, inX: 10, inY: 50, outX: 40, outY: 10, smooth: false }, { x: 110, y: 50, inX: 80, inY: 10, outX: 110, outY: 50, smooth: false }], closed: false, op: 'combine' }, start: 5, flip: true };
    for (const l of [v, onPath]) doc.insertLayer(l, doc.root);
    const psd = exportPsd(doc);
    const root = rootOf(txt2Of(psd)!);
    const back = textLayers(importPsd(psd, 'z').doc);
    const frameOf = (l: TextLayer) => tget(root, '0', '8', '0', (tget(root, '1', '1', indexOf(l)!, '1', '0', 0, '0') as { v: number }).v);
    const vb = back.find((l) => l.text.orientation === 'vertical')!;
    expect((tget(frameOf(vb), '0', '2', '1') as { v: number }).v).toBe(2);
    // Two paragraphs with the same settings: still two runs (one per paragraph), as Photoshop needs.
    const runs = tget(root, '1', '1', indexOf(vb)!, '0', '5', '0');
    expect(runs?.k === 'arr' && runs.v.map((r) => (tget(r, '1') as { v: number }).v)).toEqual([9, 17]);
    const pb = back.find((l) => l.text.path)!;
    expect((tget(frameOf(pb), '0', '2', '0') as { v: number }).v).toBe(2);
    expect((tget(frameOf(pb), '0', '2', '11', '0') as { v: boolean }).v).toBe(true);
    expect(pb.text.path!.start).toBeCloseTo(5, 2);
    expect(pb.text.path!.flip).toBe(true);
  });

  it("keeps Celenne-only paragraph settings in the file's XMP metadata", () => {
    const { doc } = importPsd(bytesOf('text-para-paragraphs.psd'), 'x');
    const l = textLayers(doc)[0];
    l.text.paragraphs = runsPerParagraph(l.text).map((p, i) => ({ ...p, style: { ...p.style, ...(i === 1 ? { composer: 'celenne' as const, opticalMargins: true } : {}) } }));
    const psd = exportPsd(doc);
    // Photoshop's own settings say Single-line (Photoshop lays the paragraph out with it).
    const back = textLayers(importPsd(psd, 'y').doc)[0];
    const paras = runsPerParagraph(back.text);
    expect(paras[1].style.composer).toBe('celenne');
    expect(paras[1].style.opticalMargins).toBe(true);
    expect(paras[0].style.composer ?? 'single').toBe('single');
    expect(readCelenneText('<x:xmpmeta><celenne:text>not base64!</celenne:text></x:xmpmeta>')).toEqual({});
  });

  it('names fonts by their PostScript names, as Photoshop finds them', () => {
    // New text has only a family ("Arial"); Photoshop reports "Arial" as a missing font.
    const { doc } = importPsd(bytesOf('text-para-left.psd'), 'x');
    const l = createTextLayer('New text', 8, 10, 30);
    expect(l.text.runs[0].style.postScriptName).toBeUndefined();
    doc.insertLayer(l, doc.root);
    const psd = exportPsd(doc);
    const back = textLayers(importPsd(psd, 'y').doc).find((x) => x.text.text === 'New text')!;
    expect(back.text.runs[0].style.postScriptName).toBe('ArialMT');
    const fontsList = tget(rootOf(txt2Of(psd)!), '0', '1', '0');
    const names = fontsList?.k === 'arr' ? fontsList.v.map((f) => (tget(f, '0', '0', '0') as { v: string }).v) : [];
    expect(names).toContain('ArialMT');
    expect(names).not.toContain('Arial');
  });

  it('drops the block when a new layer cannot be written exactly', () => {
    const src = bytesOf('text-point-arial.psd');
    const v0 = createTextLayer('V', 8, 0, 0);
    v0.text.runs[0].style.openTypeFeatures = ['ss01'];
    expect(patchTxt2(txt2Of(src)!, [], [{ text: v0.text }])).toBeNull();
    const { doc } = importPsd(src, 'x');
    const v = createTextLayer('Stylistic set', 8, 10, 10);
    v.text.runs[0].style.openTypeFeatures = ['ss01'];
    doc.insertLayer(v, doc.root);
    expect(txt2Of(exportPsd(doc))).toBeUndefined();
  });

  it('keeps the block unchanged when no text changed', () => {
    const src = bytesOf('text-thai-para-tahoma.psd');
    const out = txt2Of(exportPsd(importPsd(src, 'x').doc))!;
    // (The block may gain a padding byte when written.)
    const unpadded = (b: Uint8Array) => Buffer.from(b).toString('latin1').replace(/\0+$/, '');
    expect(unpadded(out)).toBe(unpadded(txt2Of(src)!));
  });
});
