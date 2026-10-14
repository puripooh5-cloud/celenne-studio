/// <reference lib="webworker" />
/** Filter worker: runs one built-in filter off the main thread. */
import { filterById } from './builtin';
import { runFilterSync } from './runner';

self.onmessage = (e: MessageEvent) => {
  const { filterId, params, w, h, ch, data, base } = e.data;
  const def = filterById(filterId);
  if (!def) {
    self.postMessage({ type: 'error', message: `Unknown filter ${filterId}` });
    return;
  }
  try {
    let last = 0;
    const out = runFilterSync(def, params, { w, h, ch, data }, base, () => false, (f) => {
      const now = Date.now();
      if (now - last > 60) {
        last = now;
        self.postMessage({ type: 'progress', value: f });
      }
    });
    self.postMessage({ type: 'done', w: out.w, h: out.h, ch: out.ch, data: out.data }, { transfer: [out.data.buffer] });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err as Error).message });
  }
};
