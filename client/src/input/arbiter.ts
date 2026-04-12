import type { ActionSnapshot, DeviceFamily, InputFamilyMode } from './types';

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
  touch: ActionSnapshot | null = null,
): DeviceFamily | null {
  const candidates: Array<[DeviceFamily, ActionSnapshot | null]> = [
    ['keyboardMouse', keyboardMouse],
    ['gamepad', gamepad],
    ['touch', touch],
  ];
  const active = candidates.filter(([, snap]) => hasMeaningfulInput(snap));

  if (active.length === 0) {
    return current;
  }
  if (active.length === 1) {
    return active[0][0];
  }

  // Sticky: if the current family is still active, only switch when another
  // family has a strictly-newer activityId (matches the previous pairwise
  // behavior so rapid device flipping doesn't occur).
  const currentEntry = active.find(([family]) => family === current);
  if (currentEntry) {
    const currentId = currentEntry[1]!.activityId;
    let newest = currentEntry;
    for (const entry of active) {
      if (entry[0] === current) continue;
      if (entry[1]!.activityId > currentId && entry[1]!.activityId > newest[1]!.activityId) {
        newest = entry;
      }
    }
    return newest[0];
  }

  // No current (or current went inactive): pick the highest-activity family.
  let best = active[0];
  for (const entry of active) {
    if (entry[1]!.activityId > best[1]!.activityId) {
      best = entry;
    }
  }
  return best[0];
}

export function resolveActiveFamily(
  mode: InputFamilyMode,
  current: DeviceFamily | null,
  keyboardMouse: ActionSnapshot | null,
  gamepad: ActionSnapshot | null,
  touch: ActionSnapshot | null = null,
): DeviceFamily | null {
  if (mode !== 'auto') {
    return mode;
  }
  return pickActiveFamily(current, keyboardMouse, gamepad, touch);
}
