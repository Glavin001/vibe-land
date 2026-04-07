import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as RAPIER from '@dimforge/rapier3d-compat';
import {
  PredictedFpsController,
  seqIsNewer,
  type Vec3,
} from './predictedFpsController';
import {
  BTN_FORWARD,
  BTN_JUMP,
  BTN_SPRINT,
  BTN_CROUCH,
  type InputFrame,
  type NetPlayerState,
  metersToMm,
  angleToI16,
} from '../net/protocol';

const FIXED_DT = 1 / 60;

/** Build an InputFrame with sensible defaults. */
function makeInput(overrides: Partial<InputFrame> = {}): InputFrame {
  return {
    seq: 1,
    buttons: 0,
    moveX: 0,
    moveY: 0,
    yaw: 0,
    pitch: 0,
    ...overrides,
  };
}

/** Build a NetPlayerState from meters (handles unit encoding). */
function makeNetState(opts: {
  id?: number;
  position?: [number, number, number];
  velocity?: [number, number, number];
  yaw?: number;
  pitch?: number;
  flags?: number;
}): NetPlayerState {
  const pos = opts.position ?? [0, 0, 0];
  const vel = opts.velocity ?? [0, 0, 0];
  return {
    id: opts.id ?? 1,
    pxMm: metersToMm(pos[0]),
    pyMm: metersToMm(pos[1]),
    pzMm: metersToMm(pos[2]),
    vxCms: Math.round(vel[0] * 100),
    vyCms: Math.round(vel[1] * 100),
    vzCms: Math.round(vel[2] * 100),
    yawI16: angleToI16(opts.yaw ?? 0),
    pitchI16: angleToI16(opts.pitch ?? 0),
    flags: opts.flags ?? 0,
  };
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// ──────────────────────────────────────────────
// seqIsNewer
// ──────────────────────────────────────────────

describe('seqIsNewer', () => {
  it('returns true when a > b (simple case)', () => {
    expect(seqIsNewer(5, 3)).toBe(true);
  });

  it('returns false when a == b', () => {
    expect(seqIsNewer(3, 3)).toBe(false);
  });

  it('returns false when a < b (simple case)', () => {
    expect(seqIsNewer(3, 5)).toBe(false);
  });

  it('handles 16-bit wrap-around: a just wrapped past 0', () => {
    // a = 2, b = 0xfffe → a is "newer" because it wrapped
    expect(seqIsNewer(2, 0xfffe)).toBe(true);
  });

  it('handles 16-bit wrap-around: b just wrapped past 0', () => {
    // a = 0xfffe, b = 2 → b is newer, so a is NOT newer
    expect(seqIsNewer(0xfffe, 2)).toBe(false);
  });

  it('handles half-range boundary', () => {
    // Exactly 0x8000 apart should be "not newer" (ambiguous, treated as old)
    expect(seqIsNewer(0x8000, 0)).toBe(false);
  });
});

// ──────────────────────────────────────────────
// PredictedFpsController
// ──────────────────────────────────────────────

describe('PredictedFpsController', () => {
  let world: RAPIER.World;
  let body: RAPIER.RigidBody;
  let collider: RAPIER.Collider;

  beforeAll(async () => {
    await RAPIER.init();
  });

  beforeEach(() => {
    world = new RAPIER.World({ x: 0, y: -20, z: 0 });

    // Ground plane so the player doesn't fall forever
    const groundDesc = RAPIER.ColliderDesc.cuboid(50, 0.5, 50)
      .setTranslation(0, -0.5, 0);
    world.createCollider(groundDesc);

    body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(0.45, 0.35),
      body,
    );

    // Step once to initialize broadphase so collision detection works
    world.step();
  });

  it('starts at the origin', () => {
    const ctrl = new PredictedFpsController(world, body, collider);
    const pos = ctrl.getPosition();
    expect(pos.x).toBeCloseTo(0);
    expect(pos.y).toBeCloseTo(0);
    expect(pos.z).toBeCloseTo(0);
    ctrl.dispose();
  });

  it('predict with no input does not move horizontally', () => {
    const ctrl = new PredictedFpsController(world, body, collider);
    const before = ctrl.getPosition();

    ctrl.predict(makeInput({ seq: 1 }), FIXED_DT);

    const after = ctrl.getPosition();
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.z).toBeCloseTo(before.z, 3);
    ctrl.dispose();
  });

  it('predict with forward input moves the player forward', () => {
    const ctrl = new PredictedFpsController(world, body, collider);
    // Place above ground so there's room to move
    ctrl.setPosition({ x: 0, y: 1, z: 0 });

    // Yaw = 0 means forward is +Z
    for (let i = 0; i < 30; i++) {
      ctrl.predict(
        makeInput({ seq: i + 1, buttons: BTN_FORWARD, moveY: 127, yaw: 0 }),
        FIXED_DT,
      );
    }

    const pos = ctrl.getPosition();
    expect(pos.z).toBeGreaterThan(0.5); // Should have moved forward significantly
    ctrl.dispose();
  });

  it('predict uses move axes even without directional button bits', () => {
    const ctrl = new PredictedFpsController(world, body, collider);
    ctrl.setPosition({ x: 0, y: 1, z: 0 });

    for (let i = 0; i < 30; i++) {
      ctrl.predict(
        makeInput({ seq: i + 1, moveX: 127, buttons: 0, yaw: 0 }),
        FIXED_DT,
      );
    }

    const pos = ctrl.getPosition();
    expect(pos.x).toBeGreaterThan(0.5);
    expect(Math.abs(pos.z)).toBeLessThan(0.2);
    ctrl.dispose();
  });

  it('sprint moves faster than walk', () => {
    const ctrlWalk = new PredictedFpsController(world, body, collider);
    ctrlWalk.setPosition({ x: 0, y: 1, z: 0 });

    const body2 = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    body2.setTranslation({ x: 100, y: 1, z: 0 }, true); // far away to avoid collision
    const collider2 = world.createCollider(RAPIER.ColliderDesc.capsule(0.45, 0.35), body2);
    const ctrlSprint = new PredictedFpsController(world, body2, collider2);

    for (let i = 0; i < 30; i++) {
      ctrlWalk.predict(
        makeInput({ seq: i + 1, buttons: BTN_FORWARD, moveY: 127 }),
        FIXED_DT,
      );
      ctrlSprint.predict(
        makeInput({ seq: i + 1, buttons: BTN_FORWARD | BTN_SPRINT, moveY: 127 }),
        FIXED_DT,
      );
    }

    const walkDist = ctrlWalk.getPosition().z;
    const sprintDist = ctrlSprint.getPosition().z - 0; // started at z=0 (body2 x-offset only)
    expect(sprintDist).toBeGreaterThan(walkDist);
    ctrlWalk.dispose();
    ctrlSprint.dispose();
  });

  it('jump increases Y position', () => {
    const ctrl = new PredictedFpsController(world, body, collider);
    // Place well above ground and let settle
    ctrl.setPosition({ x: 0, y: 2, z: 0 });

    // Settle onto ground
    for (let i = 0; i < 60; i++) {
      ctrl.predict(makeInput({ seq: i + 1 }), FIXED_DT);
    }
    const groundY = ctrl.getPosition().y;

    // Jump — must be grounded for jump to fire
    ctrl.predict(makeInput({ seq: 61, buttons: BTN_JUMP }), FIXED_DT);
    let peakY = ctrl.getPosition().y;

    // Continue for a few frames and track the jump apex.
    for (let i = 0; i < 30; i++) {
      ctrl.predict(makeInput({ seq: 62 + i }), FIXED_DT);
      peakY = Math.max(peakY, ctrl.getPosition().y);
    }

    expect(peakY).toBeGreaterThan(groundY + 0.02);
    ctrl.dispose();
  });

  describe('reconcile', () => {
    it('snaps to server position when error exceeds threshold', () => {
      const ctrl = new PredictedFpsController(world, body, collider);

      // Predict a few inputs locally
      for (let i = 0; i < 5; i++) {
        ctrl.predict(
          makeInput({ seq: i + 1, buttons: BTN_FORWARD, moveY: 127 }),
          FIXED_DT,
        );
      }

      // Server says player is at a very different position
      const serverPos: [number, number, number] = [10, 1, 10];
      const serverState = makeNetState({
        position: serverPos,
        flags: 1, // on_ground
      });

      ctrl.reconcile({ ackInputSeq: 5, state: serverState }, FIXED_DT);

      // Since all inputs are acked (seq <= 5), no replay happens.
      // Position should be near server position.
      const pos = ctrl.getPosition();
      expect(pos.x).toBeCloseTo(serverPos[0], 0);
      expect(pos.z).toBeCloseTo(serverPos[2], 0);
      ctrl.dispose();
    });

    it('does not correct when error is within deadzone', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 5, y: 1, z: 5 });

      // Server position very close (within 0.05m)
      const serverState = makeNetState({
        position: [5.01, 1, 5.01],
        flags: 1,
      });

      ctrl.reconcile({ ackInputSeq: 0, state: serverState }, FIXED_DT);

      // Should NOT have moved — error is within deadzone
      const pos = ctrl.getPosition();
      expect(pos.x).toBeCloseTo(5, 1);
      expect(pos.z).toBeCloseTo(5, 1);
      ctrl.dispose();
    });

    it('replays unacked inputs after correction', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });

      // Predict 5 inputs moving forward
      for (let i = 0; i < 5; i++) {
        ctrl.predict(
          makeInput({ seq: i + 1, buttons: BTN_FORWARD, moveY: 127, yaw: 0 }),
          FIXED_DT,
        );
      }

      // Server acks only seq 2 — inputs 3, 4, 5 are unacked and will be replayed
      const serverState = makeNetState({
        position: [0, 1, 0.1],
        flags: 1,
      });

      ctrl.reconcile({ ackInputSeq: 2, state: serverState }, FIXED_DT);

      // After reconciliation, the player should have moved forward from [0,1,0.1]
      // by replaying 3 inputs. Position should be ahead of the server position.
      const pos = ctrl.getPosition();
      expect(pos.z).toBeGreaterThan(0.1);
      ctrl.dispose();
    });

    it('filters acked inputs from pending queue', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });

      // Predict 10 inputs
      for (let i = 0; i < 10; i++) {
        ctrl.predict(
          makeInput({ seq: i + 1, buttons: BTN_FORWARD, moveY: 127 }),
          FIXED_DT,
        );
      }

      // Ack all 10 inputs — server at a different position
      const serverState = makeNetState({
        position: [0, 1, 3],
        flags: 1,
      });

      ctrl.reconcile({ ackInputSeq: 10, state: serverState }, FIXED_DT);

      // All inputs acked, no replay. Position should match server exactly.
      const pos = ctrl.getPosition();
      expect(pos.z).toBeCloseTo(3, 0);
      ctrl.dispose();
    });
  });

  describe('setPosition', () => {
    it('teleports the body to the given position', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 7, y: 3, z: -5 });

      const pos = ctrl.getPosition();
      expect(pos.x).toBeCloseTo(7);
      expect(pos.y).toBeCloseTo(3);
      expect(pos.z).toBeCloseTo(-5);
      ctrl.dispose();
    });
  });

  describe('getAngles', () => {
    it('reflects yaw/pitch from the last predicted input', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.predict(makeInput({ seq: 1, yaw: 1.5, pitch: -0.3 }), FIXED_DT);

      const angles = ctrl.getAngles();
      expect(angles.yaw).toBeCloseTo(1.5);
      expect(angles.pitch).toBeCloseTo(-0.3);
      ctrl.dispose();
    });
  });

  describe('isGrounded', () => {
    it('detects ground contact after settling (via jump behavior)', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      // Start slightly above ground and let gravity settle
      ctrl.setPosition({ x: 0, y: 2, z: 0 });

      for (let i = 0; i < 60; i++) {
        ctrl.predict(makeInput({ seq: i + 1 }), FIXED_DT);
      }
      const settledY = ctrl.getPosition().y;

      // If grounded, a jump input should increase Y velocity.
      ctrl.predict(makeInput({ seq: 61, buttons: BTN_JUMP }), FIXED_DT);
      let peakY = ctrl.getPosition().y;
      for (let i = 0; i < 30; i++) {
        ctrl.predict(makeInput({ seq: 62 + i }), FIXED_DT);
        peakY = Math.max(peakY, ctrl.getPosition().y);
      }

      expect(peakY).toBeGreaterThan(settledY + 0.02);
      ctrl.dispose();
    });

    it('is not grounded when in the air', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 10, z: 0 });

      // One frame — still falling
      ctrl.predict(makeInput({ seq: 1 }), FIXED_DT);

      expect(ctrl.isGrounded()).toBe(false);
      ctrl.dispose();
    });
  });
});
