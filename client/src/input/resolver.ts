import { BTN_CROUCH, BTN_JUMP, BTN_RELOAD, BTN_SPRINT, MAX_MACHINE_CHANNELS } from '../net/protocol';
import type { ActionSnapshot, ResolvedGameInput } from './types';

export type SnapMachineBinding = {
  action: string;
  posKey: string;
  negKey: string | null;
  scale: number;
};

export const LOOK_PITCH_MIN = -Math.PI / 2 + 0.01;
export const LOOK_PITCH_MAX = Math.PI / 2 - 0.01;
export const VEHICLE_CAMERA_PITCH_MIN = -0.35;
export const VEHICLE_CAMERA_PITCH_MAX = 0.6;
export const VEHICLE_CAMERA_DEFAULT_PITCH = 0.15;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeAxis(value: number): number {
  return clamp(value, -1, 1);
}

export function advanceLookAngles(yaw: number, pitch: number, action: ActionSnapshot | null): { yaw: number; pitch: number } {
  if (!action) {
    return { yaw, pitch };
  }
  return {
    yaw: yaw + action.lookX,
    pitch: clamp(pitch + action.lookY, LOOK_PITCH_MIN, LOOK_PITCH_MAX),
  };
}

export function advanceVehicleCamera(
  orbitYaw: number,
  orbitPitch: number,
  action: ActionSnapshot | null,
  idleMs: number,
  deltaSec: number,
): { orbitYaw: number; orbitPitch: number; hadLookInput: boolean } {
  const hadLookInput = Boolean(action && (Math.abs(action.lookX) > 0.0001 || Math.abs(action.lookY) > 0.0001));
  let nextYaw = orbitYaw + (action?.lookX ?? 0);
  let nextPitch = clamp(orbitPitch + (action?.lookY ?? 0), VEHICLE_CAMERA_PITCH_MIN, VEHICLE_CAMERA_PITCH_MAX);

  if (!hadLookInput && idleMs > 300) {
    const yawStep = 2.5 * deltaSec;
    const pitchStep = 1.5 * deltaSec;
    nextYaw = moveToward(nextYaw, 0, yawStep);
    nextPitch = moveToward(nextPitch, VEHICLE_CAMERA_DEFAULT_PITCH, pitchStep);
  }

  return {
    orbitYaw: nextYaw,
    orbitPitch: nextPitch,
    hadLookInput,
  };
}

function moveToward(current: number, target: number, maxStep: number): number {
  if (Math.abs(target - current) <= maxStep) return target;
  return current + Math.sign(target - current) * maxStep;
}

export function resolveOnFootInput(
  action: ActionSnapshot | null,
  yaw: number,
  pitch: number,
  activeFamily: ResolvedGameInput['activeFamily'],
): ResolvedGameInput {
  let buttons = 0;
  if (action?.jump) buttons |= BTN_JUMP;
  if (action?.sprint) buttons |= BTN_SPRINT;
  if (action?.crouch) buttons |= BTN_CROUCH;

  return {
    activeFamily,
    moveX: normalizeAxis(action?.moveX ?? 0),
    moveY: normalizeAxis(action?.moveY ?? 0),
    yaw,
    pitch,
    buttons,
    firePrimary: action?.firePrimary ?? false,
    interactPressed: action?.interactPressed ?? false,
    blockRemovePressed: action?.blockRemovePressed ?? false,
    blockPlacePressed: action?.blockPlacePressed ?? false,
    materialSlot1Pressed: action?.materialSlot1Pressed ?? false,
    materialSlot2Pressed: action?.materialSlot2Pressed ?? false,
  };
}

export function resolveVehicleInput(
  action: ActionSnapshot | null,
  yaw: number,
  pitch: number,
  activeFamily: ResolvedGameInput['activeFamily'],
): ResolvedGameInput {
  let buttons = 0;
  if (action?.handbrake) buttons |= BTN_JUMP;
  if (action?.resetVehiclePressed) buttons |= BTN_RELOAD;

  return {
    activeFamily,
    moveX: normalizeAxis(action?.steer ?? action?.moveX ?? 0),
    moveY: normalizeAxis((action?.throttle ?? 0) - (action?.brake ?? 0)),
    yaw,
    pitch,
    buttons,
    firePrimary: false,
    interactPressed: action?.interactPressed ?? false,
    blockRemovePressed: false,
    blockPlacePressed: false,
    materialSlot1Pressed: false,
    materialSlot2Pressed: false,
  };
}

/**
 * Build a `ResolvedGameInput` for a player operating a snap-machine.
 *
 * - `buttons` is clean — we don't repurpose the on-foot BTN_FORWARD
 *   bits, since they aren't meaningful while inside a machine.
 * - `machineChannels` is populated by reading raw key-down state
 *   through `keyDownQuery`, scaled to `-127..127`. Index order matches
 *   `actionChannels` (same order as `derive_action_channels` on the
 *   Rust side), which is what `InputCmd.machine_channels` expects.
 * - `interactPressed` still rides the action snapshot so the player
 *   can press E to exit.
 */
export function resolveSnapMachineInput(
  action: ActionSnapshot | null,
  yaw: number,
  pitch: number,
  activeFamily: ResolvedGameInput['activeFamily'],
  actionChannels: readonly string[],
  bindings: readonly SnapMachineBinding[],
  keyDownQuery: (code: string) => boolean,
): ResolvedGameInput {
  const channels = new Int8Array(MAX_MACHINE_CHANNELS);
  for (let idx = 0; idx < actionChannels.length && idx < MAX_MACHINE_CHANNELS; idx += 1) {
    const actionName = actionChannels[idx];
    const binding = bindings.find((b) => b.action === actionName);
    if (!binding) continue;
    let value = 0;
    if (keyDownQuery(binding.posKey)) value += 1;
    if (binding.negKey && keyDownQuery(binding.negKey)) value -= 1;
    channels[idx] = Math.max(-127, Math.min(127, Math.round(value * 127)));
  }

  return {
    activeFamily,
    moveX: 0,
    moveY: 0,
    yaw,
    pitch,
    buttons: 0,
    firePrimary: false,
    interactPressed: action?.interactPressed ?? false,
    blockRemovePressed: false,
    blockPlacePressed: false,
    materialSlot1Pressed: false,
    materialSlot2Pressed: false,
    machineChannels: channels,
  };
}
