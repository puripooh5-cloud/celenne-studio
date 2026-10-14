/** Colour settings shared by modes, proofing and conversions. */
import { editor } from './editor';
import type { ColorProfileRef } from '../document/types';
import { CELENNE_CMYK_NAME } from '../color/cmykProfile';
import { parseIccInfo } from '../color/icc';

/**
 * The working CMYK profile: the CMYK profile loaded in Preferences ▸ Color Management, or the
 * built-in "Celenne Coated CMYK (approximate)" profile.
 */
export function workingCmykProfile(): ColorProfileRef {
  const b64 = editor.prefs.color.proofProfile;
  if (b64) {
    try {
      const icc = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const info = parseIccInfo(icc);
      if (info?.colorSpace === 'CMYK') return { name: info.description || 'CMYK profile', icc };
    } catch { /* fall back */ }
  }
  return { name: CELENNE_CMYK_NAME, builtin: 'celenneCMYK' };
}

/** True when the user loaded their own CMYK profile. */
export function hasCustomCmykProfile(): boolean {
  return workingCmykProfile().builtin !== 'celenneCMYK';
}

/** The CMYK profile the colour UI uses: the active CMYK document's, else the working CMYK profile. */
export function uiCmykProfile(): ColorProfileRef {
  const d = editor.active?.doc;
  return d && d.canvas.colorMode === 'cmyk' ? d.profile : workingCmykProfile();
}
