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

describe('PresentationTrack.rebase', () => {
  const at = (
    tick: number,
    position: [number, number, number],
    rotation: [number, number, number, number] = [0, 0, 0, 1],
    linearVelocity: [number, number, number] = [0, 0, 0],
    angularVelocity: [number, number, number] = [0, 0, 0],
  ): MotionSnapshot => ({
    tick,
    position,
    rotation,
    linearVelocity,
    angularVelocity,
    class: PresentationClass.ContactActive,
  });

  // The whole fracture-jump fix rests on this: a body's pose is stated about
  // its centre of mass, so when the body sheds members every chunk offset
  // shifts by -delta. Rebasing the buffered poses by +delta must therefore
  // leave the composed world position of a chunk exactly where it was.
  it('leaves composed world placement unchanged', () => {
    const track = new PresentationTrack(config());
    track.push(at(0, [1, 2, 3]));
    track.push(at(1, [1.5, 2, 3]));
    const chunkOffsetBefore: [number, number, number] = [0.25, -0.5, 0.75];
    const before = track.sample(1);
    const worldBefore = [
      before.position[0] + chunkOffsetBefore[0],
      before.position[1] + chunkOffsetBefore[1],
      before.position[2] + chunkOffsetBefore[2],
    ];

    // COM moves by delta => every offset moves by -delta.
    const delta: [number, number, number] = [0.1, -0.2, 0.3];
    track.rebase(delta);
    const chunkOffsetAfter = chunkOffsetBefore.map((v, i) => v - delta[i]);

    const after = track.sample(1);
    const worldAfter = [
      after.position[0] + chunkOffsetAfter[0],
      after.position[1] + chunkOffsetAfter[1],
      after.position[2] + chunkOffsetAfter[2],
    ];
    expect(worldAfter[0]).toBeCloseTo(worldBefore[0], 9);
    expect(worldAfter[1]).toBeCloseTo(worldBefore[1], 9);
    expect(worldAfter[2]).toBeCloseTo(worldBefore[2], 9);
  });

  it('shifts the sampled pose by exactly the rotated delta', () => {
    // 90 degrees about +Y: a local +X delta must come out as world -Z.
    const half = Math.SQRT1_2;
    const track = new PresentationTrack(config());
    track.push(at(0, [0, 0, 0], [0, half, 0, half]));
    // Copy: `sample` hands back the same object it keeps as its on-screen
    // anchor, and the rebase updates that anchor too.
    const before = [...track.sample(0).position];
    track.rebase([1, 0, 0]);
    const after = track.sample(0).position;
    expect(after[0] - before[0]).toBeCloseTo(0, 6);
    expect(after[1] - before[1]).toBeCloseTo(0, 6);
    expect(after[2] - before[2]).toBeCloseTo(-1, 6);
  });

  // A rebase is a restatement of the same motion, not new information. If it
  // registered as a path revision the track would smooth it, reintroducing
  // exactly the visible drift the rebase exists to remove.
  it('does not produce a correction', () => {
    const track = new PresentationTrack(config({ interpolationDelayTicks: 2 }));
    track.push(at(0, [0, 0, 0]));
    track.push(at(1, [1, 0, 0]));
    track.push(at(2, [2, 0, 0]));
    track.sample(2);
    track.rebase([0.5, 0, 0]);
    const after = track.sample(3);
    expect(after.positionCorrection[0]).toBeCloseTo(0, 9);
    expect(after.positionCorrection[1]).toBeCloseTo(0, 9);
    expect(after.positionCorrection[2]).toBeCloseTo(0, 9);
  });

  it('carries the angular term into linear velocity', () => {
    const track = new PresentationTrack(config());
    // Spinning about +Y; a lever arm along +X gains velocity along -Z.
    track.push(at(0, [0, 0, 0], [0, 0, 0, 1], [0, 0, 0], [0, 2, 0]));
    track.rebase([1, 0, 0]);
    const state = track.sample(0);
    expect(state.linearVelocity[2]).toBeCloseTo(-2, 6);
  });

  it('ignores degenerate deltas', () => {
    const track = new PresentationTrack(config());
    track.push(at(0, [1, 2, 3]));
    track.rebase([0, 0, 0]);
    track.rebase([NaN, 0, 0]);
    const state = track.sample(0);
    expect(state.position).toEqual([1, 2, 3]);
  });
});

describe('settled fast path', () => {
  /** A track holding one quiescent snapshot, sampled well past it. */
  function restingTrack() {
    const track = new PresentationTrack(config({ interpolationDelayTicks: 0 }));
    track.push({
      tick: 100,
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      class: PresentationClass.Quiescent,
    });
    return track;
  }

  it('returns the same pose once resting', () => {
    const track = restingTrack();
    const first = track.sample(200);
    const second = track.sample(260);
    expect(second.position).toEqual(first.position);
    expect(second.rotation).toEqual(first.rotation);
  });

  it('still moves when a new snapshot arrives', () => {
    // The fast path must not latch: a resting body that gets shot has to
    // resume interpolating, or it freezes on screen for the rest of the match.
    const track = restingTrack();
    track.sample(200);
    track.push({
      tick: 260,
      position: [9, 2, 3],
      rotation: [0, 0, 0, 1],
      linearVelocity: [1, 0, 0],
      angularVelocity: [0, 0, 0],
      class: PresentationClass.Ballistic,
    });
    const after = track.sample(400);
    expect(after.position[0]).toBeGreaterThan(1.5);
  });

  it('does not take the fast path before the target tick passes the snapshot', () => {
    // Sampling BEFORE the quiescent tick must interpolate/clamp normally
    // rather than reuse a pose that has not been reached yet.
    const track = restingTrack();
    const early = track.sample(0);
    expect(early.position).toEqual([1, 2, 3]);
  });

  it('collapses an asymptotic correction so resting can actually be reached', () => {
    // Critically-damped decay never hits zero, so without the epsilon collapse
    // a body that was ever corrected re-interpolates for the whole session.
    const track = restingTrack();
    track.sample(200);
    track.push({
      tick: 210,
      position: [1.05, 2, 3],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      class: PresentationClass.Quiescent,
    });
    track.sample(260);
    // Run well past the correction window; the pose must converge and hold.
    let last = track.sample(1000);
    for (let t = 1060; t < 4000; t += 60) last = track.sample(t);
    const held = track.sample(4060);
    expect(held.position[0]).toBeCloseTo(last.position[0], 9);
    expect(held.positionCorrection).toEqual([0, 0, 0]);
  });
});
