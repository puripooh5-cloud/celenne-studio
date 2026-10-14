/**
 * Headless WebGPU for tests and benchmarks (Dawn through the `webgpu` package). Returns null when
 * the machine has no usable adapter, so GPU tests skip instead of failing.
 */
let device: Promise<GPUDevice | null> | null = null;
/** Dawn's instance and adapter must stay referenced: if they are garbage-collected, Dawn tears down under the live device. */
const keepAlive: unknown[] = [];

export function testDevice(): Promise<GPUDevice | null> {
  if (!device) {
    device = (async () => {
      try {
        const mod = await import('webgpu');
        Object.assign(globalThis, mod.globals);
        const gpu = mod.create(process.env.CELENNE_GPU_BACKEND ? [`backend=${process.env.CELENNE_GPU_BACKEND}`] : []);
        const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
        keepAlive.push(gpu, adapter);
        if (!adapter) return null;
        const d = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30) } });
        d.addEventListener('uncapturederror', (e) => { console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error.message); });
        return d;
      } catch (e) {
        console.warn('WebGPU unavailable for tests:', (e as Error).message);
        return null;
      }
    })();
  }
  return device;
}

/** Largest absolute difference between two float buffers. */
export function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): { max: number; at: number } {
  let max = 0, at = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) { max = d; at = i; }
  }
  return { max, at };
}
