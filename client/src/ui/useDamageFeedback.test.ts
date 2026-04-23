import { describe, expect, it } from 'vitest';
import { computeBodyLocalDirectionWeights } from './useDamageFeedback';

const VICTIM: [number, number, number] = [0, 1, 0];
const HALF_PI = Math.PI / 2;

describe('computeBodyLocalDirectionWeights', () => {
  it('puts attacker directly in front (yaw=0 faces +Z)', () => {
    const w = computeBodyLocalDirectionWeights([0, 1, 5], VICTIM, 0);
    expect(w.front).toBeGreaterThan(0.99);
    expect(w.back).toBe(0);
    expect(w.left).toBe(0);
    expect(w.right).toBe(0);
  });

  it('puts attacker directly behind when victim faces +Z and attacker is on -Z', () => {
    const w = computeBodyLocalDirectionWeights([0, 1, -5], VICTIM, 0);
    expect(w.back).toBeGreaterThan(0.99);
    expect(w.front).toBe(0);
    expect(w.left).toBe(0);
    expect(w.right).toBe(0);
  });

  it('puts attacker on the right when attacker is on +X and victim faces +Z', () => {
    const w = computeBodyLocalDirectionWeights([5, 1, 0], VICTIM, 0);
    expect(w.right).toBeGreaterThan(0.99);
    expect(w.left).toBe(0);
    expect(w.front).toBe(0);
    expect(w.back).toBe(0);
  });

  it('puts attacker on the left when attacker is on -X and victim faces +Z', () => {
    const w = computeBodyLocalDirectionWeights([-5, 1, 0], VICTIM, 0);
    expect(w.left).toBeGreaterThan(0.99);
    expect(w.right).toBe(0);
    expect(w.front).toBe(0);
    expect(w.back).toBe(0);
  });

  it('rotates with victim yaw — attacker on +X with victim facing +X is "front"', () => {
    const w = computeBodyLocalDirectionWeights([5, 1, 0], VICTIM, HALF_PI);
    expect(w.front).toBeGreaterThan(0.99);
    expect(w.back).toBe(0);
    expect(w.left).toBe(0);
    expect(w.right).toBe(0);
  });

  it('rotates with victim yaw — attacker on +Z with victim facing +X is "left"', () => {
    const w = computeBodyLocalDirectionWeights([0, 1, 5], VICTIM, HALF_PI);
    expect(w.left).toBeGreaterThan(0.99);
    expect(w.right).toBe(0);
    expect(w.front).toBe(0);
    expect(w.back).toBe(0);
  });

  it('blends weights for diagonal attackers', () => {
    const w = computeBodyLocalDirectionWeights([5, 1, 5], VICTIM, 0);
    expect(w.front).toBeGreaterThan(0.1);
    expect(w.right).toBeGreaterThan(0.1);
    expect(w.back).toBe(0);
    expect(w.left).toBe(0);
  });

  it('falls back to front bias when attacker is on top of victim', () => {
    const w = computeBodyLocalDirectionWeights([0, 1, 0], VICTIM, 0);
    expect(w.front).toBe(1);
    expect(w.back).toBe(0);
    expect(w.left).toBe(0);
    expect(w.right).toBe(0);
  });
});
