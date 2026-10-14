/**
 * Celenne's text engine against Photoshop, on the Photoshop-made text corpus
 * (tests/fixtures/photoshop/text): the engine's rendering of each text layer compared with the
 * pixels Photoshop stored for it. Needs the Windows fonts the corpus uses; skipped elsewhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { importPsd } from '../../src/psd/import';
import { FaceRegistry } from '../../src/typography/engine/registry';
import { registerFontFolder } from '../../src/typography/engine/nodeFonts';
import { renderEngineText } from '../../src/typography/engineRender';
import { layoutEngine } from '../../src/typography/engine/layout';
import type { ShapeLayer, TextLayer } from '../../src/document/types';
import { pathCoverage } from '../../src/typography/engine/raster';

const dir = path.resolve('tests/fixtures/photoshop/text');
const reg = new FaceRegistry();
let fontsOk = false;

beforeAll(async () => {
  fontsOk = fs.existsSync(dir) && (await registerFontFolder(reg)) > 0 && !!reg.resolve({ family: 'Arial', weight: 400, italic: false });
}, 60_000);

interface Loaded { text: TextLayer; outline: ShapeLayer | null; W: number; H: number }

function load(name: string): Loaded {
  const { doc } = importPsd(new Uint8Array(fs.readFileSync(path.join(dir, `${name}.psd`))), name);
  const text = doc.allLayers().find((x): x is TextLayer => x.kind === 'text')!;
  // Each corpus file holds a hidden copy of the text converted to a shape by Photoshop.
  const outline = doc.allLayers().find((x): x is ShapeLayer => x.kind === 'shape' && / outline$/.test(x.name)) ?? null;
  return { text, outline, W: doc.width, H: doc.height };
}

/** The engine's rendering (alpha) on the whole canvas. */
function engineAlpha(f: Loaded): Float32Array {
  const r = renderEngineText(f.text.text, reg);
  if (!r || r === 'pending') throw new Error('engine did not render');
  const out = new Float32Array(f.W * f.H);
  for (let y = 0; y < r.rect.h; y++)
    for (let x = 0; x < r.rect.w; x++) {
      const X = x + r.rect.x, Y = y + r.rect.y;
      if (X >= 0 && Y >= 0 && X < f.W && Y < f.H) out[Y * f.W + X] = r.data[(y * r.rect.w + x) * 4 + 3] / 255;
    }
  return out;
}

function iou(a: Float32Array, b: Float32Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) { inter += Math.min(a[i], b[i]); uni += Math.max(a[i], b[i]); }
  return uni ? inter / uni : 1;
}

describe('Text engine vs Photoshop', () => {
  // Minimum IoU per file: vertical text (upright glyphs, columns right to left) and type on a path
  // (text-path-*: Celenne's files outlined by Photoshop) included.
  const files: [string, number][] = [
    ['text-point-arial', 0.99], ['text-point-times', 0.99], ['text-point-verdana', 0.99], ['text-para-left', 0.99], ['text-para-justify', 0.99], ['text-para-hyphen', 0.99],
    ['text-para-every', 0.99], ['text-para-segoe-every', 0.99], ['text-kern-optical', 0.99], ['text-faux-italic', 0.97],
    ['text-vertical-point', 0.99], ['text-vertical-para', 0.99], ['text-path-curve', 0.97], ['text-path-flip', 0.97],
  ];
  for (const [name, min] of files) {
    it(`${name}: glyphs land where Photoshop puts them`, (ctx) => {
      if (!fontsOk) return ctx.skip();
      const f = load(name);
      // Photoshop's own outlines of the same text, filled by the same rasterizer: only placement differs.
      const ps = pathCoverage(f.outline!.path, 0, 0, f.W, f.H);
      expect(iou(engineAlpha(f), ps)).toBeGreaterThan(min);
    });
  }

  it("anti-aliasing modes follow Photoshop's (Strong is heavier, None is aliased)", (ctx) => {
    if (!fontsOk) return ctx.skip();
    const pixels = (f: Loaded) => { const px = f.text.raster.readFloat({ x: -f.text.x, y: -f.text.y, w: f.W, h: f.H }); const a = new Float32Array(f.W * f.H); for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3]; return a; };
    const strong = load('text-aa-strong-large');
    const exact = pathCoverage(strong.outline!.path, 0, 0, strong.W, strong.H);
    const ours = engineAlpha(strong);
    // The Strong curve brings Celenne closer to Photoshop's pixels than plain coverage.
    expect(iou(ours, pixels(strong))).toBeGreaterThan(0.95);
    expect(iou(ours, pixels(strong))).toBeGreaterThan(iou(exact, pixels(strong)) + 0.03);
    const none = engineAlpha(load('text-aa-none-large'));
    expect(none.every((v) => v === 0 || v === 1)).toBe(true);
  });

  it('underline and strikethrough follow the font metrics as in Photoshop', (ctx) => {
    if (!fontsOk) return ctx.skip();
    const f = load('text-underline');
    const px = f.text.raster.readFloat({ x: -f.text.x, y: -f.text.y, w: f.W, h: f.H });
    const ps = new Float32Array(f.W * f.H);
    for (let i = 0; i < ps.length; i++) ps[i] = px[i * 4 + 3];
    const ours = engineAlpha(f);
    // Rows that are fully covered (the lines) are the same rows as in Photoshop's pixels.
    const fullRows = (a: Float32Array) => { const rows: number[] = []; for (let y = 0; y < f.H; y++) { let n = 0; for (let x = 0; x < f.W; x++) if (a[y * f.W + x] > 0.5) n++; if (n > 600) rows.push(y); } return rows; };
    expect(fullRows(ours)).toEqual(fullRows(ps));
  });

  it("keeps Photoshop's line breaks for an unchanged paragraph, re-flows an edited one", (ctx) => {
    if (!fontsOk) return ctx.skip();
    const l = load('text-para-every').text;
    expect(l.text.psBreaks?.length).toBe(1);
    const starts = (o = {}) => layoutEngine(l.text, reg, o).lines.map((ln) => ln.glyphs[0]?.index);
    const stored = starts();
    const composed = starts({ ignoreStoredBreaks: true });
    // Celenne's Every-line approximation breaks this paragraph as Photoshop did.
    expect(composed).toEqual(stored);
    // Recolouring keeps the breaks…
    l.text.runs = l.text.runs.map((r) => ({ ...r, style: { ...r.style, color: { r: 1, g: 0, b: 0, a: 1 } } }));
    expect(starts()).toEqual(stored);
    // …an edit of the paragraph re-flows it with Celenne's composer.
    l.text.text = l.text.text.replace('Celenne', 'Our editor');
    l.text.runs[l.text.runs.length - 1].length += 3;
    l.text.paragraphs[l.text.paragraphs.length - 1].length += 3;
    expect(starts()[1]).not.toBe(stored[1]);
  });
});
