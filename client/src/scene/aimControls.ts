import type { DeviceFamily } from '../input/types';

export function canUseScopedAim(
  activeFamily: DeviceFamily | null,
  pointerLocked: boolean,
  isDriving: boolean,
  isDead: boolean,
  botAutopilotEnabled: boolean = false,
  agentDriveActive: boolean = false,
): boolean {
  if (isDriving || isDead) {
    return false;
  }
  return botAutopilotEnabled
    || agentDriveActive
    || pointerLocked
    || activeFamily === 'gamepad'
    || activeFamily === 'touch';
}
