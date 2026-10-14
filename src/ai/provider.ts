/**
 * AI provider abstraction. The editor never talks to a specific AI vendor: every AI-powered
 * feature goes through an AIProvider, selected in Preferences › AI.
 *
 *   AIProvider
 *   ├── LocalAIProvider   (built-in classical algorithms, runs offline)
 *   ├── CloudAIProvider   (user-configured HTTPS endpoint, documented JSON protocol)
 *   └── CustomAIProvider  (models contributed by sandboxed plugins)
 */
import type { DocumentSession } from '../app/session';
import type { TiledRaster } from '../image-engine/tiledRaster';
import type { Rect } from '../image-engine/rect';
import { LocalAIProvider } from './local';
import { CloudAIProvider } from './cloud';
import { CustomAIProvider } from './custom';
import { editor } from '../app/editor';

export interface AICapabilities {
  selectSubject: boolean;
  selectSky: boolean;
  removeBackground: boolean;
  objectRemoval: boolean;
  generativeFill: boolean;
  generativeExpand: boolean;
  upscale: boolean;
  faceAware: boolean;
  refineEdges: boolean;
}

export interface InpaintRequest {
  /** Straight RGBA of the working region. */
  image: Float32Array;
  width: number;
  height: number;
  /** 1 = pixel to synthesize. */
  mask: Uint8Array;
  prompt?: string;
}

export interface AIProvider {
  readonly id: string;
  readonly kind: 'local' | 'cloud' | 'custom';
  readonly label: string;
  capabilities(): AICapabilities;
  /** Coverage raster (document space) of the main subject, optionally limited to a box. */
  selectSubject(s: DocumentSession, box?: Rect): Promise<TiledRaster>;
  selectSky(s: DocumentSession): Promise<TiledRaster>;
  /** Mask (document space) separating the subject of a layer from its background. */
  removeBackground(s: DocumentSession, layerId: string): Promise<TiledRaster>;
  /** Content-aware fill, object removal and generative fill (prompt may be ignored locally). */
  inpaint(req: InpaintRequest, cancelled?: () => boolean, progress?: (f: number) => void): Promise<Float32Array>;
  /**
   * Optional: inpaints `req.image` and synthesises each of `plates` (straight RGBA buffers of the
   * same size, e.g. CMYK ink plates) from the same source patches. Providers without it get
   * their RGB result separated by the document profile instead.
   */
  inpaintPlates?(req: InpaintRequest, plates: Float32Array[], cancelled?: () => boolean, progress?: (f: number) => void): Promise<{ image: Float32Array; plates: Float32Array[] }>;
  /** Returns a new straight RGBA image scaled by `factor`. */
  upscale(image: Float32Array, width: number, height: number, factor: number): Promise<{ data: Float32Array; width: number; height: number }>;
  /** Edge-aware refinement of a coverage mask using the image as guide (hair / fine edges). */
  refineEdges(image: Float32Array, mask: Float32Array, width: number, height: number, radius: number): Promise<Float32Array>;
}

const local = new LocalAIProvider();
const cloud = new CloudAIProvider(() => editor.prefs.ai.cloudEndpoint);
const custom = new CustomAIProvider();

/** The provider configured in preferences; falls back to the local provider when unavailable. */
export function aiProvider(): AIProvider {
  const p = editor.prefs.ai.provider;
  if (p === 'cloud' && cloud.isConfigured()) return cloud;
  if (p === 'custom' && custom.isAvailable()) return custom;
  return local;
}

export function providers(): AIProvider[] {
  return [local, cloud, custom];
}

export { local as localProvider, custom as customProvider };
