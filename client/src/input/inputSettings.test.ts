import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INPUT_SETTINGS,
  INPUT_SETTINGS_LIMITS,
  cloneInputSettings,
  parseInputSettings,
} from './inputSettings';

describe('parseInputSettings', () => {
  it('returns defaults-shaped object for a v1 blob', () => {
    const parsed = parseInputSettings({ version: 1 });
    expect(parsed).not.toBeNull();
    expect(parsed?.mouse.sensitivity).toBe(DEFAULT_INPUT_SETTINGS.mouse.sensitivity);
    expect(parsed?.gamepad.yawSpeed).toBe(DEFAULT_INPUT_SETTINGS.gamepad.yawSpeed);
    expect(parsed?.meta.firstRunPromptDismissed).toBe(false);
  });

  it('rejects a wrong version', () => {
    expect(parseInputSettings({ version: 2 })).toBeNull();
    expect(parseInputSettings(null)).toBeNull();
    expect(parseInputSettings('nope')).toBeNull();
  });

  it('clamps out-of-range numeric fields', () => {
    const parsed = parseInputSettings({
      version: 1,
      mouse: { sensitivity: 999, yOverXRatio: 0.01 },
      gamepad: { yawSpeed: -5, curveExponent: 10, aimDeadzone: 0.9 },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.mouse.sensitivity).toBe(INPUT_SETTINGS_LIMITS.mouse.sensitivity.max);
    expect(parsed!.mouse.yOverXRatio).toBe(INPUT_SETTINGS_LIMITS.mouse.yOverXRatio.min);
    expect(parsed!.gamepad.yawSpeed).toBe(INPUT_SETTINGS_LIMITS.gamepad.yawSpeed.min);
    expect(parsed!.gamepad.curveExponent).toBe(INPUT_SETTINGS_LIMITS.gamepad.curveExponent.max);
    expect(parsed!.gamepad.aimDeadzone).toBe(INPUT_SETTINGS_LIMITS.gamepad.aimDeadzone.max);
  });

  it('preserves valid fields exactly', () => {
    const parsed = parseInputSettings({
      version: 1,
      mouse: { sensitivity: 0.0042, yOverXRatio: 1.1, invertY: true },
      gamepad: {
        yawSpeed: 3.3,
        yOverXRatio: 0.8,
        curveExponent: 1.5,
        aimDeadzone: 0.1,
        invertY: false,
      },
      meta: { firstRunPromptDismissed: true, revision: 3 },
    });
    expect(parsed?.mouse.sensitivity).toBeCloseTo(0.0042);
    expect(parsed?.mouse.invertY).toBe(true);
    expect(parsed?.gamepad.curveExponent).toBeCloseTo(1.5);
    expect(parsed?.meta.firstRunPromptDismissed).toBe(true);
    expect(parsed?.meta.revision).toBe(3);
  });

  it('ignores non-finite numbers (NaN / Infinity) and falls back to defaults', () => {
    const parsed = parseInputSettings({
      version: 1,
      mouse: { sensitivity: Number.NaN, yOverXRatio: Number.POSITIVE_INFINITY },
    });
    expect(parsed?.mouse.sensitivity).toBe(DEFAULT_INPUT_SETTINGS.mouse.sensitivity);
    expect(parsed?.mouse.yOverXRatio).toBe(DEFAULT_INPUT_SETTINGS.mouse.yOverXRatio);
  });
});

describe('cloneInputSettings', () => {
  it('produces an independent copy', () => {
    const a = cloneInputSettings(DEFAULT_INPUT_SETTINGS);
    a.mouse.sensitivity = 0.005;
    expect(DEFAULT_INPUT_SETTINGS.mouse.sensitivity).toBe(0.003);
  });
});
