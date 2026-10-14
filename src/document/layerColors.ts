/** Parametric colours stored by layers. */
import type { Layer } from './types';
import type { RGB } from '../color/types';

/** Converts every color value a layer stores as a parameter (not its pixels). */
export function convertLayerColors(l: Layer, conv: (c: RGB) => RGB): void {
  // Style objects can be shared (text runs): convert each color object once.
  const seen = new Set<object>();
  const walk = (o: unknown): void => {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const rec = o as Record<string, unknown>;
    if (typeof rec.r === 'number' && typeof rec.g === 'number' && typeof rec.b === 'number' && Object.keys(rec).every((k) => k === 'r' || k === 'g' || k === 'b' || k === 'a' || k === 'exact')) {
      const c = conv({ r: rec.r, g: rec.g as number, b: rec.b as number, exact: rec.exact as RGB['exact'] });
      rec.r = c.r; rec.g = c.g; rec.b = c.b;
      if (c.exact) rec.exact = c.exact;
      else delete rec.exact;
      return;
    }
    for (const v of Object.values(rec)) walk(v);
  };
  if (l.effects) walk(l.effects);
  switch (l.kind) {
    case 'fill': walk(l.fill); break;
    case 'shape': walk(l.fill); walk(l.stroke.paint); break;
    case 'text': for (const r of l.text.runs) walk(r.style.color); break;
    case 'adjustment':
      if (l.adjustment.type === 'photoFilter' || l.adjustment.type === 'blackWhite' || l.adjustment.type === 'gradientMap') walk(l.adjustment);
      break;
  }
}
