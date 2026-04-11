import { pickActiveFamily } from './arbiter';
import { GamepadInputSource } from './gamepad';
import { KeyboardMouseInputSource } from './keyboardMouse';
import type { ActionSnapshot, DeviceFamily, InputContext, InputSample } from './types';

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

  sample(deltaSec: number, pointerLocked: boolean, context: InputContext): InputSample {
    const keyboardMouseSnapshot = this.keyboardMouse.sample(pointerLocked, context);
    const gamepadSnapshot = this.gamepad.sample(deltaSec, context);
    this.activeFamily = pickActiveFamily(this.activeFamily, keyboardMouseSnapshot, gamepadSnapshot);

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
