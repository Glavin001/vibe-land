// Catalog of HDR environment maps shipped under client/public/assets/env/.
// All six are Poly Haven CC0 1K HDRIs. See CREDITS.md.

export type EnvironmentPresetId =
  | 'blouberg_sunrise_2'
  | 'kloofendal_48d_partly_cloudy'
  | 'moonless_golf'
  | 'royal_esplanade'
  | 'studio_small_09'
  | 'venice_sunset';

export interface EnvironmentPreset {
  id: EnvironmentPresetId;
  label: string;
  /** Public URL path — usable with R3F's `<Environment files={path} />`. */
  path: string;
}

const BASE = '/assets/env';

export const ENVIRONMENT_PRESETS: Record<EnvironmentPresetId, EnvironmentPreset> = {
  blouberg_sunrise_2: {
    id: 'blouberg_sunrise_2',
    label: 'Blouberg Sunrise',
    path: `${BASE}/blouberg_sunrise_2_1k.hdr`,
  },
  kloofendal_48d_partly_cloudy: {
    id: 'kloofendal_48d_partly_cloudy',
    label: 'Kloofendal Partly Cloudy',
    path: `${BASE}/kloofendal_48d_partly_cloudy_1k.hdr`,
  },
  moonless_golf: {
    id: 'moonless_golf',
    label: 'Moonless Golf (Night)',
    path: `${BASE}/moonless_golf_1k.hdr`,
  },
  royal_esplanade: {
    id: 'royal_esplanade',
    label: 'Royal Esplanade',
    path: `${BASE}/royal_esplanade_1k.hdr`,
  },
  studio_small_09: {
    id: 'studio_small_09',
    label: 'Studio (Small 09)',
    path: `${BASE}/studio_small_09_1k.hdr`,
  },
  venice_sunset: {
    id: 'venice_sunset',
    label: 'Venice Sunset',
    path: `${BASE}/venice_sunset_1k.hdr`,
  },
};

export const ENVIRONMENT_PRESET_LIST: EnvironmentPreset[] =
  Object.values(ENVIRONMENT_PRESETS);
