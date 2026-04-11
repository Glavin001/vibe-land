import type { ActionSnapshot, InputContext } from './types';

const LEFT_STICK_DEADZONE = 0.18;
const RIGHT_STICK_DEADZONE = 0.12;
const GAMEPAD_YAW_SPEED = 2.8;
const GAMEPAD_PITCH_SPEED = 2.1;
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

export function shapeLookAxis(value: number): number {
  const sign = Math.sign(value);
  return sign * value * value;
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

    const [moveX, moveYRaw] = applyRadialDeadzone(gamepad.axes[0] ?? 0, gamepad.axes[1] ?? 0, LEFT_STICK_DEADZONE);
    const [lookXRaw, lookYRaw] = applyRadialDeadzone(gamepad.axes[2] ?? 0, gamepad.axes[3] ?? 0, RIGHT_STICK_DEADZONE);
    const lookX = -shapeLookAxis(lookXRaw) * GAMEPAD_YAW_SPEED * deltaSec;
    const lookY = shapeLookAxis(lookYRaw) * GAMEPAD_PITCH_SPEED * deltaSec;
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
      lookY: -lookY,
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
