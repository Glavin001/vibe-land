import { describe, expect, it } from 'vitest';

import { DustSourceQueue, type DustSource } from './destructionEvents';
import { DustImpactDetector } from './dustImpacts';

function drained(queue: DustSourceQueue): DustSource[] {
  const out: DustSource[] = [];
  queue.drain((s) => out.push({ ...s }));
  return out;
}

describe('DustImpactDetector', () => {
  it('raises an impact where a falling body was stopped, on its underside', () => {
    const d = new DustImpactDetector();
    const q = new DustSourceQueue();
    expect(d.noteVelocity(7, 1, 10, 0, 5, 0, 0, -9, 0, 1000, 1.5, 100, q)).toBe(false);
    expect(d.noteVelocity(7, 1, 12, 0, 2, 0, 0, -0.5, 0, 1000, 1.5, 133, q)).toBe(true);
    const [s] = drained(q);
    expect(s.kind).toBe('impact');
    // Stopped from below: the contact is under the body; near the ground it is the ground.
    expect(s.y).toBeCloseTo(0.3);
    expect(s.ny).toBe(1);
    expect(s.magnitude).toBeCloseTo((1000 * 8.5) / 4000);
    expect(d.impactedRecently(7, 500)).toBe(true);
    expect(d.impactedRecently(7, 2000)).toBe(false);
  });

  it('puts a mid-air stop against the thing that stopped it', () => {
    const d = new DustImpactDetector();
    const q = new DustSourceQueue();
    d.noteVelocity(7, 1, 10, 0, 20, 0, 6, 0, 0, 1000, 1, 100, q);
    d.noteVelocity(7, 1, 12, 1, 20, 0, 0.5, 0, 0, 1000, 1, 133, q);
    const [s] = drained(q);
    expect(s.y).toBeCloseTo(20);
    expect(s.x).toBeCloseTo(1 + 1); // back along Δv (−x) means +x side... contact = x − ux·r, ux = −1
    expect(s.nx).toBeCloseTo(-1);
  });

  it('ignores a slow body, a small change, a speed-up, and a repeat within the cooldown', () => {
    const d = new DustImpactDetector();
    const q = new DustSourceQueue();
    d.noteVelocity(1, 1, 1, 0, 5, 0, 0, -1, 0, 100, 1, 0, q);
    expect(d.noteVelocity(1, 1, 2, 0, 5, 0, 0, 0, 0, 100, 1, 33, q)).toBe(false); // slow before
    d.noteVelocity(2, 1, 1, 0, 5, 0, 0, -9, 0, 100, 1, 0, q);
    expect(d.noteVelocity(2, 1, 2, 0, 5, 0, 0, -7, 0, 100, 1, 33, q)).toBe(false); // lost only 2
    d.noteVelocity(3, 1, 1, 0, 5, 0, 0, -5, 0, 100, 1, 0, q);
    expect(d.noteVelocity(3, 1, 2, 0, 5, 0, 0, -15, 0, 100, 1, 33, q)).toBe(false); // sped up
    d.noteVelocity(4, 1, 1, 0, 5, 0, 0, -9, 0, 100, 1, 0, q);
    expect(d.noteVelocity(4, 1, 2, 0, 5, 0, 0, 0, 0, 100, 1, 33, q)).toBe(true);
    d.noteVelocity(4, 1, 3, 0, 5, 0, 0, -9, 0, 100, 1, 66, q);
    expect(d.noteVelocity(4, 1, 4, 0, 5, 0, 0, 0, 0, 100, 1, 100, q)).toBe(false); // cooldown
    expect(drained(q)).toHaveLength(1);
  });

  it('adds many impacts in one cell up to a wave, once per cooldown', () => {
    const d = new DustImpactDetector();
    const q = new DustSourceQueue();
    // Twenty 1 t bodies each losing 10 m/s within 300 ms in one 8 m cell: 200,000 kg·m/s.
    for (let i = 0; i < 20; i += 1) {
      d.noteVelocity(100 + i, 1, 10, i * 0.3, 6, 0, 0, -10, 0, 1000, 1, 100 + i * 10, q);
      d.noteVelocity(100 + i, 1, 12, i * 0.3, 2, 0, 0, 0, 0, 1000, 1, 110 + i * 10, q);
    }
    const sources = drained(q);
    const waves = sources.filter((s) => s.kind === 'wave');
    expect(waves).toHaveLength(1);
    expect(waves[0].magnitude).toBeGreaterThanOrEqual(100_000 / 4000);
    expect(waves[0].y).toBeCloseTo(0.3);
    expect(sources.filter((s) => s.kind === 'impact')).toHaveLength(20);
    expect(d.wavesRaised).toBe(1);
  });
});
