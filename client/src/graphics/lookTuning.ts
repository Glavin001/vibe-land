// Live knobs for the parts of the lighting that can only be judged by looking.
//
// Fog density, AO strength and skylight intensity are all perceptual calls with
// no computable answer, and all three interact -- fog washes out the same
// distant contrast that AO is drawing, and the skylight sets the level both are
// judged against. Rebuilding the client between candidates makes them
// incomparable for a reason that has nothing to do with the values: the spawn
// point moves, and in a 21 m street grid at this fog density, which way the
// camera happens to face matters more than any of these numbers.
//
// So they are a store rather than constants: one session, camera parked, sweep
// the grid. `e2eBridge.setLook` drives it from a harness and the committed
// defaults are whatever that sweep picked.

type LookTuning = {
  /** Exponent on the SSAO term. Higher = deeper, harder contact shadows. */
  aoStrength: number;
  /** SSAO sample radius in metres -- roughly the size of crevice it can see. */
  aoRadius: number;
  /** Multiplier on the sky environment map's contribution. */
  envIntensity: number;
};

/**
 * Defaults, chosen from the sweep in `city-look-tuning.spec.ts`.
 *
 * `aoStrength` came down from 1.5. On a city built entirely of hard edges, an
 * exponent that high draws a dark line along every one of them, which reads as
 * an outline round each chunk rather than as contact shading -- and it fights
 * the whole point of the rest-space texturing, which is that a wall should NOT
 * look like a mosaic of separate panels.
 */
const state: LookTuning = {
  aoStrength: 0.9,
  aoRadius: 1.0,
  envIntensity: 1,
};

const listeners = new Set<(next: LookTuning) => void>();

export function lookTuning(): LookTuning {
  return state;
}

export function setLookTuning(next: Partial<LookTuning>): void {
  let changed = false;
  for (const key of Object.keys(next) as Array<keyof LookTuning>) {
    const value = next[key];
    if (typeof value === 'number' && Number.isFinite(value) && state[key] !== value) {
      state[key] = value;
      changed = true;
    }
  }
  if (!changed) return;
  for (const listener of listeners) listener(state);
}

export function subscribeLookTuning(listener: (next: LookTuning) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
