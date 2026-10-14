/**
 * Proprietary camera raw formats through LibRaw (Phase 4.2), on CC0 samples from raw.pixls.us
 * (tests/fixtures/raw; fetch with `node scripts/raw/fetch-samples.mjs`; skipped when absent).
 * Celenne's development is compared with LibRaw's own (same white level, white balance and
 * matrix, ProPhoto RGB): 16 × 16 block means, ΔE2000.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeLibRaw, libRawReference } from '../../src/formats/libraw';
import { decodeDng } from '../../src/formats/dng';
import { deltaE2000, proPhoto16ToLab } from '../helpers/deltaE';

const dir = path.resolve('tests/fixtures/raw');
const have = (f: string) => fs.existsSync(path.join(dir, f));
const read = (f: string) => new Uint8Array(fs.readFileSync(path.join(dir, f)));

// File, camera, Celenne's size [, Photoshop 2025's size when it differs (Adobe's per-camera crop)].
const CASES: [string, string, string, string?][] = [
  ['Canon-EOS6D.cr2', 'Canon EOS 6D', '5472x3648'],
  ['Canon-EOSM50.cr3', 'Canon EOS M50', '6000x4000'],
  ['Fujifilm-X-T3.raf', 'Fujifilm X-T3', '6240x4155', '6240x4160'],
  ['Nikon-D750.nef', 'Nikon D750', '6032x4032', '6016x4016'],
  ['Nikon-Z6.nef', 'Nikon Z 6', '6048x4024'],
  ['Olympus-E-M1MarkII.orf', 'Olympus E-M1MarkII', '5184x3888'],
  ['Panasonic-DC-G9.rw2', 'Panasonic DC-G9', '5184x3456'],
  ['Pentax-KP.pef', 'Pentax KP', '6028x4032', '6016x4000'],
  ['Samsung-NX500.srw', 'Samsung NX500', '6496x4336', '6480x4320'],
  ['Sony-ILCE-7M3.arw', 'Sony ILCE-7M3', '6000x4000'],
];

describe('Camera raw through LibRaw', () => {
  for (const [file, camera, size] of CASES) {
    it(`${file}: ${camera} decodes at ${size} with LibRaw's colours`, async (ctx) => {
      if (!have(file)) return ctx.skip();
      const bytes = read(file);
      const img = await decodeLibRaw(bytes);
      expect(`${img.camera.make} ${img.camera.model}`).toBe(camera);
      expect(`${img.width}x${img.height}`).toBe(size);
      expect(img.depth).toBe(16);
      const ref = await libRawReference(bytes, 0);
      const { x: ox, y: oy } = img.camera.crop;
      const B = 16, des: number[] = [];
      for (let by = 0; by + B <= img.height; by += B * 8)
        for (let bx = 0; bx + B <= img.width; bx += B * 8) {
          const a = [0, 0, 0], b = [0, 0, 0];
          for (let y = by; y < by + B; y++)
            for (let x = bx; x < bx + B; x++)
              for (let c = 0; c < 3; c++) { a[c] += img.data[(y * img.width + x) * 4 + c]; b[c] += ref.data[((y + oy) * ref.width + x + ox) * 3 + c]; }
          if (Math.max(...a, ...b) > 64000 * B * B) continue; // clipped highlights
          des.push(deltaE2000(proPhoto16ToLab(a.map((v) => v / (B * B))), proPhoto16ToLab(b.map((v) => v / (B * B)))));
        }
      des.sort((p, q) => p - q);
      expect(des.reduce((s, v) => s + v, 0) / des.length).toBeLessThan(0.5);
      expect(des[Math.floor(des.length * 0.95)]).toBeLessThan(1.2);
    }, 120_000);
  }

  it("the camera's own DNG (Pentax KP) decodes at Photoshop's size", (ctx) => {
    if (!have('Pentax-KP.dng')) return ctx.skip();
    const img = decodeDng(read('Pentax-KP.dng'));
    expect(`${img.width}x${img.height}`).toBe('6016x4000');
  }, 60_000);

  it('rejects damaged and cut-short files without crashing or hanging', async (ctx) => {
    if (!have('Nikon-Z6.nef') || !have('Canon-EOSM50.cr3')) return ctx.skip();
    for (const file of ['Nikon-Z6.nef', 'Canon-EOSM50.cr3']) {
      const bytes = read(file);
      // Cut short: LibRaw stops with an error, or returns what it could read.
      await decodeLibRaw(bytes.slice(0, Math.floor(bytes.length * 0.3))).then((img) => expect(img.width).toBeGreaterThan(0), (e) => expect(String(e)).toMatch(/Camera raw/));
      // Damaged: random bytes all through the file.
      const bad = bytes.slice();
      let seed = 1;
      for (let i = 0; i < 2000; i++) { seed = (seed * 1103515245 + 12345) >>> 0; bad[seed % bad.length] = seed & 255; }
      await decodeLibRaw(bad).then((img) => expect(img.width).toBeGreaterThan(0), (e) => expect(String(e)).toMatch(/Camera raw/));
      // Not a raw file at all.
      await expect(decodeLibRaw(new Uint8Array(4096).fill(7))).rejects.toThrow(/Camera raw/);
    }
  }, 120_000);
});
