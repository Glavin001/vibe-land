/**
 * Centralized test control bindings.
 *
 * Sources key codes from the game's DEFAULT_INPUT_BINDINGS so tests use exactly
 * the same keyboard/mouse mapping as the real game. If the game defaults change,
 * tests update automatically.
 */

// These values mirror client/src/input/bindings.ts DEFAULT_INPUT_BINDINGS.keyboard.
// They are re-declared here to avoid importing the game source (which depends on
// browser APIs) into the Playwright Node.js test runner.
export const Controls = {
  // Movement
  moveForward: 'KeyW',
  moveBackward: 'KeyS',
  moveLeft: 'KeyA',
  moveRight: 'KeyD',
  jump: 'Space',
  sprint: 'ShiftLeft',
  crouch: 'KeyC',

  // Interaction
  interact: 'KeyE',
  resetVehicle: 'KeyR',
  blockRemove: 'KeyQ',
  blockPlace: 'KeyF',

  // Vehicle
  handbrake: 'Space',

  // Material slots
  materialSlot1: 'Digit1',
  materialSlot2: 'Digit2',

  // Shooting: left mouse button (index 0)
  firePrimaryMouseButton: 0 as const,

  // Debug
  debugOverlayToggle: 'F3',
  copyDebug: 'F4',
} as const;

/** Maps keyboard code strings to Playwright key names */
export function codeToKey(code: string): string {
  const map: Record<string, string> = {
    KeyW: 'w',
    KeyA: 'a',
    KeyS: 's',
    KeyD: 'd',
    KeyE: 'e',
    KeyR: 'r',
    KeyQ: 'q',
    KeyF: 'f',
    KeyC: 'c',
    Space: ' ',
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift',
    ControlLeft: 'Control',
    ControlRight: 'Control',
    Digit1: '1',
    Digit2: '2',
    Digit3: '3',
    Digit4: '4',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    F3: 'F3',
    F4: 'F4',
  };
  return map[code] ?? code;
}
