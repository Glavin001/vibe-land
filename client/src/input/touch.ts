import type { ActionSnapshot, InputContext } from './types';

// Look sensitivity in radians per CSS pixel swiped.
// Slightly higher than mouse (0.003) because swipe distance per thumb motion is smaller.
export const TOUCH_LOOK_SENSITIVITY = 0.004;

// Joystick geometry (CSS pixels).
export const JOYSTICK_INNER_RADIUS_PX = 70;
export const JOYSTICK_SPRINT_RADIUS_PX = 95;
export const JOYSTICK_DEADZONE = 0.14;

type EdgeButton = 'interact' | 'blockRemove' | 'blockPlace' | 'mat1' | 'mat2';
type HoldButton = 'jump' | 'crouch' | 'firePrimary' | 'sprint';

export class TouchInputSource {
  private moveX = 0;
  private moveY = 0;
  private sprintFromStick = false;

  private pointerDeltaX = 0;
  private pointerDeltaY = 0;

  private holdJump = false;
  private holdCrouch = false;
  private holdFire = false;
  private holdSprint = false;

  private interactPressed = false;
  private blockRemovePressed = false;
  private blockPlacePressed = false;
  private materialSlot1Pressed = false;
  private materialSlot2Pressed = false;

  private activityId = 0;

  // No DOM listeners — the React HUD pushes into this source imperatively.
  attach() {
    // intentionally empty
  }

  detach() {
    this.reset();
  }

  reset() {
    this.moveX = 0;
    this.moveY = 0;
    this.sprintFromStick = false;
    this.pointerDeltaX = 0;
    this.pointerDeltaY = 0;
    this.holdJump = false;
    this.holdCrouch = false;
    this.holdFire = false;
    this.holdSprint = false;
    this.interactPressed = false;
    this.blockRemovePressed = false;
    this.blockPlacePressed = false;
    this.materialSlot1Pressed = false;
    this.materialSlot2Pressed = false;
  }

  setMoveVector(x: number, y: number, sprinting: boolean) {
    const clampedX = Math.max(-1, Math.min(1, x));
    const clampedY = Math.max(-1, Math.min(1, y));
    if (
      Math.abs(clampedX - this.moveX) > 0.001
      || Math.abs(clampedY - this.moveY) > 0.001
      || sprinting !== this.sprintFromStick
    ) {
      this.activityId += 1;
    }
    this.moveX = clampedX;
    this.moveY = clampedY;
    this.sprintFromStick = sprinting;
  }

  addLookDelta(dxPx: number, dyPx: number) {
    if (dxPx === 0 && dyPx === 0) return;
    this.pointerDeltaX += dxPx;
    this.pointerDeltaY += dyPx;
    this.activityId += 1;
  }

  setHold(name: HoldButton, pressed: boolean) {
    switch (name) {
      case 'jump':
        if (this.holdJump !== pressed) this.activityId += 1;
        this.holdJump = pressed;
        break;
      case 'crouch':
        if (this.holdCrouch !== pressed) this.activityId += 1;
        this.holdCrouch = pressed;
        break;
      case 'firePrimary':
        if (this.holdFire !== pressed) this.activityId += 1;
        this.holdFire = pressed;
        break;
      case 'sprint':
        if (this.holdSprint !== pressed) this.activityId += 1;
        this.holdSprint = pressed;
        break;
    }
  }

  pulseEdge(name: EdgeButton) {
    switch (name) {
      case 'interact':
        this.interactPressed = true;
        break;
      case 'blockRemove':
        this.blockRemovePressed = true;
        break;
      case 'blockPlace':
        this.blockPlacePressed = true;
        break;
      case 'mat1':
        this.materialSlot1Pressed = true;
        break;
      case 'mat2':
        this.materialSlot2Pressed = true;
        break;
    }
    this.activityId += 1;
  }

  sample(context: InputContext): ActionSnapshot {
    // Drain accumulated pointer delta into look radians, mirroring keyboardMouse.ts:96-99.
    const lookX = -this.pointerDeltaX * TOUCH_LOOK_SENSITIVITY;
    const lookY = -this.pointerDeltaY * TOUCH_LOOK_SENSITIVITY;
    this.pointerDeltaX = 0;
    this.pointerDeltaY = 0;

    const sprinting = context === 'onFoot' && (this.sprintFromStick || this.holdSprint);
    const throttle = context === 'vehicle' ? Math.max(0, this.moveY) : Math.max(0, this.moveY);
    const brake = context === 'vehicle' ? Math.max(0, -this.moveY) : 0;
    const steer = this.moveX;

    const snapshot: ActionSnapshot = {
      family: 'touch',
      activityId: this.activityId,
      moveX: this.moveX,
      moveY: this.moveY,
      lookX,
      lookY,
      steer,
      throttle,
      brake,
      jump: context === 'onFoot' && this.holdJump,
      sprint: sprinting,
      crouch: context === 'onFoot' && this.holdCrouch,
      firePrimary: context === 'onFoot' && this.holdFire,
      firePrimaryValue: context === 'onFoot' && this.holdFire ? 1 : 0,
      handbrake: context === 'vehicle' && this.holdJump,
      interactPressed: this.interactPressed,
      resetVehiclePressed: false,
      blockRemovePressed: context === 'onFoot' && this.blockRemovePressed,
      blockPlacePressed: context === 'onFoot' && this.blockPlacePressed,
      materialSlot1Pressed: context === 'onFoot' && this.materialSlot1Pressed,
      materialSlot2Pressed: context === 'onFoot' && this.materialSlot2Pressed,
    };

    // Edge-triggered flags auto-clear after each sample (matches keyboardMouse.ts:125-129).
    this.interactPressed = false;
    this.blockRemovePressed = false;
    this.blockPlacePressed = false;
    this.materialSlot1Pressed = false;
    this.materialSlot2Pressed = false;

    return snapshot;
  }
}

// Module-level singleton shared between GameInputManager and the MobileHUD React component
// so we don't have to thread a ref through the scene tree.
export const touchInputSource = new TouchInputSource();
