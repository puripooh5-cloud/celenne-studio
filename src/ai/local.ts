/**
 * LocalAIProvider — offline implementations built from classical computer-vision techniques.
 * Results are good for many photos but are estimates, not learned segmentation; the UI says so.
 */
import type { AICapabilities, AIProvider, InpaintRequest } from './provider';
import type { DocumentSession } from '../app/session';
import { TiledRaster } from '../image-engine/tiledRaster';
import type { Rect } from '../image-engine/rect';
import { intersect } from '../image-engine/rect';
import { compositeRegion } from '../rendering/compositor';
import { hasRaster } from '../document/types';
import { inpaint, inpaintCarry } from './inpaint';
import { resizeImage } from '../image-engine/resample';
import { boxBlur, gaussianBlur } from '../image-engine/blur';
import { rgbToLab } from '../color/convert';

const WORK = 384;

function straight(buf: Float32Array, n: number) {
  for (let i = 0; i < n; i++) {
    const a = buf[i * 4 + 3];
    if (a > 1e-7) { buf[i * 4] /= a; buf[i * 4 + 1] /= a; buf[i * 4 + 2] /= a; }
  }
}

function labOf(img: Float32Array, n: number): Float32Array {
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const L = rgbToLab({ r: img[i * 4], g: img[i * 4 + 1], b: img[i * 4 + 2] });
    lab[i * 3] = L.l; lab[i * 3 + 1] = L.a; lab[i * 3 + 2] = L.b;
  }
  return lab;
}

function kmeans(pts: number[][], k: number, iters = 8): number[][] {
  if (!pts.length) return [];
  const centers = Array.from({ length: Math.min(k, pts.length) }, (_, i) => [...pts[Math.floor((i * pts.length) / k)]]);
  for (let it = 0; it < iters; it++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const p of pts) {
      let bi = 0, bd = Infinity;
      centers.forEach((c, i) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; bi = i; } });
      const s = sums[bi];
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    sums.forEach((s, i) => { if (s[3]) centers[i] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  return centers;
}

const minDist = (p: number[], cs: number[][]) => Math.sqrt(Math.min(...cs.map((c) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2)));

function largestComponent(m: Uint8Array, w: number, h: number): Uint8Array {
  const label = new Int32Array(w * h).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || label[i] >= 0) continue;
    const stack = [i];
    label[i] = id;
    let size = 0;
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % w, y = Math.floor(j / w);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx;
        if (m[k] && label[k] < 0) { label[k] = id; stack.push(k); }
      }
    }
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = label[i] === best ? 1 : 0;
  // Fill holes: background regions not connected to the border become foreground.
  const bg = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
  while (stack.length) {
    const j = stack.pop()!;
    if (bg[j] || out[j]) continue;
    bg[j] = 1;
    const x = j % w, y = Math.floor(j / w);
    if (x > 0) stack.push(j - 1);
    if (x < w - 1) stack.push(j + 1);
    if (y > 0) stack.push(j - w);
    if (y < h - 1) stack.push(j + w);
  }
  for (let i = 0; i < w * h; i++) if (!bg[i]) out[i] = 1;
  return out;
}

/** Guided filter (He et al.) on a single-channel mask with the luminance as guide. */
export function guidedRefine(img: Float32Array, mask: Float32Array, w: number, h: number, r: number, eps = 1e-3): Float32Array {
  const n = w * h;
  const I = new Float32Array(n);
  for (let i = 0; i < n; i++) I[i] = 0.3 * img[i * 4] + 0.59 * img[i * 4 + 1] + 0.11 * img[i * 4 + 2];
  const mean = (a: Float32Array) => { const b = a.slice(); boxBlur(b, w, h, 1, r); return b; };
  const mI = mean(I), mP = mean(mask);
  const II = I.map((v) => v * v), IP = I.map((v, i) => v * mask[i]);
  const mII = mean(II), mIP = mean(IP);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = mII[i] - mI[i] * mI[i];
    const cov = mIP[i] - mI[i] * mP[i];
    a[i] = cov / (varI + eps);
    b[i] = mP[i] - a[i] * mI[i];
  }
  const ma = mean(a), mb = mean(b);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(1, ma[i] * I[i] + mb[i]));
  return out;
}

export class LocalAIProvider implements AIProvider {
  readonly id = 'local';
  readonly kind = 'local' as const;
  readonly label = 'Local (built-in, offline)';

  capabilities(): AICapabilities {
    return { selectSubject: true, selectSky: true, removeBackground: true, objectRemoval: true, generativeFill: false, generativeExpand: false, upscale: true, faceAware: false, refineEdges: true };
  }

  private sample(s: DocumentSession, box: Rect, layerId?: string): { img: Float32Array; w: number; h: number; scale: number } {
    const scale = Math.min(1, WORK / Math.max(box.w, box.h));
    const level = Math.max(0, Math.floor(Math.log2(1 / scale)));
    const ls = 1 << level;
    const r = { x: Math.floor(box.x / ls), y: Math.floor(box.y / ls), w: Math.max(1, Math.ceil(box.w / ls)), h: Math.max(1, Math.ceil(box.h / ls)) };
    let img: Float32Array;
    const layer = layerId ? s.doc.getLayer(layerId) : null;
    if (layer && hasRaster(layer)) {
      img = layer.raster.readFloat({ x: r.x - Math.round(layer.x / ls), y: r.y - Math.round(layer.y / ls), w: r.w, h: r.h }, level);
    } else {
      img = compositeRegion(s.doc, r, { level });
      straight(img, r.w * r.h);
    }
    return { img, w: r.w, h: r.h, scale: 1 / ls };
  }

  private toRaster(mask: Float32Array, w: number, h: number, box: Rect, img: Float32Array): TiledRaster {
    // Refine at working resolution, then upsample to the document box.
    const refined = guidedRefine(img, mask, w, h, 3, 2e-3);
    const up = resizeImage(refined, w, h, box.w, box.h, 'bilinear', 1);
    for (let i = 0; i < up.length; i++) up[i] = Math.max(0, Math.min(1, (up[i] - 0.5) * 3 + 0.5));
    const out = new TiledRaster(1, 8, 0);
    out.writeFloat(box, up);
    out.compact();
    return out;
  }

  async selectSubject(s: DocumentSession, box?: Rect, layerId?: string): Promise<TiledRaster> {
    const b = box ? intersect(box, s.doc.bounds) : s.doc.bounds;
    const { img, w, h } = this.sample(s, b, layerId);
    const n = w * h;
    const lab = labOf(img, n);
    const P = (i: number) => [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
    // Background model: border pixels. Foreground model: center-weighted interior.
    const border: number[][] = [];
    const bw = Math.max(2, Math.round(Math.min(w, h) * 0.04));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < bw || y < bw || x >= w - bw || y >= h - bw) if ((x + y) % 2 === 0) border.push(P(y * w + x));
    const bg = kmeans(border, 6);
    const inner: number[][] = [];
    for (let y = Math.floor(h * 0.25); y < h * 0.75; y += 2) for (let x = Math.floor(w * 0.25); x < w * 0.75; x += 2) { const p = P(y * w + x); if (minDist(p, bg) > 12) inner.push(p); }
    const fg = inner.length > 20 ? kmeans(inner, 6) : [[50, 0, 0]];
    const prob = new Float32Array(n);
    const cx = w / 2, cy = h / 2;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const p = P(i);
        const db = minDist(p, bg), df = minDist(p, fg);
        const prior = Math.exp(-(((x - cx) / (w * 0.45)) ** 2 + ((y - cy) / (h * 0.45)) ** 2));
        const a = img[i * 4 + 3];
        prob[i] = a < 0.05 ? 0 : (db / (db + df + 1e-6)) * (0.55 + 0.45 * prior);
      }
    gaussianBlur(prob, w, h, 1, 1.2);
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) bin[i] = prob[i] > 0.5 ? 1 : 0;
    const comp = largestComponent(bin, w, h);
    const mask = new Float32Array(n);
    for (let i = 0; i < n; i++) mask[i] = comp[i];
    return this.toRaster(mask, w, h, b, img);
  }

  async selectSky(s: DocumentSession): Promise<TiledRaster> {
    const b = s.doc.bounds;
    const { img, w, h } = this.sample(s, b);
    const n = w * h;
    // Local texture (variance) — skies are smooth.
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = 0.3 * img[i * 4] + 0.59 * img[i * 4 + 1] + 0.11 * img[i * 4 + 2];
    const m = L.slice(), m2 = L.map((v) => v * v);
    boxBlur(m, w, h, 1, 2);
    boxBlur(m2, w, h, 1, 2);
    const skyLike = (i: number) => {
      const r = img[i * 4], g = img[i * 4 + 1], bb = img[i * 4 + 2];
      const variance = m2[i] - m[i] * m[i];
      const blue = bb > r * 1.02 && bb > 0.35;
      const bright = L[i] > 0.62 && Math.max(r, g, bb) - Math.min(r, g, bb) < 0.18;
      return variance < 0.004 && (blue || bright);
    };
    const mask = new Uint8Array(n);
    const stack: number[] = [];
    for (let x = 0; x < w; x++) if (skyLike(x)) stack.push(x);
    while (stack.length) {
      const i = stack.pop()!;
      if (mask[i]) continue;
      if (!skyLike(i)) continue;
      mask[i] = 1;
      const x = i % w, y = Math.floor(i / w);
      if (x > 0) stack.push(i - 1);
      if (x < w - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - w);
      if (y < h - 1) stack.push(i + w);
    }
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = mask[i];
    return this.toRaster(f, w, h, b, img);
  }

  async removeBackground(s: DocumentSession, layerId: string): Promise<TiledRaster> {
    return this.selectSubject(s, undefined, layerId);
  }

  async inpaint(req: InpaintRequest, cancelled?: () => boolean, progress?: (f: number) => void): Promise<Float32Array> {
    return inpaint(req.image, req.width, req.height, req.mask, { cancelled, progress });
  }

  async inpaintPlates(req: InpaintRequest, plates: Float32Array[], cancelled?: () => boolean, progress?: (f: number) => void): Promise<{ image: Float32Array; plates: Float32Array[] }> {
    const r = inpaintCarry(req.image, req.width, req.height, req.mask, plates, { cancelled, progress });
    return { image: r.image, plates: r.carried };
  }

  async upscale(image: Float32Array, width: number, height: number, factor: number) {
    const w = Math.round(width * factor), h = Math.round(height * factor);
    const up = resizeImage(image, width, height, w, h, 'bicubic');
    // Mild detail enhancement to counter interpolation softness.
    const blur = up.slice();
    gaussianBlur(blur, w, h, 4, Math.max(0.6, factor * 0.4));
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) up[i * 4 + c] = Math.max(0, Math.min(1, up[i * 4 + c] + (up[i * 4 + c] - blur[i * 4 + c]) * 0.5));
    return { data: up, width: w, height: h };
  }

  async refineEdges(image: Float32Array, mask: Float32Array, width: number, height: number, radius: number): Promise<Float32Array> {
    return guidedRefine(image, mask, width, height, Math.max(1, Math.round(radius)), 1e-3);
  }
}
