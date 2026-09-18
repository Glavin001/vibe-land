/**
 * Which shot the /city page fires.
 *
 * The rifle is a hitscan: the server traces a ray and the city loses bonds the
 * same tick, with nothing to watch. The cannonball is the shot the engine's own
 * destruction demos use -- a heavy sphere that leaves the muzzle, arcs, lands
 * and breaks whatever it lands on, because the native stage takes its loads
 * from contacts PhysX actually solved. Seeing the projectile is the point.
 *
 * Per-viewer and remembered locally, like the other overlay toggles. The server
 * is told per shot through the fire packet's existing `weapon` byte, so nothing
 * here needs a session, a round trip, or a protocol change.
 */

const STORAGE_KEY = 'vibe.city.cannonball';

type Listener = () => void;

const listeners = new Set<Listener>();

function readStored(): boolean {
  try {
    return localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    // Private windows and blocked site data both throw here. The shot mode is
    // a convenience, so failing to remember it is not worth failing over.
    return false;
  }
}

let enabled = readStored();

/** True when the next shot should be a thrown ball rather than a hitscan. */
export function cannonballEnabled(): boolean {
  return enabled;
}

export function setCannonballEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  try {
    localStorage?.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // See readStored.
  }
  for (const listener of listeners) listener();
}

/** Subscribe to changes; returns the unsubscribe. */
export function onCannonballChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
