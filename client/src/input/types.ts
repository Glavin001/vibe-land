export type DeviceFamily = 'keyboardMouse' | 'gamepad' | 'touch';
export type InputFamilyMode = DeviceFamily | 'auto';

export type InputContext = 'onFoot' | 'vehicle';

export type ActionSnapshot = {
  family: DeviceFamily;
  activityId: number;
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
  steer: number;
  throttle: number;
  brake: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  firePrimary: boolean;
  firePrimaryValue: number;
  aimSecondary: boolean;
  handbrake: boolean;
  interactPressed: boolean;
  resetVehiclePressed: boolean;
  blockRemovePressed: boolean;
  blockPlacePressed: boolean;
  materialSlot1Pressed: boolean;
  materialSlot2Pressed: boolean;
  meleePressed: boolean;
  /** Weapon switch this frame: +1 next, -1 previous, 0 none (scroll wheel, gamepad Y). */
  weaponSwitch: number;
  /** Weapon picked directly this frame, 1-based (number keys); 0 none. */
  weaponSlot: number;
  /** Reset the city this frame (R on foot; in a car R resets the car). */
  resetWorldPressed: boolean;
};

export type InputSample = {
  context: InputContext;
  activeFamily: DeviceFamily | null;
  action: ActionSnapshot | null;
};

export type SemanticInputState = {
  moveX: number;
  moveY: number;
  yaw: number;
  pitch: number;
  buttons: number;
};

export type ResolvedGameInput = SemanticInputState & {
  activeFamily: DeviceFamily | null;
  firePrimary: boolean;
  aimSecondary: boolean;
  interactPressed: boolean;
  blockRemovePressed: boolean;
  blockPlacePressed: boolean;
  materialSlot1Pressed: boolean;
  materialSlot2Pressed: boolean;
  meleePressed: boolean;
  weaponSwitch: number;
  weaponSlot: number;
  resetWorldPressed: boolean;
};
