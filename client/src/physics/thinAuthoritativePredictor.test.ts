import { describe, expect, it } from 'vitest';

import { BTN_JUMP } from '../net/protocol';
import { ThinAuthoritativePredictor } from './thinAuthoritativePredictor';

describe('ThinAuthoritativePredictor', () => {
  // Driving, the walking inputs steer the car: the old predictor walked the
  // hidden avatar off its seat by the 0.35 m cap (0.35 m p50 against the
  // server while driving, 2026-09-24 quick 3-client bench, c0).
  it('adds no offset while the player drives, and drops the one it had', () => {
    const predictor = new ThinAuthoritativePredictor();
    const input = { moveX: 0, moveY: 1, yaw: 0, pitch: 0, buttons: 0 };
    predictor.observeAuthoritative({ position: [0, 0, 0], velocity: [0, 0, 0], grounded: true }, 1 / 60);
    for (let i = 0; i < 30; i += 1) predictor.update([0, 0, 0], 1 / 60, input);
    expect(predictor.correctionMagnitude()).toBeGreaterThan(0.3);
    for (let i = 0; i < 30; i += 1) {
      predictor.observeAuthoritative({ position: [5, 1, 2], velocity: [8, 0, 0], grounded: true, inVehicle: true }, 1 / 60);
      expect(predictor.update([5, 1, 2], 1 / 60, input)).toEqual([5, 1, 2]);
    }
    expect(predictor.correctionMagnitude()).toBe(0);
  });

  it('bounds local presentation error without simulating collisions', () => {
    const predictor = new ThinAuthoritativePredictor();
    predictor.observeAuthoritative(
      { position: [0, 0, 0], velocity: [0, 0, 0], grounded: true },
      1 / 60,
    );

    let rendered: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 60; i += 1) {
      rendered = predictor.update([0, 0, 0], 1 / 60, {
        moveX: 1,
        moveY: 0,
        yaw: 0,
        pitch: 0,
        buttons: 0,
      });
    }

    expect(Math.hypot(rendered[0], rendered[2])).toBeLessThanOrEqual(0.350001);
  });

  it('uses the same camera-relative basis as authoritative movement', () => {
    const strafePredictor = new ThinAuthoritativePredictor();
    strafePredictor.observeAuthoritative(
      { position: [0, 0, 0], velocity: [0, 0, 0], grounded: true },
      1 / 60,
    );
    const strafeRight = strafePredictor.update([0, 0, 0], 1 / 60, {
      moveX: 1,
      moveY: 0,
      yaw: 0,
      pitch: 0,
      buttons: 0,
    });
    expect(strafeRight[0]).toBeLessThan(0);
    expect(strafeRight[2]).toBeCloseTo(0);

    const forwardPredictor = new ThinAuthoritativePredictor();
    forwardPredictor.observeAuthoritative(
      { position: [0, 0, 0], velocity: [0, 0, 0], grounded: true },
      1 / 60,
    );
    const forwardAtQuarterTurn = forwardPredictor.update([0, 0, 0], 1 / 60, {
      moveX: 0,
      moveY: 1,
      yaw: Math.PI / 2,
      pitch: 0,
      buttons: 0,
    });
    expect(forwardAtQuarterTurn[0]).toBeGreaterThan(0);
    expect(forwardAtQuarterTurn[2]).toBeCloseTo(0);
  });

  it('only anticipates one jump until the server confirms grounded again', () => {
    const predictor = new ThinAuthoritativePredictor();
    predictor.observeAuthoritative(
      { position: [0, 0, 0], velocity: [0, 0, 0], grounded: true },
      1 / 60,
    );
    const first = predictor.update([0, 0, 0], 1 / 60, {
      moveX: 0,
      moveY: 0,
      yaw: 0,
      pitch: 0,
      buttons: BTN_JUMP,
    });
    const second = predictor.update([0, 0, 0], 1 / 60, {
      moveX: 0,
      moveY: 0,
      yaw: 0,
      pitch: 0,
      buttons: BTN_JUMP,
    });

    expect(first[1]).toBeGreaterThan(0);
    expect(second[1]).toBe(first[1]);
  });
});
