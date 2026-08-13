// Update-rate scheduling for distant chunks.

import { describe, expect, it } from 'vitest';

import { shouldUpdateThisFrame, updateStrideForDistanceSq } from './renderScheduling';

describe('updateStrideForDistanceSq', () => {
  it('never defers nearby bodies', () => {
    expect(updateStrideForDistanceSq(0)).toBe(1);
    expect(updateStrideForDistanceSq(39 * 39)).toBe(1);
  });

  it('defers further with distance', () => {
    expect(updateStrideForDistanceSq(50 * 50)).toBe(2);
    expect(updateStrideForDistanceSq(120 * 120)).toBe(4);
    expect(updateStrideForDistanceSq(500 * 500)).toBe(8);
  });

  it('is monotonic, so moving away never means updating more often', () => {
    let previous = 0;
    for (let d = 0; d < 400; d += 5) {
      const stride = updateStrideForDistanceSq(d * d);
      expect(stride).toBeGreaterThanOrEqual(previous);
      previous = stride;
    }
  });

  // NaN fails every `<` comparison, so a naive chain would fall through to the
  // largest stride and defer the chunks nearest the camera -- the exact
  // opposite of the intent.
  it('does not defer on a degenerate distance', () => {
    expect(updateStrideForDistanceSq(Number.NaN)).toBe(1);
    expect(updateStrideForDistanceSq(-1)).toBe(1);
  });
});

describe('shouldUpdateThisFrame', () => {
  it('always updates at stride 1', () => {
    for (let frame = 0; frame < 10; frame++) {
      expect(shouldUpdateThisFrame(frame, 12345, 1)).toBe(true);
    }
  });

  it('updates each body once per stride window', () => {
    for (const key of [0, 7, 2_147_483_649]) {
      const hits = [0, 1, 2, 3].filter((frame) => shouldUpdateThisFrame(frame, key, 4));
      expect(hits).toHaveLength(1);
    }
  });

  // If every deferred body updated on the same frame, the cost would spike
  // periodically rather than flatten -- worse for pacing than not deferring.
  it('spreads bodies across the stride window', () => {
    const frameOfKey = new Set<number>();
    for (let key = 0; key < 64; key++) {
      for (let frame = 0; frame < 8; frame++) {
        if (shouldUpdateThisFrame(frame, key, 8)) {
          frameOfKey.add(frame);
          break;
        }
      }
    }
    expect(frameOfKey.size).toBe(8);
  });
});
