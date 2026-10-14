/**
 * ag-psd environment setup: image data is allocated as plain objects (never canvas-backed), so
 * pixels are never premultiplied and parsing works identically in the renderer, workers and Node.
 */
import { initializeCanvas } from 'ag-psd';

let done = false;
export function ensureAgPsd(): void {
  if (done) return;
  done = true;
  const createCanvas = (width: number, height: number) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement;
    throw new Error('Canvas is not available in this environment');
  };
  const createImageData = (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as unknown as ImageData;
  initializeCanvas(createCanvas, createImageData);
}
