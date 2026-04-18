import { describe, expect, it } from 'vitest';
import {
  computeTurnAwareCost,
  SOFT_TURN_WEIGHT,
  TIGHT_TURN_PENALTY_BIAS,
  TIGHT_TURN_PENALTY_SCALE,
} from './vehicleQueryFilter';

type V3 = readonly [number, number, number];

describe('computeTurnAwareCost', () => {
  const turningRadius = 5;

  it('returns the raw Euclidean cost on a straight segment', () => {
    // pa → center → pb are collinear. θ=0 so sinHalf≈0 → early return.
    const pa: V3 = [0, 0, 0];
    const center: V3 = [0, 0, 5];
    const pb: V3 = [0, 0, 10];
    const cost = computeTurnAwareCost(pa, pb, center, turningRadius);
    expect(cost).toBeCloseTo(10, 5);
  });

  it('applies a small soft penalty on a gentle curve', () => {
    // Symmetric V that threads a wide corner — segmentLen well above the
    // turning radius limit so we should hit the soft-cost branch only.
    const pa: V3 = [0, 0, 0];
    const center: V3 = [0, 0, 20];
    const pb: V3 = [4, 0, 40];
    const cost = computeTurnAwareCost(pa, pb, center, turningRadius);
    const base = Math.hypot(4, 0, 40);
    // Soft weight scales θ/π ∈ [0, 1] by SOFT_TURN_WEIGHT=0.3.
    expect(cost).toBeGreaterThan(base);
    expect(cost).toBeLessThan(base * (1 + SOFT_TURN_WEIGHT));
  });

  it('applies the hard penalty on a sharp 90° corner', () => {
    // pa approaches from −Z, pb exits along +X through a tight corner.
    // Short segments keep segmentLen below what a 5 m turning radius
    // can physically execute.
    const pa: V3 = [0, 0, -2];
    const center: V3 = [0, 0, 0];
    const pb: V3 = [2, 0, 0];
    const cost = computeTurnAwareCost(pa, pb, center, turningRadius);
    const base = Math.hypot(2 - 0, 0, 0 - (-2));
    // Hard-penalty branch: base * 100 + 50.
    expect(cost).toBeCloseTo(
      base * TIGHT_TURN_PENALTY_SCALE + TIGHT_TURN_PENALTY_BIAS,
      5,
    );
  });

  it('does not apply the hard penalty when segments are long enough for the chassis', () => {
    // Same 90° bend, but with 20 m approach/exit — requiredRadius ≈ 20/sin(45°)
    // ≈ 28.3 m, well above turningRadius=5.
    const pa: V3 = [0, 0, -20];
    const center: V3 = [0, 0, 0];
    const pb: V3 = [20, 0, 0];
    const cost = computeTurnAwareCost(pa, pb, center, turningRadius);
    const base = Math.hypot(20, 0, 20);
    // Should land in the soft branch — roughly base + 15% (θ=π/2).
    expect(cost).toBeGreaterThan(base);
    expect(cost).toBeLessThan(base * (1 + SOFT_TURN_WEIGHT));
  });

  it('is safe on a zero-length approach or exit vector', () => {
    // pa === center → inLen=0 → should not produce NaN; falls back to base.
    const pa: V3 = [5, 0, 0];
    const center: V3 = [5, 0, 0];
    const pb: V3 = [10, 0, 0];
    const cost = computeTurnAwareCost(pa, pb, center, turningRadius);
    expect(cost).toBeCloseTo(5, 5);
  });
});
