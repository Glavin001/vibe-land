import { describe, expect, it } from 'vitest';
import { WEATHER_PRESETS, WEATHER_PRESET_ORDER, windVectorFromSettings } from './weatherPresets';

describe('WEATHER_PRESETS', () => {
  it('includes the three required presets', () => {
    expect(WEATHER_PRESET_ORDER).toEqual(['clear', 'dust_storm', 'snow_storm']);
    for (const key of WEATHER_PRESET_ORDER) {
      expect(WEATHER_PRESETS[key]).toBeDefined();
    }
  });

  it('clear preset emits no particles', () => {
    expect(WEATHER_PRESETS.clear.particleCount).toBe(0);
  });

  it('storm presets fit inside the player AOI (80m)', () => {
    expect(WEATHER_PRESETS.dust_storm.boxSizeM).toBeLessThanOrEqual(80);
    expect(WEATHER_PRESETS.snow_storm.boxSizeM).toBeLessThanOrEqual(80);
  });

  it('storm presets produce non-zero particle counts', () => {
    expect(WEATHER_PRESETS.dust_storm.particleCount).toBeGreaterThan(0);
    expect(WEATHER_PRESETS.snow_storm.particleCount).toBeGreaterThan(0);
  });
});

describe('windVectorFromSettings', () => {
  it('zero strength gives zero vector', () => {
    const v = windVectorFromSettings(0, 90);
    expect(v).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('0° heading points along +Z', () => {
    const v = windVectorFromSettings(10, 0);
    expect(v.x).toBeCloseTo(0, 5);
    expect(v.z).toBeCloseTo(10, 5);
  });

  it('90° heading points along +X', () => {
    const v = windVectorFromSettings(10, 90);
    expect(v.x).toBeCloseTo(10, 5);
    expect(v.z).toBeCloseTo(0, 5);
  });

  it('180° heading reverses along -Z', () => {
    const v = windVectorFromSettings(10, 180);
    expect(v.z).toBeCloseTo(-10, 5);
  });

  it('y component is always zero (horizontal wind)', () => {
    for (const deg of [0, 45, 90, 135, 180, 270]) {
      expect(windVectorFromSettings(7, deg).y).toBe(0);
    }
  });
});
