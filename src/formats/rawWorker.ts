/// <reference lib="webworker" />
/** Camera raw worker: unpacks a proprietary raw file with LibRaw and develops it off the main thread. */
import { decodeLibRaw } from './libraw';

self.onmessage = async (e: MessageEvent) => {
  try {
    const img = await decodeLibRaw(e.data.bytes, { exposure: e.data.exposure });
    self.postMessage({ type: 'done', img }, { transfer: [(img.data as Uint16Array).buffer] });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err as Error).message });
  }
};
