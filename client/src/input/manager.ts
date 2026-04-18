import type { InputBindings } from './bindings';
import { resolveActiveFamily } from './arbiter';
import { GamepadInputSource } from './gamepad';
import { KeyboardMouseInputSource } from './keyboardMouse';
import { touchInputSource, type TouchInputSource } from './touch';
import type {
  ActionSnapshot,
  DeviceFamily,
  InputContext,
  InputFamilyMode,
  InputSample,
  LocalDeviceAssignment,
} from './types';

export class GameInputManager {
  private readonly keyboardMouse: KeyboardMouseInputSource | null;
  private readonly gamepad: GamepadInputSource | null;
  private readonly touch: TouchInputSource | null;
  private activeFamily: DeviceFamily | null = null;
  private readonly assignment: LocalDeviceAssignment | null;

  /**
   * @param assignment  If provided, this manager is owned by a concrete
   *   local-split-screen slot: it samples **only** the assigned device
   *   family (keyboard+touch, or one specific pad index). If null, legacy
   *   single-player behavior — all sources are sampled and the runtime
   *   mode (auto/keyboard/gamepad) picks the active one per-frame.
   */
  constructor(assignment: LocalDeviceAssignment | null = null) {
    this.assignment = assignment;
    if (assignment == null) {
      this.keyboardMouse = new KeyboardMouseInputSource();
      this.gamepad = new GamepadInputSource();
      this.touch = touchInputSource;
    } else if (assignment.family === 'keyboardMouse') {
      this.keyboardMouse = new KeyboardMouseInputSource();
      this.gamepad = null;
      this.touch = touchInputSource;
    } else {
      this.keyboardMouse = null;
      this.gamepad = new GamepadInputSource(assignment.index);
      this.touch = null;
    }
  }

  attach() {
    this.keyboardMouse?.attach();
    this.touch?.attach();
  }

  detach() {
    this.keyboardMouse?.detach();
    this.touch?.detach();
  }

  sample(
    deltaSec: number,
    pointerLocked: boolean,
    context: InputContext,
    bindings: InputBindings,
    mode: InputFamilyMode = 'auto',
  ): InputSample {
    const keyboardMouseSnapshot = this.keyboardMouse?.sample(pointerLocked, context, bindings) ?? null;
    const gamepadSnapshot = this.gamepad?.sample(deltaSec, context, bindings) ?? null;
    const touchSnapshot = this.touch?.sample(context) ?? null;
    if (this.assignment != null) {
      // Split-screen slot: no arbitration, the chosen family wins.
      this.activeFamily = this.assignment.family === 'gamepad' ? 'gamepad' : 'keyboardMouse';
    } else {
      this.activeFamily = resolveActiveFamily(
        mode,
        this.activeFamily,
        keyboardMouseSnapshot,
        gamepadSnapshot,
        touchSnapshot,
      );
    }

    let action: ActionSnapshot | null = null;
    if (this.activeFamily === 'keyboardMouse') {
      action = keyboardMouseSnapshot;
    } else if (this.activeFamily === 'gamepad') {
      action = gamepadSnapshot;
    } else if (this.activeFamily === 'touch') {
      action = touchSnapshot;
    }

    return {
      context,
      activeFamily: this.activeFamily,
      action,
    };
  }
}
