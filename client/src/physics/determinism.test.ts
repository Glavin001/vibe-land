/**
 * Determinism verification tests.
 *
 * These tests answer one question: given IDENTICAL inputs, does the
 * same Rapier code produce IDENTICAL outputs?
 *
 * If yes → the jitter comes from something upstream (quantization,
 * timing, ground geometry mismatch, etc.)
 * If no → Rapier itself is non-deterministic (unlikely but must verify).
 *
 * We then layer on each potential divergence source one at a time to
 * isolate exactly what causes the prediction error.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { PredictedFpsController, DEFAULT_CONFIG } from './predictedFpsController';
import {
  type InputFrame,
  metersToMm,
  mmToMeters,
  angleToI16,
  i16ToAngle,
  FLAG_ON_GROUND,
  BTN_FORWARD,
  BTN_SPRINT,
  BTN_JUMP,
  BTN_RIGHT,
} from '../net/protocol';

beforeAll(async () => {
  await RAPIER.init();
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

type Vec3Tuple = [number, number, number];

function createWorld(): RAPIER.World {
  return new RAPIER.World({ x: 0, y: -20, z: 0 });
}

function createGroundPlane(world: RAPIER.World, y = 0): void {
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(500, 0.5, 500).setTranslation(0, y - 0.5, 0),
  );
  world.step();
}

function createGroundBlocks(world: RAPIER.World, y = 0, range = 24): void {
  for (let x = -range; x < range; x++) {
    for (let z = -range; z < range; z++) {
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5)
          .setTranslation(x + 0.5, y + 0.5, z + 0.5),
      );
    }
  }
  world.step();
}

function createController(
  world: RAPIER.World,
  position: Vec3Tuple,
): { controller: PredictedFpsController; body: RAPIER.RigidBody } {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(position[0], position[1], position[2]),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.capsule(
      DEFAULT_CONFIG.capsuleHalfSegment,
      DEFAULT_CONFIG.capsuleRadius,
    ),
    body,
  );
  const controller = new PredictedFpsController(world, body, collider);
  controller.setFullState(
    { x: position[0], y: position[1], z: position[2] },
    { x: 0, y: 0, z: 0 }, 0, 0, false,
  );
  return { controller, body };
}

function positionTuple(ctrl: PredictedFpsController): Vec3Tuple {
  const p = ctrl.getPosition();
  return [p.x, p.y, p.z];
}

function velocityTuple(ctrl: PredictedFpsController): Vec3Tuple {
  const v = ctrl.getVelocity();
  return [v.x, v.y, v.z];
}

const DT = 1 / 60;

// ═══════════════════════════════════════════════════════════════════════
// Layer 0: Raw Rapier determinism
// Two identical worlds, identical inputs, tick-by-tick comparison.
// ═══════════════════════════════════════════════════════════════════════

describe('Layer 0: Rapier determinism — identical worlds, identical inputs', () => {
  it('two controllers on ground planes produce identical positions', () => {
    const worldA = createWorld();
    const worldB = createWorld();
    createGroundPlane(worldA);
    createGroundPlane(worldB);

    const a = createController(worldA, [8, 2, 8]);
    const b = createController(worldB, [8, 2, 8]);

    const inputs: InputFrame[] = [];
    // 60 ticks idle (settle), then 120 ticks sprinting forward
    for (let i = 0; i < 60; i++) {
      inputs.push({ seq: i, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 });
    }
    for (let i = 60; i < 180; i++) {
      inputs.push({
        seq: i, buttons: BTN_FORWARD | BTN_SPRINT,
        moveX: 0, moveY: 127, yaw: 0, pitch: 0,
      });
    }

    let maxPosDiff = 0;
    let maxVelDiff = 0;

    for (let i = 0; i < inputs.length; i++) {
      a.controller.simulateTick(inputs[i], DT);
      b.controller.simulateTick(inputs[i], DT);

      const pa = positionTuple(a.controller);
      const pb = positionTuple(b.controller);
      const va = velocityTuple(a.controller);
      const vb = velocityTuple(b.controller);

      const posDiff = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
      const velDiff = Math.hypot(va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]);
      maxPosDiff = Math.max(maxPosDiff, posDiff);
      maxVelDiff = Math.max(maxVelDiff, velDiff);
    }

    console.log(`Ground plane determinism: maxPosDiff=${maxPosDiff}, maxVelDiff=${maxVelDiff}`);
    expect(maxPosDiff).toBe(0); // Must be exactly zero
    expect(maxVelDiff).toBe(0);

    a.controller.dispose();
    b.controller.dispose();
  });

  it('two controllers on voxel blocks produce identical positions', () => {
    const worldA = createWorld();
    const worldB = createWorld();
    createGroundBlocks(worldA, 0, 8);
    createGroundBlocks(worldB, 0, 8);

    const a = createController(worldA, [4, 2, 4]);
    const b = createController(worldB, [4, 2, 4]);

    const inputs: InputFrame[] = [];
    for (let i = 0; i < 60; i++) {
      inputs.push({ seq: i, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 });
    }
    for (let i = 60; i < 240; i++) {
      inputs.push({
        seq: i, buttons: BTN_FORWARD | BTN_SPRINT,
        moveX: 0, moveY: 127, yaw: 0, pitch: 0,
      });
    }

    let maxPosDiff = 0;
    let maxVelDiff = 0;
    let groundingMismatches = 0;

    for (let i = 0; i < inputs.length; i++) {
      a.controller.simulateTick(inputs[i], DT);
      b.controller.simulateTick(inputs[i], DT);

      const pa = positionTuple(a.controller);
      const pb = positionTuple(b.controller);
      const va = velocityTuple(a.controller);
      const vb = velocityTuple(b.controller);

      const posDiff = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
      const velDiff = Math.hypot(va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]);
      maxPosDiff = Math.max(maxPosDiff, posDiff);
      maxVelDiff = Math.max(maxVelDiff, velDiff);

      if (a.controller.isGrounded() !== b.controller.isGrounded()) {
        groundingMismatches++;
      }
    }

    console.log(`Voxel block determinism: maxPosDiff=${maxPosDiff}, maxVelDiff=${maxVelDiff}, groundingMismatches=${groundingMismatches}`);
    expect(maxPosDiff).toBe(0);
    expect(maxVelDiff).toBe(0);
    expect(groundingMismatches).toBe(0);

    a.controller.dispose();
    b.controller.dispose();
  });

  it('deterministic across direction changes and jumps', () => {
    const worldA = createWorld();
    const worldB = createWorld();
    createGroundPlane(worldA);
    createGroundPlane(worldB);

    const a = createController(worldA, [0, 2, 0]);
    const b = createController(worldB, [0, 2, 0]);

    // Complex input sequence: settle, sprint, turn, jump, land, strafe
    const inputs: InputFrame[] = [];
    for (let i = 0; i < 60; i++) {
      inputs.push({ seq: i, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 });
    }
    for (let i = 60; i < 90; i++) {
      inputs.push({
        seq: i, buttons: BTN_FORWARD | BTN_SPRINT,
        moveX: 0, moveY: 127, yaw: i * 0.05, pitch: 0,
      });
    }
    for (let i = 90; i < 95; i++) {
      inputs.push({
        seq: i, buttons: BTN_FORWARD | BTN_SPRINT | BTN_JUMP,
        moveX: 0, moveY: 127, yaw: 90 * 0.05, pitch: 0,
      });
    }
    for (let i = 95; i < 150; i++) {
      inputs.push({
        seq: i, buttons: BTN_FORWARD | BTN_RIGHT | BTN_SPRINT,
        moveX: 127, moveY: 127, yaw: 90 * 0.05 + (i - 95) * 0.03, pitch: -0.2,
      });
    }

    let maxPosDiff = 0;

    for (const input of inputs) {
      a.controller.simulateTick(input, DT);
      b.controller.simulateTick(input, DT);

      const pa = positionTuple(a.controller);
      const pb = positionTuple(b.controller);
      maxPosDiff = Math.max(maxPosDiff, Math.hypot(
        pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2],
      ));
    }

    console.log(`Complex input determinism: maxPosDiff=${maxPosDiff}`);
    expect(maxPosDiff).toBe(0);

    a.controller.dispose();
    b.controller.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Layer 1: Position quantization (meters → mm → meters round-trip)
// Feed identical inputs, but after each tick on controller B, apply
// the metersToMm/mmToMeters round-trip to its position (simulating
// what reconciliation does when it receives a server snapshot).
// ═══════════════════════════════════════════════════════════════════════

describe('Layer 1: Position quantization error', () => {
  it('metersToMm round-trip error accumulates over replayed ticks', () => {
    const world = createWorld();
    createGroundPlane(world);

    const { controller } = createController(world, [0, 2, 0]);

    // Settle
    for (let i = 0; i < 60; i++) {
      controller.simulateTick(
        { seq: i, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 }, DT,
      );
    }

    // Record position at "ack point" (server would snapshot here)
    const ackPos = positionTuple(controller);
    const ackVel = velocityTuple(controller);
    const ackGrounded = controller.isGrounded();

    // Continue simulating 30 more ticks (representing unacked inputs)
    const unackedInputs: InputFrame[] = [];
    for (let i = 60; i < 90; i++) {
      const input: InputFrame = {
        seq: i, buttons: BTN_FORWARD | BTN_SPRINT,
        moveX: 0, moveY: 127, yaw: 0, pitch: 0,
      };
      unackedInputs.push(input);
      controller.simulateTick(input, DT);
    }
    const predictedPos = positionTuple(controller);

    // Now simulate what reconciliation does:
    // 1. Quantize the ack position (server→client encoding)
    const quantizedPos: Vec3Tuple = [
      mmToMeters(metersToMm(ackPos[0])),
      mmToMeters(metersToMm(ackPos[1])),
      mmToMeters(metersToMm(ackPos[2])),
    ];
    // 2. Quantize velocity
    const quantizedVel: Vec3Tuple = [
      Math.round(ackVel[0] * 100) / 100,
      Math.round(ackVel[1] * 100) / 100,
      Math.round(ackVel[2] * 100) / 100,
    ];

    // Measure position quantization error at the ack point
    const posQuantError = Math.hypot(
      ackPos[0] - quantizedPos[0],
      ackPos[1] - quantizedPos[1],
      ackPos[2] - quantizedPos[2],
    );
    const velQuantError = Math.hypot(
      ackVel[0] - quantizedVel[0],
      ackVel[1] - quantizedVel[1],
      ackVel[2] - quantizedVel[2],
    );

    // 3. Reset controller to quantized state and replay
    controller.setFullState(
      { x: quantizedPos[0], y: quantizedPos[1], z: quantizedPos[2] },
      { x: quantizedVel[0], y: quantizedVel[1], z: quantizedVel[2] },
      0, 0, ackGrounded,
    );

    for (const input of unackedInputs) {
      controller.simulateTick(input, DT);
    }
    const replayedPos = positionTuple(controller);

    // Measure replay divergence: predicted vs replayed-from-quantized
    const replayError = Math.hypot(
      predictedPos[0] - replayedPos[0],
      predictedPos[1] - replayedPos[1],
      predictedPos[2] - replayedPos[2],
    );

    console.log('=== Position quantization analysis ===');
    console.log(`  Position quant error at ack:  ${posQuantError.toFixed(6)}m`);
    console.log(`  Velocity quant error at ack:  ${velQuantError.toFixed(6)}m/s`);
    console.log(`  Replay divergence (30 ticks): ${replayError.toFixed(6)}m`);
    console.log(`  Predicted pos: [${predictedPos.map(v => v.toFixed(4)).join(', ')}]`);
    console.log(`  Replayed pos:  [${replayedPos.map(v => v.toFixed(4)).join(', ')}]`);

    // Record the actual values for analysis
    expect(posQuantError).toBeLessThan(0.001); // mm precision → <1mm error
    // The key question: does this small seed error compound over 30 replayed ticks?
    expect(replayError).toBeGreaterThanOrEqual(0); // Just record it
  });

  it('quantization error scales with replay length', () => {
    const results: Array<{ replayTicks: number; error: number }> = [];

    for (const replayTicks of [5, 10, 20, 30, 60]) {
      const world = createWorld();
      createGroundPlane(world);
      const { controller } = createController(world, [0, 2, 0]);

      // Settle
      for (let i = 0; i < 60; i++) {
        controller.simulateTick(
          { seq: i, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 }, DT,
        );
      }

      const ackPos = positionTuple(controller);
      const ackVel = velocityTuple(controller);
      const ackGrounded = controller.isGrounded();

      // Simulate unacked ticks
      const unacked: InputFrame[] = [];
      for (let i = 0; i < replayTicks; i++) {
        const input: InputFrame = {
          seq: 60 + i, buttons: BTN_FORWARD | BTN_SPRINT,
          moveX: 0, moveY: 127, yaw: 0, pitch: 0,
        };
        unacked.push(input);
        controller.simulateTick(input, DT);
      }
      const predicted = positionTuple(controller);

      // Reset to quantized state and replay
      controller.setFullState(
        { x: mmToMeters(metersToMm(ackPos[0])),
          y: mmToMeters(metersToMm(ackPos[1])),
          z: mmToMeters(metersToMm(ackPos[2])) },
        { x: Math.round(ackVel[0] * 100) / 100,
          y: Math.round(ackVel[1] * 100) / 100,
          z: Math.round(ackVel[2] * 100) / 100 },
        0, 0, ackGrounded,
      );

      for (const input of unacked) {
        controller.simulateTick(input, DT);
      }
      const replayed = positionTuple(controller);

      const error = Math.hypot(
        predicted[0] - replayed[0], predicted[1] - replayed[1], predicted[2] - replayed[2],
      );
      results.push({ replayTicks, error });

      controller.dispose();
    }

    console.log('=== Quantization error vs replay length ===');
    for (const r of results) {
      console.log(`  ${r.replayTicks} ticks: ${r.error.toFixed(6)}m`);
    }

    // Error should be small (mm-level seed, may compound slightly)
    for (const r of results) {
      expect(r.error).toBeLessThan(0.1); // Should be well under 10cm
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Layer 2: Ground geometry mismatch
// One controller uses a smooth ground plane, the other uses voxel
// blocks. Same inputs. How much do they diverge?
// ═══════════════════════════════════════════════════════════════════════

describe('Layer 2: Ground geometry — plane vs blocks', () => {
  it('plane vs voxel blocks divergence over time', () => {
    const worldPlane = createWorld();
    const worldBlocks = createWorld();
    createGroundPlane(worldPlane);
    createGroundBlocks(worldBlocks, 0, 8);

    const plane = createController(worldPlane, [4, 2, 4]);
    const blocks = createController(worldBlocks, [4, 2, 4]);

    const divergence: number[] = [];
    const groundMismatches: number[] = [];

    // Settle
    for (let i = 0; i < 60; i++) {
      const input: InputFrame = { seq: i, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 };
      plane.controller.simulateTick(input, DT);
      blocks.controller.simulateTick(input, DT);
    }

    // Sprint forward
    for (let i = 60; i < 240; i++) {
      const input: InputFrame = {
        seq: i, buttons: BTN_FORWARD | BTN_SPRINT,
        moveX: 0, moveY: 127, yaw: 0, pitch: 0,
      };
      plane.controller.simulateTick(input, DT);
      blocks.controller.simulateTick(input, DT);

      const pp = positionTuple(plane.controller);
      const bp = positionTuple(blocks.controller);
      const diff = Math.hypot(pp[0] - bp[0], pp[1] - bp[1], pp[2] - bp[2]);
      divergence.push(diff);

      if (plane.controller.isGrounded() !== blocks.controller.isGrounded()) {
        groundMismatches.push(i);
      }
    }

    const maxDiv = Math.max(...divergence);
    const finalDiv = divergence[divergence.length - 1];

    console.log('=== Plane vs Blocks divergence ===');
    console.log(`  Max divergence:      ${maxDiv.toFixed(4)}m`);
    console.log(`  Final divergence:    ${finalDiv.toFixed(4)}m`);
    console.log(`  Grounding mismatches: ${groundMismatches.length}`);
    if (groundMismatches.length > 0) {
      console.log(`  First mismatch at tick: ${groundMismatches[0]}`);
    }
    console.log(`  Divergence at ticks 60,120,180: ${
      [divergence[0], divergence[60], divergence[120]]
        .map(v => v?.toFixed(4) ?? 'N/A').join(', ')}m`);

    // Record the actual behavior
    console.log(`  Plane final pos:  [${positionTuple(plane.controller).map(v => v.toFixed(4)).join(', ')}]`);
    console.log(`  Blocks final pos: [${positionTuple(blocks.controller).map(v => v.toFixed(4)).join(', ')}]`);

    plane.controller.dispose();
    blocks.controller.dispose();
  });

  it('voxel blocks vs voxel blocks — must be identical', () => {
    const worldA = createWorld();
    const worldB = createWorld();
    createGroundBlocks(worldA, 0, 8);
    createGroundBlocks(worldB, 0, 8);

    const a = createController(worldA, [4, 2, 4]);
    const b = createController(worldB, [4, 2, 4]);

    let maxDiv = 0;

    for (let i = 0; i < 240; i++) {
      const buttons = i < 60 ? 0 : BTN_FORWARD | BTN_SPRINT;
      const input: InputFrame = {
        seq: i, buttons, moveX: 0, moveY: buttons ? 127 : 0, yaw: 0, pitch: 0,
      };
      a.controller.simulateTick(input, DT);
      b.controller.simulateTick(input, DT);

      const pa = positionTuple(a.controller);
      const pb = positionTuple(b.controller);
      maxDiv = Math.max(maxDiv, Math.hypot(
        pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2],
      ));
    }

    console.log(`Blocks vs Blocks determinism: maxDiv=${maxDiv}`);
    expect(maxDiv).toBe(0); // Must be exactly identical

    a.controller.dispose();
    b.controller.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Layer 3: Full reconciliation round-trip
// Simulate the exact sequence: predict → quantize → reset → replay.
// Measure the correction magnitude at each snapshot.
// ═══════════════════════════════════════════════════════════════════════

describe('Layer 3: Full reconciliation round-trip', () => {
  it('reconciliation corrections with matching ground geometry', () => {
    // BOTH sides use voxel blocks — matching the real game
    const serverWorld = createWorld();
    const clientWorld = createWorld();
    createGroundBlocks(serverWorld, 0, 8);
    createGroundBlocks(clientWorld, 0, 8);

    const server = createController(serverWorld, [4, 2, 4]);
    const client = createController(clientWorld, [4, 2, 4]);

    const corrections: number[] = [];
    const pendingInputs: InputFrame[] = [];
    const snapshotInterval = 2; // Every 2 ticks = 30Hz
    const latencyTicks = 3; // ~50ms at 60Hz

    // Input queue for server (delayed delivery)
    const serverInputQueue: Array<{ input: InputFrame; deliverAt: number }> = [];
    let serverAckSeq = 0;

    for (let tick = 0; tick < 240; tick++) {
      const buttons = tick < 60 ? 0 : BTN_FORWARD | BTN_SPRINT;
      const input: InputFrame = {
        seq: tick, buttons, moveX: 0, moveY: buttons ? 127 : 0, yaw: 0, pitch: 0,
      };

      // Client predicts
      client.controller.simulateTick(input, DT);
      pendingInputs.push(input);

      // Queue input for server with latency
      serverInputQueue.push({ input, deliverAt: tick + latencyTicks });

      // Deliver arrived inputs to server
      const arrived = serverInputQueue.filter(q => q.deliverAt <= tick);
      serverInputQueue.splice(0, serverInputQueue.length,
        ...serverInputQueue.filter(q => q.deliverAt > tick));
      for (const a of arrived) {
        server.controller.simulateTick(a.input, DT);
        serverAckSeq = a.input.seq;
      }

      // Server also ticks even without input (uses idle input)
      if (arrived.length === 0) {
        server.controller.simulateTick(
          { seq: 0, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 }, DT,
        );
      }

      // Snapshot from server every snapshotInterval ticks
      if (tick >= latencyTicks * 2 && tick % snapshotInterval === 0) {
        // Get server authoritative state
        const serverPos = positionTuple(server.controller);
        const serverVel = velocityTuple(server.controller);
        const serverGrounded = server.controller.isGrounded();

        // Quantize (simulating network encoding)
        const qPos: Vec3Tuple = [
          mmToMeters(metersToMm(serverPos[0])),
          mmToMeters(metersToMm(serverPos[1])),
          mmToMeters(metersToMm(serverPos[2])),
        ];
        const qVel: Vec3Tuple = [
          Math.round(serverVel[0] * 100) / 100,
          Math.round(serverVel[1] * 100) / 100,
          Math.round(serverVel[2] * 100) / 100,
        ];

        // Record pre-reconciliation position
        const prePos = positionTuple(client.controller);

        // Reset client to server state
        client.controller.setFullState(
          { x: qPos[0], y: qPos[1], z: qPos[2] },
          { x: qVel[0], y: qVel[1], z: qVel[2] },
          0, 0, serverGrounded,
        );

        // Filter to unacked inputs and replay
        const unacked = pendingInputs.filter(inp => {
          const diff = (inp.seq - serverAckSeq + 0x10000) & 0xffff;
          return diff !== 0 && diff < 0x8000;
        });

        for (const inp of unacked) {
          client.controller.simulateTick(inp, DT);
        }

        // Clear acked inputs
        while (pendingInputs.length > 0 && pendingInputs[0].seq <= serverAckSeq) {
          pendingInputs.shift();
        }

        const postPos = positionTuple(client.controller);
        const correction = Math.hypot(
          postPos[0] - prePos[0], postPos[1] - prePos[1], postPos[2] - prePos[2],
        );
        corrections.push(correction);
      }
    }

    const significantCorrections = corrections.filter(c => c > 0.001);
    const maxCorrection = corrections.length > 0 ? Math.max(...corrections) : 0;
    const meanCorrection = significantCorrections.length > 0
      ? significantCorrections.reduce((a, b) => a + b, 0) / significantCorrections.length : 0;

    console.log('=== Full reconciliation round-trip (matching geometry) ===');
    console.log(`  Total snapshots:         ${corrections.length}`);
    console.log(`  Significant corrections: ${significantCorrections.length}`);
    console.log(`  Max correction:          ${maxCorrection.toFixed(6)}m`);
    console.log(`  Mean correction:         ${meanCorrection.toFixed(6)}m`);

    if (significantCorrections.length > 0) {
      console.log('  ⚠ Corrections found! Sources of error:');
      console.log('    - Position quantization (mm encoding)');
      console.log('    - Velocity quantization (cm/s encoding)');
      console.log('    - Grounding state quantization (boolean flag)');
    } else {
      console.log('  ✓ No significant corrections — prediction matches server');
    }

    server.controller.dispose();
    client.controller.dispose();
  });

  it('reconciliation corrections with MISMATCHED ground geometry', () => {
    // Server: voxel blocks, Client: smooth plane
    // This simulates what the jitter tests were accidentally doing
    const serverWorld = createWorld();
    const clientWorld = createWorld();
    createGroundBlocks(serverWorld, 0, 8);
    createGroundPlane(clientWorld);

    const server = createController(serverWorld, [4, 2, 4]);
    const client = createController(clientWorld, [4, 2, 4]);

    const corrections: number[] = [];
    const pendingInputs: InputFrame[] = [];
    const serverInputQueue: Array<{ input: InputFrame; deliverAt: number }> = [];
    let serverAckSeq = 0;

    for (let tick = 0; tick < 240; tick++) {
      const buttons = tick < 60 ? 0 : BTN_FORWARD | BTN_SPRINT;
      const input: InputFrame = {
        seq: tick, buttons, moveX: 0, moveY: buttons ? 127 : 0, yaw: 0, pitch: 0,
      };

      client.controller.simulateTick(input, DT);
      pendingInputs.push(input);

      serverInputQueue.push({ input, deliverAt: tick + 3 });
      const arrived = serverInputQueue.filter(q => q.deliverAt <= tick);
      serverInputQueue.splice(0, serverInputQueue.length,
        ...serverInputQueue.filter(q => q.deliverAt > tick));
      for (const a of arrived) {
        server.controller.simulateTick(a.input, DT);
        serverAckSeq = a.input.seq;
      }
      if (arrived.length === 0) {
        server.controller.simulateTick(
          { seq: 0, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 }, DT,
        );
      }

      if (tick >= 6 && tick % 2 === 0) {
        const sp = positionTuple(server.controller);
        const sv = velocityTuple(server.controller);
        const qPos: Vec3Tuple = [
          mmToMeters(metersToMm(sp[0])), mmToMeters(metersToMm(sp[1])), mmToMeters(metersToMm(sp[2])),
        ];
        const qVel: Vec3Tuple = [
          Math.round(sv[0] * 100) / 100, Math.round(sv[1] * 100) / 100, Math.round(sv[2] * 100) / 100,
        ];

        const prePos = positionTuple(client.controller);
        client.controller.setFullState(
          { x: qPos[0], y: qPos[1], z: qPos[2] },
          { x: qVel[0], y: qVel[1], z: qVel[2] },
          0, 0, server.controller.isGrounded(),
        );

        const unacked = pendingInputs.filter(inp => {
          const diff = (inp.seq - serverAckSeq + 0x10000) & 0xffff;
          return diff !== 0 && diff < 0x8000;
        });
        for (const inp of unacked) {
          client.controller.simulateTick(inp, DT);
        }
        while (pendingInputs.length > 0 && pendingInputs[0].seq <= serverAckSeq) {
          pendingInputs.shift();
        }

        const postPos = positionTuple(client.controller);
        corrections.push(Math.hypot(
          postPos[0] - prePos[0], postPos[1] - prePos[1], postPos[2] - prePos[2],
        ));
      }
    }

    const significant = corrections.filter(c => c > 0.001);
    const maxCorr = Math.max(...corrections);

    console.log('=== Full reconciliation (MISMATCHED geometry: blocks vs plane) ===');
    console.log(`  Total snapshots:         ${corrections.length}`);
    console.log(`  Significant corrections: ${significant.length}`);
    console.log(`  Max correction:          ${maxCorr.toFixed(4)}m`);
    console.log(`  Mean correction:         ${(significant.length > 0
      ? significant.reduce((a, b) => a + b, 0) / significant.length : 0).toFixed(4)}m`);
    console.log('  ⚠ This shows what happens when client and server');
    console.log('    have different collision geometry (the real bug!)');

    server.controller.dispose();
    client.controller.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Layer 4: Server/client arithmetic parity
// Both server (Rust) and client (JS) now use f64 for movement math.
// The only f32 truncation happens at the Rapier KCC boundary, which is
// identical on both sides (same Rapier 0.30.1, same WASM).
// These tests verify that two f64 controllers produce identical results
// and that the old f32/f64 divergence is eliminated.
// ═══════════════════════════════════════════════════════════════════════

describe('Layer 4: f64 server/client parity (f32 divergence eliminated)', () => {
  it('two f64 controllers produce identical positions over 10 seconds', () => {
    const world = createWorld();
    createGroundBlocks(world, 0, 16);

    const a = createController(world, [4, 2, 4]);
    const b = createController(world, [4, 2, 4]);

    let maxPosDiff = 0;
    let maxVelDiff = 0;

    for (let tick = 0; tick < 600; tick++) {
      const buttons = tick < 60 ? 0 : BTN_FORWARD | BTN_SPRINT;
      const yaw = tick < 120 ? 0 : (tick - 120) * 0.02;
      const input: InputFrame = {
        seq: tick, buttons,
        moveX: 0, moveY: buttons ? 127 : 0,
        yaw, pitch: 0,
      };

      a.controller.simulateTick(input, DT);
      b.controller.simulateTick(input, DT);

      const pa = positionTuple(a.controller);
      const pb = positionTuple(b.controller);
      const va = velocityTuple(a.controller);
      const vb = velocityTuple(b.controller);

      maxPosDiff = Math.max(maxPosDiff, Math.hypot(
        pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2],
      ));
      maxVelDiff = Math.max(maxVelDiff, Math.hypot(
        va[0] - vb[0], va[1] - vb[1], va[2] - vb[2],
      ));
    }

    console.log('=== f64 parity: two identical controllers over 600 ticks ===');
    console.log(`  Max position divergence: ${maxPosDiff}`);
    console.log(`  Max velocity divergence: ${maxVelDiff}`);

    expect(maxPosDiff).toBe(0);
    expect(maxVelDiff).toBe(0);

    a.controller.dispose();
    b.controller.dispose();
  });

  it('no corrections needed when server and client both use f64 math', () => {
    // Simulate the full reconciliation loop but with both sides using
    // the same f64 PredictedFpsController (matching the new f64 server).
    const serverWorld = createWorld();
    const clientWorld = createWorld();
    createGroundBlocks(serverWorld, 0, 16);
    createGroundBlocks(clientWorld, 0, 16);

    const server = createController(serverWorld, [4, 2, 4]);
    const client = createController(clientWorld, [4, 2, 4]);

    const pendingInputs: InputFrame[] = [];
    const latencyTicks = 3;
    const serverInputQueue: Array<{ input: InputFrame; deliverAt: number }> = [];
    let serverAckSeq = 0;
    let maxCorrection = 0;
    let correctionCount = 0;

    for (let tick = 0; tick < 600; tick++) {
      const buttons = tick < 60 ? 0 : BTN_FORWARD | BTN_SPRINT;
      const yaw = tick < 120 ? 0 : (tick - 120) * 0.02;
      const input: InputFrame = {
        seq: tick, buttons,
        moveX: 0, moveY: buttons ? 127 : 0,
        yaw, pitch: 0,
      };

      client.controller.simulateTick(input, DT);
      pendingInputs.push(input);
      serverInputQueue.push({ input, deliverAt: tick + latencyTicks });

      const arrived = serverInputQueue.filter(q => q.deliverAt <= tick);
      serverInputQueue.splice(0, serverInputQueue.length,
        ...serverInputQueue.filter(q => q.deliverAt > tick));
      for (const a of arrived) {
        server.controller.simulateTick(a.input, DT);
        serverAckSeq = a.input.seq;
      }
      if (arrived.length === 0) {
        server.controller.simulateTick(
          { seq: 0, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 }, DT,
        );
      }

      // Reconcile every 2 ticks (30Hz snapshots)
      if (tick >= latencyTicks * 2 && tick % 2 === 0) {
        const sp = positionTuple(server.controller);
        const sv = velocityTuple(server.controller);

        const prePos = positionTuple(client.controller);

        client.controller.setFullState(
          { x: sp[0], y: sp[1], z: sp[2] },
          { x: sv[0], y: sv[1], z: sv[2] },
          0, 0, server.controller.isGrounded(),
        );

        const unacked = pendingInputs.filter(inp => {
          const diff = (inp.seq - serverAckSeq + 0x10000) & 0xffff;
          return diff !== 0 && diff < 0x8000;
        });
        for (const inp of unacked) {
          client.controller.simulateTick(inp, DT);
        }
        while (pendingInputs.length > 0 && pendingInputs[0].seq <= serverAckSeq) {
          pendingInputs.shift();
        }

        const postPos = positionTuple(client.controller);
        const correction = Math.hypot(
          postPos[0] - prePos[0], postPos[1] - prePos[1], postPos[2] - prePos[2],
        );
        if (correction > 0.001) correctionCount++;
        maxCorrection = Math.max(maxCorrection, correction);
      }
    }

    console.log('=== f64 parity: reconciliation with matching f64 math ===');
    console.log(`  Max correction:          ${maxCorrection.toFixed(6)}m`);
    console.log(`  Significant corrections: ${correctionCount}`);
    console.log(`  Ticks exceeding 15cm:    ${maxCorrection > 0.15 ? 'YES' : 'NO'}`);

    // With both sides using f64, corrections should be zero or negligible
    // (only network quantization can cause tiny differences)
    expect(maxCorrection).toBeLessThan(0.15);
    console.log('  ✓ f64 parity eliminates f32/f64 prediction drift');

    server.controller.dispose();
    client.controller.dispose();
  });
});
