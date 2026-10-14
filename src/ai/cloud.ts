/**
 * CloudAIProvider — talks to a user-configured HTTPS endpoint using a small, documented JSON
 * protocol (docs/AI_PROVIDERS.md). No vendor is hard-coded; nothing is sent anywhere unless the
 * user configures an endpoint in Preferences › AI.
 *
 *   POST {endpoint}/v1/{task}
 *   { "image": "<base64 PNG>", "mask": "<base64 PNG>", "prompt": "...", "params": {...} }
 *   → { "image": "<base64 PNG>" } | { "mask": "<base64 PNG>" }
 */
import type { AICapabilities, AIProvider, InpaintRequest } from './provider';
import type { DocumentSession } from '../app/session';
import { TiledRaster } from '../image-engine/tiledRaster';
import type { Rect } from '../image-engine/rect';
import { encodePNG, decodePNG } from '../formats/codecs';
import { compositeRegion } from '../rendering/compositor';

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function png8(data: Float32Array, w: number, h: number): string {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i++) px[i] = data[i] * 255;
  return toB64(encodePNG(w, h, px, 8));
}

export class CloudAIProvider implements AIProvider {
  readonly id = 'cloud';
  readonly kind = 'cloud' as const;
  readonly label = 'Cloud (custom endpoint)';
  constructor(private endpoint: () => string) {}

  isConfigured(): boolean {
    return /^https:\/\//.test(this.endpoint());
  }

  capabilities(): AICapabilities {
    const on = this.isConfigured();
    return { selectSubject: on, selectSky: on, removeBackground: on, objectRemoval: on, generativeFill: on, generativeExpand: on, upscale: on, faceAware: on, refineEdges: on };
  }

  private async call(task: string, body: Record<string, unknown>): Promise<{ image?: string; mask?: string }> {
    if (!this.isConfigured()) throw new Error('No cloud AI endpoint is configured (Preferences › AI).');
    const res = await fetch(`${this.endpoint().replace(/\/+$/, '')}/v1/${task}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`AI service error ${res.status}: ${await res.text().catch(() => '')}`);
    return res.json();
  }

  private maskToRaster(b64: string, box: Rect): TiledRaster {
    const img = decodePNG(fromB64(b64));
    const n = img.width * img.height;
    const f = new Float32Array(n);
    const max = img.depth === 16 ? 65535 : 255;
    for (let i = 0; i < n; i++) f[i] = img.data[i * 4] / max;
    const r = new TiledRaster(1, 8, 0);
    r.writeFloat({ x: box.x, y: box.y, w: img.width, h: img.height }, f);
    return r;
  }

  private docImage(s: DocumentSession, box: Rect): string {
    const buf = compositeRegion(s.doc, box, { level: 0 });
    for (let i = 0; i < box.w * box.h; i++) { const a = buf[i * 4 + 3]; if (a > 0) { buf[i * 4] /= a; buf[i * 4 + 1] /= a; buf[i * 4 + 2] /= a; } }
    return png8(buf, box.w, box.h);
  }

  async selectSubject(s: DocumentSession, box?: Rect): Promise<TiledRaster> {
    const b = box ?? s.doc.bounds;
    const r = await this.call('select-subject', { image: this.docImage(s, b) });
    if (!r.mask) throw new Error('AI service returned no mask');
    return this.maskToRaster(r.mask, b);
  }
  async selectSky(s: DocumentSession): Promise<TiledRaster> {
    const r = await this.call('select-sky', { image: this.docImage(s, s.doc.bounds) });
    if (!r.mask) throw new Error('AI service returned no mask');
    return this.maskToRaster(r.mask, s.doc.bounds);
  }
  async removeBackground(s: DocumentSession): Promise<TiledRaster> {
    const r = await this.call('remove-background', { image: this.docImage(s, s.doc.bounds) });
    if (!r.mask) throw new Error('AI service returned no mask');
    return this.maskToRaster(r.mask, s.doc.bounds);
  }
  async inpaint(req: InpaintRequest): Promise<Float32Array> {
    const m = new Float32Array(req.width * req.height * 4);
    for (let i = 0; i < req.mask.length; i++) m[i * 4] = m[i * 4 + 1] = m[i * 4 + 2] = m[i * 4 + 3] = req.mask[i];
    const r = await this.call(req.prompt ? 'generative-fill' : 'inpaint', { image: png8(req.image, req.width, req.height), mask: png8(m, req.width, req.height), prompt: req.prompt });
    if (!r.image) throw new Error('AI service returned no image');
    const img = decodePNG(fromB64(r.image));
    const out = new Float32Array(req.width * req.height * 4);
    const max = img.depth === 16 ? 65535 : 255;
    for (let i = 0; i < out.length; i++) out[i] = img.data[i] / max;
    return out;
  }
  async upscale(image: Float32Array, width: number, height: number, factor: number) {
    const r = await this.call('upscale', { image: png8(image, width, height), params: { factor } });
    if (!r.image) throw new Error('AI service returned no image');
    const img = decodePNG(fromB64(r.image));
    const max = img.depth === 16 ? 65535 : 255;
    const data = new Float32Array(img.width * img.height * 4);
    for (let i = 0; i < data.length; i++) data[i] = img.data[i] / max;
    return { data, width: img.width, height: img.height };
  }
  async refineEdges(image: Float32Array, mask: Float32Array, width: number, height: number, radius: number): Promise<Float32Array> {
    const m = new Float32Array(width * height * 4);
    for (let i = 0; i < mask.length; i++) m[i * 4] = m[i * 4 + 1] = m[i * 4 + 2] = m[i * 4 + 3] = mask[i];
    const r = await this.call('refine-edges', { image: png8(image, width, height), mask: png8(m, width, height), params: { radius } });
    if (!r.mask) throw new Error('AI service returned no mask');
    const img = decodePNG(fromB64(r.mask));
    const out = new Float32Array(width * height);
    const max = img.depth === 16 ? 65535 : 255;
    for (let i = 0; i < out.length; i++) out[i] = img.data[i * 4] / max;
    return out;
  }
}
