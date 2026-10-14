/** Persisted application preferences. */
import type { RulerUnit } from '../document/types';

export interface Preferences {
  performance: {
    /** Fraction of system memory the editor may use for caches (0.2..0.9). */
    ramFraction: number;
    /** Off = Canvas 2D (CPU) display. */
    gpuAcceleration: boolean;
    /** Viewport renderer: Auto picks WebGPU, then WebGL 2, then Canvas 2D. */
    renderer: 'auto' | 'webgpu' | 'webgl2' | 'canvas2d';
    /** Composite layers on the GPU (WebGPU renderer only); files are always produced on the CPU. */
    gpuCompositing: boolean;
    /** Display tile cache budget (MB). */
    tileCacheMB: number;
    historyStates: number;
    /** Page tiles of old history steps to the scratch disk (desktop app). */
    historyToScratch: boolean;
    /** History tile data kept in memory before paging to the scratch disk (MB). */
    historyMemoryMB: number;
  };
  scratch: {
    directory: string | null;
    maxMB: number;
  };
  general: {
    autosaveMinutes: number;
    uiScale: number;
    largeUI: boolean;
    units: RulerUnit;
    checkerSize: number;
    recentLimit: number;
    confirmOverwrite: boolean;
  };
  color: {
    workingRGB: 'srgb' | 'displayP3' | 'adobeRGB' | 'proPhotoRGB';
    displayProfile: 'srgb' | 'displayP3';
    renderingIntent: 'perceptual' | 'relative' | 'saturation' | 'absolute';
    blackPointCompensation: boolean;
    proofProfile: string | null;
    /** Dot gain of spot inks at 50 % (Photoshop's Color Settings ▸ Spot): Duotone and Multichannel display. */
    spotDotGain: number;
  };
  guides: {
    gridSpacing: number;
    gridSubdivisions: number;
    guideColor: string;
    smartGuides: boolean;
  };
  ai: {
    provider: 'local' | 'cloud' | 'custom';
    cloudEndpoint: string;
  };
}

export const DEFAULT_PREFERENCES: Preferences = {
  performance: { ramFraction: 0.6, gpuAcceleration: true, renderer: 'auto', gpuCompositing: true, tileCacheMB: 768, historyStates: 80, historyToScratch: true, historyMemoryMB: 1024 },
  scratch: { directory: null, maxMB: 20480 },
  general: { autosaveMinutes: 5, uiScale: 1, largeUI: false, units: 'px', checkerSize: 8, recentLimit: 20, confirmOverwrite: true },
  color: { workingRGB: 'srgb', displayProfile: 'srgb', renderingIntent: 'relative', blackPointCompensation: true, proofProfile: null, spotDotGain: 20 },
  guides: { gridSpacing: 64, gridSubdivisions: 4, guideColor: '#00d0ff', smartGuides: true },
  ai: { provider: 'local', cloudEndpoint: '' },
};

const KEY = 'celenne.preferences.v1';

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object') return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out as T;
}

export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? merge(DEFAULT_PREFERENCES, JSON.parse(raw)) : structuredClone(DEFAULT_PREFERENCES);
  } catch {
    return structuredClone(DEFAULT_PREFERENCES);
  }
}

export function savePreferences(p: Preferences): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

/** Small typed localStorage helpers for UI conveniences. */
export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
