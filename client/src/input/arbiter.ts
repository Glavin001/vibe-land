import type { ActionSnapshot, DeviceFamily } from './types';

export function hasMeaningfulInput(snapshot: ActionSnapshot | null): boolean {
  if (!snapshot) return false;
  return (
    Math.abs(snapshot.moveX) > 0.001
    || Math.abs(snapshot.moveY) > 0.001
    || Math.abs(snapshot.lookX) > 0.0001
    || Math.abs(snapshot.lookY) > 0.0001
    || Math.abs(snapshot.steer) > 0.001
    || snapshot.throttle > 0.001
    || snapshot.brake > 0.001
    || snapshot.jump
    || snapshot.sprint
    || snapshot.crouch
    || snapshot.firePrimary
    || snapshot.handbrake
    || snapshot.interactPressed
    || snapshot.blockRemovePressed
    || snapshot.blockPlacePressed
    || snapshot.materialSlot1Pressed
    || snapshot.materialSlot2Pressed
  );
}

export function pickActiveFamily(
  current: DeviceFamily | null,
  keyboardMouse: ActionSnapshot | null,
  gamepad: ActionSnapshot | null,
): DeviceFamily | null {
  const keyboardActive = hasMeaningfulInput(keyboardMouse);
  const gamepadActive = hasMeaningfulInput(gamepad);

  if (!keyboardActive && !gamepadActive) {
    return current;
  }
  if (!keyboardActive) {
    return 'gamepad';
  }
  if (!gamepadActive) {
    return 'keyboardMouse';
  }
  if (current === 'keyboardMouse' || current === 'gamepad') {
    const currentSnapshot = current === 'keyboardMouse' ? keyboardMouse : gamepad;
    const otherSnapshot = current === 'keyboardMouse' ? gamepad : keyboardMouse;
    if (otherSnapshot && currentSnapshot && otherSnapshot.activityId > currentSnapshot.activityId) {
      return current === 'keyboardMouse' ? 'gamepad' : 'keyboardMouse';
    }
    return current;
  }

  return (keyboardMouse?.activityId ?? 0) >= (gamepad?.activityId ?? 0) ? 'keyboardMouse' : 'gamepad';
}
