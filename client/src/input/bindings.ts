export type KeyboardCodeBinding =
  | 'KeyW'
  | 'KeyA'
  | 'KeyS'
  | 'KeyD'
  | 'KeyQ'
  | 'KeyE'
  | 'KeyR'
  | 'KeyF'
  | 'KeyC'
  | 'KeyV'
  | 'Space'
  | 'ShiftLeft'
  | 'ShiftRight'
  | 'ControlLeft'
  | 'ControlRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Digit1'
  | 'Digit2'
  | 'Digit3'
  | 'Digit4';

export type MouseButtonBinding = 0 | 1 | 2;

export type GamepadButtonBinding =
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
  | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

export type GamepadAxisBinding = 0 | 1 | 2 | 3;

export type KeyboardBindings = {
  moveForward: KeyboardCodeBinding;
  moveBackward: KeyboardCodeBinding;
  moveLeft: KeyboardCodeBinding;
  moveRight: KeyboardCodeBinding;
  jump: KeyboardCodeBinding;
  sprint: KeyboardCodeBinding;
  crouch: KeyboardCodeBinding;
  interact: KeyboardCodeBinding;
  resetVehicle: KeyboardCodeBinding;
  blockRemove: KeyboardCodeBinding;
  blockPlace: KeyboardCodeBinding;
  materialSlot1: KeyboardCodeBinding;
  materialSlot2: KeyboardCodeBinding;
  handbrake: KeyboardCodeBinding;
  firePrimaryMouseButton: MouseButtonBinding;
  melee: KeyboardCodeBinding;
};

export type GamepadBindings = {
  moveXAxis: GamepadAxisBinding;
  moveYAxis: GamepadAxisBinding;
  lookXAxis: GamepadAxisBinding;
  lookYAxis: GamepadAxisBinding;
  throttleButton: GamepadButtonBinding;
  brakeButton: GamepadButtonBinding;
  jumpButton: GamepadButtonBinding;
  sprintButton: GamepadButtonBinding;
  crouchButton: GamepadButtonBinding;
  firePrimaryButton: GamepadButtonBinding;
  handbrakeButton: GamepadButtonBinding;
  interactButton: GamepadButtonBinding;
  resetVehicleButton: GamepadButtonBinding;
  blockRemoveButton: GamepadButtonBinding;
  blockPlaceButton: GamepadButtonBinding;
  materialSlot1Button: GamepadButtonBinding;
  materialSlot2Button: GamepadButtonBinding;
  meleeButton: GamepadButtonBinding;
};

export type InputBindings = {
  keyboard: KeyboardBindings;
  gamepad: GamepadBindings;
};

const STORAGE_KEY = 'vibe-land/input-bindings/v1';

export const DEFAULT_INPUT_BINDINGS: InputBindings = {
  keyboard: {
    moveForward: 'KeyW',
    moveBackward: 'KeyS',
    moveLeft: 'KeyA',
    moveRight: 'KeyD',
    jump: 'Space',
    sprint: 'ShiftLeft',
    crouch: 'KeyC',
    interact: 'KeyE',
    resetVehicle: 'KeyR',
    blockRemove: 'KeyQ',
    blockPlace: 'KeyF',
    materialSlot1: 'Digit1',
    materialSlot2: 'Digit2',
    handbrake: 'Space',
    firePrimaryMouseButton: 0,
    melee: 'KeyV',
  },
  gamepad: {
    moveXAxis: 0,
    moveYAxis: 1,
    lookXAxis: 2,
    lookYAxis: 3,
    throttleButton: 7,
    brakeButton: 6,
    jumpButton: 0,
    sprintButton: 10,
    crouchButton: 1,
    firePrimaryButton: 7,
    handbrakeButton: 0,
    interactButton: 2,
    resetVehicleButton: 3,
    blockRemoveButton: 4,
    blockPlaceButton: 5,
    materialSlot1Button: 14,
    materialSlot2Button: 15,
    meleeButton: 1,
  },
};

export const KEYBOARD_CODE_OPTIONS: Array<{ value: KeyboardCodeBinding; label: string }> = [
  { value: 'KeyW', label: 'W' },
  { value: 'KeyA', label: 'A' },
  { value: 'KeyS', label: 'S' },
  { value: 'KeyD', label: 'D' },
  { value: 'KeyQ', label: 'Q' },
  { value: 'KeyE', label: 'E' },
  { value: 'KeyR', label: 'R' },
  { value: 'KeyF', label: 'F' },
  { value: 'KeyC', label: 'C' },
  { value: 'KeyV', label: 'V' },
  { value: 'Space', label: 'Space' },
  { value: 'ShiftLeft', label: 'Left Shift' },
  { value: 'ShiftRight', label: 'Right Shift' },
  { value: 'ControlLeft', label: 'Left Ctrl' },
  { value: 'ControlRight', label: 'Right Ctrl' },
  { value: 'ArrowUp', label: 'Arrow Up' },
  { value: 'ArrowDown', label: 'Arrow Down' },
  { value: 'ArrowLeft', label: 'Arrow Left' },
  { value: 'ArrowRight', label: 'Arrow Right' },
  { value: 'Digit1', label: '1' },
  { value: 'Digit2', label: '2' },
  { value: 'Digit3', label: '3' },
  { value: 'Digit4', label: '4' },
];

export const MOUSE_BUTTON_OPTIONS: Array<{ value: MouseButtonBinding; label: string }> = [
  { value: 0, label: 'Left Mouse' },
  { value: 1, label: 'Middle Mouse' },
  { value: 2, label: 'Right Mouse' },
];

export const GAMEPAD_BUTTON_OPTIONS: Array<{ value: GamepadButtonBinding; label: string }> = [
  { value: 0, label: 'A / Cross' },
  { value: 1, label: 'B / Circle' },
  { value: 2, label: 'X / Square' },
  { value: 3, label: 'Y / Triangle' },
  { value: 4, label: 'LB / L1' },
  { value: 5, label: 'RB / R1' },
  { value: 6, label: 'LT / L2' },
  { value: 7, label: 'RT / R2' },
  { value: 8, label: 'View / Select' },
  { value: 9, label: 'Menu / Start' },
  { value: 10, label: 'L3' },
  { value: 11, label: 'R3' },
  { value: 12, label: 'D-Pad Up' },
  { value: 13, label: 'D-Pad Down' },
  { value: 14, label: 'D-Pad Left' },
  { value: 15, label: 'D-Pad Right' },
];

export const GAMEPAD_AXIS_OPTIONS: Array<{ value: GamepadAxisBinding; label: string }> = [
  { value: 0, label: 'Left Stick X' },
  { value: 1, label: 'Left Stick Y' },
  { value: 2, label: 'Right Stick X' },
  { value: 3, label: 'Right Stick Y' },
];

function cloneDefaultBindings(): InputBindings {
  return {
    keyboard: { ...DEFAULT_INPUT_BINDINGS.keyboard },
    gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad },
  };
}

function isKeyboardBinding(value: unknown): value is KeyboardBindings {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Record<string, unknown>;
  return typeof binding.moveForward === 'string'
    && typeof binding.moveBackward === 'string'
    && typeof binding.moveLeft === 'string'
    && typeof binding.moveRight === 'string'
    && typeof binding.jump === 'string'
    && typeof binding.sprint === 'string'
    && typeof binding.crouch === 'string'
    && typeof binding.interact === 'string'
    && typeof binding.resetVehicle === 'string'
    && typeof binding.blockRemove === 'string'
    && typeof binding.blockPlace === 'string'
    && typeof binding.materialSlot1 === 'string'
    && typeof binding.materialSlot2 === 'string'
    && typeof binding.handbrake === 'string'
    && typeof binding.firePrimaryMouseButton === 'number'
    && typeof binding.melee === 'string';
}

function isGamepadBinding(value: unknown): value is GamepadBindings {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Record<string, unknown>;
  return typeof binding.moveXAxis === 'number'
    && typeof binding.moveYAxis === 'number'
    && typeof binding.lookXAxis === 'number'
    && typeof binding.lookYAxis === 'number'
    && typeof binding.throttleButton === 'number'
    && typeof binding.brakeButton === 'number'
    && typeof binding.jumpButton === 'number'
    && typeof binding.sprintButton === 'number'
    && typeof binding.crouchButton === 'number'
    && typeof binding.firePrimaryButton === 'number'
    && typeof binding.handbrakeButton === 'number'
    && typeof binding.interactButton === 'number'
    && typeof binding.resetVehicleButton === 'number'
    && typeof binding.blockRemoveButton === 'number'
    && typeof binding.blockPlaceButton === 'number'
    && typeof binding.materialSlot1Button === 'number'
    && typeof binding.materialSlot2Button === 'number'
    && typeof binding.meleeButton === 'number';
}

export function loadInputBindings(): InputBindings {
  if (typeof window === 'undefined') {
    return cloneDefaultBindings();
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaultBindings();
    const parsed = JSON.parse(raw) as { keyboard?: unknown; gamepad?: unknown };
    if (!isKeyboardBinding(parsed.keyboard) || !isGamepadBinding(parsed.gamepad)) {
      return cloneDefaultBindings();
    }
    return {
      keyboard: { ...DEFAULT_INPUT_BINDINGS.keyboard, ...parsed.keyboard },
      gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad, ...parsed.gamepad },
    };
  } catch {
    return cloneDefaultBindings();
  }
}

export function saveInputBindings(bindings: InputBindings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // ignore localStorage failures
  }
}

export function resetAllInputBindings(): InputBindings {
  const bindings = cloneDefaultBindings();
  saveInputBindings(bindings);
  return bindings;
}

export function keyboardCodeLabel(code: KeyboardCodeBinding): string {
  return KEYBOARD_CODE_OPTIONS.find((option) => option.value === code)?.label ?? code;
}

export function mouseButtonLabel(button: MouseButtonBinding): string {
  return MOUSE_BUTTON_OPTIONS.find((option) => option.value === button)?.label ?? `Mouse ${button}`;
}

export function gamepadButtonLabel(button: GamepadButtonBinding): string {
  return GAMEPAD_BUTTON_OPTIONS.find((option) => option.value === button)?.label ?? `Button ${button}`;
}

export function gamepadAxisLabel(axis: GamepadAxisBinding): string {
  return GAMEPAD_AXIS_OPTIONS.find((option) => option.value === axis)?.label ?? `Axis ${axis}`;
}
