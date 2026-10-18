// The predictive lead (dead reckoning past the playout delay): a track drawn
// ahead of the shared presentation tick. docs/netcode-tuning.md#predictive-debris-dead-reckoning-ahead-of-the-playout-delay.

import { describe, expect, it } from 'vitest';

import {
  MotionSnapshot,
  PresentationClass,
  PresentationTrack,
  PresentationConfig,
  PresentedState,
} from './presentation';
import { Vec3 } from './vec';

const DT = 1 / 60;
const G = -9.81;

const config = (overrides: Partial<PresentationConfig> = {}): PresentationConfig => ({
  interpolationDelayTicks: 5,
  maxExtrapolationTicks: 8,
  correctionSeconds: 0.25,
  dt: DT,
  gravity: [0, G, 0],
  snapDistanceMeters: 5,
  ...overrides,
});

const record = (
  tick: number,
  position: Vec3,
  velocity: Vec3,
  klass: PresentationClass = PresentationClass.Ballistic,
): MotionSnapshot => ({
  tick,
  position,
  rotation: [0, 0, 0, 1],
  linearVelocity: velocity,
  angularVelocity: [0, 0, 0],
  class: klass,
});

/** Free fall from `p0` with `v0` at tick `t0`, evaluated at `tick`. */
const fall = (p0: Vec3, v0: Vec3, t0: number, tick: number): { p: Vec3; v: Vec3 } => {
  const t = (tick - t0) * DT;
  return {
    p: [p0[0] + v0[0] * t, p0[1] + v0[1] * t + 0.5 * G * t * t, p0[2] + v0[2] * t],
    v: [v0[0], v0[1] + G * t, v0[2]],
  };
};

const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Samples the track every half tick from `from` to `to`; returns the poses. */
const run = (track: PresentationTrack, from: number, to: number, each?: (tick: number) => void): PresentedState[] => {
  const out: PresentedState[] = [];
  for (let tick = from; tick <= to + 1e-9; tick += 0.5) {
    each?.(tick);
    const state = track.sample(tick);
    out.push({ ...state, position: [...state.position] as Vec3 });
  }
  return out;
};

describe('PresentationTrack lead', () => {
  it('without a lead samples exactly as a track that never heard of one (guard)', () => {
    const classic = new PresentationTrack(config());
    const zero = new PresentationTrack(config());
    const records = [
      record(100, [0, 20, 0], [2, 0, 0]),
      record(104, [0.2, 19.9, 0], [2, -0.6, 0]),
      record(103, [0.1, 19.95, 0], [2, -0.4, 0], PresentationClass.ContactActive),
      record(110, [0.9, 18, 1], [4, -3, 0]),
    ];
    let next = 0;
    for (let tick = 100; tick <= 130; tick += 0.5) {
      // Records land between samples, one of them late (a revision), and
      // the delay moves as a topology hold would move it.
      if (next < records.length && tick >= 102 + next * 3) {
        classic.push(records[next]);
        zero.push(records[next]);
        next += 1;
      }
      const delay = tick > 115 && tick < 120 ? 7 : 5;
      classic.setInterpolationDelayTicks(delay);
      zero.setInterpolationDelayTicks(delay);
      zero.setLeadHorizon(0, 0);
      expect(zero.sample(tick)).toEqual(classic.sample(tick));
    }
  });

  it('draws a ballistic record the lead ahead, on its gravity path', () => {
    const track = new PresentationTrack(config());
    const p0: Vec3 = [0, 30, 0];
    const v0: Vec3 = [5, 0, 0];
    track.push(record(100, p0, v0));
    track.setLeadHorizon(6, 0);
    // Presentation tick 100 (render 105), drawn at 106: 6 ticks of free fall.
    const state = track.sample(105);
    expect(track.currentLead()).toBe(6);
    expect(distance(state.position, fall(p0, v0, 100, 106).p)).toBeLessThan(1e-9);
  });

  it('gives a body in contact only its share of the lead', () => {
    const track = new PresentationTrack(config());
    track.push(record(100, [0, 1, 0], [3, 0, 0], PresentationClass.ContactActive));
    track.setLeadHorizon(6, 0.5);
    track.sample(105);
    expect(track.currentLead()).toBe(3);
  });

  it('changes lead as playback speed, never as a jump, when the class flips', () => {
    const track = new PresentationTrack(config());
    const p0: Vec3 = [0, 50, 0];
    const v0: Vec3 = [20, 0, 0];
    for (let tick = 100; tick <= 110; tick += 1) {
      const { p, v } = fall(p0, v0, 100, tick);
      track.push(record(tick, p, v));
    }
    const rates = { rise: 0.5, fall: 0.5 };
    const poses = run(track, 105, 140, (tick) => {
      track.setLeadHorizon(8, 0, rates);
      if (tick === 115) {
        // The body lands: in contact from here on, sliding on at 20 m/s.
        const { p } = fall(p0, v0, 100, 111);
        for (let t = 111; t <= 140; t += 1) {
          track.push(record(t, [p[0] + 20 * (t - 111) * DT, p[1], 0], [20, 0, 0], PresentationClass.ContactActive));
        }
      }
    });
    expect(track.currentLead()).toBe(0);
    // Each half-tick step moves at most (1 + rise) times what the body
    // itself covers in half a tick (~24 m/s by then), with room for the
    // landing's own correction; the lead's 8 ticks (~3 m) never show as a step.
    const steps = poses.slice(1).map((pose, i) => distance(pose.position, poses[i].position));
    expect(Math.max(...steps)).toBeLessThan(1.5 * 25 * DT * 0.5 + 0.1);
  });

  it('meets an impulse it ran ahead of in time, not with a snap', () => {
    const track = new PresentationTrack(config());
    const snaps: number[] = [];
    const corrections: Array<[number, boolean]> = [];
    track.setAnomalyListener((anomaly) => {
      if (anomaly.kind === 'correction_snap') snaps.push(anomaly.magnitude);
    });
    track.setCorrectionListener((metres, warped) => corrections.push([metres, warped]));
    // Barely moving (ballistic, just loosened), drawn 9 ticks ahead.
    track.push(record(100, [0, 5, 0], [0.5, 0, 0]));
    track.setLeadHorizon(9, 0);
    run(track, 104, 106);
    // Struck at tick 102: 60 m/s. The revised path at the tick last drawn
    // (106 - 5 + 9 = 110) is 8 ticks past the strike, 8 m along.
    track.push(record(102, [0.05, 5, 0], [60, 0, 0]));
    const state = track.sample(106.5);
    expect(snaps).toHaveLength(0);
    expect(corrections).toHaveLength(1);
    const [metres, warped] = corrections[0];
    expect(warped).toBe(true);
    expect(metres).toBeLessThan(0.5);
    // The lead was given up to meet it, and is regained at the rise rate.
    expect(track.currentLead()).toBeLessThan(2);
    expect(state.position[0]).toBeLessThan(1);
    run(track, 107, 140, () => track.setLeadHorizon(9, 0));
    expect(track.currentLead()).toBe(9);
  });

  it('stops a leading ballistic body at the floor, and only a leading one', () => {
    const falling = record(100, [0, 1, 0], [0, -10, 0]);
    const leading = new PresentationTrack(config());
    leading.setLeadFloor(0.1);
    leading.push(falling);
    leading.setLeadHorizon(10, 0);
    expect(leading.sample(110).position[1]).toBe(0.1);
    const classic = new PresentationTrack(config());
    classic.setLeadFloor(0.1);
    classic.push(falling);
    // Eight ticks of fall (its clamp) take it through the ground.
    expect(classic.sample(120).position[1]).toBeLessThan(0);
  });

  it('takes the lead at once on a seeded track, gliding from the pose on screen', () => {
    const track = new PresentationTrack(config());
    const seed: Vec3 = [4, 12, 0];
    track.seedPresented(
      { position: seed, rotation: [0, 0, 0, 1], linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
      105,
    );
    track.push(record(100, [4, 12, 0], [3, 0, 0]));
    track.setLeadHorizon(8, 0);
    const first = track.sample(105.5);
    expect(track.currentLead()).toBe(8);
    // Continuous with the seed: half a tick of motion and the glide, not the
    // 8 ticks of lead (0.4 m).
    expect(distance(first.position, seed)).toBeLessThan(0.1);
  });
});
