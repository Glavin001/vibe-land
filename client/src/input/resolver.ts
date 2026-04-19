import { BTN_CROUCH, BTN_JUMP, BTN_RELOAD, BTN_SPRINT } from '../net/protocol';
import type { ActionSnapshot, ResolvedGameInput } from './types';

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
    meleePressed: action?.meleePressed ?? false,
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
    meleePressed: false,
  };
}
