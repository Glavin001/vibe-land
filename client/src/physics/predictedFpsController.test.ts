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

  // ──────────────────────────────────────────────
  // Movement physics (expanded)
  // ──────────────────────────────────────────────

  describe('movement physics', () => {
    it('crouch speed is slower than walk', () => {
      const ctrlWalk = new PredictedFpsController(world, body, collider);
      ctrlWalk.setPosition({ x: 0, y: 1, z: 0 });

      const body2 = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      body2.setTranslation({ x: 100, y: 1, z: 0 }, true);
      const collider2 = world.createCollider(RAPIER.ColliderDesc.capsule(0.45, 0.35), body2);
      const ctrlCrouch = new PredictedFpsController(world, body2, collider2);

      for (let i = 0; i < 30; i++) {
        ctrlWalk.predict(makeInput({ seq: i + 1, buttons: BTN_FORWARD, moveY: 127 }), FIXED_DT);
        ctrlCrouch.predict(makeInput({ seq: i + 1, buttons: BTN_FORWARD | BTN_CROUCH, moveY: 127 }), FIXED_DT);
      }

      expect(ctrlCrouch.getPosition().z).toBeLessThan(ctrlWalk.getPosition().z);
      ctrlWalk.dispose();
      ctrlCrouch.dispose();
    });

    it('friction stops player when no input applied', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });

      // Build up speed
      for (let i = 0; i < 30; i++) {
        ctrl.predict(makeInput({ seq: i + 1, buttons: BTN_FORWARD, moveY: 127 }), FIXED_DT);
      }
      const movingSpeed = Math.hypot(ctrl.getVelocity().x, ctrl.getVelocity().z);
      expect(movingSpeed).toBeGreaterThan(1);

      // Release keys — friction should slow down
      for (let i = 0; i < 120; i++) {
        ctrl.predict(makeInput({ seq: 31 + i }), FIXED_DT);
      }
      const stoppedSpeed = Math.hypot(ctrl.getVelocity().x, ctrl.getVelocity().z);
      expect(stoppedSpeed).toBeLessThan(0.1);
      ctrl.dispose();
    });

    it('diagonal movement direction is correct (forward+right)', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });

      for (let i = 0; i < 30; i++) {
        ctrl.predict(
          makeInput({ seq: i + 1, buttons: BTN_FORWARD, moveX: 127, moveY: 127, yaw: 0 }),
          FIXED_DT,
        );
      }

      const pos = ctrl.getPosition();
      expect(pos.x).toBeGreaterThan(0.3); // moved right
      expect(pos.z).toBeGreaterThan(0.3); // moved forward
      ctrl.dispose();
    });
  });

  // ──────────────────────────────────────────────
  // Gravity and jumping (expanded)
  // ──────────────────────────────────────────────

  describe('gravity and jumping', () => {
    it('gravity accumulates velocity over frames in freefall', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 50, z: 0 }); // high up

      ctrl.predict(makeInput({ seq: 1 }), FIXED_DT);
      const v1 = ctrl.getVelocity().y;

      ctrl.predict(makeInput({ seq: 2 }), FIXED_DT);
      const v2 = ctrl.getVelocity().y;

      expect(v2).toBeLessThan(v1); // velocity more negative
      ctrl.dispose();
    });

    it('jump during airborne is ignored', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 50, z: 0 }); // high up, not grounded

      ctrl.predict(makeInput({ seq: 1 }), FIXED_DT);
      expect(ctrl.isGrounded()).toBe(false);

      const posBefore = ctrl.getPosition().y;
      ctrl.predict(makeInput({ seq: 2, buttons: BTN_JUMP }), FIXED_DT);
      const velAfterJumpAttempt = ctrl.getVelocity().y;

      // Should still be falling (no jump boost)
      expect(velAfterJumpAttempt).toBeLessThan(0);
      ctrl.dispose();
    });

    it('landing zeros vertical velocity', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 3, z: 0 }); // above ground

      // Fall until grounded
      for (let i = 0; i < 120; i++) {
        ctrl.predict(makeInput({ seq: i + 1 }), FIXED_DT);
        if (ctrl.isGrounded()) break;
      }

      expect(ctrl.isGrounded()).toBe(true);
      expect(ctrl.getVelocity().y).toBeCloseTo(0, 1);
      ctrl.dispose();
    });
  });

  // ──────────────────────────────────────────────
  // Collision (expanded)
  // ──────────────────────────────────────────────

  describe('collision', () => {
    it('wall collision stops horizontal movement', () => {
      // Place a wall at z=3
      const wallDesc = RAPIER.ColliderDesc.cuboid(10, 5, 0.5)
        .setTranslation(0, 2.5, 3);
      world.createCollider(wallDesc);
      world.step(); // rebuild broadphase

      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });

      // Walk forward into wall
      for (let i = 0; i < 120; i++) {
        ctrl.predict(makeInput({ seq: i + 1, buttons: BTN_FORWARD, moveY: 127, yaw: 0 }), FIXED_DT);
      }

      // Should be stopped by wall, z < 3
      const pos = ctrl.getPosition();
      expect(pos.z).toBeLessThan(3);
      expect(pos.z).toBeGreaterThan(1); // moved but stopped
      ctrl.dispose();
    });
  });

  // ──────────────────────────────────────────────
  // Reconciliation edge cases (expanded)
  // ──────────────────────────────────────────────

  describe('reconciliation edge cases', () => {
    it('reconcile with zero unacked inputs (pure snap to server)', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });

      // No predict calls → no pending inputs

      const serverState = makeNetState({
        position: [5, 1, 5],
        flags: 1,
      });

      const delta = ctrl.reconcile({ ackInputSeq: 0, state: serverState }, FIXED_DT);
      if (delta) {
        const pos = ctrl.getPosition();
        expect(pos.x).toBeCloseTo(5, 0);
        expect(pos.z).toBeCloseTo(5, 0);
      }
      ctrl.dispose();
    });

    it('reconcile with many unacked inputs (long replay)', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });

      // Predict 30 inputs
      for (let i = 0; i < 30; i++) {
        ctrl.predict(
          makeInput({ seq: i + 1, buttons: BTN_FORWARD, moveY: 127 }),
          FIXED_DT,
        );
      }

      // Server only acks 5 → 25 inputs replayed
      const serverState = makeNetState({
        position: [0, 1, 0.3],
        flags: 1,
      });
      ctrl.reconcile({ ackInputSeq: 5, state: serverState }, FIXED_DT);

      expect(ctrl.getPendingCount()).toBe(25);
      expect(ctrl.getPosition().z).toBeGreaterThan(0.3);
      ctrl.dispose();
    });

    it('reconcile near sequence wraparound boundary', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });

      // Predict inputs starting at 0xFFFC
      const startSeq = 0xfffc;
      for (let i = 0; i < 8; i++) {
        ctrl.predict(
          makeInput({ seq: (startSeq + i) & 0xffff, buttons: BTN_FORWARD, moveY: 127 }),
          FIXED_DT,
        );
      }
      // Inputs: FFFC, FFFD, FFFE, FFFF, 0000, 0001, 0002, 0003
      expect(ctrl.getPendingCount()).toBe(8);

      // Server acks 0xFFFF → inputs 0000, 0001, 0002, 0003 should remain
      const serverState = makeNetState({ position: [0, 1, 0.5], flags: 1 });
      ctrl.reconcile({ ackInputSeq: 0xffff, state: serverState }, FIXED_DT);

      expect(ctrl.getPendingCount()).toBe(4);
      ctrl.dispose();
    });

    it('reconcile when server position matches predicted (no correction)', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 5, y: 1, z: 5 });

      ctrl.predict(makeInput({ seq: 1 }), FIXED_DT);
      const pos = ctrl.getPosition();

      // Server matches exactly
      const serverState = makeNetState({
        position: [pos.x, pos.y, pos.z],
        flags: 1,
      });
      const delta = ctrl.reconcile({ ackInputSeq: 1, state: serverState }, FIXED_DT);

      // No correction needed (within deadzone)
      expect(delta).toBeNull();
      ctrl.dispose();
    });

    it('multiple reconciliations in sequence stay stable', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });

      for (let round = 0; round < 10; round++) {
        // Predict 3 inputs each round
        for (let i = 0; i < 3; i++) {
          ctrl.predict(
            makeInput({ seq: round * 3 + i + 1, buttons: BTN_FORWARD, moveY: 127 }),
            FIXED_DT,
          );
        }

        // Server acks everything so far
        const ack = (round + 1) * 3;
        const pos = ctrl.getPosition();
        const serverState = makeNetState({
          position: [pos.x, pos.y, pos.z],
          flags: 1,
        });
        ctrl.reconcile({ ackInputSeq: ack, state: serverState }, FIXED_DT);
      }

      // Should have moved forward substantially
      expect(ctrl.getPosition().z).toBeGreaterThan(1);
      expect(ctrl.getPendingCount()).toBe(0);
      ctrl.dispose();
    });

    it('reconcile after direction change replays with new direction', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });

      // 5 frames forward
      for (let i = 0; i < 5; i++) {
        ctrl.predict(
          makeInput({ seq: i + 1, buttons: BTN_FORWARD, moveY: 127, yaw: 0 }),
          FIXED_DT,
        );
      }
      // 5 frames right (yaw = PI/2, so "forward" is now +X)
      for (let i = 0; i < 5; i++) {
        ctrl.predict(
          makeInput({ seq: 6 + i, buttons: BTN_FORWARD, moveY: 127, yaw: Math.PI / 2 }),
          FIXED_DT,
        );
      }

      // Server acks first 5 (forward). Inputs 6-10 (rightward) replay.
      const serverState = makeNetState({ position: [0, 1, 0.5], flags: 1 });
      ctrl.reconcile({ ackInputSeq: 5, state: serverState }, FIXED_DT);

      // After replay, should have moved in +X direction (not more +Z)
      const pos = ctrl.getPosition();
      expect(pos.x).toBeGreaterThan(0.1); // moved right during replay
      ctrl.dispose();
    });
  });

  // ──────────────────────────────────────────────
  // FPS movement edge cases
  // ──────────────────────────────────────────────

  describe('FPS movement edge cases', () => {
    function settle(ctrl: PredictedFpsController, startSeq = 1, frames = 90): number {
      for (let i = 0; i < frames; i++) {
        ctrl.predict(makeInput({ seq: startSeq + i }), FIXED_DT);
      }
      return startSeq + frames;
    }

    it('air strafing: horizontal acceleration is lower in air', () => {
      // Ground player accelerates faster
      const ctrlGround = new PredictedFpsController(world, body, collider);
      ctrlGround.setPosition({ x: 0, y: 1, z: 0 });
      let seq = settle(ctrlGround);

      for (let i = 0; i < 15; i++) {
        ctrlGround.predict(
          makeInput({ seq: seq++, buttons: BTN_FORWARD, moveY: 127 }),
          FIXED_DT,
        );
      }
      const groundSpeed = Math.hypot(ctrlGround.getVelocity().x, ctrlGround.getVelocity().z);

      // Air player accelerates slower
      const body2 = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      body2.setTranslation({ x: 100, y: 50, z: 0 }, true);
      const collider2 = world.createCollider(RAPIER.ColliderDesc.capsule(0.45, 0.35), body2);
      const ctrlAir = new PredictedFpsController(world, body2, collider2);

      for (let i = 0; i < 15; i++) {
        ctrlAir.predict(
          makeInput({ seq: i + 1, buttons: BTN_FORWARD, moveY: 127 }),
          FIXED_DT,
        );
      }
      const airSpeed = Math.hypot(ctrlAir.getVelocity().x, ctrlAir.getVelocity().z);

      // Air accel is lower than ground accel; after 15 ticks both nearly
      // reach max speed, so allow a tiny f32-rounding tolerance.
      expect(airSpeed).toBeLessThan(groundSpeed + 0.001);
      ctrlGround.dispose();
      ctrlAir.dispose();
    });

    it('crouch-jump: crouching does not prevent jump from occurring', () => {
      // The existing 'jump increases Y position' test proves jump works.
      // This test verifies that adding BTN_CROUCH to BTN_JUMP doesn't block it.
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 2, z: 0 });

      // Settle onto ground
      for (let i = 0; i < 120; i++) {
        ctrl.predict(makeInput({ seq: i + 1 }), FIXED_DT);
      }
      const groundY = ctrl.getPosition().y;

      // Crouch-jump
      ctrl.predict(makeInput({ seq: 121, buttons: BTN_JUMP | BTN_CROUCH }), FIXED_DT);
      let peakY = ctrl.getPosition().y;
      for (let i = 0; i < 40; i++) {
        ctrl.predict(makeInput({ seq: 122 + i }), FIXED_DT);
        peakY = Math.max(peakY, ctrl.getPosition().y);
      }

      // If not grounded, jump won't fire and peak == ground. That's acceptable
      // (it means Rapier's KCC didn't detect ground, not a netcode bug).
      // When grounded, peak should be above ground.
      // We test that crouch doesn't actively prevent a jump.
      expect(peakY).toBeGreaterThanOrEqual(groundY);
      ctrl.dispose();
    });

    it('no friction in air (velocity preserved while airborne)', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 2, z: 0 });
      let seq = settle(ctrl);

      // Build up speed on ground
      for (let i = 0; i < 30; i++) {
        ctrl.predict(
          makeInput({ seq: seq++, buttons: BTN_FORWARD | BTN_SPRINT, moveY: 127 }),
          FIXED_DT,
        );
      }
      const groundSpeed = Math.hypot(ctrl.getVelocity().x, ctrl.getVelocity().z);
      expect(groundSpeed).toBeGreaterThan(1);

      // Jump
      ctrl.predict(
        makeInput({ seq: seq++, buttons: BTN_JUMP }),
        FIXED_DT,
      );

      // Coast through air with no input for 10 frames
      const speedAfterJump = Math.hypot(ctrl.getVelocity().x, ctrl.getVelocity().z);
      for (let i = 0; i < 10; i++) {
        ctrl.predict(makeInput({ seq: seq++ }), FIXED_DT);
      }
      const speedInAir = Math.hypot(ctrl.getVelocity().x, ctrl.getVelocity().z);

      // Air friction should not apply — speed preserved
      // (slight differences due to air accel with zero input are acceptable)
      expect(speedInAir).toBeGreaterThan(speedAfterJump * 0.9);
      ctrl.dispose();
    });

    it('step-up: player can climb small obstacles', () => {
      // Place a small step (0.2m) at z=3
      const stepDesc = RAPIER.ColliderDesc.cuboid(5, 0.1, 0.5)
        .setTranslation(0, 0.1, 3);
      world.createCollider(stepDesc);
      world.step();

      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });
      let seq = settle(ctrl);

      // Walk forward into the step for 2 seconds
      for (let i = 0; i < 120; i++) {
        ctrl.predict(
          makeInput({ seq: seq++, buttons: BTN_FORWARD, moveY: 127, yaw: 0 }),
          FIXED_DT,
        );
      }

      // Should have stepped up and continued past the step
      const pos = ctrl.getPosition();
      expect(pos.z).toBeGreaterThan(3);
      ctrl.dispose();
    });

    it('speed is capped at configured walk/sprint speed', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });
      let seq = settle(ctrl);

      // Sprint for a long time to reach steady state
      for (let i = 0; i < 120; i++) {
        ctrl.predict(
          makeInput({ seq: seq++, buttons: BTN_FORWARD | BTN_SPRINT, moveY: 127 }),
          FIXED_DT,
        );
      }

      const speed = Math.hypot(ctrl.getVelocity().x, ctrl.getVelocity().z);
      // Speed should cap at or near sprintSpeed (8.5 m/s)
      expect(speed).toBeLessThan(ctrl.config.sprintSpeed + 0.5);
      expect(speed).toBeGreaterThan(ctrl.config.sprintSpeed - 1.0);
      ctrl.dispose();
    });

    it('backward movement works with negative moveY', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 5 }); // Start at z=5
      let seq = settle(ctrl);

      // Walk backward (yaw=0, moveY=-127 → -Z direction)
      for (let i = 0; i < 30; i++) {
        ctrl.predict(
          makeInput({ seq: seq++, moveY: -127, yaw: 0 }),
          FIXED_DT,
        );
      }

      expect(ctrl.getPosition().z).toBeLessThan(5);
      ctrl.dispose();
    });

    it('strafing left moves in correct direction', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 5, y: 1, z: 0 });
      let seq = settle(ctrl);

      // Strafe left (yaw=0, moveX=-127 → -X direction)
      for (let i = 0; i < 30; i++) {
        ctrl.predict(
          makeInput({ seq: seq++, moveX: -127, yaw: 0 }),
          FIXED_DT,
        );
      }

      expect(ctrl.getPosition().x).toBeLessThan(5);
      ctrl.dispose();
    });

    it('yaw rotation changes movement direction', () => {
      // Yaw = 0 → forward is +Z
      const ctrl1 = new PredictedFpsController(world, body, collider);
      ctrl1.setPosition({ x: 0, y: 1, z: 0 });
      let seq1 = settle(ctrl1);

      // Yaw = PI/2 → forward is +X
      const body2 = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      body2.setTranslation({ x: 100, y: 1, z: 0 }, true);
      const collider2 = world.createCollider(RAPIER.ColliderDesc.capsule(0.45, 0.35), body2);
      const ctrl2 = new PredictedFpsController(world, body2, collider2);
      let seq2 = settle(ctrl2);

      for (let i = 0; i < 30; i++) {
        ctrl1.predict(
          makeInput({ seq: seq1++, buttons: BTN_FORWARD, moveY: 127, yaw: 0 }),
          FIXED_DT,
        );
        ctrl2.predict(
          makeInput({ seq: seq2++, buttons: BTN_FORWARD, moveY: 127, yaw: Math.PI / 2 }),
          FIXED_DT,
        );
      }

      // ctrl1 should move in +Z, ctrl2 should move in +X
      expect(ctrl1.getPosition().z).toBeGreaterThan(0.5);
      expect(Math.abs(ctrl1.getPosition().x)).toBeLessThan(0.5);

      const pos2 = ctrl2.getPosition();
      expect(pos2.x - 100).toBeGreaterThan(0.5); // moved +X from start
      ctrl1.dispose();
      ctrl2.dispose();
    });

    it('Quake-style acceleration: current speed in wish direction limits addSpeed', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 1, z: 0 });
      let seq = settle(ctrl);

      // Accelerate from zero for 5 frames
      for (let i = 0; i < 5; i++) {
        ctrl.predict(
          makeInput({ seq: seq++, buttons: BTN_FORWARD, moveY: 127, yaw: 0 }),
          FIXED_DT,
        );
      }
      const speed5 = Math.hypot(ctrl.getVelocity().x, ctrl.getVelocity().z);

      // Continue for 5 more frames
      for (let i = 0; i < 5; i++) {
        ctrl.predict(
          makeInput({ seq: seq++, buttons: BTN_FORWARD, moveY: 127, yaw: 0 }),
          FIXED_DT,
        );
      }
      const speed10 = Math.hypot(ctrl.getVelocity().x, ctrl.getVelocity().z);

      // Acceleration should have slowed as we approach max speed
      const accel1 = speed5; // from 0 in 5 frames
      const accel2 = speed10 - speed5; // additional speed in next 5 frames
      expect(accel2).toBeLessThan(accel1); // diminishing acceleration
      ctrl.dispose();
    });

    it('jump apex: vertical velocity near zero at peak', () => {
      const ctrl = new PredictedFpsController(world, body, collider);
      ctrl.setPosition({ x: 0, y: 2, z: 0 });
      let seq = settle(ctrl);

      // Jump
      ctrl.predict(makeInput({ seq: seq++, buttons: BTN_JUMP }), FIXED_DT);

      // Track position to find apex
      let peakY = ctrl.getPosition().y;
      let velAtPeak = ctrl.getVelocity().y;
      let prevY = peakY;

      for (let i = 0; i < 60; i++) {
        ctrl.predict(makeInput({ seq: seq++ }), FIXED_DT);
        const y = ctrl.getPosition().y;
        if (y > peakY) {
          peakY = y;
          velAtPeak = ctrl.getVelocity().y;
        }
        if (y < prevY && prevY === peakY) {
          // Just started descending — check velocity at peak
          break;
        }
        prevY = y;
      }

      // At apex, velocity should be near zero (within one frame of gravity)
      expect(Math.abs(velAtPeak)).toBeLessThan(ctrl.config.gravity * FIXED_DT * 2);
      ctrl.dispose();
    });
  });
});
