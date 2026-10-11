import { describe, expect, it } from 'vitest';
import { INPUT_PACE_CLOSE_SEC, inputClockRate } from './inputPacing';
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

  it('never runs the input clock backwards', () => {
    // A server far behind (a collapse at 30 Hz) holds a deep queue: the
    // client stops producing, it cannot unproduce.
    expect(inputClockRate({ depth: 200, target: 0 })).toBe(0);
  });

  it('resends at most what one QUIC datagram carries', () => {
    // RFC 9000 guarantees a 1,200-byte UDP payload.
    const frames = Array.from({ length: INPUT_BUNDLE_MAX_FRAMES }, (_, seq) => ({ seq, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 }));
    expect(encodeInputBundle(frames).length).toBeLessThanOrEqual(1200 - 45);
    expect(encodeInputBundle([...frames, frames[0]]).length).toBeGreaterThan(1200 - 45);
  });
});
