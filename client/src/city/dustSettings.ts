/**
 * Whether the /city destruction dust is on, and its caps.
 *
 * Per-viewer and remembered locally, like the cannonball toggle. The URL wins
 * for a session so a perf sweep or a bug report can pin it:
 *   /city?dust=0        off
 *   /city?dust=1        on, whatever the tier or the stored choice
 *   /city?dustCap=N     live parcel capacity (default 4096)
 *   /city?dustTick=N    parcels one server tick may spawn (default 48)
 *
 * The data side (extraction, policy, store) is tier-agnostic; how the parcels
 * are drawn is the renderer's business (see app/renderQuality.ts dustMode).
 */

const STORAGE_KEY = 'vibe.city.dust';

type Listener = () => void;

const listeners = new Set<Listener>();

const params = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '');
  } catch {
    return new URLSearchParams();
  }
})();

function readStored(): boolean {
  try {
    const stored = localStorage?.getItem(STORAGE_KEY);
    return stored === null ? true : stored === '1';
  } catch {
    return true;
  }
}

const urlDust = params.get('dust');
/** The URL pins the choice for the session; the toggle still works but is not remembered. */
const pinnedByUrl = urlDust === '0' || urlDust === '1';
let enabled = pinnedByUrl ? urlDust === '1' : readStored();

function positiveInt(name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Live parcel capacity. Read once at load. */
export const DUST_CAPACITY_OVERRIDE: number | null = params.has('dustCap') ? positiveInt('dustCap', 4096) : null;
/** Per-tick spawn cap. Read once at load. */
export const DUST_TICK_CAP_OVERRIDE: number | null = params.has('dustTick') ? positiveInt('dustTick', 48) : null;

export function dustEnabled(): boolean {
  return enabled;
}

export function dustForcedByUrl(): boolean {
  return pinnedByUrl;
}

export function setDustEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  if (!pinnedByUrl) {
    try {
      localStorage?.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      // Not remembered; not fatal.
    }
  }
  for (const listener of listeners) listener();
}

/** Subscribe to changes; returns the unsubscribe. */
export function onDustChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
