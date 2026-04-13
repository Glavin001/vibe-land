export type DeviceFamily = 'keyboardMouse' | 'gamepad';
export type InputFamilyMode = DeviceFamily | 'auto';

export type InputContext = 'onFoot' | 'vehicle' | 'snapMachine';

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
  resetVehiclePressed: boolean;
  blockRemovePressed: boolean;
  blockPlacePressed: boolean;
  materialSlot1Pressed: boolean;
  materialSlot2Pressed: boolean;
};

export type InputSample = {
  context: InputContext;
  activeFamily: DeviceFamily | null;
  action: ActionSnapshot | null;
  /// Human-readable name of the snap-machine the player is operating.
  /// Present only when `context === 'snapMachine'`.
  machineDisplayName?: string | null;
  /// Parsed snap-machine action → key bindings for the currently
  /// operated machine, so the HUD can render one hint row per action.
  /// Present only when `context === 'snapMachine'`.
  machineBindings?: ReadonlyArray<{
    action: string;
    posKey: string;
    negKey: string | null;
    scale: number;
  }>;
  /// Current per-action channel values (range `-127..127`) for the
  /// operated snap-machine, computed by `resolveSnapMachineInput`.
  /// The HUD lights hint rows based on these so the player can see
  /// keypresses register in real time.
  machineChannels?: Int8Array;
};

export type SemanticInputState = {
  moveX: number;
  moveY: number;
  yaw: number;
  pitch: number;
  buttons: number;
  /// Per-tick scalar values for the snap-machine actuator channels the
  /// player is currently driving. Index → action-name mapping is
  /// determined when the player enters a machine. Optional: zero-filled
  /// when not operating a machine.
  machineChannels?: Int8Array;
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
