import {
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_SECONDARY_FIRE,
  BTN_RELOAD,
  angleToI16,
  i16ToAngle,
  type InputCmd,
} from '../net/protocol';

export function buildInputFromButtons(
  seq: number,
  _clientTick: number,
  buttons: number,
  yaw: number,
  pitch: number,
): InputCmd {
  const moveX = ((buttons & BTN_RIGHT) !== 0 ? 127 : 0) + ((buttons & BTN_LEFT) !== 0 ? -127 : 0);
  const moveY = ((buttons & BTN_FORWARD) !== 0 ? 127 : 0) + ((buttons & BTN_BACK) !== 0 ? -127 : 0);

  // Quantize yaw/pitch the same way the network encoding does (angleToI16 → i16ToAngle).
  // The server receives these quantized values, so the client must predict with them too,
  // otherwise the slight float→int16→float error causes persistent misprediction → jitter.
  const quantizedYaw = i16ToAngle(angleToI16(yaw));
  const quantizedPitch = i16ToAngle(angleToI16(pitch));

  return {
    seq,
    buttons: buttons & ~(BTN_SECONDARY_FIRE | BTN_RELOAD),
    moveX,
    moveY,
    yaw: quantizedYaw,
    pitch: quantizedPitch,
  };
}
