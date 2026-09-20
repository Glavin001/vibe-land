/**
 * Which shot the /city page fires.
 *
 * The rifle is a hitscan: the server traces a ray and the city loses bonds the
 * same tick, with nothing to watch. The cannonball is the shot the engine's own
 * destruction demos use -- a heavy sphere that leaves the muzzle, arcs, lands
 * and breaks whatever it lands on, because the native stage takes its loads
 * from contacts PhysX actually solved. Seeing the projectile is the point.
 *
 * The meteor is the cannonball's mechanism at a scale the cannon cannot reach:
 * the shot picks a point on the world, and a rock the size of a room falls onto
 * it from somewhere high and far outside the city, on a real ballistic arc the
 * server solves so it passes through that point. Where it comes from is not up
 * to the shooter.
 *
 * Per-viewer and remembered locally, like the other overlay toggles. The server
 * is told per shot through the fire packet's existing `weapon` byte, so nothing
 * here needs a session, a round trip, or a protocol change.
 */

import { WEAPON_CANNONBALL, WEAPON_HITSCAN, WEAPON_METEOR } from '../net/sharedConstants';

export type ShotMode = 'rifle' | 'cannonball' | 'meteor';

/** The button cycles through these in this order. */
export const SHOT_MODES: readonly ShotMode[] = ['rifle', 'cannonball', 'meteor'];

const STORAGE_KEY = 'vibe.city.shotMode';
/** The key the cannonball toggle used before there were three modes. */
const LEGACY_STORAGE_KEY = 'vibe.city.cannonball';

type Listener = () => void;

const listeners = new Set<Listener>();

function isShotMode(value: unknown): value is ShotMode {
  return value === 'rifle' || value === 'cannonball' || value === 'meteor';
}

function readStored(): ShotMode {
  try {
    const stored = localStorage?.getItem(STORAGE_KEY);
    if (isShotMode(stored)) return stored;
    return localStorage?.getItem(LEGACY_STORAGE_KEY) === '1' ? 'cannonball' : 'rifle';
  } catch {
    // Private windows and blocked site data both throw here. The shot mode is
    // a convenience, so failing to remember it is not worth failing over.
    return 'rifle';
  }
}

let mode: ShotMode = readStored();

export function shotMode(): ShotMode {
  return mode;
}

/** The fire packet's weapon byte for the current mode. */
export function shotWeapon(): number {
  switch (mode) {
    case 'cannonball':
      return WEAPON_CANNONBALL;
    case 'meteor':
      return WEAPON_METEOR;
    default:
      return WEAPON_HITSCAN;
  }
}

export function setShotMode(next: ShotMode): void {
  if (next === mode) return;
  mode = next;
  try {
    localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // See readStored.
  }
  for (const listener of listeners) listener();
}

/** The mode after `current` in the button's cycle. */
export function nextShotMode(current: ShotMode): ShotMode {
  const index = SHOT_MODES.indexOf(current);
  return SHOT_MODES[(index + 1) % SHOT_MODES.length];
}

/** True when the next shot should be a thrown ball rather than a hitscan. */
export function cannonballEnabled(): boolean {
  return mode === 'cannonball';
}

/** Kept for the e2e bridge: on selects the cannonball, off the rifle. */
export function setCannonballEnabled(next: boolean): void {
  setShotMode(next ? 'cannonball' : 'rifle');
}

/** Subscribe to changes; returns the unsubscribe. */
export function onShotModeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
