// Singleton store for the player's visual fog + weather preferences.
// Persisted to localStorage, pub/sub-based, exposed via a React hook. Modeled
// after `client/src/input/inputSettingsStore.ts`.
//
// Fog density is derived from the server's area-of-interest radius so sight
// ends where replication ends: players, vehicles, and dynamic bodies are
// streamed within `PLAYER_AOI_RADIUS_M` (see `shared/src/constants.rs`), so
// rendering anything past that distance would only reveal a pop-in boundary.
// The `weather` preset re-skins that same boundary as an in-fiction phenomenon
// (dust storm / snow storm) with an animated particle volume on top — see
// `weatherPresets.ts`.

import { useSyncExternalStore } from 'react';
import { PLAYER_AOI_RADIUS_M } from '../net/sharedConstants';
import { WEATHER_PRESETS, type WeatherPreset } from './weatherPresets';

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
  // When non-null, overrides the preset's fog color. When null, the preset
  // drives the color. Kept nullable so "user changed preset" doesn't require
  // also wiping a leftover custom color.
  color: string | null;
  weather: WeatherPreset;
  // Scalar wind speed, metres per second. Drives how fast particles blow
  // horizontally. 0 = dead calm.
  windStrengthMps: number;
  // Compass degrees (0 = +Z, 90 = +X), so "wind is blowing toward" direction.
  windDirectionDeg: number;
};

export const DEFAULT_FOG_SETTINGS: FogSettings = {
  enabled: true,
  density: fogDensityForAoi(),
  color: null,
  weather: 'clear',
  windStrengthMps: 8,
  windDirectionDeg: 45,
};

/**
 * Resolve the effective background/fog color to apply. Falls back to the
 * active weather preset's `fogColor` when the user hasn't set a custom one.
 */
export function resolveFogColor(settings: FogSettings): string {
  if (settings.color != null && settings.color.length > 0) return settings.color;
  return WEATHER_PRESETS[settings.weather].fogColor;
}

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

function parseWeather(raw: unknown): WeatherPreset {
  if (typeof raw === 'string' && raw in WEATHER_PRESETS) return raw as WeatherPreset;
  return DEFAULT_FOG_SETTINGS.weather;
}

function parseFiniteNumber(raw: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  if (raw < min || raw > max) return fallback;
  return raw;
}

export function parseFogSettings(raw: unknown): FogSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<FogSettings> & Record<string, unknown>;
  const enabled = typeof candidate.enabled === 'boolean' ? candidate.enabled : DEFAULT_FOG_SETTINGS.enabled;
  const density = typeof candidate.density === 'number' && Number.isFinite(candidate.density) && candidate.density > 0
    ? candidate.density
    : DEFAULT_FOG_SETTINGS.density;
  let color: string | null;
  if (candidate.color === null) {
    color = null;
  } else if (typeof candidate.color === 'string' && candidate.color.length > 0) {
    color = candidate.color;
  } else {
    color = DEFAULT_FOG_SETTINGS.color;
  }
  const weather = parseWeather(candidate.weather);
  const windStrengthMps = parseFiniteNumber(candidate.windStrengthMps, DEFAULT_FOG_SETTINGS.windStrengthMps, 0, 200);
  const windDirectionDeg = parseFiniteNumber(candidate.windDirectionDeg, DEFAULT_FOG_SETTINGS.windDirectionDeg);
  return { enabled, density, color, weather, windStrengthMps, windDirectionDeg };
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

// Test-only: reset the in-memory singleton so each test starts from defaults.
// Keep in the module (not a separate test helper file) so there's no second
// path to the module-scoped `current` variable.
export function __resetFogSettingsForTest(): void {
  current = { ...DEFAULT_FOG_SETTINGS };
  loaded = false;
  listeners.clear();
}
