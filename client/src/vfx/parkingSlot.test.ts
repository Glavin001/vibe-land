import { describe, expect, it } from 'vitest';
import { ParkingSlot, type Parkable } from './parkingSlot';

function item(): Parkable & { resumed: number; disposed: number } {
  const it = {
    resumed: 0,
    disposed: 0,
    resume() { it.resumed += 1; },
    dispose() { it.disposed += 1; },
  };
  return it;
}

describe('ParkingSlot', () => {
  it('hands the parked item back, resumed, for the same key', () => {
    const slot = new ParkingSlot<ReturnType<typeof item>>();
    const a = item();
    slot.park(a, 'sun:30:120');
    expect(slot.take('sun:30:120')).toBe(a);
    expect(a.resumed).toBe(1);
    expect(a.disposed).toBe(0);
    expect(slot.occupied).toBe(false);
    expect(slot.take('sun:30:120')).toBeNull();
  });

  it('disposes on a key mismatch, on a second park and on clear', () => {
    const slot = new ParkingSlot<ReturnType<typeof item>>();
    const a = item();
    const b = item();
    const c = item();
    slot.park(a, 'k1');
    expect(slot.take('k2')).toBeNull();
    expect(a.disposed).toBe(1);
    slot.park(b, 'k1');
    slot.park(c, 'k1');
    expect(b.disposed).toBe(1);
    slot.clear();
    expect(c.disposed).toBe(1);
    expect(slot.occupied).toBe(false);
  });

  it('does not dispose an item parked twice', () => {
    const slot = new ParkingSlot<ReturnType<typeof item>>();
    const a = item();
    slot.park(a, 'k');
    slot.park(a, 'k');
    expect(a.disposed).toBe(0);
  });
});
