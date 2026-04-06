import {
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_SECONDARY_FIRE,
  BTN_RELOAD,
  type InputCmd,
} from '../net/protocol';

export function buildInputFromButtons(
  seq: number,
  clientTick: number,
  buttons: number,
  yaw: number,
  pitch: number,
): InputCmd {
  const moveX = ((buttons & BTN_RIGHT) !== 0 ? 127 : 0) + ((buttons & BTN_LEFT) !== 0 ? -127 : 0);
  const moveY = ((buttons & BTN_FORWARD) !== 0 ? 127 : 0) + ((buttons & BTN_BACK) !== 0 ? -127 : 0);

  return {
    seq,
    clientTick,
    buttons: buttons & ~(BTN_SECONDARY_FIRE | BTN_RELOAD),
    moveX,
    moveY,
    yaw,
    pitch,
  };
}
