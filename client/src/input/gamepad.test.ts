import { describe, expect, it } from 'vitest';
import { applyRadialDeadzone, shapeLookAxis } from './gamepad';

describe('applyRadialDeadzone', () => {
  it('zeroes values inside the deadzone', () => {
    expect(applyRadialDeadzone(0.05, -0.05, 0.18)).toEqual([0, 0]);
  });

  it('rescales values outside the deadzone', () => {
    const [x, y] = applyRadialDeadzone(0.5, 0, 0.18);
    expect(x).toBeGreaterThan(0.3);
    expect(y).toBe(0);
  });
});

describe('shapeLookAxis', () => {
  it('preserves sign and squares magnitude', () => {
    expect(shapeLookAxis(0.5)).toBeCloseTo(0.25);
    expect(shapeLookAxis(-0.5)).toBeCloseTo(-0.25);
  });
});
