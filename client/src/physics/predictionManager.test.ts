import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as RAPIER from '@dimforge/rapier3d-compat';
import {
  PredictionManager,
  FIXED_DT,
  MAX_CATCHUP_STEPS,
  HARD_SNAP_DISTANCE,
  VISUAL_SMOOTH_RATE,
} from './predictionManager';
import {
  BTN_FORWARD,
  BTN_SPRINT,
  BTN_JUMP,
  FLAG_ON_GROUND,
  metersToMm,
  angleToI16,
  type NetPlayerState,
  type ChunkFullPacket,
  type BlockCell,
} from '../net/protocol';

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

function makeGroundChunk(): ChunkFullPacket {
  const blocks: BlockCell[] = [];
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      blocks.push({ x, y: 15, z, material: 1 });
    }
  }
  return { type: 'chunkFull', chunk: [0, -1, 0], version: 1, blocks };
}

describe('PredictionManager', () => {
  let world: RAPIER.World;
  let body: RAPIER.RigidBody;
  let collider: RAPIER.Collider;

  beforeAll(async () => {
    await RAPIER.init();
  });

  beforeEach(() => {
    world = new RAPIER.World({ x: 0, y: -20, z: 0 });
    const groundDesc = RAPIER.ColliderDesc.cuboid(50, 0.5, 50)
      .setTranslation(0, -0.5, 0);
    world.createCollider(groundDesc);
    body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.45, 0.35), body);
    world.step();
  });

  // ──────────────────────────────────────────────
  // Initialization & lifecycle
  // ──────────────────────────────────────────────

  describe('initialization', () => {
    it('is not initialized before first reconcile', () => {
      const mgr = new PredictionManager(world, body, collider);
      expect(mgr.isInitialized()).toBe(false);
      expect(mgr.getInterpolatedPosition()).toBeNull();
      mgr.dispose();
    });

    it('returns no inputs before world is loaded', () => {
      const mgr = new PredictionManager(world, body, collider);
      // Reconcile to initialize but don't load world
      mgr.reconcile(0, makeNetState({ position: [0, 1, 0], flags: FLAG_ON_GROUND }));
      expect(mgr.isInitialized()).toBe(true);
      expect(mgr.isWorldLoaded()).toBe(false);

      const cmds = mgr.update(FIXED_DT, BTN_FORWARD, 0, 0);
      expect(cmds).toHaveLength(0);
      mgr.dispose();
    });

    it('returns no inputs before reconcile initializes', () => {
      const mgr = new PredictionManager(world, body, collider);
      mgr.applyWorldPacket(makeGroundChunk());
      expect(mgr.isWorldLoaded()).toBe(true);
      expect(mgr.isInitialized()).toBe(false);

      const cmds = mgr.update(FIXED_DT, BTN_FORWARD, 0, 0);
      expect(cmds).toHaveLength(0);
      mgr.dispose();
    });

    it('produces inputs after world loaded AND reconcile initialized', () => {
      const mgr = new PredictionManager(world, body, collider);
      mgr.applyWorldPacket(makeGroundChunk());
      mgr.reconcile(0, makeNetState({ position: [0, 1, 0], flags: FLAG_ON_GROUND }));
      expect(mgr.isWorldLoaded()).toBe(true);
      expect(mgr.isInitialized()).toBe(true);

      const cmds = mgr.update(FIXED_DT, BTN_FORWARD, 0, 0);
      expect(cmds).toHaveLength(1);
      mgr.dispose();
    });
  });

  // ──────────────────────────────────────────────
  // Fixed timestep accumulator
  // ──────────────────────────────────────────────

  describe('fixed timestep accumulator', () => {
    function readyManager(): PredictionManager {
      const mgr = new PredictionManager(world, body, collider);
      mgr.applyWorldPacket(makeGroundChunk());
      mgr.reconcile(0, makeNetState({ position: [0, 1, 0], flags: FLAG_ON_GROUND }));
      return mgr;
    }

    it('produces exactly 1 input per FIXED_DT', () => {
      const mgr = readyManager();
      const cmds = mgr.update(FIXED_DT, 0, 0, 0);
      expect(cmds).toHaveLength(1);
      mgr.dispose();
    });

    it('produces 0 inputs for sub-tick frame', () => {
      const mgr = readyManager();
      const cmds = mgr.update(FIXED_DT * 0.5, 0, 0, 0);
      expect(cmds).toHaveLength(0);
      mgr.dispose();
    });

    it('accumulates fractional time across frames', () => {
      const mgr = readyManager();
      const cmds1 = mgr.update(FIXED_DT * 0.6, 0, 0, 0);
      expect(cmds1).toHaveLength(0);

      const cmds2 = mgr.update(FIXED_DT * 0.6, 0, 0, 0);
      expect(cmds2).toHaveLength(1); // 0.6 + 0.6 = 1.2 * FIXED_DT → 1 tick
      mgr.dispose();
    });

    it('produces multiple inputs for large frame delta', () => {
      const mgr = readyManager();
      const cmds = mgr.update(FIXED_DT * 3, 0, 0, 0);
      expect(cmds).toHaveLength(3);
      mgr.dispose();
    });

    it('caps at MAX_CATCHUP_STEPS per frame', () => {
      const mgr = readyManager();
      const cmds = mgr.update(FIXED_DT * 10, 0, 0, 0);
      expect(cmds).toHaveLength(MAX_CATCHUP_STEPS);
      mgr.dispose();
    });

    it('clamps accumulator to FIXED_DT after catchup overflow', () => {
      const mgr = readyManager();
      mgr.update(FIXED_DT * 10, 0, 0, 0); // caps at 4 steps
      // Remaining accumulator should be clamped to at most FIXED_DT
      const cmds = mgr.update(FIXED_DT * 0.5, 0, 0, 0);
      // Should produce 1 tick (leftover + 0.5)
      expect(cmds.length).toBeLessThanOrEqual(2);
      mgr.dispose();
    });
  });

  // ──────────────────────────────────────────────
  // Input sequence generation
  // ──────────────────────────────────────────────

  describe('input sequence generation', () => {
    function readyManager(): PredictionManager {
      const mgr = new PredictionManager(world, body, collider);
      mgr.applyWorldPacket(makeGroundChunk());
      mgr.reconcile(0, makeNetState({ position: [0, 1, 0], flags: FLAG_ON_GROUND }));
      return mgr;
    }

    it('sequences start at 1 and increment', () => {
      const mgr = readyManager();
      const cmds1 = mgr.update(FIXED_DT, 0, 0, 0);
      const cmds2 = mgr.update(FIXED_DT, 0, 0, 0);
      expect(cmds1[0].seq).toBe(1);
      expect(cmds2[0].seq).toBe(2);
      mgr.dispose();
    });

    it('sequences wrap around at u16 boundary', () => {
      const mgr = readyManager();
      // Advance near wraparound, periodically reconciling to keep
      // pending count below the throttle cap (MAX_PENDING_INPUTS).
      for (let i = 0; i < 0xfffe; i++) {
        mgr.update(FIXED_DT, 0, 0, 0);
        // Reconcile every 20 ticks to clear the pending queue
        if ((i + 1) % 20 === 0) {
          const ackSeq = mgr.getNextSeq() - 1;
          mgr.reconcile(ackSeq & 0xffff, makeNetState({ position: mgr.getPosition(), flags: FLAG_ON_GROUND }));
        }
      }
      const cmdsLast = mgr.update(FIXED_DT, 0, 0, 0);
      expect(cmdsLast[0].seq).toBe(0xffff);

      const cmdsWrap = mgr.update(FIXED_DT, 0, 0, 0);
      expect(cmdsWrap[0].seq).toBe(0);
      mgr.dispose();
    });
  });

  // ──────────────────────────────────────────────
  // Visual smoothing
  // ──────────────────────────────────────────────

  describe('visual smoothing', () => {
    function readyManagerAt(pos: [number, number, number]): PredictionManager {
      const mgr = new PredictionManager(world, body, collider);
      mgr.applyWorldPacket(makeGroundChunk());
      mgr.reconcile(0, makeNetState({ position: pos, flags: FLAG_ON_GROUND }));
      return mgr;
    }

    it('correction offset decays exponentially', () => {
      const mgr = readyManagerAt([0, 1, 0]);

      // Predict 10 frames moving forward
      for (let i = 0; i < 10; i++) {
        mgr.update(FIXED_DT, BTN_FORWARD, 0, 0);
      }

      // Reconcile with server acking only 5, at a noticeably different position
      // The 5 unacked inputs will be replayed from a different start, creating offset
      const serverState = makeNetState({
        position: [0.5, 1, 0.3],
        flags: FLAG_ON_GROUND,
      });
      mgr.reconcile(5, serverState);

      const offset1 = mgr.getCorrectionOffset();
      const offsetMag1 = Math.hypot(...offset1);

      // Run a few more frames — offset should decay
      for (let i = 0; i < 10; i++) {
        mgr.update(FIXED_DT, 0, 0, 0);
      }

      const offset2 = mgr.getCorrectionOffset();
      const offsetMag2 = Math.hypot(...offset2);

      expect(offsetMag2).toBeLessThan(offsetMag1);
      mgr.dispose();
    });

    it('hard snap resets correction offset to zero', () => {
      const mgr = readyManagerAt([0, 1, 0]);

      // Predict a few frames
      for (let i = 0; i < 3; i++) {
        mgr.update(FIXED_DT, BTN_FORWARD, 0, 0);
      }

      // Server says player is 10m away (> HARD_SNAP_DISTANCE)
      const serverState = makeNetState({
        position: [10, 1, 10],
        flags: FLAG_ON_GROUND,
      });
      mgr.reconcile(3, serverState);

      const offset = mgr.getCorrectionOffset();
      expect(Math.hypot(...offset)).toBe(0);
      mgr.dispose();
    });

    it('interpolated position includes correction offset', () => {
      const mgr = readyManagerAt([5, 1, 5]);

      // Predict one frame
      mgr.update(FIXED_DT, 0, 0, 0);

      // Reconcile with small offset
      mgr.reconcile(1, makeNetState({
        position: [5.5, 1, 5],
        flags: FLAG_ON_GROUND,
      }));

      const pos = mgr.getInterpolatedPosition();
      expect(pos).not.toBeNull();
      // Position should reflect correction offset
      const offset = mgr.getCorrectionOffset();
      expect(Math.hypot(...offset)).toBeGreaterThan(0);
      mgr.dispose();
    });
  });

  // ──────────────────────────────────────────────
  // Reconciliation
  // ──────────────────────────────────────────────

  describe('reconciliation', () => {
    function readyManagerAt(pos: [number, number, number]): PredictionManager {
      const mgr = new PredictionManager(world, body, collider);
      mgr.applyWorldPacket(makeGroundChunk());
      mgr.reconcile(0, makeNetState({ position: pos, flags: FLAG_ON_GROUND }));
      return mgr;
    }

    it('first reconcile initializes position', () => {
      const mgr = new PredictionManager(world, body, collider);
      mgr.applyWorldPacket(makeGroundChunk());

      mgr.reconcile(0, makeNetState({ position: [5, 2, 3], flags: FLAG_ON_GROUND }));

      expect(mgr.isInitialized()).toBe(true);
      const pos = mgr.getPosition();
      expect(pos[0]).toBeCloseTo(5, 0);
      expect(pos[1]).toBeCloseTo(2, 0);
      expect(pos[2]).toBeCloseTo(3, 0);
      mgr.dispose();
    });

    it('reconcile with all inputs acked snaps to server', () => {
      const mgr = readyManagerAt([0, 1, 0]);

      // Predict 5 frames forward
      for (let i = 0; i < 5; i++) {
        mgr.update(FIXED_DT, BTN_FORWARD, 0, 0);
      }
      expect(mgr.getPendingInputCount()).toBe(5);

      // Server acks all 5
      mgr.reconcile(5, makeNetState({ position: [0, 1, 3], flags: FLAG_ON_GROUND }));

      expect(mgr.getPendingInputCount()).toBe(0);
      const pos = mgr.getPosition();
      expect(pos[2]).toBeCloseTo(3, 0); // Should match server
      mgr.dispose();
    });

    it('reconcile replays unacked inputs', () => {
      const mgr = readyManagerAt([0, 1, 0]);

      // Predict 5 frames moving forward
      for (let i = 0; i < 5; i++) {
        mgr.update(FIXED_DT, BTN_FORWARD, 0, 0);
      }

      // Server only acks 2 (inputs 3,4,5 need replay)
      mgr.reconcile(2, makeNetState({ position: [0, 1, 0.1], flags: FLAG_ON_GROUND }));

      expect(mgr.getPendingInputCount()).toBe(3);
      const pos = mgr.getPosition();
      expect(pos[2]).toBeGreaterThan(0.1); // Replayed inputs moved forward
      mgr.dispose();
    });

    it('multiple reconciliations converge', () => {
      const mgr = readyManagerAt([0, 1, 0]);

      // Predict and reconcile multiple times
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < 10; i++) {
          mgr.update(FIXED_DT, BTN_FORWARD, 0, 0);
        }
        const tick = (round + 1) * 10;
        mgr.reconcile(tick, makeNetState({
          position: [0, 1, tick * FIXED_DT * 5],
          flags: FLAG_ON_GROUND,
        }));
      }

      // Should have converged - pending count should be 0 after final ack
      expect(mgr.getPendingInputCount()).toBe(0);
      mgr.dispose();
    });
  });

  // ──────────────────────────────────────────────
  // World packet handling
  // ──────────────────────────────────────────────

  describe('world packets', () => {
    it('applyWorldPacket loads chunk and enables worldLoaded', () => {
      const mgr = new PredictionManager(world, body, collider);
      expect(mgr.isWorldLoaded()).toBe(false);

      mgr.applyWorldPacket(makeGroundChunk());
      expect(mgr.isWorldLoaded()).toBe(true);
      mgr.dispose();
    });

    it('getRenderBlocks returns blocks from loaded chunks', () => {
      const mgr = new PredictionManager(world, body, collider);
      mgr.applyWorldPacket(makeGroundChunk());

      const blocks = mgr.getRenderBlocks();
      expect(blocks.length).toBe(256); // 16x16 ground blocks
      mgr.dispose();
    });
  });

  // ──────────────────────────────────────────────
  // Tick counting
  // ──────────────────────────────────────────────

  describe('tick counting', () => {
    it('tickCount increments with each fixed step', () => {
      const mgr = new PredictionManager(world, body, collider);
      mgr.applyWorldPacket(makeGroundChunk());
      mgr.reconcile(0, makeNetState({ position: [0, 1, 0], flags: FLAG_ON_GROUND }));

      expect(mgr.getTickCount()).toBe(0);
      mgr.update(FIXED_DT, 0, 0, 0);
      expect(mgr.getTickCount()).toBe(1);
      mgr.update(FIXED_DT * 3, 0, 0, 0);
      expect(mgr.getTickCount()).toBe(4);
      mgr.dispose();
    });
  });
});
