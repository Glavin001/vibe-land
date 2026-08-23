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

export function setBodyDebugEnabled(enabled: boolean): void {
  bodyDebug.enabled = enabled;
  bodyDebug.version += 1;
}

export function setBodyDebugStates(pairs: Array<[number, number]>): void {
  bodyDebug.states.clear();
  for (const [entity, state] of pairs) {
    bodyDebug.states.set(entity, state);
  }
  bodyDebug.version += 1;
}

/// Color for a body key (entity), or null to keep the structure color.
export function bodyDebugColor(bodyKey: number, isSupportBody: boolean): Color | null {
  if (isSupportBody) {
    return COLORS.get(5) ?? null;
  }
  const state = bodyDebug.states.get(bodyKey);
  return COLORS.get(state ?? 6) ?? null;
}
