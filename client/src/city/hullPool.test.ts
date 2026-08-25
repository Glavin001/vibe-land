import { describe, expect, it } from 'vitest';

import { buildHullPool, patternRadius } from './hullPool';

/** A shard of roughly `radius`, distinct per `seed`. */
function shard(seed: number, radius: number): { key: string; points: Float32Array } {
  const points = new Float32Array(8 * 3);
  for (let i = 0; i < 8; i += 1) {
    const t = (seed * 13 + i * 7) % 360;
    points[i * 3] = Math.cos((t * Math.PI) / 180) * radius;
    points[i * 3 + 1] = ((i % 3) - 1) * radius * 0.5;
    points[i * 3 + 2] = Math.sin((t * Math.PI) / 180) * radius;
  }
  return { key: `shard-${seed}`, points };
}

function pool(hullSlots: number[], poolSize: number, radius = (slot: number) => 0.4 + slot * 0.01) {
  return buildHullPool({
    // Sized from the slots themselves. A typed array silently drops writes past
    // its end, so a fixed size here would make out-of-range slots read back as
    // `undefined` and quietly pass assertions they should fail.
    slotCount: Math.max(8, ...hullSlots.map((slot) => slot + 1)),
    hullSlots,
    shapeOf: (slot) => shard(slot, 0.5),
    radiusOf: radius,
    poolSize,
  });
}

describe('buildHullPool', () => {
  it('assigns nothing when pooling is off, so the caller draws real hulls', () => {
    const result = pool([1, 2, 3], 0);
    expect(result.patterns).toHaveLength(0);
    expect([...result.patternOfSlot].every((v) => v === -1)).toBe(true);
  });

  it('never hands out more patterns than there are distinct shards', () => {
    // Asking for 50 out of 3 must not fabricate shapes, or index past the end.
    const result = pool([1, 2, 3], 50);
    expect(result.patterns).toHaveLength(3);
  });

  it('caps the library at the requested size', () => {
    const slots = Array.from({ length: 40 }, (_, i) => i);
    expect(pool(slots, 8).patterns).toHaveLength(8);
  });

  it('leaves box slots untouched', () => {
    const result = pool([2, 4], 2);
    // Only the two hull slots are claimed; everything else stays unassigned.
    expect(result.patternOfSlot[2]).toBeGreaterThanOrEqual(0);
    expect(result.patternOfSlot[4]).toBeGreaterThanOrEqual(0);
    expect(result.patternOfSlot[3]).toBe(-1);
  });

  it('scales each pattern to the radius of the chunk it replaces', () => {
    // The substitution must not change how big anything looks: pattern radius
    // times the assigned scale has to come back to the chunk's own radius.
    const slots = Array.from({ length: 20 }, (_, i) => i);
    const result = pool(slots, 4);
    for (const slot of slots) {
      const pattern = result.patterns[result.patternOfSlot[slot]];
      const drawn = patternRadius(pattern.points) * result.scaleOfSlot[slot];
      expect(drawn).toBeCloseTo(0.4 + slot * 0.01, 5);
    }
  });

  it('is stable across builds, so two pool sizes can be compared by eye', () => {
    const slots = Array.from({ length: 30 }, (_, i) => i);
    expect([...pool(slots, 6).patternOfSlot]).toEqual([...pool(slots, 6).patternOfSlot]);
  });

  it('spreads slots across the whole library rather than favouring one', () => {
    const slots = Array.from({ length: 400 }, (_, i) => i);
    const result = pool(slots, 8);
    const used = new Set(slots.map((slot) => result.patternOfSlot[slot]));
    expect(used.size).toBe(8);
  });

  it('samples the library across the shard list, not off the front', () => {
    // The manifest is ordered structure by structure, so taking the first N
    // would draw every pattern from one corner of one building.
    const slots = Array.from({ length: 100 }, (_, i) => i);
    const keys = pool(slots, 4).patterns.map((p) => p.key);
    expect(keys).toEqual(['shard-0', 'shard-25', 'shard-50', 'shard-75']);
  });

  it('survives a degenerate shard instead of scaling a chunk to infinity', () => {
    const result = buildHullPool({
      slotCount: 8,
      hullSlots: [0, 1],
      // A single collapsed point set has radius 0 and must not become a divisor.
      shapeOf: (slot) => (slot === 0
        ? { key: 'flat', points: new Float32Array(12) }
        : shard(1, 0.5)),
      radiusOf: () => 0.4,
      poolSize: 2,
    });
    expect(result.patterns).toHaveLength(1);
    for (const slot of [0, 1]) {
      expect(Number.isFinite(result.scaleOfSlot[slot])).toBe(true);
      expect(result.scaleOfSlot[slot]).toBeGreaterThan(0);
    }
  });

  it('handles a city with no hulls at all', () => {
    const result = pool([], 16);
    expect(result.patterns).toHaveLength(0);
  });
});
