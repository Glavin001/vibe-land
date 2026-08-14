// Which weapon the local player is firing.
//
// Lives outside React because the shooter reads it inside a frame loop (where
// a re-render per shot would be wasteful) while the HUD needs to re-render
// when it changes. A tiny store with subscriptions serves both without either
// owning the other.

import { WEAPON_CANNON, WEAPON_HITSCAN } from '../net/sharedConstants';

export type WeaponMode = typeof WEAPON_HITSCAN | typeof WEAPON_CANNON;

export const WEAPON_LABELS: Record<number, string> = {
  [WEAPON_HITSCAN]: 'ray',
  [WEAPON_CANNON]: 'cannon',
};

let current: WeaponMode = WEAPON_HITSCAN;
const listeners = new Set<(weapon: WeaponMode) => void>();

export function getWeaponMode(): WeaponMode {
  return current;
}

export function setWeaponMode(weapon: WeaponMode): void {
  if (weapon === current) {
    return;
  }
  current = weapon;
  for (const listener of listeners) {
    listener(current);
  }
}

/** Cycle to the next weapon. Two today, so this is a toggle. */
export function cycleWeaponMode(): WeaponMode {
  setWeaponMode(current === WEAPON_HITSCAN ? WEAPON_CANNON : WEAPON_HITSCAN);
  return current;
}

export function subscribeWeaponMode(listener: (weapon: WeaponMode) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
