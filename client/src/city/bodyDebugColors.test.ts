// The "unknown to server" state must mean a real client/server disagreement,
// not the body-state poll's own latency. Before this, a body promoted by a
// fresh fracture could not appear in a list fetched before it existed, so
// every newly broken chunk flashed white for up to a second.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  bodyDebugStateCode,
  setBodyDebugEnabled,
  setBodyDebugStates,
} from './bodyDebugColors';

const AWAKE = 0;
const FROZEN = 3;
const STRUCTURE = 5;
const UNKNOWN = 6;

describe('body debug state codes', () => {
  beforeEach(() => {
    // Toggling the mode is the documented reset for its observation state.
    setBodyDebugEnabled(false);
    setBodyDebugStates([]);
  });

  it('draws a body the server has not reported yet as awake, not unknown', () => {
    setBodyDebugStates([[100, FROZEN]]);
    // 200 was promoted after that list was fetched.
    expect(bodyDebugStateCode(200, false)).toBe(AWAKE);
  });

  it('calls a body unknown once it has survived a whole refresh unnamed', () => {
    setBodyDebugStates([[100, FROZEN]]);
    expect(bodyDebugStateCode(200, false)).toBe(AWAKE);
    // A fresh list still does not mention it: now it is a real disagreement.
    setBodyDebugStates([[100, FROZEN]]);
    expect(bodyDebugStateCode(200, false)).toBe(UNKNOWN);
  });

  it('clears the suspicion as soon as the server names the body', () => {
    setBodyDebugStates([]);
    expect(bodyDebugStateCode(200, false)).toBe(AWAKE);
    setBodyDebugStates([]);
    expect(bodyDebugStateCode(200, false)).toBe(UNKNOWN);
    setBodyDebugStates([[200, FROZEN]]);
    expect(bodyDebugStateCode(200, false)).toBe(FROZEN);
    // And having once been unknown must not make it unknown again later.
    setBodyDebugStates([[200, FROZEN]]);
    expect(bodyDebugStateCode(200, false)).toBe(FROZEN);
  });

  it('still reports the server state verbatim, and support bodies as structure', () => {
    setBodyDebugStates([[7, FROZEN]]);
    expect(bodyDebugStateCode(7, false)).toBe(FROZEN);
    expect(bodyDebugStateCode(7, true)).toBe(STRUCTURE);
  });
});
