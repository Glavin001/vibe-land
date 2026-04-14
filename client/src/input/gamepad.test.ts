import { describe, expect, it } from 'vitest';
import { applyRadialDeadzone, shapeLookAxis, shapeLookAxisWithExponent } from './gamepad';

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

describe('shapeLookAxisWithExponent', () => {
  it('is linear when exponent is 1', () => {
    expect(shapeLookAxisWithExponent(0.5, 1)).toBeCloseTo(0.5);
    expect(shapeLookAxisWithExponent(-0.3, 1)).toBeCloseTo(-0.3);
  });

  it('matches shapeLookAxis when exponent is 2', () => {
    expect(shapeLookAxisWithExponent(0.5, 2)).toBeCloseTo(shapeLookAxis(0.5));
    expect(shapeLookAxisWithExponent(-0.7, 2)).toBeCloseTo(shapeLookAxis(-0.7));
  });

  it('is more aggressive near center with larger exponents', () => {
    // At the same small input, exponent 3 should produce a smaller magnitude
    // than exponent 2 (more precision near center).
    const e2 = Math.abs(shapeLookAxisWithExponent(0.3, 2));
    const e3 = Math.abs(shapeLookAxisWithExponent(0.3, 3));
    expect(e3).toBeLessThan(e2);
  });

  it('reaches 1.0 at full deflection for any exponent', () => {
    expect(shapeLookAxisWithExponent(1, 1)).toBeCloseTo(1);
    expect(shapeLookAxisWithExponent(1, 2)).toBeCloseTo(1);
    expect(shapeLookAxisWithExponent(1, 3)).toBeCloseTo(1);
    expect(shapeLookAxisWithExponent(-1, 2.5)).toBeCloseTo(-1);
  });
});
