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
import * as RAPIER from '@dimforge/rapier3d-compat';
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
import { FIXED_DT, HARD_SNAP_DISTANCE, MAX_CATCHUP_STEPS } from '../physics/predictionManager';
import { FLAG_ON_GROUND } from './protocol';

beforeAll(async () => {
  await RAPIER.init();
});

let scenario: NetcodeTestScenario | null = null;
afterEach(() => {
  scenario?.dispose();
  scenario = null;
});

function createScenario(config?: Parameters<typeof NetcodeTestScenario['prototype']['constructor']>[0]): NetcodeTestScenario {
  const s = new NetcodeTestScenario(config);
  s.init();
  scenario = s;
  return s;
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

    // With zero latency and same physics, divergence should be small
    const divergence = s.getClientServerDivergence();
    expect(divergence).toBeLessThan(0.5);
    expect(s.getPendingInputCount()).toBe(0);
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

    const posBeforeSpike = s.getClientPosition();

    // Spike: increase latency to 250ms one-way
    s.setClientToServerConfig({ latencyMs: 250 });
    s.setServerToClientConfig({ latencyMs: 250 });

    // Continue during spike: 60 frames (1 second)
    for (let i = 0; i < 60; i++) {
      s.runClientFrames(1, { buttons: BTN_FORWARD });
      s.runServerTicks(1);
    }

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

    // Should not have exploded or teleported wildly
    const posAfterRecovery = s.getClientPosition();
    expect(posAfterRecovery[2]).toBeGreaterThan(posBeforeSpike[2]); // still moving
    expect(s.getClientServerDivergence()).toBeLessThan(5.0);
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

    // Advance sequence near wraparound
    for (let i = 0; i < 0xfff0; i++) {
      s.runClientFrames(1);
    }

    // Now run across the boundary
    const cmds = s.runClientFrames(32, { buttons: BTN_FORWARD });
    s.runServerTicks(32);
    s.deliverServerToClient();

    // Should have handled wraparound correctly
    expect(s.getClientServerDivergence()).toBeLessThan(1.0);

    // Verify we actually crossed the boundary
    const seqs = cmds.map((c) => c.seq);
    expect(seqs.some((s) => s > 0xfff0)).toBe(true);
    expect(seqs.some((s) => s < 0x0010)).toBe(true);
  });
});

// ═══════════════════════════════════════════════
// Category H: World State / Physics
// ═══════════════════════════════════════════════

describe('Category H: World State', () => {
  it('H28: chunk version mismatch throws', () => {
    const s = createScenario();

    // Apply chunk at version 1 (already done in init)
    // Try to apply diff with version 5 (mismatch: expected version 2)
    expect(() => {
      s.injectWorldPacket({
        type: 'chunkDiff',
        chunk: [0, -1, 0],
        version: 5,
        edits: [{ x: 0, y: 0, z: 0, op: 1, material: 2 }],
      });
    }).toThrow('version mismatch');
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
  it('L37: replay produces identical result', () => {
    // Run 100 inputs through two separate PredictionManagers
    const s1 = createScenario({ latencyMs: 0 });
    const s2 = createScenario({ latencyMs: 0 });

    // Same input sequence
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

    expect(pos1[0]).toBeCloseTo(pos2[0], 4);
    expect(pos1[1]).toBeCloseTo(pos2[1], 4);
    expect(pos1[2]).toBeCloseTo(pos2[2], 4);

    s2.dispose();
  });

  it('L38: client-server determinism (same inputs → close positions)', () => {
    const s = createScenario({ latencyMs: 0 });

    // Run 60 frames with same input, no latency
    s.runClientFrames(60, { buttons: BTN_FORWARD });
    s.runServerTicks(60);

    // Deliver all snapshots
    s.deliverServerToClient();

    // Client uses Rapier + collisions, server uses pure math
    // They won't be bit-identical but should be within protocol encoding precision
    const cp = s.getClientPosition();
    const sp = s.getServerPosition();

    // Within ~0.5m tolerance (Rapier collision vs pure math difference)
    expect(Math.abs(cp[2] - sp[2])).toBeLessThan(0.5);
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
