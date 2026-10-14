/** Regressions found by testing Photoshop-authored files. */
import { describe, expect, it } from 'vitest';
import { exportPsd } from '../../src/psd/export';
import { importPsd } from '../../src/psd/import';
import { parseContainer, findResource } from '../../src/psd/container';
import { fontHintsFromPostScript } from '../../src/psd/mapping';
import { createTextLayer } from '../../src/document/layerFactory';
import { add, newDoc, solidLayer } from '../helpers/build';

describe('Photoshop file regressions', () => {
  it('derives font families from PostScript names with acronyms', () => {
    expect(fontHintsFromPostScript('SegoeUIEmoji').family).toBe('Segoe UI Emoji');
    expect(fontHintsFromPostScript('SegoeUI-Bold')).toMatchObject({ family: 'Segoe UI', weight: 700 });
    expect(fontHintsFromPostScript('TimesNewRomanPSMT').family).toBe('Times New Roman');
    expect(fontHintsFromPostScript('ArialMT').family).toBe('Arial');
    expect(fontHintsFromPostScript('MyriadPro-Regular').family).toBe('Myriad Pro');
  });

  it('keeps untagged documents untagged (no sRGB profile embedded on save)', () => {
    const d = newDoc(16, 16);
    add(d, solidLayer(d, 'bg', 0, 0, 16, 16, [1, 1, 1, 1]));
    d.profile = { name: 'Untagged (working sRGB)', builtin: 'srgb', untagged: true };
    const c = parseContainer(exportPsd(d));
    expect(findResource(c, 1039)).toBeUndefined();
    expect(findResource(c, 1041)).toBeDefined();
    const back = importPsd(exportPsd(d), 'u.psd').doc;
    expect(back.profile.untagged).toBe(true);
    // A tagged document still embeds its profile.
    d.profile = { name: 'sRGB IEC61966-2.1', builtin: 'srgb' };
    expect(findResource(parseContainer(exportPsd(d)), 1039)).toBeDefined();
  });

  it('writes the layer selection so the file reopens with the same layers selected', () => {
    const d = newDoc(16, 16);
    add(d, solidLayer(d, 'a', 0, 0, 8, 8, [1, 0, 0, 1]));
    const b = add(d, solidLayer(d, 'b', 0, 0, 8, 8, [0, 1, 0, 1]));
    const c = parseContainer(exportPsd(d, { selectedLayerIds: [b.id] }));
    expect(findResource(c, 1069)).toBeDefined();
  });

  it('does not report ordinary text layers as "text on path"', () => {
    const d = newDoc(64, 32);
    add(d, solidLayer(d, 'bg', 0, 0, 64, 32, [1, 1, 1, 1]));
    add(d, createTextLayer('Label', 8, 4, 20));
    const { issues } = importPsd(exportPsd(d), 't.psd');
    expect(issues.some((i) => i.feature === 'Text on path')).toBe(false);
  });
});
