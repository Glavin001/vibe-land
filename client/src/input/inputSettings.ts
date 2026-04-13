// Calibratable input settings for mouse/keyboard and gamepad aim feel.
// Read every frame by keyboardMouse.ts and gamepad.ts via `inputSettingsStore`.

export type InputSettingsV1 = {
  version: 1;
  mouse: {
    // Base radians-per-mouse-count multiplier.
    // Default 0.003 preserves the legacy POINTER_LOOK_SENSITIVITY behavior.
    sensitivity: number;
    // Vertical sensitivity as a multiplier of horizontal. 1.0 = symmetric.
    yOverXRatio: number;
    // If true, inverts vertical look. Reserved for a future toggle; default false.
    invertY: boolean;
  };
  gamepad: {
    // Radians/sec at full stick deflection after curve. Default 2.8.
    yawSpeed: number;
    // pitchSpeed is derived as yawSpeed * yOverXRatio (so calibrating speed
    // doesn't secretly also change the aspect ratio).
    // Default 2.1 / 2.8 ≈ 0.75 preserves the legacy (2.8, 2.1) pair.
    yOverXRatio: number;
    // Response-curve exponent: sign(v) * |v|^exponent.
    // 1.0 = linear, 2.0 = legacy squared curve, 3.0 = very precise near center.
    curveExponent: number;
    // Radial deadzone on the right (aim) stick. Default 0.12.
    aimDeadzone: number;
    // Reserved; default false.
    invertY: boolean;
  };
  meta: {
    // True once the user has finished or skipped the first-run flow. Controls
    // whether the firing-range auto-prompt appears.
    firstRunPromptDismissed: boolean;
    // Monotonic counter bumped on each wizard completion so listeners can
    // react without deep-comparing the whole object.
    revision: number;
  };
};

export type InputSettings = InputSettingsV1;

export const DEFAULT_INPUT_SETTINGS: InputSettingsV1 = {
  version: 1,
  mouse: {
    sensitivity: 0.003,
    yOverXRatio: 1.0,
    invertY: false,
  },
  gamepad: {
    yawSpeed: 2.8,
    yOverXRatio: 2.1 / 2.8,
    curveExponent: 2.0,
    aimDeadzone: 0.12,
    invertY: false,
  },
  meta: {
    firstRunPromptDismissed: false,
    revision: 0,
  },
};

// Hard valid ranges. The wizard's knob specs use tighter calibration brackets,
// but these are the ultimate clamp boundaries applied when parsing stored JSON
// or receiving user input from anywhere.
export const INPUT_SETTINGS_LIMITS = {
  mouse: {
    sensitivity: { min: 0.0005, max: 0.01 },
    yOverXRatio: { min: 0.4, max: 1.6 },
  },
  gamepad: {
    yawSpeed: { min: 1.0, max: 5.5 },
    yOverXRatio: { min: 0.4, max: 1.3 },
    curveExponent: { min: 1.0, max: 3.0 },
    aimDeadzone: { min: 0.03, max: 0.25 },
  },
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Parse an unknown blob (typically from localStorage) into a valid settings
 * object. Unknown fields are ignored, missing numbers fall back to defaults,
 * and all numeric fields are clamped to their valid range. Returns null only
 * when the input is not a plain object at all or carries a wrong `version`
 * — mirrors how `parseWorldDocument` treats wrong versions.
 */
export function parseInputSettings(raw: unknown): InputSettingsV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;

  const mouseRaw = (obj.mouse ?? {}) as Record<string, unknown>;
  const gamepadRaw = (obj.gamepad ?? {}) as Record<string, unknown>;
  const metaRaw = (obj.meta ?? {}) as Record<string, unknown>;

  const limits = INPUT_SETTINGS_LIMITS;
  const mouseSens = finiteNumber(mouseRaw.sensitivity)
    ? clamp(mouseRaw.sensitivity, limits.mouse.sensitivity.min, limits.mouse.sensitivity.max)
    : DEFAULT_INPUT_SETTINGS.mouse.sensitivity;
  const mouseYx = finiteNumber(mouseRaw.yOverXRatio)
    ? clamp(mouseRaw.yOverXRatio, limits.mouse.yOverXRatio.min, limits.mouse.yOverXRatio.max)
    : DEFAULT_INPUT_SETTINGS.mouse.yOverXRatio;

  const gpYaw = finiteNumber(gamepadRaw.yawSpeed)
    ? clamp(gamepadRaw.yawSpeed, limits.gamepad.yawSpeed.min, limits.gamepad.yawSpeed.max)
    : DEFAULT_INPUT_SETTINGS.gamepad.yawSpeed;
  const gpYx = finiteNumber(gamepadRaw.yOverXRatio)
    ? clamp(gamepadRaw.yOverXRatio, limits.gamepad.yOverXRatio.min, limits.gamepad.yOverXRatio.max)
    : DEFAULT_INPUT_SETTINGS.gamepad.yOverXRatio;
  const gpCurve = finiteNumber(gamepadRaw.curveExponent)
    ? clamp(gamepadRaw.curveExponent, limits.gamepad.curveExponent.min, limits.gamepad.curveExponent.max)
    : DEFAULT_INPUT_SETTINGS.gamepad.curveExponent;
  const gpDead = finiteNumber(gamepadRaw.aimDeadzone)
    ? clamp(gamepadRaw.aimDeadzone, limits.gamepad.aimDeadzone.min, limits.gamepad.aimDeadzone.max)
    : DEFAULT_INPUT_SETTINGS.gamepad.aimDeadzone;

  const revision = finiteNumber(metaRaw.revision) ? Math.max(0, Math.floor(metaRaw.revision)) : 0;

  return {
    version: 1,
    mouse: {
      sensitivity: mouseSens,
      yOverXRatio: mouseYx,
      invertY: asBool(mouseRaw.invertY, DEFAULT_INPUT_SETTINGS.mouse.invertY),
    },
    gamepad: {
      yawSpeed: gpYaw,
      yOverXRatio: gpYx,
      curveExponent: gpCurve,
      aimDeadzone: gpDead,
      invertY: asBool(gamepadRaw.invertY, DEFAULT_INPUT_SETTINGS.gamepad.invertY),
    },
    meta: {
      firstRunPromptDismissed: asBool(metaRaw.firstRunPromptDismissed, false),
      revision,
    },
  };
}

export function cloneInputSettings(settings: InputSettingsV1): InputSettingsV1 {
  // Small enough that a hand-clone is clearer than structuredClone and
  // works in test environments without the global.
  return {
    version: 1,
    mouse: { ...settings.mouse },
    gamepad: { ...settings.gamepad },
    meta: { ...settings.meta },
  };
}
