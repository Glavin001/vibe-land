import type { ActionSnapshot, InputContext } from './types';

const POINTER_LOOK_SENSITIVITY = 0.003;

export class KeyboardMouseInputSource {
  private readonly keys = new Set<string>();
  private readonly mouseButtons = new Set<number>();
  private pointerDeltaX = 0;
  private pointerDeltaY = 0;
  private activityId = 0;
  private interactPressed = false;
  private blockRemovePressed = false;
  private blockPlacePressed = false;
  private materialSlot1Pressed = false;
  private materialSlot2Pressed = false;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.keys.has(event.code)) {
      this.activityId += 1;
    }
    this.keys.add(event.code);
    if (event.code === 'KeyE') this.interactPressed = true;
    if (event.code === 'KeyQ') this.blockRemovePressed = true;
    if (event.code === 'KeyF') this.blockPlacePressed = true;
    if (event.code === 'Digit1') this.materialSlot1Pressed = true;
    if (event.code === 'Digit2') this.materialSlot2Pressed = true;
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = () => {
    this.keys.clear();
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

  sample(pointerLocked: boolean, context: InputContext): ActionSnapshot {
    const moveX = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0)
      + (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? -1 : 0);
    const moveY = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0)
      + (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? -1 : 0);
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
      throttle: this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0,
      brake: this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0,
      jump: context === 'onFoot' && this.keys.has('Space'),
      sprint: context === 'onFoot' && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')),
      crouch: context === 'onFoot'
        && (this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyC')),
      firePrimary: context === 'onFoot' && pointerLocked && this.mouseButtons.has(0),
      firePrimaryValue: context === 'onFoot' && pointerLocked && this.mouseButtons.has(0) ? 1 : 0,
      handbrake: context === 'vehicle' && this.keys.has('Space'),
      interactPressed: this.interactPressed,
      blockRemovePressed: context === 'onFoot' && this.blockRemovePressed,
      blockPlacePressed: context === 'onFoot' && this.blockPlacePressed,
      materialSlot1Pressed: context === 'onFoot' && this.materialSlot1Pressed,
      materialSlot2Pressed: context === 'onFoot' && this.materialSlot2Pressed,
    };

    this.interactPressed = false;
    this.blockRemovePressed = false;
    this.blockPlacePressed = false;
    this.materialSlot1Pressed = false;
    this.materialSlot2Pressed = false;

    return snapshot;
  }
}
