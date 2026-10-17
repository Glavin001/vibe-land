// Weather preset table. Each preset re-skins the AOI-sized fog volume as an
// in-fiction atmospheric phenomenon and drives the GPU particle renderer in
// `client/src/scene/WeatherParticles.tsx`.
//
// The keys are the canonical string identifiers persisted to localStorage by
// `fogSettings.ts`. The table itself is shared/assets/weather/presets.json,
// which the Unreal client reads too: add a preset there.

import table from '../../../shared/assets/weather/presets.json';

export type WeatherPreset = 'clear' | 'dust_storm' | 'snow_storm';

export type WeatherPresetConfig = {
  /** Short, UI-friendly label. */
  label: string;
  /** Scene background + FogExp2 color when the user hasn't overridden it. */
  fogColor: string;
  /** Number of particles rendered in the camera-follow volume. 0 = disabled. */
  particleCount: number;
  /** Base particle tint. Multiplied by the fog color at edge to dissolve in. */
  particleColor: string;
  /** Pixel size of each particle sprite at 1m distance (size attenuation on). */
  particleSizePx: number;
  /** How particles blend into the scene. Additive reads as glowy/snowy. */
  particleBlending: 'normal' | 'additive';
  /** Edge length of the cube around the camera that particles wrap inside. */
  boxSizeM: number;
  /** Gravity-like vertical drift in metres per second. */
  fallSpeedMps: number;
  /** How fast each particle flutters side to side (Hz). */
  tumbleHz: number;
  /** Tumble amplitude in metres (how wide the flutter path is). */
  tumbleAmplitudeM: number;
  /** Multiplier on the global wind vector. Heavier grit drifts less than snow. */
  windFollow: number;
};

// One table for both clients: shared/assets/weather/presets.json (client-core weather.rs reads
// the same file for the Unreal client).
export const WEATHER_PRESETS = table.presets as Record<WeatherPreset, WeatherPresetConfig>;

export const WEATHER_PRESET_ORDER = table.order as WeatherPreset[];

/**
 * Convert the scalar wind config to a world-space velocity vector.
 * Compass: 0° → +Z, 90° → +X. "Wind is blowing toward" this heading.
 */
export function windVectorFromSettings(
  windStrengthMps: number,
  windDirectionDeg: number,
): { x: number; y: number; z: number } {
  const rad = (windDirectionDeg * Math.PI) / 180;
  return {
    x: Math.sin(rad) * windStrengthMps,
    y: 0,
    z: Math.cos(rad) * windStrengthMps,
  };
}
