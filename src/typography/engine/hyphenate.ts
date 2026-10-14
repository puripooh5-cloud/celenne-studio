/**
 * Hyphenation points (Liang's TeX patterns via the `hyphen` package). Photoshop's English
 * hyphenation agrees with these patterns on the corpus words (para-graph, spac-ing, hy-phen-ation,
 * ty-pog-ra-phy). Only English (US) patterns are bundled today; other languages are not hyphenated.
 */
import createHyphenator from 'hyphen';
import enUs from 'hyphen/patterns/en-us';

const SOFT = '­';
const hyph = createHyphenator(enUs, { hyphenChar: SOFT, minWordLength: 3 }) as (s: string) => string;
const cache = new Map<string, number[]>();

/** Offsets inside `word` (letters only) where it may be hyphenated. */
export function hyphenPoints(word: string): number[] {
  const hit = cache.get(word);
  if (hit) return hit;
  const out: number[] = [];
  const marked = hyph(word.toLowerCase());
  let pos = 0;
  for (const ch of marked) {
    if (ch === SOFT) out.push(pos);
    else pos += ch.length;
  }
  if (cache.size > 5000) cache.clear();
  cache.set(word, out);
  return out;
}
