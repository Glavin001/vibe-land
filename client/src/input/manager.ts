import type { InputBindings } from './bindings';
import { resolveActiveFamily } from './arbiter';
import { GamepadInputSource } from './gamepad';
import { KeyboardMouseInputSource } from './keyboardMouse';
import type { ActionSnapshot, DeviceFamily, InputContext, InputFamilyMode, InputSample } from './types';

export class GameInputManager {
  private readonly keyboardMouse = new KeyboardMouseInputSource();
  private readonly gamepad = new GamepadInputSource();
  private activeFamily: DeviceFamily | null = null;

  attach() {
    this.keyboardMouse.attach();
  }

  detach() {
    this.keyboardMouse.detach();
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
    this.activeFamily = resolveActiveFamily(mode, this.activeFamily, keyboardMouseSnapshot, gamepadSnapshot);

    let action: ActionSnapshot | null = null;
    if (this.activeFamily === 'keyboardMouse') {
      action = keyboardMouseSnapshot;
    } else if (this.activeFamily === 'gamepad') {
      action = gamepadSnapshot;
    }

    return {
      context,
      activeFamily: this.activeFamily,
      action,
    };
  }
}
