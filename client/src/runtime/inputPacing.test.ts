import { describe, expect, it } from 'vitest';
import { INPUT_PACE_CLOSE_SEC, INPUT_PACE_MAX_DEVIATION, inputClockRate } from './inputPacing';
import { INPUT_BUNDLE_MAX_FRAMES, encodeInputBundle } from '../net/protocol';

describe('vehicle input pacing (server VIBE_VEHICLE_INPUT_PACING)', () => {
  it('runs the input clock at real time without a report, or at the target', () => {
    expect(inputClockRate(null)).toBe(1);
    expect(inputClockRate({ depth: 3, target: 3 })).toBe(1);
  });

  it('closes a depth error over the pacing time constant', () => {
    // Three inputs short: three extra inputs over INPUT_PACE_CLOSE_SEC.
    const rate = inputClockRate({ depth: 0, target: 3 });
    expect((rate - 1) * 60 * INPUT_PACE_CLOSE_SEC).toBeCloseTo(3);
    expect(inputClockRate({ depth: 5, target: 3 })).toBeLessThan(1);
  });

  // Owner's choice (2026-10-11): the driver's own car moves at the input
  // clock's rate, so the correction stays within what a driver cannot see:
  // the Weber fraction for speed discrimination, about 5% (McKee 1981).
  // Unbounded, a 2 s outage stopped the clock (controls frozen 1.2 s) and a
  // tab stall ran it at 3.9x. Larger backlogs are dropped by the server.
  it('keeps the correction within the speed-discrimination threshold', () => {
    expect(INPUT_PACE_MAX_DEVIATION).toBe(0.05);
    expect(inputClockRate({ depth: 200, target: 0 })).toBeCloseTo(0.95);
    expect(inputClockRate({ depth: 0, target: 100 })).toBeCloseTo(1.05);
  });

  // Owner's choice (2026-10-11): when the server runs slow (a collapse at
  // 30 Hz), the world moves in slow motion; the driver's car follows it.
  it("runs at the server's simulation rate, corrected within the bound", () => {
    expect(inputClockRate({ depth: 4, target: 4 }, 0.5)).toBeCloseTo(0.5);
    expect(inputClockRate({ depth: 200, target: 0 }, 0.5)).toBeCloseTo(0.5 * 0.95);
    // Without a queue report there is nothing to pace: real time.
    expect(inputClockRate(null, 0.5)).toBe(1);
  });

  it('resends at most what one QUIC datagram carries', () => {
    // RFC 9000 guarantees a 1,200-byte UDP payload.
    const frames = Array.from({ length: INPUT_BUNDLE_MAX_FRAMES }, (_, seq) => ({ seq, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 }));
    expect(encodeInputBundle(frames).length).toBeLessThanOrEqual(1200 - 45);
    expect(encodeInputBundle([...frames, frames[0]]).length).toBeGreaterThan(1200 - 45);
  });
});
