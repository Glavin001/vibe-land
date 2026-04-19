import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FOG_SETTINGS,
  FOG_OPACITY_AT_AOI,
  __resetFogSettingsForTest,
  fogDensityForAoi,
  parseFogSettings,
  resolveFogColor,
} from './fogSettings';
import { WEATHER_PRESETS } from './weatherPresets';

afterEach(() => {
  __resetFogSettingsForTest();
});

describe('fogDensityForAoi', () => {
  it('produces density that hits FOG_OPACITY_AT_AOI at the given radius', () => {
    const radius = 80;
    const density = fogDensityForAoi(radius);
    // FogExp2: opacity = 1 - exp(-(density * distance)^2)
    const opacity = 1 - Math.exp(-Math.pow(density * radius, 2));
    expect(opacity).toBeCloseTo(FOG_OPACITY_AT_AOI, 5);
  });
});

describe('parseFogSettings', () => {
  it('returns null for non-object input', () => {
    expect(parseFogSettings(null)).toBeNull();
    expect(parseFogSettings(42)).toBeNull();
    expect(parseFogSettings('stringified')).toBeNull();
  });

  it('fills defaults when fields are missing (pre-weather schema)', () => {
    const parsed = parseFogSettings({ enabled: false, density: 0.1, color: '#abcdef' });
    expect(parsed).toEqual({
      enabled: false,
      density: 0.1,
      color: '#abcdef',
      weather: DEFAULT_FOG_SETTINGS.weather,
      windStrengthMps: DEFAULT_FOG_SETTINGS.windStrengthMps,
      windDirectionDeg: DEFAULT_FOG_SETTINGS.windDirectionDeg,
    });
  });

  it('preserves a persisted null color', () => {
    const parsed = parseFogSettings({ color: null });
    expect(parsed?.color).toBeNull();
  });

  it('falls back to default for unknown weather strings', () => {
    const parsed = parseFogSettings({ weather: 'fire_tornado' });
    expect(parsed?.weather).toBe(DEFAULT_FOG_SETTINGS.weather);
  });

  it('accepts each valid weather preset', () => {
    for (const key of Object.keys(WEATHER_PRESETS)) {
      const parsed = parseFogSettings({ weather: key });
      expect(parsed?.weather).toBe(key);
    }
  });

  it('clamps wind strength to [0, 200] and preserves valid values', () => {
    expect(parseFogSettings({ windStrengthMps: 42 })?.windStrengthMps).toBe(42);
    expect(parseFogSettings({ windStrengthMps: -5 })?.windStrengthMps).toBe(DEFAULT_FOG_SETTINGS.windStrengthMps);
    expect(parseFogSettings({ windStrengthMps: 500 })?.windStrengthMps).toBe(DEFAULT_FOG_SETTINGS.windStrengthMps);
    expect(parseFogSettings({ windStrengthMps: Number.NaN })?.windStrengthMps).toBe(DEFAULT_FOG_SETTINGS.windStrengthMps);
  });

  it('ignores negative or non-finite fog density', () => {
    expect(parseFogSettings({ density: -1 })?.density).toBe(DEFAULT_FOG_SETTINGS.density);
    expect(parseFogSettings({ density: Number.NaN })?.density).toBe(DEFAULT_FOG_SETTINGS.density);
  });
});

describe('resolveFogColor', () => {
  it('returns the preset fog color when no user override', () => {
    const color = resolveFogColor({ ...DEFAULT_FOG_SETTINGS, weather: 'dust_storm', color: null });
    expect(color).toBe(WEATHER_PRESETS.dust_storm.fogColor);
  });

  it('returns the user override when one is set', () => {
    const color = resolveFogColor({ ...DEFAULT_FOG_SETTINGS, weather: 'dust_storm', color: '#123456' });
    expect(color).toBe('#123456');
  });
});
