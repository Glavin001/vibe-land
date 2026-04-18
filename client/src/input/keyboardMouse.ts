import type { InputBindings } from './bindings';
import { getInputSettings } from './inputSettingsStore';
import type { ActionSnapshot, InputContext } from './types';

export class KeyboardMouseInputSource {
  private readonly keys = new Set<string>();
  private readonly mouseButtons = new Set<number>();
  private readonly justPressedKeys = new Set<string>();
  private pointerDeltaX = 0;
  private pointerDeltaY = 0;
  private activityId = 0;

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
    const aimingWithKeyboard = this.keys.has(keyboard.aimSecondaryKey);
    // Mouse look sensitivity and Y/X ratio come from the calibration settings
    // store, NOT the key bindings — those two systems are orthogonal.
    // Bindings control which key does what; calibration controls how the
    // look delta is scaled.
    const mouse = getInputSettings().mouse;
    const baseSens = mouse.sensitivity;
    // invertY=false keeps the legacy "-pointerDeltaY" semantics.
    const ySign = mouse.invertY ? 1 : -1;
    const lookX = pointerLocked ? -this.pointerDeltaX * baseSens : 0;
    // yOverXRatio multiplies only Y so calibrating X (knob 1) stays stable
    // when Y/X ratio (knob 2) is later tuned.
    const lookY = pointerLocked ? ySign * this.pointerDeltaY * baseSens * mouse.yOverXRatio : 0;
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
      aimSecondary: context === 'onFoot'
        && pointerLocked
        && (this.mouseButtons.has(keyboard.aimSecondaryMouseButton) || aimingWithKeyboard),
      handbrake: context === 'vehicle' && this.keys.has(keyboard.handbrake),
      interactPressed: this.justPressedKeys.has(keyboard.interact),
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
