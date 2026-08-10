// Behavior tests for the presentation port, mirroring the semantics of
// destruction-codec/src/presentation.rs (interpolation exactness, bounded
// class-aware extrapolation, quiescent freeze, correction continuity+decay,
// discontinuity snap).

import { describe, expect, it } from 'vitest';

import {
  MotionSnapshot,
  PresentationClass,
  PresentationTrack,
  PresentationConfig,
} from './presentation';

const config = (overrides: Partial<PresentationConfig> = {}): PresentationConfig => ({
  interpolationDelayTicks: 0,
  maxExtrapolationTicks: 4,
  correctionSeconds: 0.5,
  dt: 1,
  gravity: [0, -10, 0],
  snapDistanceMeters: 5,
  ...overrides,
});

const snap = (
  tick: number,
  x: number,
  vx = 0,
  klass: PresentationClass = PresentationClass.ContactActive,
): MotionSnapshot => ({
  tick,
  position: [x, 0, 0],
  rotation: [0, 0, 0, 1],
  linearVelocity: [vx, 0, 0],
  angularVelocity: [0, 0, 0],
  class: klass,
});

describe('PresentationTrack', () => {
  it('is exact at snapshot ticks and smooth between', () => {
    const track = new PresentationTrack(config());
    track.push(snap(0, 0, 1));
    track.push(snap(2, 2, 1));
    expect(track.sample(0).position[0]).toBeCloseTo(0, 5);
    const mid = track.sample(1).position[0];
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(1.5);
    expect(track.sample(2).position[0]).toBeCloseTo(2, 5);
  });

  it('applies the interpolation delay', () => {
    const track = new PresentationTrack(config({ interpolationDelayTicks: 2 }));
    track.push(snap(0, 0));
    track.push(snap(2, 2, 0));
    // render tick 2 → target tick 0.
    expect(track.sample(2).position[0]).toBeCloseTo(0, 5);
  });

  it('bounds extrapolation and applies gravity only when ballistic', () => {
    const contact = new PresentationTrack(config());
    contact.push(snap(0, 0, 1));
    // Contact-active: velocity extrapolation, no gravity.
    const contactState = contact.sample(2);
    expect(contactState.position[0]).toBeCloseTo(2, 4);
    expect(contactState.position[1]).toBeCloseTo(0, 4);

    const ballistic = new PresentationTrack(config());
    ballistic.push(snap(0, 0, 1, PresentationClass.Ballistic));
    const ballisticState = ballistic.sample(2);
    expect(ballisticState.position[1]).toBeLessThan(-10); // 0.5*g*t^2 = -20
    // Extrapolation clamps at maxExtrapolationTicks.
    const clamped = ballistic.sample(100);
    const atMax = 0.5 * -10 * 4 * 4;
    expect(clamped.position[1]).toBeCloseTo(atMax, 3);
  });

  it('freezes quiescent bodies', () => {
    const track = new PresentationTrack(config());
    track.push(snap(0, 3, 5, PresentationClass.Quiescent));
    const state = track.sample(10);
    expect(state.position[0]).toBeCloseTo(3, 5);
    expect(state.linearVelocity[0]).toBe(0);
  });

  it('turns a late path revision into a decaying correction', () => {
    const track = new PresentationTrack(config({ correctionSeconds: 1 }));
    track.push(snap(0, 0));
    track.push(snap(10, 0));
    // On-screen at x=0.
    track.sample(5);
    // Late revision: the path was actually moving.
    track.push(snap(5, 2, 0));
    const corrected = track.sample(5.01);
    // The correction re-anchors near the on-screen pose rather than jumping.
    expect(corrected.position[0]).toBeLessThan(1.0);
    expect(corrected.positionCorrection[0]).not.toBe(0);
    // Correction decays over time.
    const later = track.sample(12);
    expect(Math.abs(later.positionCorrection[0])).toBeLessThan(
      Math.abs(corrected.positionCorrection[0]),
    );
  });

  it('snaps on discontinuous lifecycle moves instead of gliding', () => {
    const track = new PresentationTrack(config());
    track.push(snap(0, 0, 0));
    track.push(snap(1, 100, 0)); // 100 m in one tick with zero velocity
    const state = track.sample(1);
    expect(state.position[0]).toBeCloseTo(100, 5);
    const before = track.sample(0.5);
    expect([0, 100]).toContain(Math.round(before.position[0]));
  });

  it('samples empty tracks as default state', () => {
    const track = new PresentationTrack(config());
    const state = track.sample(5);
    expect(state.position).toEqual([0, 0, 0]);
  });
});
