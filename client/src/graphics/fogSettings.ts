// Singleton store for the player's visual fog preferences. Persisted to
// localStorage, pub/sub-based, exposed via a React hook. Modeled after
// `client/src/input/inputSettingsStore.ts`.
//
// Fog density is derived from the server's area-of-interest radius so sight
// ends where replication ends: players, vehicles, and dynamic bodies are
// streamed within `PLAYER_AOI_RADIUS_M` (see `shared/src/constants.rs`), so
// rendering anything past that distance would only reveal a pop-in boundary.

import { useSyncExternalStore } from 'react';
import { PLAYER_AOI_RADIUS_M } from '../net/sharedConstants';

const STORAGE_KEY = 'vibe-land/graphics-settings';

// Fraction of fog opacity reached at the AOI boundary. 0.99 ≈ "effectively
// invisible" exactly where server-side streaming stops.
export const FOG_OPACITY_AT_AOI = 0.99;

/**
 * FogExp2 density chosen so opacity hits `FOG_OPACITY_AT_AOI` at the given
 * radius. Derivation: `factor = 1 - exp(-(density * distance)^2)`, so
 * `density = sqrt(-ln(1 - factor)) / radius`.
 */
export function fogDensityForAoi(aoiRadiusM = PLAYER_AOI_RADIUS_M): number {
  return Math.sqrt(-Math.log(1 - FOG_OPACITY_AT_AOI)) / aoiRadiusM;
}

export type FogSettings = {
  enabled: boolean;
  density: number;
  color: string;
};

export const DEFAULT_FOG_SETTINGS: FogSettings = {
  enabled: true,
  density: fogDensityForAoi(),
  color: '#b7c7d8',
};

let current: FogSettings = { ...DEFAULT_FOG_SETTINGS };
let loaded = false;
const listeners = new Set<(settings: FogSettings) => void>();

function safeReadStorage(): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

function safeWriteStorage(value: string): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, value);
    }
  } catch (error) {
    console.warn('Failed to persist fog settings', error);
  }
}

function parseFogSettings(raw: unknown): FogSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<FogSettings>;
  const enabled = typeof candidate.enabled === 'boolean' ? candidate.enabled : DEFAULT_FOG_SETTINGS.enabled;
  const density = typeof candidate.density === 'number' && Number.isFinite(candidate.density) && candidate.density > 0
    ? candidate.density
    : DEFAULT_FOG_SETTINGS.density;
  const color = typeof candidate.color === 'string' && candidate.color.length > 0
    ? candidate.color
    : DEFAULT_FOG_SETTINGS.color;
  return { enabled, density, color };
}

export function loadFogSettings(): FogSettings {
  if (loaded) return current;
  loaded = true;
  const raw = safeReadStorage();
  if (raw) {
    try {
      const parsed = parseFogSettings(JSON.parse(raw));
      if (parsed) current = parsed;
    } catch (error) {
      console.warn('Failed to restore fog settings', error);
    }
  }
  return current;
}

export function getFogSettings(): FogSettings {
  if (!loaded) loadFogSettings();
  return current;
}

export function saveFogSettings(next: FogSettings): void {
  current = next;
  if (!loaded) loaded = true;
  safeWriteStorage(JSON.stringify(next));
  for (const fn of listeners) fn(current);
}

export function updateFogSettings(mutate: (draft: FogSettings) => FogSettings): FogSettings {
  const draft = { ...getFogSettings() };
  const next = mutate(draft);
  saveFogSettings(next);
  return next;
}

export function subscribeFogSettings(fn: (settings: FogSettings) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useFogSettings(): FogSettings {
  return useSyncExternalStore(
    (onStoreChange) => subscribeFogSettings(onStoreChange),
    () => getFogSettings(),
    () => DEFAULT_FOG_SETTINGS,
  );
}
