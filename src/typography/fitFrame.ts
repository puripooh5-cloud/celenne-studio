/**
 * Fit Text to Frame (Celenne): the largest type size at which a paragraph's text still fits its
 * box, found by bisection on a common scale of every run's size (and fixed leading, and paragraph
 * spacing). The text is laid out by the engine at each step, so it fits as it will be drawn.
 */
import type { TextData } from './types';
import type { EngineLayout } from './engine/layout';

/** The text with every size scaled by `k`. */
export function scaledText(t: TextData, k: number): TextData {
  return {
    ...t,
    runs: t.runs.map((r) => ({ ...r, style: { ...r.style, fontSize: r.style.fontSize * k, leading: r.style.leading === null ? null : r.style.leading * k } })),
    paragraphs: t.paragraphs.map((p) => ({ ...p, style: { ...p.style, spaceBefore: p.style.spaceBefore * k, spaceAfter: p.style.spaceAfter * k } })),
  };
}

/** Whether a layout of `t` shows all of its text inside the box. */
function fits(t: TextData, L: EngineLayout): boolean {
  if (L.overflow || L.missing || !t.box) return false;
  const last = L.lines[L.lines.length - 1];
  if (!last) return true;
  if (last.end < t.text.length) return false;
  // (Vertical text: columns run leftwards from the box's right edge.)
  if (t.orientation === 'vertical') return last.baseline - last.ascent >= t.box.x - 0.5;
  return last.baseline + last.descent <= t.box.y + t.box.h + 0.5;
}

/** The scale (relative to the current sizes) that fills the box, or null when the text is not paragraph text. */
export function fitScale(t: TextData, layout: (t: TextData) => EngineLayout, lo = 0.05, hi = 40): number | null {
  if (t.kind !== 'paragraph' || !t.box || !t.text.trim()) return null;
  if (!fits(scaledText(t, lo), layout(scaledText(t, lo)))) return null;
  for (let i = 0; i < 28; i++) {
    const mid = Math.sqrt(lo * hi);
    const s = scaledText(t, mid);
    if (fits(s, layout(s))) lo = mid;
    else hi = mid;
  }
  return lo;
}
