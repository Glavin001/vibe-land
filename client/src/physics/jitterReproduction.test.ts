/**
 * Jitter / teleporting reproduction tests.
 *
 * These tests use the REAL PredictedFpsController on BOTH client and
 * server sides — zero duplicated physics code. The server sim is just
 * a thin wrapper that manages input queues and snapshot generation
 * around the same PredictedFpsController that the client uses.
 *
 * This means any divergence detected IS real prediction error, not a
 * bug in the test's reimplemented physics.
 *
 * Key metrics measured by JitterRecorder:
 *   - maxFrameJump:     largest single-frame visual position change
 *   - meanCorrection:   average reconciliation correction magnitude
 *   - correctionCount:  how many reconciliation corrections triggered
 *   - maxCorrection:    largest single reconciliation correction
 *   - smoothness:       % of frames with position change < threshold
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { PredictionManager, FIXED_DT } from './predictionManager';
import { PredictedFpsController, DEFAULT_CONFIG } from './predictedFpsController';
import {
  type InputCmd,
  type InputFrame,
  type NetPlayerState,
  type SnapshotPacket,
  type ChunkFullPacket,
  type BlockCell,
  metersToMm,
  angleToI16,
  FLAG_ON_GROUND,
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_JUMP,
  BTN_SPRINT,
} from '../net/protocol';

beforeAll(async () => {
  await RAPIER.init();
});

// ─────────────────────────────────────────────────────────────────────
// JitterRecorder — captures per-frame visual positions and computes
// smoothness metrics for detecting jitter/teleporting.
// ─────────────────────────────────────────────────────────────────────

type FrameSample = {
  tick: number;
  visualPos: [number, number, number];
  physicsPos: [number, number, number];
  correctionOffset: [number, number, number];
};

type ReconciliationEvent = {
  tick: number;
  ackSeq: number;
  correctionMagnitude: number;
  prePos: [number, number, number];
  postPos: [number, number, number];
};

type JitterMetrics = {
  maxFrameJump: number;
  meanFrameJump: number;
  stdFrameJump: number;
  maxCorrection: number;
  meanCorrection: number;
  correctionCount: number;
  frameCount: number;
  smoothness: number;
  frameJumps: number[];
  reconciliations: ReconciliationEvent[];
};

class JitterRecorder {
  private frames: FrameSample[] = [];
  private reconciliations: ReconciliationEvent[] = [];

  recordFrame(tick: number, client: PredictionManager): void {
    const visualPos = client.getInterpolatedPosition() ?? client.getPosition();
    const physicsPos = client.getPosition();
    const correctionOffset = client.getCorrectionOffset();
    this.frames.push({
      tick,
      visualPos: [...visualPos] as [number, number, number],
      physicsPos: [...physicsPos] as [number, number, number],
      correctionOffset: [...correctionOffset] as [number, number, number],
    });
  }

  recordReconciliation(
    tick: number,
    ackSeq: number,
    prePos: [number, number, number],
    postPos: [number, number, number],
  ): void {
    const correctionMagnitude = Math.hypot(
      postPos[0] - prePos[0],
      postPos[1] - prePos[1],
      postPos[2] - prePos[2],
    );
    this.reconciliations.push({
      tick, ackSeq, correctionMagnitude,
      prePos: [...prePos] as [number, number, number],
      postPos: [...postPos] as [number, number, number],
    });
  }

  computeMetrics(expectedSpeed: number = 6.0): JitterMetrics {
    const frameJumps: number[] = [];
    for (let i = 1; i < this.frames.length; i++) {
      const prev = this.frames[i - 1].visualPos;
      const curr = this.frames[i].visualPos;
      frameJumps.push(Math.hypot(
        curr[0] - prev[0], curr[1] - prev[1], curr[2] - prev[2],
      ));
    }

    const maxFrameJump = frameJumps.length > 0 ? Math.max(...frameJumps) : 0;
    const meanFrameJump = frameJumps.length > 0
      ? frameJumps.reduce((a, b) => a + b, 0) / frameJumps.length : 0;
    const variance = frameJumps.length > 0
      ? frameJumps.reduce((sum, j) => sum + (j - meanFrameJump) ** 2, 0) / frameJumps.length : 0;

    const expectedMaxJump = expectedSpeed * FIXED_DT * 2.5;
    const smoothFrames = frameJumps.filter((j) => j < expectedMaxJump).length;
    const smoothness = frameJumps.length > 0 ? smoothFrames / frameJumps.length : 1;

    const corrections = this.reconciliations.filter((r) => r.correctionMagnitude > 0.001);
    const maxCorrection = corrections.length > 0
      ? Math.max(...corrections.map((r) => r.correctionMagnitude)) : 0;
    const meanCorrection = corrections.length > 0
      ? corrections.reduce((s, r) => s + r.correctionMagnitude, 0) / corrections.length : 0;

    return {
      maxFrameJump,
      meanFrameJump,
      stdFrameJump: Math.sqrt(variance),
      maxCorrection,
      meanCorrection,
      correctionCount: corrections.length,
      frameCount: this.frames.length,
      smoothness,
      frameJumps,
      reconciliations: this.reconciliations,
    };
  }

  printSummary(metrics?: JitterMetrics): void {
    const m = metrics ?? this.computeMetrics();
    console.log('=== Jitter Metrics ===');
    console.log(`  Frames:          ${m.frameCount}`);
    console.log(`  Max frame jump:  ${m.maxFrameJump.toFixed(4)}m`);
    console.log(`  Mean frame jump: ${m.meanFrameJump.toFixed(4)}m`);
    console.log(`  Std frame jump:  ${m.stdFrameJump.toFixed(4)}m`);
    console.log(`  Smoothness:      ${(m.smoothness * 100).toFixed(1)}%`);
    console.log(`  Corrections:     ${m.correctionCount}`);
    console.log(`  Max correction:  ${m.maxCorrection.toFixed(4)}m`);
    console.log(`  Mean correction: ${m.meanCorrection.toFixed(4)}m`);
    if (m.reconciliations.length > 0) {
      console.log('  Top 5 corrections:');
      const sorted = [...m.reconciliations]
        .sort((a, b) => b.correctionMagnitude - a.correctionMagnitude);
      for (const r of sorted.slice(0, 5)) {
        console.log(`    tick=${r.tick} ackSeq=${r.ackSeq} mag=${r.correctionMagnitude.toFixed(4)}m`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// RapierServerSim — thin wrapper around PredictedFpsController.
//
// Reuses the REAL production movement code. The only extra logic is
// input queue management and snapshot generation — things the real
// server does in Rust, but the physics is identical.
// ─────────────────────────────────────────────────────────────────────

type ServerPlayer = {
  controller: PredictedFpsController;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  lastAckedSeq: number;
  inputQueue: InputCmd[];
  lastAppliedInput: InputFrame | null;
};

class RapierServerSim {
  readonly world: RAPIER.World;
  private players = new Map<number, ServerPlayer>();
  private tick = 0;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -20, z: 0 });
  }

  addGroundPlane(y = 0): void {
    const desc = RAPIER.ColliderDesc.cuboid(500, 0.5, 500)
      .setTranslation(0, y - 0.5, 0);
    this.world.createCollider(desc);
    this.world.step();
  }

  addGroundBlocks(floorY = 0): void {
    for (let x = -24; x < 24; x++) {
      for (let z = -24; z < 24; z++) {
        // Place block center 0.5m BELOW the floor surface, matching the
        // client's voxelWorld positioning (chunk[-1] y=15 → center y=-0.5).
        const desc = RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5)
          .setTranslation(x + 0.5, floorY - 0.5, z + 0.5);
        this.world.createCollider(desc);
      }
    }
    this.world.step();
  }

  spawnPlayer(id: number, position: [number, number, number]): void {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(position[0], position[1], position[2]),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(
        DEFAULT_CONFIG.capsuleHalfSegment,
        DEFAULT_CONFIG.capsuleRadius,
      ),
      body,
    );

    // Uses the REAL PredictedFpsController — same physics as the client
    const controller = new PredictedFpsController(this.world, body, collider);
    controller.setFullState(
      { x: position[0], y: position[1], z: position[2] },
      { x: 0, y: 0, z: 0 },
      0, 0, false,
    );

    this.players.set(id, {
      controller,
      body,
      collider,
      lastAckedSeq: 0,
      inputQueue: [],
      lastAppliedInput: null,
    });
  }

  enqueueInputs(playerId: number, cmds: InputCmd[]): void {
    const player = this.players.get(playerId);
    if (!player) return;
    for (const cmd of cmds) {
      const diff = (cmd.seq - player.lastAckedSeq + 0x10000) & 0xffff;
      if (diff === 0 || diff >= 0x8000) continue;
      player.inputQueue.push(cmd);
    }
    while (player.inputQueue.length > 120) {
      player.inputQueue.shift();
    }
  }

  simulateTick(dt: number = FIXED_DT): void {
    this.tick++;
    for (const [, player] of this.players) {
      let input: InputFrame;
      if (player.inputQueue.length > 0) {
        const cmd = player.inputQueue.shift()!;
        player.lastAckedSeq = cmd.seq;
        input = cmd;
        player.lastAppliedInput = input;
      } else if (player.lastAppliedInput) {
        input = player.lastAppliedInput;
      } else {
        input = { seq: 0, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 };
      }

      // Use the REAL production physics — simulateTick() calls simulateOne()
      player.controller.simulateTick(input, dt);
    }
  }

  getPlayerState(id: number): NetPlayerState | null {
    const player = this.players.get(id);
    if (!player) return null;
    const pos = player.controller.getPosition();
    const vel = player.controller.getVelocity();
    const angles = player.controller.getAngles();
    return {
      id,
      pxMm: metersToMm(pos.x),
      pyMm: metersToMm(pos.y),
      pzMm: metersToMm(pos.z),
      vxCms: Math.round(vel.x * 100),
      vyCms: Math.round(vel.y * 100),
      vzCms: Math.round(vel.z * 100),
      yawI16: angleToI16(angles.yaw),
      pitchI16: angleToI16(angles.pitch),
      flags: player.controller.isGrounded() ? FLAG_ON_GROUND : 0,
    };
  }

  getAckedSeq(id: number): number {
    return this.players.get(id)?.lastAckedSeq ?? 0;
  }

  getTick(): number {
    return this.tick;
  }

  dispose(): void {
    for (const [, player] of this.players) {
      player.controller.dispose();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// FullPhysicsScenario — wires up RapierServerSim (reusing production
// PredictedFpsController) + production PredictionManager + simulated
// network latency.
//
// Both sides use the exact same Rapier KCC code path. The only
// source of divergence is:
//   - Network quantization (meters→mm, angles→i16)
//   - Velocity quantization (m/s→cm/s as i16)
//   - Timing (which inputs arrive before which server tick)
// ─────────────────────────────────────────────────────────────────────

type FullPhysicsConfig = {
  latencyMs: number;
  jitterMs?: number;
  snapshotInterval?: number; // server ticks between snapshots (default 2 = 30Hz)
  startPosition?: [number, number, number];
  useVoxelGround?: boolean;
};

class FullPhysicsScenario {
  readonly server: RapierServerSim;
  readonly recorder: JitterRecorder;
  client!: PredictionManager;

  private clientWorld!: RAPIER.World;
  private readonly playerId = 1;
  private readonly snapshotInterval: number;
  private clientTick = 0;
  private readonly latencyMs: number;
  private readonly jitterMs: number;

  private inputQueue: Array<{ cmds: InputCmd[]; deliverAtTick: number }> = [];
  private snapshotQueue: Array<{ snapshot: SnapshotPacket; deliverAtTick: number }> = [];

  constructor(private readonly config: FullPhysicsConfig) {
    this.server = new RapierServerSim();
    this.recorder = new JitterRecorder();
    this.snapshotInterval = config.snapshotInterval ?? 2;
    this.latencyMs = config.latencyMs;
    this.jitterMs = config.jitterMs ?? 0;
  }

  init(): void {
    const startPos = this.config.startPosition ?? [0, 0, 0];

    // Server world
    if (this.config.useVoxelGround) {
      this.server.addGroundBlocks(0);
    } else {
      this.server.addGroundPlane(0);
    }
    this.server.spawnPlayer(this.playerId, startPos);

    // Client world — uses production PredictionManager
    this.clientWorld = new RAPIER.World({ x: 0, y: -20, z: 0 });
    const clientBody = this.clientWorld.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased(),
    );
    const clientCollider = this.clientWorld.createCollider(
      RAPIER.ColliderDesc.capsule(
        DEFAULT_CONFIG.capsuleHalfSegment,
        DEFAULT_CONFIG.capsuleRadius,
      ),
      clientBody,
    );
    this.clientWorld.step();

    this.client = new PredictionManager(this.clientWorld, clientBody, clientCollider);

    // Give client matching ground chunks
    this.injectClientGround();

    // Initialize with first server state
    const state = this.server.getPlayerState(this.playerId)!;
    this.client.reconcile(0, state);
  }

  /**
   * Run a full simulation for the given duration with constant input.
   * Returns jitter metrics.
   */
  runSimulation(
    durationSeconds: number,
    input: { buttons: number; yaw?: number; pitch?: number },
  ): JitterMetrics {
    const totalTicks = Math.ceil(durationSeconds / FIXED_DT);
    const yaw = input.yaw ?? 0;
    const pitch = input.pitch ?? 0;

    for (let t = 0; t < totalTicks; t++) {
      this.stepOneTick(input.buttons, yaw, pitch);
    }

    return this.recorder.computeMetrics(
      (input.buttons & BTN_SPRINT) !== 0 ? 8.5 : 6.0,
    );
  }

  /**
   * Run a simulation with per-tick input function for dynamic scenarios.
   */
  runDynamic(
    durationSeconds: number,
    inputFn: (tick: number) => { buttons: number; yaw: number; pitch: number },
  ): JitterMetrics {
    const totalTicks = Math.ceil(durationSeconds / FIXED_DT);

    for (let t = 0; t < totalTicks; t++) {
      const input = inputFn(t);
      this.stepOneTick(input.buttons, input.yaw, input.pitch);
    }

    return this.recorder.computeMetrics(8.5);
  }

  private stepOneTick(buttons: number, yaw: number, pitch: number): void {
    this.clientTick++;
    const latencyTicks = Math.ceil(this.latencyMs / (FIXED_DT * 1000));

    // 1. Client predicts
    const cmds = this.client.update(FIXED_DT, buttons, yaw, pitch);
    if (cmds.length > 0) {
      const jitter = this.jitterTicks();
      this.inputQueue.push({
        cmds,
        deliverAtTick: this.clientTick + latencyTicks + jitter,
      });
    }

    // 2. Deliver inputs to server
    const arrivedInputs = this.inputQueue.filter((q) => q.deliverAtTick <= this.clientTick);
    this.inputQueue = this.inputQueue.filter((q) => q.deliverAtTick > this.clientTick);
    for (const arrived of arrivedInputs) {
      this.server.enqueueInputs(this.playerId, arrived.cmds);
    }

    // 3. Server tick
    this.server.simulateTick();

    // 4. Snapshot generation
    if (this.server.getTick() % this.snapshotInterval === 0) {
      const state = this.server.getPlayerState(this.playerId)!;
      const snapshot: SnapshotPacket = {
        type: 'snapshot',
        serverTimeUs: this.server.getTick() * Math.round(1_000_000 / 60),
        serverTick: this.server.getTick(),
        ackInputSeq: this.server.getAckedSeq(this.playerId),
        playerStates: [state],
        projectileStates: [],
        dynamicBodyStates: [],
      };
      const jitter = this.jitterTicks();
      this.snapshotQueue.push({
        snapshot,
        deliverAtTick: this.clientTick + latencyTicks + jitter,
      });
    }

    // 5. Deliver snapshots to client
    const arrivedSnapshots = this.snapshotQueue.filter((q) => q.deliverAtTick <= this.clientTick);
    this.snapshotQueue = this.snapshotQueue.filter((q) => q.deliverAtTick > this.clientTick);
    for (const arrived of arrivedSnapshots) {
      const localState = arrived.snapshot.playerStates.find((p) => p.id === this.playerId);
      if (localState) {
        const prePos = this.client.getPosition();
        this.client.reconcile(arrived.snapshot.ackInputSeq, localState);
        const postPos = this.client.getPosition();
        this.recorder.recordReconciliation(
          this.clientTick, arrived.snapshot.ackInputSeq, prePos, postPos,
        );
      }
    }

    // 6. Record frame
    this.recorder.recordFrame(this.clientTick, this.client);
  }

  private jitterTicks(): number {
    if (this.jitterMs <= 0) return 0;
    return Math.round((Math.random() - 0.5) * 2 * this.jitterMs / (FIXED_DT * 1000));
  }

  private injectClientGround(): void {
    for (let cx = -2; cx <= 1; cx++) {
      for (let cz = -2; cz <= 1; cz++) {
        const blocks: BlockCell[] = [];
        for (let x = 0; x < 16; x++) {
          for (let z = 0; z < 16; z++) {
            blocks.push({ x, y: 15, z, material: 1 });
          }
        }
        const chunk: ChunkFullPacket = {
          type: 'chunkFull',
          chunk: [cx, -1, cz],
          version: 1,
          blocks,
        };
        this.client.applyWorldPacket(chunk);
      }
    }
  }

  dispose(): void {
    this.client.dispose();
    this.server.dispose();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Test Scenarios
// ═══════════════════════════════════════════════════════════════════════

describe('Jitter reproduction: real PredictedFpsController on both sides', () => {
  let scenario: FullPhysicsScenario | null = null;

  afterEach(() => {
    scenario?.dispose();
    scenario = null;
  });

  // ─── Baseline ────────────────────────────────────────────────────

  it('standing still — should have near-zero corrections', () => {
    scenario = new FullPhysicsScenario({
      latencyMs: 50,
      startPosition: [8, 2, 8],
      useVoxelGround: true,
    });
    scenario.init();

    const metrics = scenario.runSimulation(3.0, { buttons: 0 });
    console.log('Standing still:');
    scenario.recorder.printSummary(metrics);

    // With identical physics on both sides, only quantization error remains.
    // If this fails, the quantization round-trip is causing divergence.
    expect(metrics.maxCorrection).toBeLessThan(0.5);
    expect(metrics.smoothness).toBeGreaterThan(0.9);
  });

  // ─── Walking / sprinting ─────────────────────────────────────────

  it('walking forward — low corrections expected', () => {
    scenario = new FullPhysicsScenario({
      latencyMs: 50,
      startPosition: [8, 2, 8],
    });
    scenario.init();

    const metrics = scenario.runSimulation(3.0, { buttons: BTN_FORWARD });
    console.log('Walking forward:');
    scenario.recorder.printSummary(metrics);

    expect(metrics.smoothness).toBeGreaterThan(0.9);
    expect(metrics.maxCorrection).toBeLessThan(0.3);
    expect(metrics.meanCorrection).toBeLessThan(0.1);
  });

  it('sprinting forward — should remain smooth', () => {
    scenario = new FullPhysicsScenario({
      latencyMs: 50,
      startPosition: [8, 2, 8],
    });
    scenario.init();

    const metrics = scenario.runSimulation(3.0, {
      buttons: BTN_FORWARD | BTN_SPRINT,
    });
    console.log('Sprinting forward:');
    scenario.recorder.printSummary(metrics);

    expect(metrics.smoothness).toBeGreaterThan(0.9);
    expect(metrics.maxCorrection).toBeLessThan(0.5);
  });

  // ─── High latency ────────────────────────────────────────────────

  it('sprinting with 150ms latency', () => {
    scenario = new FullPhysicsScenario({
      latencyMs: 150,
      startPosition: [8, 2, 8],
    });
    scenario.init();

    const metrics = scenario.runSimulation(3.0, {
      buttons: BTN_FORWARD | BTN_SPRINT,
    });
    console.log('Sprint + 150ms latency:');
    scenario.recorder.printSummary(metrics);

    expect(metrics.smoothness).toBeGreaterThan(0.85);
    expect(metrics.maxCorrection).toBeLessThan(1.0);
  });

  it('sprinting with 200ms latency — stress test', () => {
    scenario = new FullPhysicsScenario({
      latencyMs: 200,
      startPosition: [8, 2, 8],
    });
    scenario.init();

    const metrics = scenario.runSimulation(3.0, {
      buttons: BTN_FORWARD | BTN_SPRINT,
    });
    console.log('Sprint + 200ms latency:');
    scenario.recorder.printSummary(metrics);

    expect(metrics.smoothness).toBeGreaterThan(0.8);
    expect(metrics.maxCorrection).toBeLessThan(2.0);
  });

  // ─── Diagonal and direction changes ──────────────────────────────

  it('sprinting diagonally', () => {
    scenario = new FullPhysicsScenario({
      latencyMs: 50,
      startPosition: [8, 2, 8],
    });
    scenario.init();

    const metrics = scenario.runSimulation(3.0, {
      buttons: BTN_FORWARD | BTN_RIGHT | BTN_SPRINT,
    });
    console.log('Diagonal sprint:');
    scenario.recorder.printSummary(metrics);

    expect(metrics.smoothness).toBeGreaterThan(0.9);
    expect(metrics.maxCorrection).toBeLessThan(0.5);
  });

  it('rapid direction changes — prediction stress', () => {
    scenario = new FullPhysicsScenario({
      latencyMs: 80,
      startPosition: [8, 2, 8],
    });
    scenario.init();

    const directions = [
      BTN_FORWARD | BTN_SPRINT,
      BTN_FORWARD | BTN_RIGHT | BTN_SPRINT,
      BTN_RIGHT | BTN_SPRINT,
      BTN_BACK | BTN_RIGHT | BTN_SPRINT,
      BTN_BACK | BTN_SPRINT,
      BTN_BACK | BTN_LEFT | BTN_SPRINT,
      BTN_LEFT | BTN_SPRINT,
      BTN_FORWARD | BTN_LEFT | BTN_SPRINT,
    ];

    const metrics = scenario.runDynamic(4.0, (tick) => ({
      buttons: directions[Math.floor(tick / 30) % directions.length],
      yaw: 0,
      pitch: 0,
    }));
    console.log('Rapid direction changes:');
    scenario.recorder.printSummary(metrics);

    expect(metrics.smoothness).toBeGreaterThan(0.85);
    expect(metrics.maxCorrection).toBeLessThan(1.0);
  });

  // ─── Jump ────────────────────────────────────────────────────────

  it('jump while sprinting — airborne prediction', () => {
    scenario = new FullPhysicsScenario({
      latencyMs: 50,
      startPosition: [8, 2, 8],
    });
    scenario.init();

    // Settle first
    scenario.runSimulation(1.0, { buttons: 0 });

    // Create a fresh recorder for the interesting part
    const recorder2 = new JitterRecorder();
    const savedRecorder = scenario.recorder;
    (scenario as unknown as { recorder: JitterRecorder }).recorder = recorder2;

    const metrics = scenario.runDynamic(3.0, (tick) => {
      let buttons = BTN_FORWARD | BTN_SPRINT;
      if (tick >= 30 && tick < 35) buttons |= BTN_JUMP;
      return { buttons, yaw: 0, pitch: 0 };
    });

    console.log('Jump while sprinting:');
    recorder2.printSummary(metrics);

    expect(metrics.smoothness).toBeGreaterThan(0.85);
    expect(metrics.maxCorrection).toBeLessThan(1.0);
  });

  // ─── Yaw rotation ───────────────────────────────────────────────

  it('sprinting with continuous yaw rotation', () => {
    scenario = new FullPhysicsScenario({
      latencyMs: 50,
      startPosition: [8, 2, 8],
    });
    scenario.init();

    const metrics = scenario.runDynamic(3.0, (tick) => ({
      buttons: BTN_FORWARD | BTN_SPRINT,
      yaw: tick * 0.02,
      pitch: 0,
    }));
    console.log('Sprint + yaw rotation:');
    scenario.recorder.printSummary(metrics);

    expect(metrics.smoothness).toBeGreaterThan(0.9);
    expect(metrics.maxCorrection).toBeLessThan(0.5);
  });

  // ─── Voxel ground ───────────────────────────────────────────────

  it('voxel ground — block collider matching', () => {
    scenario = new FullPhysicsScenario({
      latencyMs: 50,
      startPosition: [8, 2, 8],
      useVoxelGround: true,
    });
    scenario.init();

    const metrics = scenario.runSimulation(3.0, {
      buttons: BTN_FORWARD | BTN_SPRINT,
    });
    console.log('Voxel ground sprint:');
    scenario.recorder.printSummary(metrics);

    // Voxel ground uses per-block colliders which interact with KCC
    // block edges. Document actual behavior — tighten as fixes land.
    expect(metrics.smoothness).toBeGreaterThan(0.8);
    expect(metrics.maxCorrection).toBeLessThan(2.5);
  });

  // ─── Network jitter ─────────────────────────────────────────────

  it('sprinting with 50ms latency + 20ms jitter', () => {
    scenario = new FullPhysicsScenario({
      latencyMs: 50,
      jitterMs: 20,
      startPosition: [8, 2, 8],
    });
    scenario.init();

    const metrics = scenario.runSimulation(3.0, {
      buttons: BTN_FORWARD | BTN_SPRINT,
    });
    console.log('Sprint + jitter:');
    scenario.recorder.printSummary(metrics);

    expect(metrics.smoothness).toBeGreaterThan(0.85);
    expect(metrics.maxCorrection).toBeLessThan(1.0);
  });

  // ─── Long duration drift ────────────────────────────────────────

  it('10 seconds of sprinting — drift accumulation', () => {
    scenario = new FullPhysicsScenario({
      latencyMs: 80,
      startPosition: [8, 2, 8],
    });
    scenario.init();

    const metrics = scenario.runSimulation(10.0, {
      buttons: BTN_FORWARD | BTN_SPRINT,
    });
    console.log('10s long sprint:');
    scenario.recorder.printSummary(metrics);

    // Corrections should NOT grow unboundedly over time
    expect(metrics.smoothness).toBeGreaterThan(0.85);
    expect(metrics.maxCorrection).toBeLessThan(1.0);
    expect(metrics.meanCorrection).toBeLessThan(0.3);
  });
});
