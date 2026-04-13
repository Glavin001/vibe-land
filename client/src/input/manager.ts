import type { InputBindings } from './bindings';
import { resolveActiveFamily } from './arbiter';
import { GamepadInputSource } from './gamepad';
import { KeyboardMouseInputSource } from './keyboardMouse';
import { touchInputSource, type TouchInputSource } from './touch';
import type { ActionSnapshot, DeviceFamily, InputContext, InputFamilyMode, InputSample } from './types';

export class GameInputManager {
  private readonly keyboardMouse = new KeyboardMouseInputSource();
  private readonly gamepad = new GamepadInputSource();
  private readonly touch: TouchInputSource = touchInputSource;
  private activeFamily: DeviceFamily | null = null;

  attach() {
    this.keyboardMouse.attach();
    this.touch.attach();
  }

  detach() {
    this.keyboardMouse.detach();
    this.touch.detach();
  }

  sample(
    deltaSec: number,
    pointerLocked: boolean,
    context: InputContext,
    bindings: InputBindings,
    mode: InputFamilyMode = 'auto',
  ): InputSample {
    const keyboardMouseSnapshot = this.keyboardMouse.sample(pointerLocked, context, bindings);
    const gamepadSnapshot = this.gamepad.sample(deltaSec, context, bindings);
    const touchSnapshot = this.touch.sample(context);
    this.activeFamily = resolveActiveFamily(
      mode,
      this.activeFamily,
      keyboardMouseSnapshot,
      gamepadSnapshot,
      touchSnapshot,
    );

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
