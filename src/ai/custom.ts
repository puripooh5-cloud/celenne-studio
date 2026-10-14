/**
 * CustomAIProvider — dispatches AI tasks to models contributed by sandboxed plugins
 * (plugins/pluginHost.ts registers handlers here). Falls back to "unavailable" when no plugin
 * provides a task.
 */
import type { AICapabilities, AIProvider, InpaintRequest } from './provider';
import type { DocumentSession } from '../app/session';
import { TiledRaster } from '../image-engine/tiledRaster';
import type { Rect } from '../image-engine/rect';

export type AITaskHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class CustomAIProvider implements AIProvider {
  readonly id = 'custom';
  readonly kind = 'custom' as const;
  readonly label = 'Plugin models';
  private handlers = new Map<string, AITaskHandler>();

  register(task: string, h: AITaskHandler): void {
    this.handlers.set(task, h);
  }

  isAvailable(): boolean {
    return this.handlers.size > 0;
  }

  capabilities(): AICapabilities {
    const has = (t: string) => this.handlers.has(t);
    return { selectSubject: has('select-subject'), selectSky: has('select-sky'), removeBackground: has('remove-background'), objectRemoval: has('inpaint'), generativeFill: has('generative-fill'), generativeExpand: has('generative-expand'), upscale: has('upscale'), faceAware: has('face-aware'), refineEdges: has('refine-edges') };
  }

  private async run(task: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const h = this.handlers.get(task);
    if (!h) throw new Error(`No installed plugin provides "${task}".`);
    return h(payload);
  }

  private maskResult(r: Record<string, unknown>, box: Rect): TiledRaster {
    const m = r.mask as Float32Array;
    const out = new TiledRaster(1, 8, 0);
    out.writeFloat(box, m);
    return out;
  }

  async selectSubject(s: DocumentSession, box?: Rect): Promise<TiledRaster> {
    const b = box ?? s.doc.bounds;
    return this.maskResult(await this.run('select-subject', { width: b.w, height: b.h }), b);
  }
  async selectSky(s: DocumentSession): Promise<TiledRaster> {
    return this.maskResult(await this.run('select-sky', { width: s.doc.width, height: s.doc.height }), s.doc.bounds);
  }
  async removeBackground(s: DocumentSession, layerId: string): Promise<TiledRaster> {
    return this.maskResult(await this.run('remove-background', { layerId }), s.doc.bounds);
  }
  async inpaint(req: InpaintRequest): Promise<Float32Array> {
    const r = await this.run(req.prompt ? 'generative-fill' : 'inpaint', { ...req });
    return r.image as Float32Array;
  }
  async upscale(image: Float32Array, width: number, height: number, factor: number) {
    const r = await this.run('upscale', { image, width, height, factor });
    return { data: r.image as Float32Array, width: r.width as number, height: r.height as number };
  }
  async refineEdges(image: Float32Array, mask: Float32Array, width: number, height: number, radius: number): Promise<Float32Array> {
    const r = await this.run('refine-edges', { image, mask, width, height, radius });
    return r.mask as Float32Array;
  }
}
