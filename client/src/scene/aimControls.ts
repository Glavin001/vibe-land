import type { DeviceFamily } from '../input/types';

export function canUseScopedAim(
  activeFamily: DeviceFamily | null,
  pointerLocked: boolean,
  isDead: boolean,
  botAutopilotEnabled: boolean = false,
): boolean {
  if (isDead) {
    return false;
  }
  return botAutopilotEnabled
    || pointerLocked
    || activeFamily === 'gamepad'
    || activeFamily === 'touch';
}
