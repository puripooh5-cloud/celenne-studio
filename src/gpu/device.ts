/**
 * The WebGPU device shared by the viewport renderer, the GPU tile compositor and GPU filters.
 * Acquired once; when the GPU is lost (driver reset, device removed) listeners are told so the
 * app can fall back (WebGL 2 / CPU) or acquire a new device.
 */
import { GpuCompositor } from './compositor';

export interface GpuContext {
  device: GPUDevice;
  adapter: GPUAdapter;
  /** Adapter description for System Info. */
  info: { vendor: string; architecture: string; description: string };
  compositor: GpuCompositor;
}

let current: GpuContext | null = null;
let pending: Promise<GpuContext | null> | null = null;
const lostListeners = new Set<(why: string) => void>();
/** Set when acquiring a device failed (System Info shows why). */
export let gpuError: string | null = null;

export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!(navigator as Navigator & { gpu?: GPU }).gpu;
}

/** The current GPU context, acquiring one if needed (null when WebGPU is unavailable). */
export function acquireGpu(): Promise<GpuContext | null> {
  if (current) return Promise.resolve(current);
  if (pending) return pending;
  pending = (async () => {
    try {
      if (!webgpuAvailable()) { gpuError = 'WebGPU is not available in this runtime'; return null; }
      const gpu = (navigator as Navigator & { gpu: GPU }).gpu;
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) { gpuError = 'No WebGPU adapter'; return null; }
      const device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30),
          maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30),
        },
      });
      device.addEventListener('uncapturederror', (e) => console.warn('WebGPU error:', (e as GPUUncapturedErrorEvent).error.message));
      const info = adapter.info ?? ({} as GPUAdapterInfo);
      const ctx: GpuContext = {
        device,
        adapter,
        info: { vendor: info.vendor ?? '', architecture: info.architecture ?? '', description: info.description ?? '' },
        compositor: new GpuCompositor(device),
      };
      device.lost.then((l) => {
        if (current !== ctx) return;
        current = null;
        ctx.compositor.disposed = true;
        const why = l.message || l.reason || 'device lost';
        gpuError = `GPU device lost: ${why}`;
        for (const f of lostListeners) f(why);
      });
      current = ctx;
      gpuError = null;
      return ctx;
    } catch (e) {
      gpuError = (e as Error).message;
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

export function currentGpu(): GpuContext | null {
  return current;
}

export function onGpuLost(f: (why: string) => void): () => void {
  lostListeners.add(f);
  return () => lostListeners.delete(f);
}

// Diagnostics handle (System Info, automated checks): the live GPU context and compositor stats.
(globalThis as unknown as { __celenneGpu?: unknown }).__celenneGpu = { current: () => current, error: () => gpuError };
