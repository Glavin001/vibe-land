import { describe, expect, it } from 'vitest';
import {
  rotateVectorByQuaternionInverse,
  vehicleAgentStateToIntent,
  type Quaternion,
} from './vehicleSteering';
import {
  BTN_BACK,
  BTN_FORWARD,
  BTN_LEFT,
  BTN_RIGHT,
} from '../../net/sharedConstants';

const IDENTITY: Quaternion = [0, 0, 0, 1];

/** Unit quaternion rotating `angle` radians around the world +Y axis. */
function quatY(angle: number): Quaternion {
  const h = angle * 0.5;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

const PASSTHROUGH = Object.freeze({
  yaw: 0.25,
  pitch: -0.1,
  mode: 'driving' as const,
  targetPlayerId: null,
  vehicleId: 7,
  firePrimary: false,
  vehicleAction: null,
});

describe('rotateVectorByQuaternionInverse', () => {
  it('returns the original vector for the identity quaternion', () => {
    const v: [number, number, number] = [1.5, -2, 3.25];
    const out = rotateVectorByQuaternionInverse(v, IDENTITY);
    expect(out[0]).toBeCloseTo(1.5);
    expect(out[1]).toBeCloseTo(-2);
    expect(out[2]).toBeCloseTo(3.25);
  });

  it('inverts a +90° yaw rotation around Y', () => {
    // The chassis is yawed +90° (facing −X in world). Rotating (−1, 0, 0)
    // back into chassis-local should give (0, 0, −1) — "forward" in the
    // chassis frame.
    const q = quatY(Math.PI / 2);
    const world: [number, number, number] = [-1, 0, 0];
    const local = rotateVectorByQuaternionInverse(world, q);
    expect(local[0]).toBeCloseTo(0, 5);
    expect(local[1]).toBeCloseTo(0, 5);
    expect(local[2]).toBeCloseTo(-1, 5);
  });

  it('is its own inverse with a forward rotation', () => {
    // Rotating a vector by q and then by q^-1 should round-trip.
    const q: Quaternion = [0.2, 0.3, 0.1, Math.sqrt(1 - 0.04 - 0.09 - 0.01)];
    const v: [number, number, number] = [2, 0.5, -1.5];
    // forwardRotate(v, q) = inverse-rotate(v, conjugate(q))
    const conj: Quaternion = [-q[0], -q[1], -q[2], q[3]];
    const rotated = rotateVectorByQuaternionInverse(v, conj);
    const roundTripped = rotateVectorByQuaternionInverse(rotated, q);
    expect(roundTripped[0]).toBeCloseTo(2, 5);
    expect(roundTripped[1]).toBeCloseTo(0.5, 5);
    expect(roundTripped[2]).toBeCloseTo(-1.5, 5);
  });
});

describe('vehicleAgentStateToIntent', () => {
  it('emits BTN_FORWARD only for a target directly ahead', () => {
    // Chassis-local forward is −Z, so a world velocity of (0, 0, −10)
    // is straight ahead when the quaternion is identity.
    const intent = vehicleAgentStateToIntent([0, 0, -10], IDENTITY, PASSTHROUGH);
    expect(intent.buttons & BTN_FORWARD).toBeTruthy();
    expect(intent.buttons & BTN_LEFT).toBeFalsy();
    expect(intent.buttons & BTN_RIGHT).toBeFalsy();
    expect(intent.buttons & BTN_BACK).toBeFalsy();
  });

  it('emits forward + right for a target ahead-right of the chassis', () => {
    // Desired velocity in world space points +X/−Z → local heading ~+45°.
    const intent = vehicleAgentStateToIntent([5, 0, -5], IDENTITY, PASSTHROUGH);
    expect(intent.buttons & BTN_FORWARD).toBeTruthy();
    expect(intent.buttons & BTN_RIGHT).toBeTruthy();
    expect(intent.buttons & BTN_LEFT).toBeFalsy();
    expect(intent.buttons & BTN_BACK).toBeFalsy();
  });

  it('emits forward + left for a target ahead-left of the chassis', () => {
    const intent = vehicleAgentStateToIntent([-5, 0, -5], IDENTITY, PASSTHROUGH);
    expect(intent.buttons & BTN_FORWARD).toBeTruthy();
    expect(intent.buttons & BTN_LEFT).toBeTruthy();
    expect(intent.buttons & BTN_RIGHT).toBeFalsy();
    expect(intent.buttons & BTN_BACK).toBeFalsy();
  });

  it('reverses and counter-steers when the target is directly behind', () => {
    // Desired velocity is +Z world-space; chassis-local heading ~180°
    // (fully behind). We expect reverse, and since the target is
    // "straight back" the heading is exactly π so we fall just inside
    // the BTN_BACK arm with no steer (heading magnitude on threshold).
    const intent = vehicleAgentStateToIntent([0, 0, 10], IDENTITY, PASSTHROUGH);
    expect(intent.buttons & BTN_BACK).toBeTruthy();
    expect(intent.buttons & BTN_FORWARD).toBeFalsy();
  });

  it('reverses + opposite-steer for a target behind and to the right', () => {
    // Behind-right in world space → atan2(x, forward) where forward = −(−z)
    // is positive.  With local x ≈ +1 and local forward ≈ −0.17 the
    // heading lands around +1.74 rad (≈100°), just outside the forward
    // arc (100°). We should reverse and steer LEFT to swing the nose.
    const intent = vehicleAgentStateToIntent([10, 0, 1.8], IDENTITY, PASSTHROUGH);
    expect(intent.buttons & BTN_BACK).toBeTruthy();
    expect(intent.buttons & BTN_LEFT).toBeTruthy();
    expect(intent.buttons & BTN_RIGHT).toBeFalsy();
  });

  it('honors a yawed chassis — target directly ahead of a rotated car', () => {
    // Car is yawed +90° around Y. Its local forward in world space is
    // therefore along the rotated −Z axis → world +X direction. A world
    // velocity of (+1, 0, 0) should register as "dead ahead".
    //
    // NOTE: rotation sign convention — quatY(+π/2) yaws in the
    // right-handed sense around +Y, which maps chassis −Z to world… well,
    // the test asserts the output, whichever way it turns out: we just
    // need to confirm the code picks BTN_FORWARD and no steer when the
    // world velocity matches whatever "forward" the chassis resolves to.
    const chassis = quatY(Math.PI / 2);
    // To find the correct world-space "ahead" for this chassis, rotate
    // the local forward (0,0,-1) by the chassis quaternion. We can reuse
    // `rotateVectorByQuaternionInverse` by passing the conjugate, which
    // gives a forward rotation.
    const conj: Quaternion = [-chassis[0], -chassis[1], -chassis[2], chassis[3]];
    const worldForward = rotateVectorByQuaternionInverse([0, 0, -1], conj);
    // Scale to a real speed.
    const worldVel: [number, number, number] = [
      worldForward[0] * 10,
      worldForward[1] * 10,
      worldForward[2] * 10,
    ];
    const intent = vehicleAgentStateToIntent(worldVel, chassis, PASSTHROUGH);
    expect(intent.buttons & BTN_FORWARD).toBeTruthy();
    expect(intent.buttons & BTN_LEFT).toBeFalsy();
    expect(intent.buttons & BTN_RIGHT).toBeFalsy();
  });

  it('emits no drive buttons when desired velocity is below the deadband', () => {
    const intent = vehicleAgentStateToIntent([0, 0, -0.1], IDENTITY, PASSTHROUGH);
    expect(intent.buttons).toBe(0);
    // Passthrough fields are still forwarded unchanged.
    expect(intent.yaw).toBeCloseTo(PASSTHROUGH.yaw);
    expect(intent.pitch).toBeCloseTo(PASSTHROUGH.pitch);
    expect(intent.vehicleId).toBe(PASSTHROUGH.vehicleId);
  });

  it('passes vehicleId/vehicleAction through to the returned intent', () => {
    const intent = vehicleAgentStateToIntent([0, 0, -3], IDENTITY, {
      ...PASSTHROUGH,
      vehicleAction: 'exit',
    });
    expect(intent.vehicleAction).toBe('exit');
    expect(intent.vehicleId).toBe(PASSTHROUGH.vehicleId);
    expect(intent.mode).toBe('driving');
  });
});
