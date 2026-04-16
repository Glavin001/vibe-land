import {
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_SECONDARY_FIRE,
  MAX_MACHINE_CHANNELS,
  angleToI16,
  i16ToAngle,
  type InputCmd,
} from '../net/protocol';
import type { SemanticInputState } from '../input/types';

function axisToMove(value: number): number {
  return Math.max(-127, Math.min(127, Math.round(value * 127)));
}

function applyAxisButtons(moveX: number, moveY: number, buttons: number): number {
  let nextButtons = buttons;
  if (moveX > 0) nextButtons |= BTN_RIGHT;
  if (moveX < 0) nextButtons |= BTN_LEFT;
  if (moveY > 0) nextButtons |= BTN_FORWARD;
  if (moveY < 0) nextButtons |= BTN_BACK;
  return nextButtons;
}

export function buildInputFromState(
  seq: number,
  _clientTick: number,
  state: SemanticInputState,
): InputCmd {
  const moveX = axisToMove(state.moveX);
  const moveY = axisToMove(state.moveY);

  // Quantize yaw/pitch the same way the network encoding does (angleToI16 → i16ToAngle).
  // The server receives these quantized values, so the client must predict with them too,
  // otherwise the slight float→int16→float error causes persistent misprediction → jitter.
  const quantizedYaw = i16ToAngle(angleToI16(state.yaw));
  const quantizedPitch = i16ToAngle(angleToI16(state.pitch));

  const machineChannels = state.machineChannels
    ? new Int8Array(state.machineChannels)
    : new Int8Array(MAX_MACHINE_CHANNELS);
  return {
    seq,
    buttons: applyAxisButtons(moveX, moveY, state.buttons) & ~BTN_SECONDARY_FIRE,
    moveX,
    moveY,
    yaw: quantizedYaw,
    pitch: quantizedPitch,
    machineChannels,
  };
}

export function buildInputFromButtons(
  seq: number,
  clientTick: number,
  buttons: number,
  yaw: number,
  pitch: number,
): InputCmd {
  const moveX = ((buttons & BTN_RIGHT) !== 0 ? 1 : 0) + ((buttons & BTN_LEFT) !== 0 ? -1 : 0);
  const moveY = ((buttons & BTN_FORWARD) !== 0 ? 1 : 0) + ((buttons & BTN_BACK) !== 0 ? -1 : 0);
  return buildInputFromState(seq, clientTick, {
    moveX,
    moveY,
    yaw,
    pitch,
    buttons,
  });
}
