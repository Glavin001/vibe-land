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
  handbrake: boolean;
  interactPressed: boolean;
  blockRemovePressed: boolean;
  blockPlacePressed: boolean;
  materialSlot1Pressed: boolean;
  materialSlot2Pressed: boolean;
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
  interactPressed: boolean;
  blockRemovePressed: boolean;
  blockPlacePressed: boolean;
  materialSlot1Pressed: boolean;
  materialSlot2Pressed: boolean;
};
