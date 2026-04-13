import type { InputBindings } from './bindings';
import type { ActionSnapshot, InputContext } from './types';

const POINTER_LOOK_SENSITIVITY = 0.003;

export class KeyboardMouseInputSource {
  private readonly keys = new Set<string>();
  private readonly mouseButtons = new Set<number>();
  private readonly justPressedKeys = new Set<string>();
  private pointerDeltaX = 0;
  private pointerDeltaY = 0;
  private activityId = 0;

  /**
   * Raw key-down query used by the snap-machine resolver to read keys
   * that aren't part of the on-foot / vehicle binding tables (Q, R, F,
   * etc.). Accepts a DOM `KeyboardEvent.code`.
   */
  isCodeDown(code: string): boolean {
    return this.keys.has(code);
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.keys.has(event.code)) {
      this.activityId += 1;
    }
    this.keys.add(event.code);
    this.justPressedKeys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = () => {
    this.keys.clear();
    this.justPressedKeys.clear();
    this.mouseButtons.clear();
    this.pointerDeltaX = 0;
    this.pointerDeltaY = 0;
  };

  private readonly onMouseMove = (event: MouseEvent) => {
    if (document.pointerLockElement === null) {
      return;
    }
    this.pointerDeltaX += event.movementX;
    this.pointerDeltaY += event.movementY;
    if (event.movementX !== 0 || event.movementY !== 0) {
      this.activityId += 1;
    }
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (!this.mouseButtons.has(event.button)) {
      this.activityId += 1;
    }
    this.mouseButtons.add(event.button);
    if (event.button === 0 || event.button === 2) {
      event.preventDefault();
    }
  };

  private readonly onMouseUp = (event: MouseEvent) => {
    this.mouseButtons.delete(event.button);
  };

  private readonly onContextMenu = (event: MouseEvent) => {
    if (document.pointerLockElement !== null) {
      event.preventDefault();
    }
  };

  attach() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('contextmenu', this.onContextMenu);
  }

  detach() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('contextmenu', this.onContextMenu);
  }

  sample(pointerLocked: boolean, context: InputContext, bindings: InputBindings): ActionSnapshot {
    const keyboard = bindings.keyboard;
    const moveX = (this.keys.has(keyboard.moveRight) ? 1 : 0)
      + (this.keys.has(keyboard.moveLeft) ? -1 : 0);
    const moveY = (this.keys.has(keyboard.moveForward) ? 1 : 0)
      + (this.keys.has(keyboard.moveBackward) ? -1 : 0);
    const lookX = pointerLocked ? -this.pointerDeltaX * POINTER_LOOK_SENSITIVITY : 0;
    const lookY = pointerLocked ? -this.pointerDeltaY * POINTER_LOOK_SENSITIVITY : 0;
    this.pointerDeltaX = 0;
    this.pointerDeltaY = 0;

    const snapshot: ActionSnapshot = {
      family: 'keyboardMouse',
      activityId: this.activityId,
      moveX: Math.max(-1, Math.min(1, moveX)),
      moveY: Math.max(-1, Math.min(1, moveY)),
      lookX,
      lookY,
      steer: Math.max(-1, Math.min(1, moveX)),
      throttle: this.keys.has(keyboard.moveForward) ? 1 : 0,
      brake: this.keys.has(keyboard.moveBackward) ? 1 : 0,
      jump: context === 'onFoot' && this.keys.has(keyboard.jump),
      sprint: context === 'onFoot' && this.keys.has(keyboard.sprint),
      crouch: context === 'onFoot' && this.keys.has(keyboard.crouch),
      firePrimary: context === 'onFoot' && pointerLocked && this.mouseButtons.has(keyboard.firePrimaryMouseButton),
      firePrimaryValue: context === 'onFoot' && pointerLocked && this.mouseButtons.has(keyboard.firePrimaryMouseButton) ? 1 : 0,
      handbrake: context === 'vehicle' && this.keys.has(keyboard.handbrake),
      // While operating a snap-machine, the "interact" action
      // (enter/exit) moves to a dedicated exit key so it doesn't
      // overlap with the machine's motor bindings. The default
      // snap-machine `motorSpin` is E/Q, which was silently exiting
      // the machine on every press until this fix.
      interactPressed:
        context === 'snapMachine'
          ? this.justPressedKeys.has(keyboard.machineExit)
          : this.justPressedKeys.has(keyboard.interact),
      resetVehiclePressed: context === 'vehicle' && this.justPressedKeys.has(keyboard.resetVehicle),
      blockRemovePressed: context === 'onFoot' && this.justPressedKeys.has(keyboard.blockRemove),
      blockPlacePressed: context === 'onFoot' && this.justPressedKeys.has(keyboard.blockPlace),
      materialSlot1Pressed: context === 'onFoot' && this.justPressedKeys.has(keyboard.materialSlot1),
      materialSlot2Pressed: context === 'onFoot' && this.justPressedKeys.has(keyboard.materialSlot2),
    };

    this.justPressedKeys.clear();

    return snapshot;
  }
}
