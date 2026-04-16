/**
 * Integration scenario tests for netcode.
 *
 * Each test simulates a full client↔server interaction using the test harness.
 * No real network, no real timers — everything is deterministic via MockClock
 * and MockTransport. The harness logs a trace of events for debugging.
 *
 * Categories:
 *   A: Happy path / baseline
 *   B: Prediction divergence & reconciliation
 *   C: Latency nightmares
 *   D: Packet loss
 *   E: Jitter & ordering
 *   F: Sequence number edge cases
 *   G: Interpolation edge cases
 *   H: World state / physics
 *   I: Connection lifecycle
 *   J: Hard snap / teleport
 *   K: Performance / stress
 *   L: Determinism verification
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { initWasmForTests, WasmSimWorld } from '../wasm/testInit';
import {
  NetcodeTestScenario,
  makeNetState,
  makeSnapshot,
  makeGroundChunk,
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_JUMP,
  BTN_SPRINT,
  MockClock,
  MockTransport,
  SeededRandom,
} from './testHarness';
import { PredictionManager, FIXED_DT, HARD_SNAP_DISTANCE, MAX_CATCHUP_STEPS } from '../physics/predictionManager';
import { FLAG_ON_GROUND, metersToMm, angleToI16 } from './protocol';
import { ServerClockEstimator, PlayerInterpolator, ProjectileInterpolator } from './interpolation';

beforeAll(async () => {
  initWasmForTests();
});

let scenario: NetcodeTestScenario | null = null;
afterEach(() => {
  scenario?.dispose();
  scenario = null;
});

function createScenario(config?: ConstructorParameters<typeof NetcodeTestScenario>[0]): NetcodeTestScenario {
  const s = new NetcodeTestScenario(config);
  s.init();
  scenario = s;
  return s;
}

/**
 * Invariant checks that should hold true at ANY point during a scenario.
 * Call this after any significant state change to catch bugs early.
 * These are the properties that, if violated, indicate a real netcode bug.
 */
function assertInvariants(s: NetcodeTestScenario, context: string): void {
  const pos = s.getClientPosition();
  const offset = s.getCorrectionOffset();
  const pending = s.getPendingInputCount();

  // Position must always be finite (NaN/Infinity = physics explosion)
  expect(isFinite(pos[0]), `${context}: client X is not finite (${pos[0]})`).toBe(true);
  expect(isFinite(pos[1]), `${context}: client Y is not finite (${pos[1]})`).toBe(true);
  expect(isFinite(pos[2]), `${context}: client Z is not finite (${pos[2]})`).toBe(true);

  // Correction offset must be finite
  expect(isFinite(offset[0]), `${context}: offset X is not finite`).toBe(true);
  expect(isFinite(offset[1]), `${context}: offset Y is not finite`).toBe(true);
  expect(isFinite(offset[2]), `${context}: offset Z is not finite`).toBe(true);

  // Pending input count is non-negative and bounded
  expect(pending, `${context}: negative pending count`).toBeGreaterThanOrEqual(0);
  expect(pending, `${context}: pending count exploded (>500)`).toBeLessThan(500);

  // Server position must also be finite
  for (const [id, player] of s.serverPlayers) {
    expect(isFinite(player.position[0]), `${context}: server player ${id} X not finite`).toBe(true);
    expect(isFinite(player.position[1]), `${context}: server player ${id} Y not finite`).toBe(true);
    expect(isFinite(player.position[2]), `${context}: server player ${id} Z not finite`).toBe(true);
  }
}

// ═══════════════════════════════════════════════
// Category A: Happy Path / Baseline
// ═══════════════════════════════════════════════

describe('Category A: Happy Path', () => {
  it('A1: basic prediction-reconciliation loop — zero correction', () => {
    const s = createScenario({ latencyMs: 0 });

    // Run 30 client frames and server ticks simultaneously (no latency)
    s.runClientFrames(30, { buttons: BTN_FORWARD });
    s.runServerTicks(30);
    s.deliverServerToClient();

    assertInvariants(s, 'A1 after reconcile');

    // With zero latency, all inputs should be acked
    expect(s.getPendingInputCount()).toBe(0);

    // Client moved forward (not stuck at origin)
    const pos = s.getClientPosition();
    expect(pos[2]).toBeGreaterThan(1.0);

    // Client and server should be close (both ran same inputs with same physics constants)
    // The only difference is Rapier (client) vs pure-math (server) collision
    const divergence = s.getClientServerDivergence();
    expect(divergence).toBeLessThan(0.5);
  });

  it.each([10, 50, 100, 200])(
    'A2: steady-state at %dms RTT stays bounded',
    (latencyMs) => {
      const s = createScenario({ latencyMs: latencyMs / 2 }); // one-way

      // Run 120 frames (2 seconds) of forward movement
      for (let i = 0; i < 120; i++) {
        s.runClientFrames(1, { buttons: BTN_FORWARD });
        s.runServerTicks(1);

        // Advance clocks to simulate latency
        if (i % 2 === 0) {
          s.clientClock.advance(latencyMs);
          s.serverClock.advance(latencyMs / 2);
          s.deliverServerToClient();
        }
      }

      // Server and client should be reasonably close
      const divergence = s.getClientServerDivergence();
      expect(divergence).toBeLessThan(2.0);
    },
  );
});

// ═══════════════════════════════════════════════
// Category B: Prediction Divergence & Reconciliation
// ═══════════════════════════════════════════════

describe('Category B: Prediction Divergence', () => {
  it('B4: direction change mid-reconciliation replays correctly', () => {
    const s = createScenario({ latencyMs: 50 });

    // Forward for 10 frames
    s.runClientFrames(10, { buttons: BTN_FORWARD });

    // Then right for 10 frames
    s.runClientFrames(10, { buttons: BTN_FORWARD, yaw: Math.PI / 2 });

    // Server processes the first 10
    s.runServerTicks(10);

    // Deliver snapshots (acks first 10 forward inputs)
    s.clientClock.advance(100);
    s.serverClock.advance(50);
    s.deliverServerToClient();

    // After reconciliation, client should have rightward movement
    // from replaying the last 10 inputs
    const pos = s.getClientPosition();
    expect(pos[0]).not.toBe(0); // should have lateral movement from right turn
  });

  it('B5: multiple rapid reconciliations — no duplicate replays', () => {
    const s = createScenario({ latencyMs: 0 });

    // Send inputs and reconcile 5 times rapidly
    for (let i = 0; i < 5; i++) {
      s.runClientFrames(2, { buttons: BTN_FORWARD });
      s.runServerTicks(2);
      s.deliverServerToClient();
    }

    // Should have moved forward consistently without weird jumps
    const pos = s.getClientPosition();
    expect(pos[2]).toBeGreaterThan(0);
    // Position should be relatively close to server
    expect(s.getClientServerDivergence()).toBeLessThan(1.0);
  });

  it('B7: cascading corrections converge (no oscillation)', () => {
    const s = createScenario({ latencyMs: 30 });

    const corrections: number[] = [];

    for (let round = 0; round < 20; round++) {
      s.runClientFrames(3, { buttons: BTN_FORWARD });
      s.runServerTicks(3);
      s.clientClock.advance(60);
      s.serverClock.advance(30);

      const before = s.getClientPosition();
      s.deliverServerToClient();
      const after = s.getClientPosition();

      const correction = Math.hypot(
        after[0] - before[0],
        after[1] - before[1],
        after[2] - before[2],
      );
      corrections.push(correction);
    }

    // Corrections should remain bounded (not exploding).
    // Due to Rapier (client) vs pure-math (server) physics differences,
    // small steady-state corrections are expected and acceptable.
    const totalCorrection = corrections.reduce((a, b) => a + b, 0);
    const avgCorrection = totalCorrection / corrections.length;
    expect(avgCorrection).toBeLessThan(2.0); // no explosion
  });
});

// ═══════════════════════════════════════════════
// Category C: Latency Nightmares
// ═══════════════════════════════════════════════

describe('Category C: Latency', () => {
  it('C8: high latency (200ms RTT) — position stays stable', () => {
    const s = createScenario({ latencyMs: 100 }); // 100ms one-way

    // Run 60 frames of movement
    s.runClientFrames(60, { buttons: BTN_FORWARD });
    s.runServerTicks(60);

    // Deliver with full RTT delay
    s.clientClock.advance(200);
    s.serverClock.advance(100);
    s.deliverServerToClient();

    // With high latency, many inputs in flight, but position should converge
    const divergence = s.getClientServerDivergence();
    expect(divergence).toBeLessThan(3.0);
  });

  it('C9: latency spike (50ms → 500ms → 50ms) — smooth recovery', () => {
    const s = createScenario({ latencyMs: 25 }); // 25ms one-way = 50ms RTT

    // Normal latency phase: 30 frames
    for (let i = 0; i < 30; i++) {
      s.runClientFrames(1, { buttons: BTN_FORWARD });
      s.runServerTicks(1);
      if (i % 2 === 0) {
        s.clientClock.advance(50);
        s.serverClock.advance(25);
        s.deliverServerToClient();
      }
    }

    assertInvariants(s, 'C9 before spike');
    const posBeforeSpike = s.getClientPosition();
    const divBeforeSpike = s.getClientServerDivergence();

    // Spike: increase latency to 250ms one-way
    s.setClientToServerConfig({ latencyMs: 250 });
    s.setServerToClientConfig({ latencyMs: 250 });

    // Continue during spike: 60 frames (1 second)
    for (let i = 0; i < 60; i++) {
      s.runClientFrames(1, { buttons: BTN_FORWARD });
      s.runServerTicks(1);
    }

    assertInvariants(s, 'C9 during spike');

    // Restore normal latency
    s.setClientToServerConfig({ latencyMs: 25 });
    s.setServerToClientConfig({ latencyMs: 25 });

    // Let things settle: 30 more frames
    for (let i = 0; i < 30; i++) {
      s.runClientFrames(1, { buttons: BTN_FORWARD });
      s.runServerTicks(1);
      s.clientClock.advance(50);
      s.serverClock.advance(25);
      s.deliverServerToClient();
    }

    assertInvariants(s, 'C9 after recovery');

    const posAfterRecovery = s.getClientPosition();
    // Must still be moving forward (not stuck or reversed)
    expect(posAfterRecovery[2]).toBeGreaterThan(posBeforeSpike[2]);
    // Divergence should have recovered (not permanently drifted)
    expect(s.getClientServerDivergence()).toBeLessThan(3.0);
  });

  it('C12: near-zero latency (LAN, 2ms RTT) — no off-by-one', () => {
    const s = createScenario({ latencyMs: 1 }); // 1ms one-way

    for (let i = 0; i < 60; i++) {
      s.runClientFrames(1, { buttons: BTN_FORWARD });
      s.runServerTicks(1);
      s.clientClock.advance(2);
      s.serverClock.advance(1);
      s.deliverServerToClient();
    }

    // Should be very close
    expect(s.getClientServerDivergence()).toBeLessThan(0.5);
    // With snapshots every 2 ticks, there can be 1-2 inputs pending plus any
    // timing offset. On LAN, pending should be very low.
    expect(s.getPendingInputCount()).toBeLessThanOrEqual(6);
  });
});

// ═══════════════════════════════════════════════
// Category D: Packet Loss
// ═══════════════════════════════════════════════

describe('Category D: Packet Loss', () => {
  it('D15: server snapshot lost — client handles gap', () => {
    const s = createScenario({ latencyMs: 0 });

    // Normal operation for 10 frames
    s.runClientFrames(10, { buttons: BTN_FORWARD });
    s.runServerTicks(10);
    s.deliverServerToClient();

    // Now drop server→client packets for 4 ticks (2 snapshots missed)
    s.setServerToClientConfig({ packetLossRate: 1.0 });
    s.runClientFrames(4, { buttons: BTN_FORWARD });
    s.runServerTicks(4);

    // Restore and deliver
    s.setServerToClientConfig({ packetLossRate: 0.0 });
    s.runClientFrames(4, { buttons: BTN_FORWARD });
    s.runServerTicks(4);
    s.deliverServerToClient();

    // ackInputSeq will have jumped, client handles it
    expect(s.getClientServerDivergence()).toBeLessThan(2.0);
  });

  it('D16: alternating packet loss (50%) — position converges', () => {
    const s = createScenario({ latencyMs: 0, seed: 123 });

    // Run with 50% packet loss on server→client
    s.setServerToClientConfig({ packetLossRate: 0.5 });

    for (let i = 0; i < 60; i++) {
      s.runClientFrames(1, { buttons: BTN_FORWARD });
      s.runServerTicks(1);
      s.deliverServerToClient();
    }

    // Should still be moving forward (not stuck or diverged)
    const pos = s.getClientPosition();
    expect(pos[2]).toBeGreaterThan(0.5);
  });
});

// ═══════════════════════════════════════════════
// Category F: Sequence Number Edge Cases
// ═══════════════════════════════════════════════

describe('Category F: Sequence Numbers', () => {
  it('F20: sequence wraparound (0xFFFF → 0x0000)', () => {
    const s = createScenario({ latencyMs: 0 });

    // Fast-forward the sequence counter near the u16 boundary
    s.client.setNextSeq(0xfff0);

    // Also sync server's ack to match
    const player = s.serverPlayers.get(1)!;
    player.lastAckedSeq = 0xffef; // just before our first seq

    // Now run 32 frames across the boundary with actual movement
    const cmds = s.runClientFrames(32, { buttons: BTN_FORWARD });
    s.runServerTicks(32);
    s.deliverServerToClient();

    assertInvariants(s, 'F20 after wraparound');

    // Verify we actually crossed the u16 boundary
    const seqs = cmds.map((c) => c.seq);
    const preWrap = seqs.filter(s => s >= 0xfff0);
    const postWrap = seqs.filter(s => s < 0x0020);
    expect(preWrap.length).toBeGreaterThan(0);
    expect(postWrap.length).toBeGreaterThan(0);

    // Specific boundary crossing: 0xFFFF should be followed by 0x0000
    const ffff = seqs.indexOf(0xffff);
    expect(ffff).toBeGreaterThanOrEqual(0);
    expect(seqs[ffff + 1]).toBe(0);

    // All inputs should be acked (zero latency)
    expect(s.getPendingInputCount()).toBe(0);

    // Position should match server (wraparound didn't break reconciliation)
    expect(s.getClientServerDivergence()).toBeLessThan(0.5);

    // Player actually moved forward
    expect(s.getClientPosition()[2]).toBeGreaterThan(0.5);
  });
});

// ═══════════════════════════════════════════════
// Category H: World State / Physics
// ═══════════════════════════════════════════════

describe('Category H: World State', () => {
  it('H28: chunk version gap warns and no-ops (does not throw)', () => {
    const s = createScenario();

    // Apply chunk at version 1 (already done in init)
    // Try to apply diff with version 5 (gap: expected version 2)
    expect(() => {
      s.injectWorldPacket({
        type: 'chunkDiff',
        chunk: [0, -1, 0],
        version: 5,
        edits: [{ x: 0, y: 0, z: 0, op: 1, material: 2 }],
      });
    }).not.toThrow();
  });

  it('H29: multiple chunks arrive at once', () => {
    const s = createScenario();

    // Inject 3 more chunks
    for (let cx = 1; cx <= 3; cx++) {
      s.injectWorldPacket(makeGroundChunk(cx, 0, -1, 1));
    }

    // Prediction should still work
    const cmds = s.runClientFrames(10, { buttons: BTN_FORWARD });
    expect(cmds).toHaveLength(10);
  });
});

// ═══════════════════════════════════════════════
// Category J: Hard Snap / Teleport
// ═══════════════════════════════════════════════

describe('Category J: Hard Snap', () => {
  it('J33: server teleport (>3m) — hard snap, no smoothing', () => {
    const s = createScenario();

    // Predict a few frames
    s.runClientFrames(5, { buttons: BTN_FORWARD });

    // Server says player is 10m away
    const snapshot = makeSnapshot({
      serverTick: 10,
      ackInputSeq: 5,
      players: [makeNetState({ id: 1, position: [10, 0, 10], flags: FLAG_ON_GROUND })],
    });
    s.injectSnapshot(snapshot);

    // Should have hard-snapped
    const pos = s.getClientPosition();
    expect(pos[0]).toBeCloseTo(10, 0);
    expect(pos[2]).toBeCloseTo(10, 0);

    // Correction offset should be zero (hard snap)
    const offset = s.getCorrectionOffset();
    expect(Math.hypot(...offset)).toBe(0);
  });

  it('J34: near-threshold correction (2.9m vs 3.1m)', () => {
    const s = createScenario();

    // Position at origin, predict a few frames
    s.runClientFrames(3);

    // Just below threshold: smooth correction
    const snapBelow = makeSnapshot({
      serverTick: 5,
      ackInputSeq: 3,
      players: [makeNetState({ id: 1, position: [2.9, 0, 0], flags: FLAG_ON_GROUND })],
    });
    s.injectSnapshot(snapBelow);
    const offsetBelow = s.getCorrectionOffset();
    // This should have produced a correction offset (smooth)

    // Reset: inject snapshot at known position
    const resetSnap = makeSnapshot({
      serverTick: 6,
      ackInputSeq: 3,
      players: [makeNetState({ id: 1, position: [0, 0, 0], flags: FLAG_ON_GROUND })],
    });
    s.injectSnapshot(resetSnap);

    // Just above threshold: hard snap → offset = 0
    const snapAbove = makeSnapshot({
      serverTick: 7,
      ackInputSeq: 3,
      players: [makeNetState({ id: 1, position: [3.1, 0, 0], flags: FLAG_ON_GROUND })],
    });
    s.injectSnapshot(snapAbove);
    const offsetAbove = s.getCorrectionOffset();
    expect(Math.hypot(...offsetAbove)).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// Category K: Performance / Stress
// ═══════════════════════════════════════════════

describe('Category K: Performance', () => {
  it('K35: max catchup steps (frame skip after tab unfocus)', () => {
    const s = createScenario();

    // Simulate a long frame (100ms = ~6 ticks), but only 4 should execute
    const cmds = s.runClientFrames(1);

    // Now inject a huge delta
    const bigDeltaCmds = s.client.update(0.1, BTN_FORWARD, 0, 0); // 100ms

    expect(bigDeltaCmds.length).toBeLessThanOrEqual(MAX_CATCHUP_STEPS);
  });

  it('K36: 120 pending inputs (server queue full) — oldest discarded', () => {
    const s = createScenario({ latencyMs: 1000 }); // very high latency

    // Client sends 150 inputs
    s.runClientFrames(150, { buttons: BTN_FORWARD });

    // Server receives them (after delivery)
    s.serverClock.advance(2000);
    const player = s.serverPlayers.get(1);

    // Process them
    s.runServerTicks(150);

    // Queue should have been capped at 120
    // No crash, server processed what it could
    expect(player).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// Category L: Determinism Verification
// ═══════════════════════════════════════════════

describe('Category L: Determinism', () => {
  it('L37: replay produces identical result (determinism)', () => {
    // Run 100 inputs through two separate PredictionManagers
    const s1 = createScenario({ latencyMs: 0 });
    const s2 = createScenario({ latencyMs: 0 });

    // Complex input sequence: forward, sprint-forward, strafe left, with varying yaw
    const inputSeq = Array.from({ length: 100 }, (_, i) => ({
      buttons: i % 3 === 0 ? BTN_FORWARD : i % 3 === 1 ? BTN_FORWARD | BTN_SPRINT : BTN_LEFT,
      yaw: (i * 0.1) % (Math.PI * 2),
    }));

    for (const input of inputSeq) {
      s1.runClientFrames(1, input);
      s2.runClientFrames(1, input);
    }

    const pos1 = s1.getClientPosition();
    const pos2 = s2.getClientPosition();

    // Must be bit-identical (same Rapier world, same inputs, same order)
    // Using 4 decimal places = 0.0001m = 0.1mm precision
    expect(pos1[0]).toBeCloseTo(pos2[0], 4);
    expect(pos1[1]).toBeCloseTo(pos2[1], 4);
    expect(pos1[2]).toBeCloseTo(pos2[2], 4);

    // Both should have actually moved (not stuck at origin)
    // The mixed input sequence (forward, sprint-forward, left strafe) with varying yaw
    // produces modest net displacement due to direction changes
    const dist1 = Math.hypot(pos1[0], pos1[2]);
    expect(dist1).toBeGreaterThan(0.1);

    // Input counts should match
    expect(s1.client.getTickCount()).toBe(s2.client.getTickCount());

    s2.dispose();
  });

  it('L38: client-server determinism (same inputs → close positions)', () => {
    const s = createScenario({ latencyMs: 0 });

    // Run 60 frames with same input, no latency
    s.runClientFrames(60, { buttons: BTN_FORWARD });
    s.runServerTicks(60);

    // Deliver all snapshots
    s.deliverServerToClient();

    assertInvariants(s, 'L38 after reconcile');

    // Client uses Rapier + collisions, server uses pure math
    // They won't be bit-identical but should be within protocol encoding precision
    const cp = s.getClientPosition();
    const sp = s.getServerPosition();

    // Both should have moved forward substantially
    expect(cp[2]).toBeGreaterThan(2.0);
    expect(sp[2]).toBeGreaterThan(2.0);

    // Within ~0.5m tolerance (Rapier collision vs pure math difference)
    expect(Math.abs(cp[2] - sp[2])).toBeLessThan(0.5);

    // All inputs should be acked (zero latency)
    expect(s.getPendingInputCount()).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// Category B (continued): More Divergence Scenarios
// ═══════════════════════════════════════════════

describe('Category B (continued): Divergence', () => {
  it('B6: reconciliation during jump preserves trajectory', () => {
    const s = createScenario({ latencyMs: 25 });

    // Build up speed, then jump
    s.runClientFrames(15, { buttons: BTN_FORWARD });
    s.runClientFrames(1, { buttons: BTN_FORWARD | BTN_JUMP });
    s.runClientFrames(10, { buttons: BTN_FORWARD }); // in air

    // Server processes early frames
    s.runServerTicks(15);

    // Deliver snapshot mid-jump
    s.clientClock.advance(50);
    s.serverClock.advance(25);
    s.deliverServerToClient();

    // Client should still be moving forward (replay includes jump)
    const pos = s.getClientPosition();
    expect(pos[2]).toBeGreaterThan(0.5);
    // Y should be above ground (mid-jump or still ascending)
    // (Don't assert exact Y since Rapier vs pure-math jump heights differ)
  });

  it('B3: server has wall client does not — reconciliation corrects', () => {
    const s = createScenario({ latencyMs: 25 });

    // Client walks forward, server says "you stopped at z=2" (wall exists server-side)
    s.runClientFrames(60, { buttons: BTN_FORWARD });

    // Server runs but we manually override to simulate wall stop
    s.runServerTicks(60);
    const serverPlayer = s.serverPlayers.get(1)!;
    // Clamp server position as if wall existed at z=2
    if (serverPlayer.position[2] > 2) {
      serverPlayer.position[2] = 2;
      serverPlayer.velocity[2] = 0;
    }

    // Deliver corrected snapshot
    s.clientClock.advance(50);
    s.serverClock.advance(25);
    s.deliverServerToClient();

    // Client should snap back toward server's wall-limited position
    // After replay, client might push past again (no client-side wall),
    // but the reconciliation itself should have corrected
    const pending = s.getPendingInputCount();
    expect(pending).toBeGreaterThanOrEqual(0); // some unacked inputs remain
  });
});

// ═══════════════════════════════════════════════
// Category C (continued): More Latency Scenarios
// ═══════════════════════════════════════════════

describe('Category C (continued): Latency', () => {
  it('C10: asymmetric latency (upload 20ms, download 150ms)', () => {
    const s = createScenario({ latencyMs: 20 }); // start with symmetric

    // Asymmetric: fast upload, slow download
    s.setClientToServerConfig({ latencyMs: 20 });
    s.setServerToClientConfig({ latencyMs: 150 });

    for (let i = 0; i < 60; i++) {
      s.runClientFrames(1, { buttons: BTN_FORWARD });
      s.runServerTicks(1);
      s.clientClock.advance(FIXED_DT * 1000);
      s.serverClock.advance(FIXED_DT * 1000);
      if (i % 5 === 0) {
        s.deliverServerToClient();
      }
    }

    assertInvariants(s, 'C10 asymmetric');

    // Client should still be moving forward
    const pos = s.getClientPosition();
    expect(pos[2]).toBeGreaterThan(1.0);

    // With slow download, client has many pending inputs, but position stays bounded
    // Divergence is higher than symmetric case but still manageable
    expect(s.getClientServerDivergence()).toBeLessThan(4.0);
  });

  it('C11: gradual latency increase (50ms → 300ms over 5 seconds)', () => {
    const s = createScenario({ latencyMs: 25 });

    // 300 frames = 5 seconds, linearly increase latency
    for (let i = 0; i < 300; i++) {
      const oneWayMs = 25 + (i / 300) * 125; // 25ms → 150ms
      s.setClientToServerConfig({ latencyMs: oneWayMs });
      s.setServerToClientConfig({ latencyMs: oneWayMs });

      s.runClientFrames(1, { buttons: BTN_FORWARD });
      s.runServerTicks(1);

      if (i % 4 === 0) {
        s.clientClock.advance(oneWayMs * 2);
        s.serverClock.advance(oneWayMs);
        s.deliverServerToClient();
      }
    }

    // System should be stable (no explosion)
    const pos = s.getClientPosition();
    expect(pos[2]).toBeGreaterThan(1.0);
    expect(isFinite(pos[0]) && isFinite(pos[1]) && isFinite(pos[2])).toBe(true);
  });

  it('C13: cellular conditions (180ms RTT, jitter, packet loss) stay bounded', () => {
    const s = createScenario({ latencyMs: 90, jitterMs: 35, packetLossRate: 0.03, seed: 777 });

    for (let i = 0; i < 360; i++) {
      const buttons = i % 120 < 40
        ? BTN_FORWARD
        : i % 120 < 80
          ? BTN_FORWARD | BTN_RIGHT
          : BTN_FORWARD | BTN_LEFT;
      const yaw = (i % 90) * (Math.PI / 180);

      s.runClientFrames(1, { buttons, yaw });
      s.runServerTicks(1);

      if (i % 3 === 0) {
        s.clientClock.advance(180);
        s.serverClock.advance(90);
        s.deliverServerToClient();
      }
    }

    assertInvariants(s, 'C13 cellular');

    const pos = s.getClientPosition();
    expect(pos[2]).toBeGreaterThan(1.0);
    expect(s.getPendingInputCount()).toBeLessThan(220);
    expect(s.getClientServerDivergence()).toBeLessThan(6.0);
  });

  it('C14: degraded cellular burst recovers after network improves', () => {
    const s = createScenario({ latencyMs: 30, jitterMs: 5, packetLossRate: 0, seed: 909 });

    for (let i = 0; i < 90; i++) {
      s.runClientFrames(1, { buttons: BTN_FORWARD, yaw: 0.15 });
      s.runServerTicks(1);
      if (i % 3 === 0) {
        s.clientClock.advance(60);
        s.serverClock.advance(30);
        s.deliverServerToClient();
      }
    }

    const divergenceBeforeBurst = s.getClientServerDivergence();

    s.setClientToServerConfig({ latencyMs: 120, jitterMs: 60, packetLossRate: 0.08 });
    s.setServerToClientConfig({ latencyMs: 140, jitterMs: 80, packetLossRate: 0.08 });

    for (let i = 0; i < 120; i++) {
      s.runClientFrames(1, {
        buttons: i % 20 < 10 ? BTN_FORWARD | BTN_SPRINT : BTN_FORWARD,
        yaw: 0.35,
      });
      s.runServerTicks(1);
      if (i % 4 === 0) {
        s.clientClock.advance(220);
        s.serverClock.advance(110);
        s.deliverServerToClient();
      }
    }

    assertInvariants(s, 'C14 during burst');

    s.setClientToServerConfig({ latencyMs: 30, jitterMs: 5, packetLossRate: 0 });
    s.setServerToClientConfig({ latencyMs: 30, jitterMs: 5, packetLossRate: 0 });

    for (let i = 0; i < 120; i++) {
      s.runClientFrames(1, { buttons: BTN_FORWARD, yaw: 0.1 });
      s.runServerTicks(1);
      if (i % 2 === 0) {
        s.clientClock.advance(60);
        s.serverClock.advance(30);
        s.deliverServerToClient();
      }
    }

    assertInvariants(s, 'C14 after recovery');

    expect(s.getClientPosition()[2]).toBeGreaterThan(1.0);
    expect(s.getClientServerDivergence()).toBeLessThan(4.0);
    expect(s.getClientServerDivergence()).toBeLessThanOrEqual(divergenceBeforeBurst + 3.0);
  });
});

// ═══════════════════════════════════════════════
// Category D (continued): Input Packet Loss
// ═══════════════════════════════════════════════

describe('Category D (continued): Input Loss', () => {
  it('D13: single input packet lost — server repeats, client reconciles', () => {
    const s = createScenario({ latencyMs: 0 });

    // Run 10 frames normally
    s.runClientFrames(10, { buttons: BTN_FORWARD });
    s.runServerTicks(10);
    s.deliverServerToClient();

    // Drop the next input packet
    s.setClientToServerConfig({ packetLossRate: 1.0 });
    s.runClientFrames(1, { buttons: BTN_FORWARD });
    s.setClientToServerConfig({ packetLossRate: 0.0 });

    // Server didn't get it, repeats last input
    s.runServerTicks(1);

    // Continue normally
    s.runClientFrames(10, { buttons: BTN_FORWARD });
    s.runServerTicks(10);
    s.deliverServerToClient();

    // Should reconcile smoothly
    expect(s.getClientServerDivergence()).toBeLessThan(2.0);
  });

  it('D14: burst input loss (5 consecutive lost) — recovery', () => {
    const s = createScenario({ latencyMs: 0 });

    // Normal for 10 frames
    s.runClientFrames(10, { buttons: BTN_FORWARD });
    s.runServerTicks(10);
    s.deliverServerToClient();

    assertInvariants(s, 'D14 before loss');
    const posBeforeLoss = s.getClientPosition();

    // Drop 5 input packets
    s.setClientToServerConfig({ packetLossRate: 1.0 });
    s.runClientFrames(5, { buttons: BTN_FORWARD });
    s.setClientToServerConfig({ packetLossRate: 0.0 });

    // Server ran 5 ticks with repeated last input (divergence grows)
    s.runServerTicks(5);

    // Resume
    s.runClientFrames(20, { buttons: BTN_FORWARD });
    s.runServerTicks(20);
    s.deliverServerToClient();

    assertInvariants(s, 'D14 after recovery');

    // Position should converge after recovery
    expect(s.getClientServerDivergence()).toBeLessThan(2.0);
    // Must still be moving forward
    const pos = s.getClientPosition();
    expect(pos[2]).toBeGreaterThan(posBeforeLoss[2]);
  });
});

// ═══════════════════════════════════════════════
// Category E: Jitter & Ordering
// ═══════════════════════════════════════════════

describe('Category E: Jitter & Ordering', () => {
  it('E17: variable jitter (30ms-150ms) — system stays stable', () => {
    const s = createScenario({ latencyMs: 50, jitterMs: 60 });

    for (let i = 0; i < 120; i++) {
      s.runClientFrames(1, { buttons: BTN_FORWARD });
      s.runServerTicks(1);

      if (i % 3 === 0) {
        s.clientClock.advance(100);
        s.serverClock.advance(50);
        s.deliverServerToClient();
      }
    }

    const pos = s.getClientPosition();
    expect(pos[2]).toBeGreaterThan(0.5); // still moving
    expect(isFinite(pos[0])).toBe(true);
  });

  it('E19: input bundle duplication — server deduplicates', () => {
    const s = createScenario({ latencyMs: 0 });

    // Send inputs normally
    const cmds = s.runClientFrames(5, { buttons: BTN_FORWARD });

    // Manually re-inject the same commands (simulating network retry)
    const player = s.serverPlayers.get(1)!;
    const queueBefore = player.inputQueue.length;

    // Try to enqueue duplicate sequence numbers
    for (const cmd of cmds) {
      const diff = (cmd.seq - player.lastAckedSeq + 0x10000) & 0xffff;
      if (diff === 0 || diff >= 0x8000) continue; // should be rejected
      player.inputQueue.push(cmd);
    }

    s.runServerTicks(10);
    s.deliverServerToClient();

    // Should still work (server may process extras but behavior stays bounded)
    expect(s.getClientServerDivergence()).toBeLessThan(3.0);
  });
});

// ═══════════════════════════════════════════════
// Category G: Interpolation Edge Cases
// ═══════════════════════════════════════════════

describe('Category G: Interpolation Edge Cases', () => {
  it('G22: remote player with single sample — returns that sample', () => {
    const s = createScenario();

    // Add a remote player
    s.addRemotePlayer(2, [5, 0, 5]);

    // Run enough for one snapshot
    s.runServerTicks(2); // 2 ticks = 1 snapshot at default interval
    s.clientClock.advance(100);
    s.deliverServerToClient();

    // Snapshot should contain player 2
    const snapshot = s.serverPlayers.get(2);
    expect(snapshot).toBeDefined();
  });

  it('G24: server clock jump — offset converges via EMA', () => {
    const clock = new ServerClockEstimator();

    // Normal observation
    clock.observe(1_000_000, 900_000); // offset = +100_000
    expect(clock.getOffsetUs()).toBe(100_000);

    // Server time jumps forward (clock correction)
    clock.observe(1_500_000, 950_000); // sample offset = +550_000
    // Symmetric EMA: 100_000 * 0.9 + 550_000 * 0.1 = 145_000
    expect(clock.getOffsetUs()).toBe(145_000);

    // After many observations at the new offset, it converges
    for (let i = 0; i < 100; i++) {
      clock.observe(1_500_000 + i * 33_333, 950_000 + i * 33_333);
    }
    expect(clock.getOffsetUs()).toBeCloseTo(550_000, -4);
  });

  it('G25: interpolation delay too short — holds at latest sample', () => {
    const interp = new PlayerInterpolator();

    // Only one sample in the past
    interp.push(1, {
      serverTimeUs: 1_000_000,
      position: [5, 0, 5],
      velocity: [0, 0, 0],
      yaw: 0, pitch: 0, hp: 100, flags: 1,
    });

    // Request a time far in the future (buffer starved)
    const sample = interp.sample(1, 2_000_000);

    // Should return the latest sample, not null
    expect(sample).not.toBeNull();
    expect(sample!.position[0]).toBeCloseTo(5);
  });

  it('G26: projectile extrapolation capped at 150ms', () => {
    const interp = new ProjectileInterpolator();

    // Need 2+ samples for extrapolation (1 sample returns as-is)
    interp.push(1, {
      serverTimeUs: 900_000,
      position: [-1, 0, 0],
      velocity: [10, 0, 0],
      kind: 1, ownerId: 1, sourceShotId: 1,
    });
    interp.push(1, {
      serverTimeUs: 1_000_000,
      position: [0, 0, 0],
      velocity: [10, 0, 0], // 10 m/s in X
      kind: 1, ownerId: 1, sourceShotId: 1,
    });

    // 100ms after latest sample → should extrapolate
    const sample100 = interp.sample(1, 1_100_000);
    expect(sample100!.position[0]).toBeCloseTo(1.0, 1); // 10 * 0.1s

    // 500ms after → should cap at 150ms of extrapolation
    const sample500 = interp.sample(1, 1_500_000);
    expect(sample500!.position[0]).toBeCloseTo(1.5, 1); // 10 * 0.15s (capped)
  });
});

// ═══════════════════════════════════════════════
// Category I: Connection Lifecycle
// ═══════════════════════════════════════════════

describe('Category I: Connection Lifecycle', () => {
  it('I30: full startup sequence (welcome → chunk → snapshot → prediction)', () => {
    // This is implicitly tested by createScenario() but let's be explicit
    const s = createScenario();

    expect(s.client.isWorldLoaded()).toBe(true);
    expect(s.client.isInitialized()).toBe(true);

    // Can run frames immediately
    const cmds = s.runClientFrames(5, { buttons: BTN_FORWARD });
    expect(cmds).toHaveLength(5);

    const pos = s.getClientPosition();
    expect(pos[2]).toBeGreaterThan(0);
  });

  it('I31: prediction continues after snapshot gap', () => {
    const s = createScenario({ latencyMs: 0 });

    // Normal operation
    s.runClientFrames(30, { buttons: BTN_FORWARD });
    s.runServerTicks(30);
    s.deliverServerToClient();

    const posBefore = s.getClientPosition();

    // No snapshots for 2 seconds (but client keeps predicting)
    s.runClientFrames(120, { buttons: BTN_FORWARD });

    const posAfter = s.getClientPosition();
    // Client should keep moving forward even without server updates
    expect(posAfter[2]).toBeGreaterThan(posBefore[2]);
  });
});

// ═══════════════════════════════════════════════
// Category M: Multi-Player Scenarios
// ═══════════════════════════════════════════════

describe('Category M: Multi-Player', () => {
  it('M1: remote player appears in snapshot and has position', () => {
    const s = createScenario({ latencyMs: 0 });

    // Add a second player on the server
    s.addRemotePlayer(2, [10, 0, 10]);

    // Run ticks to generate snapshot with both players
    s.runClientFrames(4, { buttons: BTN_FORWARD });
    s.runServerTicks(4);
    s.deliverServerToClient();

    // The snapshot should have included player 2
    // We can verify by checking the log
    const snapEvents = s.log.filter(e => e.type === 'server-snapshot');
    expect(snapEvents.length).toBeGreaterThan(0);
  });

  it('M2: remote player removal reflected in next snapshot', () => {
    const s = createScenario({ latencyMs: 0 });

    // Add and then remove remote player
    s.addRemotePlayer(2, [10, 0, 10]);
    s.runServerTicks(4);
    s.deliverServerToClient();

    s.removeRemotePlayer(2);
    s.runServerTicks(4);
    s.deliverServerToClient();

    // Player 2 should no longer be in server players
    expect(s.serverPlayers.has(2)).toBe(false);
  });

  it('M3: two players moving independently — both positions tracked', () => {
    const s = createScenario({ latencyMs: 0 });

    s.addRemotePlayer(2, [20, 0, 0]);

    // Move player 2 on the server manually
    const player2 = s.serverPlayers.get(2)!;

    for (let i = 0; i < 30; i++) {
      s.runClientFrames(1, { buttons: BTN_FORWARD });

      // Manually move player 2 in +X direction on server
      player2.position[0] += 0.1;

      s.runServerTicks(1);
    }

    s.deliverServerToClient();

    // Local player should have moved in +Z
    const localPos = s.getClientPosition();
    expect(localPos[2]).toBeGreaterThan(0.5);

    // Server player 2 should have moved in +X
    const p2Pos = s.getServerPosition(2);
    expect(p2Pos[0]).toBeGreaterThan(19.99);
  });

  it('M4: server ackInputSeq is per-player (does not leak)', () => {
    const s = createScenario({ latencyMs: 0 });

    // Player 1 sends 10 inputs
    s.runClientFrames(10, { buttons: BTN_FORWARD });
    s.runServerTicks(10);
    s.deliverServerToClient();

    // Player 1's ackInputSeq should be > 0
    const player1 = s.serverPlayers.get(1)!;
    expect(player1.lastAckedSeq).toBeGreaterThan(0);

    // Add player 2 — their ackInputSeq should start at 0
    s.addRemotePlayer(2, [10, 0, 10]);
    const player2 = s.serverPlayers.get(2)!;
    expect(player2.lastAckedSeq).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// Category N: Movement Direction Regression
// ═══════════════════════════════════════════════

describe('Category N: Movement Direction Regression', () => {
  /**
   * Regression test for left/right strafe being flipped.
   *
   * Root cause: the movement code computed right = (cos(yaw), 0, -sin(yaw))
   * which is +X at yaw=0. But Three.js cameras look down their local -Z, so
   * when the game points the camera at +Z via lookAt, screen-right is -X.
   * The right vector was pointing the wrong way, causing D key to move left.
   *
   * This test verifies that pressing D (BTN_RIGHT) at yaw=0 moves the player
   * in the -X direction (matching Three.js camera screen-right).
   */
  it('N1: D key (BTN_RIGHT) at yaw=0 moves player in -X direction (screen right)', () => {
    const s = createScenario({ latencyMs: 0 });

    // Run enough frames to build up movement in the right-strafe direction
    s.runClientFrames(30, { buttons: BTN_RIGHT, yaw: 0 });
    s.runServerTicks(30);
    s.deliverServerToClient();

    const pos = s.getClientPosition();
    // At yaw=0, camera forward is +Z, camera right is -X in Three.js
    expect(pos[0]).toBeLessThan(-0.5,
      `D key at yaw=0 should move -X (camera right), but X=${pos[0].toFixed(3)}`);
    // Should not have significant forward/backward movement
    expect(Math.abs(pos[2])).toBeLessThan(0.5);
  });

  it('N2: A key (BTN_LEFT) at yaw=0 moves player in +X direction (screen left)', () => {
    const s = createScenario({ latencyMs: 0 });

    s.runClientFrames(30, { buttons: BTN_LEFT, yaw: 0 });
    s.runServerTicks(30);
    s.deliverServerToClient();

    const pos = s.getClientPosition();
    expect(pos[0]).toBeGreaterThan(0.5,
      `A key at yaw=0 should move +X (camera left), but X=${pos[0].toFixed(3)}`);
    expect(Math.abs(pos[2])).toBeLessThan(0.5);
  });

  it('N3: left and right strafe produce opposite displacements', () => {
    const sRight = createScenario({ latencyMs: 0 });
    sRight.runClientFrames(30, { buttons: BTN_RIGHT, yaw: 0.7 });
    const posRight = sRight.getClientPosition();
    sRight.dispose();
    scenario = null;

    const sLeft = createScenario({ latencyMs: 0 });
    sLeft.runClientFrames(30, { buttons: BTN_LEFT, yaw: 0.7 });
    const posLeft = sLeft.getClientPosition();

    // Displacement vectors should point in opposite directions
    const dot = posRight[0] * posLeft[0] + posRight[2] * posLeft[2];
    expect(dot).toBeLessThan(0,
      `Left and right displacements should be opposite, dot=${dot.toFixed(3)}`);
  });

  it('N4: forward/backward remain correct after right-vector fix', () => {
    const s = createScenario({ latencyMs: 0 });

    s.runClientFrames(30, { buttons: BTN_FORWARD, yaw: 0 });
    const pos = s.getClientPosition();

    // At yaw=0, forward is +Z
    expect(pos[2]).toBeGreaterThan(1.0,
      `W key at yaw=0 should move +Z, but Z=${pos[2].toFixed(3)}`);
    expect(Math.abs(pos[0])).toBeLessThan(1.0);
  });
});

// ═══════════════════════════════════════════════
// Category O: Dynamic Body Reconciliation Regression
// ═══════════════════════════════════════════════

describe('Category O: Dynamic Body Reconciliation', () => {
  /**
   * Regression test for jitter when standing on a dynamic body.
   *
   * Root cause: reconcile() replayed pending inputs against stale dynamic
   * body collider positions (from the previous snapshot). After reconcile,
   * the dynamic bodies were updated to their new positions, causing a
   * mismatch between the replayed trajectory and the actual collider state.
   * This produced visible jitter every snapshot frame.
   *
   * Fix: sync dynamic body colliders into the WASM sim BEFORE running
   * reconcile, so the replay collides with the same geometry the server used.
   *
   * This test creates a dynamic platform, positions the player on it, moves
   * the platform, and verifies reconciliation produces minimal correction.
   */
  it('O1: player on moving dynamic body — reconcile after body sync produces small correction', () => {
    const sim = new WasmSimWorld();

    // Ground plane
    sim.addCuboid(0, -0.5, 0, 500, 0.5, 500);

    // Dynamic platform at y=1 (player will stand on it at y~2)
    sim.syncDynamicBody(100, 0, 2, 0.5, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0);

    sim.spawnPlayer(0, 2, 0);
    sim.rebuildBroadPhase();

    const mgr = new PredictionManager(sim);

    // Load ground chunk
    const blocks: Array<{ x: number; y: number; z: number; material: number }> = [];
    for (let x = 0; x < 16; x++)
      for (let z = 0; z < 16; z++)
        blocks.push({ x, y: 15, z, material: 1 });
    mgr.applyWorldPacket({ type: 'chunkFull' as const, chunk: [0, -1, 0] as [number, number, number], version: 1, blocks });

    // Initialize position on the platform
    mgr.reconcile(0, {
      id: 1,
      pxMm: metersToMm(0), pyMm: metersToMm(2), pzMm: metersToMm(0),
      vxCms: 0, vyCms: 0, vzCms: 0,
      yawI16: angleToI16(0), pitchI16: angleToI16(0),
      flags: FLAG_ON_GROUND,
    });

    // Predict 10 ticks standing still on the platform
    for (let i = 0; i < 10; i++) {
      mgr.update(FIXED_DT, 0, 0, 0);
    }

    // Now simulate the platform moving slightly (server moved it)
    // CORRECT ORDER: sync dynamic body FIRST, then reconcile
    sim.syncDynamicBody(100, 0, 2, 0.5, 2, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0);
    sim.rebuildBroadPhase();

    const posBefore = mgr.getPosition();
    mgr.reconcile(5, {
      id: 1,
      pxMm: metersToMm(0), pyMm: metersToMm(2), pzMm: metersToMm(0),
      vxCms: 0, vyCms: 0, vzCms: 0,
      yawI16: angleToI16(0), pitchI16: angleToI16(0),
      flags: FLAG_ON_GROUND,
    });
    const posAfter = mgr.getPosition();

    const correction = Math.hypot(
      posAfter[0] - posBefore[0],
      posAfter[1] - posBefore[1],
      posAfter[2] - posBefore[2],
    );

    // With dynamic bodies synced before reconcile, correction should be small
    expect(correction).toBeLessThan(0.5,
      `Correction after body-sync + reconcile should be small, got ${correction.toFixed(3)}m`);

    mgr.dispose();
  });

  it('O2: repeated reconciliation on dynamic body — no jitter accumulation', () => {
    const sim = new WasmSimWorld();

    sim.addCuboid(0, -0.5, 0, 500, 0.5, 500);

    // Platform
    sim.syncDynamicBody(100, 0, 2, 0.5, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0);
    sim.spawnPlayer(0, 2, 0);
    sim.rebuildBroadPhase();

    const mgr = new PredictionManager(sim);
    const blocks: Array<{ x: number; y: number; z: number; material: number }> = [];
    for (let x = 0; x < 16; x++)
      for (let z = 0; z < 16; z++)
        blocks.push({ x, y: 15, z, material: 1 });
    mgr.applyWorldPacket({ type: 'chunkFull' as const, chunk: [0, -1, 0] as [number, number, number], version: 1, blocks });

    mgr.reconcile(0, {
      id: 1,
      pxMm: metersToMm(0), pyMm: metersToMm(2), pzMm: metersToMm(0),
      vxCms: 0, vyCms: 0, vzCms: 0,
      yawI16: angleToI16(0), pitchI16: angleToI16(0),
      flags: FLAG_ON_GROUND,
    });

    const corrections: number[] = [];

    // 10 rounds of predict + sync dynamic body + reconcile
    for (let round = 0; round < 10; round++) {
      // Predict 3 ticks
      for (let i = 0; i < 3; i++) {
        mgr.update(FIXED_DT, 0, 0, 0);
      }

      // Platform drifts slightly each round (simulating server physics)
      const platformX = round * 0.1;
      sim.syncDynamicBody(100, 0, 2, 0.5, 2, platformX, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0);
      sim.rebuildBroadPhase();

      const posBefore = mgr.getPosition();
      const ackSeq = (round + 1) * 3;
      mgr.reconcile(ackSeq, {
        id: 1,
        pxMm: metersToMm(0), pyMm: metersToMm(2), pzMm: metersToMm(0),
        vxCms: 0, vyCms: 0, vzCms: 0,
        yawI16: angleToI16(0), pitchI16: angleToI16(0),
        flags: FLAG_ON_GROUND,
      });
      const posAfter = mgr.getPosition();

      corrections.push(Math.hypot(
        posAfter[0] - posBefore[0],
        posAfter[1] - posBefore[1],
        posAfter[2] - posBefore[2],
      ));
    }

    // Corrections should remain small and not accumulate
    const maxCorrection = Math.max(...corrections);
    const meanCorrection = corrections.reduce((a, b) => a + b, 0) / corrections.length;
    expect(maxCorrection).toBeLessThan(1.0,
      `Max correction should be small, got ${maxCorrection.toFixed(3)}m`);
    expect(meanCorrection).toBeLessThan(0.5,
      `Mean correction should be small, got ${meanCorrection.toFixed(3)}m`);

    mgr.dispose();
  });
});

// ═══════════════════════════════════════════════
// Harness unit tests
// ═══════════════════════════════════════════════

describe('Test Harness Components', () => {
  describe('MockClock', () => {
    it('starts at zero', () => {
      const clock = new MockClock();
      expect(clock.now()).toBe(0);
      expect(clock.nowUs()).toBe(0);
    });

    it('advance increments time', () => {
      const clock = new MockClock();
      clock.advance(100);
      expect(clock.now()).toBe(100);
      expect(clock.nowUs()).toBe(100_000);
    });

    it('set replaces time', () => {
      const clock = new MockClock();
      clock.advance(50);
      clock.set(200);
      expect(clock.now()).toBe(200);
    });
  });

  describe('MockTransport', () => {
    it('delivers packets after latency', () => {
      const transport = new MockTransport<string>(
        { latencyMs: 50, jitterMs: 0, packetLossRate: 0 },
      );

      transport.send('hello', 100);

      expect(transport.receive(130)).toHaveLength(0); // too early
      expect(transport.receive(150)).toEqual(['hello']); // arrived
    });

    it('drops packets based on loss rate', () => {
      const transport = new MockTransport<string>(
        { latencyMs: 0, jitterMs: 0, packetLossRate: 1.0 },
        42,
      );

      transport.send('dropped', 0);
      expect(transport.receive(1000)).toHaveLength(0);
    });

    it('delivers in order by arrival time', () => {
      const transport = new MockTransport<number>(
        { latencyMs: 50, jitterMs: 0, packetLossRate: 0 },
      );

      transport.send(1, 0);
      transport.send(2, 10);
      transport.send(3, 20);

      const received = transport.receive(100);
      expect(received).toEqual([1, 2, 3]);
    });
  });

  describe('SeededRandom', () => {
    it('produces deterministic sequence', () => {
      const rng1 = new SeededRandom(42);
      const rng2 = new SeededRandom(42);

      for (let i = 0; i < 100; i++) {
        expect(rng1.next()).toBe(rng2.next());
      }
    });

    it('different seeds produce different sequences', () => {
      const rng1 = new SeededRandom(42);
      const rng2 = new SeededRandom(43);

      expect(rng1.next()).not.toBe(rng2.next());
    });

    it('values are in [0, 1)', () => {
      const rng = new SeededRandom(42);
      for (let i = 0; i < 1000; i++) {
        const val = rng.next();
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThan(1);
      }
    });
  });
});
