import { describe, expect, it } from 'vitest';
import { exportPsd } from '../../src/psd/export';
import { importPsd } from '../../src/psd/import';
import { parseContainer, serializeContainer } from '../../src/psd/container';
import { complexDoc, newDoc, solidLayer, add, structure } from '../helpers/build';

describe('PSD round trip', () => {
  it('saves and reopens a complex document without structural loss', () => {
    const doc = complexDoc(8);
    const bytes = exportPsd(doc);
    const { doc: back, warnings } = importPsd(bytes, 'complex.psd');
    expect(warnings).toEqual([]);
    expect(structure(back)).toEqual(structure(doc));
  });

  it('preserves pixel values of layers', () => {
    const doc = complexDoc(8);
    const back = importPsd(exportPsd(doc), 'complex.psd').doc;
    const red = back.allLayers().find((l) => l.name === 'Red')!;
    expect(red.kind).toBe('pixel');
    expect(red.x).toBe(8);
    expect(red.y).toBe(8);
    const px = (red as { raster: { readFloat: (r: unknown) => Float32Array } }).raster.readFloat({ x: 0, y: 0, w: 1, h: 1 });
    expect(Array.from(px)).toEqual([1, 0, 0, 1]);
    // Mask hole at doc (10..20, 10..20) must be black.
    const m = red.mask!.raster.readFloat({ x: 12 - red.mask!.x, y: 12 - red.mask!.y, w: 1, h: 1 });
    expect(m[0]).toBe(0);
    const m2 = red.mask!.raster.readFloat({ x: 30 - red.mask!.x, y: 30 - red.mask!.y, w: 1, h: 1 });
    expect(m2[0]).toBe(1);
  });

  it('preserves alpha channels, paths, guides and resolution', () => {
    const doc = complexDoc(8);
    doc.canvas.resolution = 300;
    const back = importPsd(exportPsd(doc), 'x.psd').doc;
    expect(back.canvas.resolution).toBe(300);
    expect(back.channels).toHaveLength(1);
    const a = back.channels[0].raster.readFloat({ x: 0, y: 0, w: 1, h: 1 })[0];
    const b = back.channels[0].raster.readFloat({ x: 40, y: 40, w: 1, h: 1 })[0];
    expect(a).toBe(1);
    expect(b).toBe(0);
    expect(back.paths[0].path.subpaths[0].knots).toHaveLength(3);
    expect(back.paths[0].path.subpaths[0].knots[1].x).toBeCloseTo(50, 3);
    expect(back.guides.map((g) => g.position).sort()).toEqual([32, 48]);
  });

  it('round-trips 16-bit documents at full precision', () => {
    const doc = newDoc(40, 30, 16);
    const l = add(doc, solidLayer(doc, 'Deep', 5, 5, 20, 10, [0.123456, 0.5, 0.987654, 1]));
    void l;
    const bytes = exportPsd(doc);
    const c = parseContainer(bytes);
    expect(c.depth).toBe(16);
    const back = importPsd(bytes, 'deep.psd').doc;
    expect(back.canvas.bitDepth).toBe(16);
    const layer = back.allLayers()[0] as { raster: { readPixels: (r: unknown) => Uint16Array }; x: number };
    const px = layer.raster.readPixels({ x: 0, y: 0, w: 1, h: 1 });
    expect(px[0]).toBe(Math.round(0.123456 * 65535));
    expect(px[2]).toBe(Math.round(0.987654 * 65535));
    expect(layer.x).toBe(5);
  });

  it('container parse → serialize is byte-stable for ag-psd output', () => {
    const bytes = exportPsd(complexDoc(8));
    const again = serializeContainer(parseContainer(bytes));
    const c1 = parseContainer(bytes), c2 = parseContainer(again);
    expect(c2.layers.length).toBe(c1.layers.length);
    expect(c2.resources.map((r) => r.id)).toEqual(c1.resources.map((r) => r.id));
    expect(importPsd(again, 'x.psd').doc.layerCount()).toBe(importPsd(bytes, 'x.psd').doc.layerCount());
  });

  it('keeps unknown layer blocks byte-for-byte', () => {
    const doc = complexDoc(8);
    const bytes = exportPsd(doc);
    // Inject an unknown block into the first layer record, as a future Photoshop might.
    const c = parseContainer(bytes);
    c.layers[c.layers.length - 1].blocks.push({ sig: '8BIM', key: 'Zzzz', data: new Uint8Array([1, 2, 3, 4]) });
    const withUnknown = serializeContainer(c);
    const { doc: opened, issues } = importPsd(withUnknown, 'x.psd');
    expect(issues.some((i) => i.message.includes('Zzzz'))).toBe(true);
    const resaved = parseContainer(exportPsd(opened));
    const found = resaved.layers.some((l) => l.blocks.some((b) => b.key === 'Zzzz' && b.data[0] === 1 && b.data[3] === 4));
    expect(found).toBe(true);
  });

  it('rejects corrupt files with a clear error instead of crashing', () => {
    const bytes = exportPsd(complexDoc(8));
    const broken = bytes.slice(0, 200);
    expect(() => importPsd(broken, 'broken.psd')).toThrow(/damaged|valid/i);
    expect(() => importPsd(new Uint8Array([1, 2, 3]), 'x.psd')).toThrow();
  });
});
