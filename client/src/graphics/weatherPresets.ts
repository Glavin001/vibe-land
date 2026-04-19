// Weather preset table. Each preset re-skins the AOI-sized fog volume as an
// in-fiction atmospheric phenomenon and drives the GPU particle renderer in
// `client/src/scene/WeatherParticles.tsx`.
//
// The keys here are the canonical string identifiers persisted to localStorage
// by `fogSettings.ts` — add to this table and the rest of the pipeline picks
// it up automatically.

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

export const WEATHER_PRESETS: Record<WeatherPreset, WeatherPresetConfig> = {
  clear: {
    label: 'Clear',
    fogColor: '#b7c7d8',
    particleCount: 0,
    particleColor: '#ffffff',
    particleSizePx: 0,
    particleBlending: 'normal',
    boxSizeM: 60,
    fallSpeedMps: 0,
    tumbleHz: 0,
    tumbleAmplitudeM: 0,
    windFollow: 0,
  },
  dust_storm: {
    label: 'Dust Storm',
    fogColor: '#b89968',
    particleCount: 3500,
    particleColor: '#d9b57a',
    particleSizePx: 36,
    particleBlending: 'normal',
    boxSizeM: 60,
    fallSpeedMps: 1.5,
    tumbleHz: 0.6,
    tumbleAmplitudeM: 0.35,
    windFollow: 1.0,
  },
  snow_storm: {
    label: 'Snow Storm',
    fogColor: '#e4ecf3',
    particleCount: 5000,
    particleColor: '#ffffff',
    particleSizePx: 52,
    particleBlending: 'additive',
    boxSizeM: 60,
    fallSpeedMps: 2.5,
    tumbleHz: 1.1,
    tumbleAmplitudeM: 0.55,
    windFollow: 0.75,
  },
};

export const WEATHER_PRESET_ORDER: WeatherPreset[] = ['clear', 'dust_storm', 'snow_storm'];

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
