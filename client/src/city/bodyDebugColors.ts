// Body-state debug colors: paint every chunk by its body's freeze-machine
// state instead of its structure color, so "why is this frozen / why won't
// this freeze / what did that shot wake" is visible on the rubble itself
// rather than inferred from aggregate counters.
//
// State comes from GET /match-stats/:id/bodies (pairs of [entity, state]),
// refreshed ~1 Hz only while the toggle is on. Chunks still bound to the
// client-side support body (intact structure and rooted stumps -- the server
// never streams either) have no per-body entry and take the STRUCTURE color.
// A streamed body MISSING from the server list is painted white: that is a
// client/server disagreement worth seeing.

import { Color } from 'three';

export const BODY_DEBUG_STATES: ReadonlyArray<{ code: number; label: string; css: string }> = [
  { code: 0, label: 'awake', css: '#ff5040' },
  { code: 1, label: 'quiet (admission pending)', css: '#ffcc33' },
  { code: 2, label: 'asleep', css: '#7ec8ff' },
  { code: 3, label: 'frozen', css: '#3a6bff' },
  { code: 4, label: 'foreign-blocked', css: '#ff4bd8' },
  { code: 5, label: 'structure / rooted', css: '#6f6f7d' },
  { code: 6, label: 'unknown to server', css: '#ffffff' },
  { code: 7, label: 'squeezed (penetrating)', css: '#ff8800' },
];

const STATE_STRUCTURE = 5;
const STATE_UNKNOWN = 6;
const STATE_AWAKE = 0;

const COLORS = new Map<number, Color>(
  BODY_DEBUG_STATES.map((state) => [state.code, new Color(state.css)]),
);

export const bodyDebug = {
  enabled: false,
  /// Bumped whenever `states` is replaced or the toggle flips, so the chunk
  /// layer knows to repaint everything once rather than per frame.
  version: 0,
  states: new Map<number, number>(),
};

/**
 * Which refresh we are on, and when each body was first seen missing from one.
 *
 * "Unknown to server" is meant to catch a client/server disagreement. Without
 * this it also caught the poll's own latency: a body promoted by a fresh
 * fracture cannot appear in a list fetched before it existed, so every newly
 * broken piece flashed white for up to a second on the way to its real colour.
 * A body only counts as unknown once it has survived a whole refresh without
 * the server naming it; until then it is drawn awake, which is what it is.
 */
let refreshGeneration = 0;
const unknownSince = new Map<number, number>();
/// Bound on the bookkeeping above: retired bodies are never queried again, so
/// their entries would otherwise accumulate for the life of the session.
const UNKNOWN_TRACKING_LIMIT = 4096;

export function setBodyDebugEnabled(enabled: boolean): void {
  bodyDebug.enabled = enabled;
  // Toggling the mode restarts the observation: bodies recorded as missing
  // during an earlier session of it would otherwise be judged unknown on their
  // first frame back, which is the same latency artefact one level up.
  unknownSince.clear();
  bodyDebug.version += 1;
}

export function setBodyDebugStates(pairs: Array<[number, number]>): void {
  bodyDebug.states.clear();
  for (const [entity, state] of pairs) {
    bodyDebug.states.set(entity, state);
  }
  refreshGeneration += 1;
  if (unknownSince.size > UNKNOWN_TRACKING_LIMIT) {
    unknownSince.clear();
  } else {
    for (const key of unknownSince.keys()) {
      if (bodyDebug.states.has(key)) {
        unknownSince.delete(key);
      }
    }
  }
  bodyDebug.version += 1;
}

/// Debug state code for a body key, or null when the mode is off.
export function bodyDebugStateCode(bodyKey: number, isSupportBody: boolean): number {
  if (isSupportBody) {
    return STATE_STRUCTURE;
  }
  const state = bodyDebug.states.get(bodyKey);
  if (state !== undefined) {
    return state;
  }
  const since = unknownSince.get(bodyKey);
  if (since === undefined) {
    unknownSince.set(bodyKey, refreshGeneration);
    return STATE_AWAKE;
  }
  return refreshGeneration > since ? STATE_UNKNOWN : STATE_AWAKE;
}

/// Color for a body key (entity), or null to keep the structure color.
export function bodyDebugColor(bodyKey: number, isSupportBody: boolean): Color | null {
  return COLORS.get(bodyDebugStateCode(bodyKey, isSupportBody)) ?? null;
}

/// Color for an already-resolved state code.
export function bodyDebugColorForCode(code: number): Color | null {
  return COLORS.get(code) ?? null;
}
