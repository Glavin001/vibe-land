import { getInputSettings } from './inputSettingsStore';
import type { ActionSnapshot, InputContext } from './types';

// Move-stick inner deadzone is not currently calibrated (move is out of v1
// scope; the player only notices it at walking edge cases). Aim-stick
// deadzone and speed/curve are read from settings per-frame.
const LEFT_STICK_DEADZONE = 0.18;
const PRESSED_EPSILON = 0.35;

type GamepadState = {
  axes: number[];
  buttons: number[];
};

function emptyState(): GamepadState {
  return { axes: [], buttons: [] };
}

export function applyRadialDeadzone(x: number, y: number, deadzone: number): [number, number] {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= deadzone) return [0, 0];
  const scaledMagnitude = (magnitude - deadzone) / (1 - deadzone);
  const scale = scaledMagnitude / magnitude;
  return [x * scale, y * scale];
}

/**
 * Apply a variable-exponent response curve: `sign(v) * |v|^exponent`.
 * - exponent = 1.0 → linear (direct)
 * - exponent = 2.0 → legacy squared curve (default)
 * - exponent > 2.0 → more precise near center, faster at the edges
 */
export function shapeLookAxisWithExponent(value: number, exponent: number): number {
  const sign = Math.sign(value);
  const mag = Math.abs(value);
  // Math.pow(0, x) === 0 for x > 0, and we clamp exponent ≥ 1 at the
  // settings layer, so this is numerically well-behaved.
  return sign * Math.pow(mag, exponent);
}

// Back-compat wrapper kept for existing tests and anyone importing the
// legacy name. Uses the hardcoded exponent-2 curve.
export function shapeLookAxis(value: number): number {
  return shapeLookAxisWithExponent(value, 2);
}

function buttonValue(gamepad: Gamepad, index: number): number {
  return gamepad.buttons[index]?.value ?? 0;
}

function buttonPressed(gamepad: Gamepad, index: number): boolean {
  const button = gamepad.buttons[index];
  return Boolean(button?.pressed || (button?.value ?? 0) > PRESSED_EPSILON);
}

function buttonJustPressed(gamepad: Gamepad, previous: GamepadState, index: number): boolean {
  const current = buttonPressed(gamepad, index);
  const before = (previous.buttons[index] ?? 0) > PRESSED_EPSILON;
  return current && !before;
}

export class GamepadInputSource {
  private previous: GamepadState = emptyState();
  private activityId = 0;

  private noteActivityIfChanged(gamepad: Gamepad, previous: GamepadState) {
    const axisChanged = gamepad.axes.some((value, index) => Math.abs(value - (previous.axes[index] ?? 0)) > 0.08);
    const buttonChanged = gamepad.buttons.some((button, index) => Math.abs(button.value - (previous.buttons[index] ?? 0)) > 0.15);
    if (axisChanged || buttonChanged) {
      this.activityId += 1;
    }
  }

  sample(deltaSec: number, context: InputContext): ActionSnapshot | null {
    const pads = navigator.getGamepads?.() ?? [];
    const gamepad = pads.find((pad) => Boolean(pad && pad.connected && pad.mapping === 'standard'))
      ?? pads.find((pad) => Boolean(pad && pad.connected))
      ?? null;
    if (!gamepad) return null;

    const previous = this.previous;
    this.noteActivityIfChanged(gamepad, previous);

    const gp = getInputSettings().gamepad;
    const [moveX, moveYRaw] = applyRadialDeadzone(gamepad.axes[0] ?? 0, gamepad.axes[1] ?? 0, LEFT_STICK_DEADZONE);
    const [lookXRaw, lookYRaw] = applyRadialDeadzone(gamepad.axes[2] ?? 0, gamepad.axes[3] ?? 0, gp.aimDeadzone);
    const yawSpeed = gp.yawSpeed;
    // Pitch speed is derived from yaw * y/x ratio so calibrating speed alone
    // doesn't secretly change the aspect ratio.
    const pitchSpeed = gp.yawSpeed * gp.yOverXRatio;
    const lookX = -shapeLookAxisWithExponent(lookXRaw, gp.curveExponent) * yawSpeed * deltaSec;
    const lookY = shapeLookAxisWithExponent(lookYRaw, gp.curveExponent) * pitchSpeed * deltaSec;
    const rt = buttonValue(gamepad, 7);
    const lt = buttonValue(gamepad, 6);
    const steer = moveX;
    const throttle = context === 'vehicle' ? rt : Math.max(0, -moveYRaw);
    const brake = context === 'vehicle' ? lt : 0;

    const snapshot: ActionSnapshot = {
      family: 'gamepad',
      activityId: this.activityId,
      moveX,
      moveY: -moveYRaw,
      lookX,
      // Legacy default (invertY=false) negates raw stick Y. invertY=true keeps
      // the sign, producing inverted vertical look.
      lookY: gp.invertY ? lookY : -lookY,
      steer,
      throttle,
      brake,
      jump: context === 'onFoot' && buttonPressed(gamepad, 0),
      sprint: context === 'onFoot' && buttonPressed(gamepad, 10),
      crouch: context === 'onFoot' && buttonPressed(gamepad, 1),
      firePrimary: context === 'onFoot' && rt > PRESSED_EPSILON,
      firePrimaryValue: context === 'onFoot' ? rt : 0,
      handbrake: context === 'vehicle' && buttonPressed(gamepad, 0),
      interactPressed: buttonJustPressed(gamepad, previous, 2),
      blockRemovePressed: context === 'onFoot' && buttonJustPressed(gamepad, previous, 4),
      blockPlacePressed: context === 'onFoot' && buttonJustPressed(gamepad, previous, 5),
      materialSlot1Pressed: context === 'onFoot' && buttonJustPressed(gamepad, previous, 14),
      materialSlot2Pressed: context === 'onFoot' && buttonJustPressed(gamepad, previous, 15),
    };

    this.previous = {
      axes: [...gamepad.axes],
      buttons: gamepad.buttons.map((button) => button.value),
    };

    return snapshot;
  }
}
