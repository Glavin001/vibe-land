/**
 * Deterministic test harness for netcode integration testing.
 *
 * No real network, no real timers, but realistic payloads.
 * Tests call the same functions the production code calls, just with
 * hand-crafted inputs and controlled time.
 */

import { initWasmForTests, WasmSimWorld } from '../wasm/testInit';
import { PredictionManager, FIXED_DT } from '../physics/predictionManager';
import { buildInputFromButtons } from '../scene/inputBuilder';
import {
  type InputCmd,
  type NetPlayerState,
  type SnapshotPacket,
  type ServerWorldPacket,
  type ChunkFullPacket,
  type BlockCell,
  metersToMm,
  angleToI16,
  FLAG_ON_GROUND,
  BTN_FORWARD,
  BTN_JUMP,
  BTN_SPRINT,
  BTN_CROUCH,
} from './protocol';

// Re-export button constants for convenient test authoring
export { BTN_FORWARD, BTN_JUMP, BTN_SPRINT, BTN_CROUCH };
export {
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
} from './protocol';

// ─────────────────────────────────────────────────────────────────────
// MockClock — injectable replacement for performance.now()
// ─────────────────────────────────────────────────────────────────────

export class MockClock {
  private timeMs = 0;

  now(): number { return this.timeMs; }
  nowUs(): number { return this.timeMs * 1000; }

  advance(ms: number): void { this.timeMs += ms; }
  set(ms: number): void { this.timeMs = ms; }
}

// ─────────────────────────────────────────────────────────────────────
// MockTransport — simulated network link with latency/jitter/loss
// ─────────────────────────────────────────────────────────────────────

export type TransportConfig = {
  latencyMs: number;
  jitterMs: number;
  packetLossRate: number;
};

export class MockTransport<T> {
  private queue: Array<{ packet: T; deliverAtMs: number }> = [];
  private rng: SeededRandom;

  constructor(
    private config: TransportConfig,
    seed = 42,
  ) {
    this.rng = new SeededRandom(seed);
  }

  send(packet: T, sendTimeMs: number): void {
    if (this.rng.next() < this.config.packetLossRate) return;
    const jitter = (this.rng.next() - 0.5) * 2 * this.config.jitterMs;
    const deliverAt = sendTimeMs + this.config.latencyMs + jitter;
    this.queue.push({ packet, deliverAtMs: deliverAt });
  }

  receive(currentTimeMs: number): T[] {
    const ready: Array<{ packet: T; deliverAtMs: number }> = [];
    const remaining: typeof this.queue = [];
    for (const entry of this.queue) {
      if (entry.deliverAtMs <= currentTimeMs) {
        ready.push(entry);
      } else {
        remaining.push(entry);
      }
    }
    this.queue = remaining;
    ready.sort((a, b) => a.deliverAtMs - b.deliverAtMs);
    return ready.map((e) => e.packet);
  }

  setConfig(config: Partial<TransportConfig>): void {
    this.config = { ...this.config, ...config };
  }

  pendingCount(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
  }
}

// ─────────────────────────────────────────────────────────────────────
// SeededRandom — deterministic PRNG for reproducible tests
// ─────────────────────────────────────────────────────────────────────

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  next(): number {
    this.state = (this.state * 1664525 + 1013904223) & 0xffffffff;
    return (this.state >>> 0) / 0x100000000;
  }
}

// ─────────────────────────────────────────────────────────────────────
// SimulatedServerPlayer — mirrors Rust server's per-player movement
// ─────────────────────────────────────────────────────────────────────

export type SimulatedPlayerState = {
  sim: WasmSimWorld;
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  pitch: number;
  onGround: boolean;
  lastAckedSeq: number;
  inputQueue: InputCmd[];
  lastAppliedInput: InputCmd | null;
};

function createSimulatedPlayer(
  startPosition: [number, number, number],
  floorY: number,
): SimulatedPlayerState {
  const sim = new WasmSimWorld();
  sim.addCuboid(0, floorY - 0.5, 0, 500, 0.5, 500);
  sim.spawnPlayer(0, 2, 0);
  sim.rebuildBroadPhase();
  sim.setFullState(
    startPosition[0],
    startPosition[1],
    startPosition[2],
    0,
    0,
    0,
    0,
    0,
    true,
  );
  return {
    sim,
    position: [...startPosition],
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    onGround: true,
    lastAckedSeq: 0,
    inputQueue: [],
    lastAppliedInput: null,
  };
}

function simulatePlayerTick(
  player: SimulatedPlayerState,
  input: InputCmd,
  dt: number,
): void {
  const result = player.sim.tick(
    input.seq,
    input.buttons,
    input.moveX,
    input.moveY,
    input.yaw,
    input.pitch,
    dt,
  );
  player.position = [result[0], result[1], result[2]];
  player.velocity = [result[3], result[4], result[5]];
  player.yaw = input.yaw;
  player.pitch = input.pitch;
  player.onGround = result[6] !== 0;
}

// ─────────────────────────────────────────────────────────────────────
// NetcodeTestScenario
// ─────────────────────────────────────────────────────────────────────

export type ScenarioConfig = {
  latencyMs?: number;
  jitterMs?: number;
  packetLossRate?: number;
  startPosition?: [number, number, number];
  snapshotInterval?: number;
  playerId?: number;
  floorY?: number;
  seed?: number;
};

export type ScenarioEvent = {
  timeMs: number;
  type: string;
  detail: string;
};

export class NetcodeTestScenario {
  readonly clientClock: MockClock;
  readonly serverClock: MockClock;
  client!: PredictionManager;

  private readonly clientToServer: MockTransport<InputCmd[]>;
  private readonly serverToClient: MockTransport<SnapshotPacket>;

  readonly serverPlayers = new Map<number, SimulatedPlayerState>();
  private serverTick = 0;
  private readonly snapshotInterval: number;
  private readonly playerId: number;
  private readonly floorY: number;

  readonly log: ScenarioEvent[] = [];

  private wasmSim!: WasmSimWorld;
  private disposed = false;

  constructor(private readonly config: ScenarioConfig = {}) {
    const latencyMs = config.latencyMs ?? 50;
    const seed = config.seed ?? 42;

    this.clientClock = new MockClock();
    this.serverClock = new MockClock();
    this.snapshotInterval = config.snapshotInterval ?? 2;
    this.playerId = config.playerId ?? 1;
    this.floorY = config.floorY ?? 0;

    this.clientToServer = new MockTransport<InputCmd[]>(
      { latencyMs, jitterMs: config.jitterMs ?? 0, packetLossRate: config.packetLossRate ?? 0 },
      seed,
    );
    this.serverToClient = new MockTransport<SnapshotPacket>(
      { latencyMs, jitterMs: config.jitterMs ?? 0, packetLossRate: config.packetLossRate ?? 0 },
      seed + 1,
    );

    const startPos = config.startPosition ?? [0, 0, 0];
    this.serverPlayers.set(this.playerId, createSimulatedPlayer(startPos, this.floorY));
  }

  /** Must be called after initWasmForTests(). */
  init(): void {
    this.wasmSim = new WasmSimWorld();

    // Ground plane collider
    this.wasmSim.addCuboid(0, this.floorY - 0.5, 0, 500, 0.5, 500);
    this.wasmSim.spawnPlayer(0, 2, 0);
    this.wasmSim.rebuildBroadPhase();

    this.client = new PredictionManager(this.wasmSim);

    this.injectGroundChunk();

    const initSnapshot = this.buildSnapshot();
    this.client.reconcile(initSnapshot.ackInputSeq, initSnapshot.playerStates[0]);

    const startPos = this.config.startPosition ?? [0, 0, 0];
    this.emit('init', `playerId=${this.playerId} pos=[${startPos}] latency=${this.config.latencyMs ?? 50}ms`);
  }

  runClientFrames(
    count: number,
    input?: { buttons?: number; yaw?: number; pitch?: number },
  ): InputCmd[] {
    const allCmds: InputCmd[] = [];
    const buttons = input?.buttons ?? 0;
    const yaw = input?.yaw ?? 0;
    const pitch = input?.pitch ?? 0;

    for (let i = 0; i < count; i++) {
      this.clientClock.advance(FIXED_DT * 1000);
      const cmds = this.client.update(FIXED_DT, buttons, yaw, pitch);
      if (cmds.length > 0) {
        this.clientToServer.send(cmds, this.clientClock.now());
        allCmds.push(...cmds);
        this.emit('client-input', `seq=${cmds.map((c) => c.seq).join(',')} pending=${this.client.getPendingInputCount()}`);
      }
    }
    return allCmds;
  }

  runServerTicks(count: number): void {
    for (let i = 0; i < count; i++) {
      this.serverClock.advance(FIXED_DT * 1000);
      this.serverTick++;

      const arrivedBundles = this.clientToServer.receive(this.serverClock.now());
      for (const bundle of arrivedBundles) {
        const player = this.serverPlayers.get(this.playerId);
        if (player) {
          for (const cmd of bundle) {
            const diff = (cmd.seq - player.lastAckedSeq + 0x10000) & 0xffff;
            if (diff === 0 || diff >= 0x8000) continue;
            player.inputQueue.push(cmd);
          }
          while (player.inputQueue.length > 120) {
            player.inputQueue.shift();
          }
        }
      }

      for (const [, player] of this.serverPlayers) {
        let input: InputCmd;
        if (player.inputQueue.length > 0) {
          input = player.inputQueue.shift()!;
          player.lastAppliedInput = input;
          player.lastAckedSeq = input.seq;
        } else if (player.lastAppliedInput) {
          input = player.lastAppliedInput;
        } else {
          input = { seq: 0, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 };
        }

        simulatePlayerTick(player, input, FIXED_DT);
      }

      if (this.serverTick % this.snapshotInterval === 0) {
        const snapshot = this.buildSnapshot();
        this.serverToClient.send(snapshot, this.serverClock.now());
        this.emit('server-snapshot', `tick=${this.serverTick} ackSeq=${snapshot.ackInputSeq}`);
      }
    }
  }

  deliverServerToClient(): void {
    const snapshots = this.serverToClient.receive(this.clientClock.now());
    for (const snapshot of snapshots) {
      const localState = snapshot.playerStates.find((p) => p.id === this.playerId);
      if (localState) {
        const posBefore = this.client.getPosition();
        this.client.reconcile(snapshot.ackInputSeq, localState);
        const posAfter = this.client.getPosition();
        const correction = Math.hypot(
          posAfter[0] - posBefore[0],
          posAfter[1] - posBefore[1],
          posAfter[2] - posBefore[2],
        );
        this.emit(
          'client-reconcile',
          `ackSeq=${snapshot.ackInputSeq} correction=${correction.toFixed(4)} pending=${this.client.getPendingInputCount()}`,
        );
      }
    }
  }

  deliverClientToServer(): void {
    const bundles = this.clientToServer.receive(this.serverClock.now());
    for (const bundle of bundles) {
      const player = this.serverPlayers.get(this.playerId);
      if (player) {
        for (const cmd of bundle) {
          const diff = (cmd.seq - player.lastAckedSeq + 0x10000) & 0xffff;
          if (diff === 0 || diff >= 0x8000) continue;
          player.inputQueue.push(cmd);
        }
      }
    }
  }

  injectSnapshot(snapshot: SnapshotPacket): void {
    const localState = snapshot.playerStates.find((p) => p.id === this.playerId);
    if (localState) {
      this.client.reconcile(snapshot.ackInputSeq, localState);
      this.emit('inject-snapshot', `ackSeq=${snapshot.ackInputSeq}`);
    }
  }

  injectWorldPacket(packet: ServerWorldPacket): void {
    this.client.applyWorldPacket(packet);
    this.emit('inject-world', `type=${packet.type}`);
  }

  runRoundTrip(
    clientFrames: number,
    input?: { buttons?: number; yaw?: number; pitch?: number },
  ): void {
    this.runClientFrames(clientFrames, input);
    this.runServerTicks(clientFrames);
    const latency = this.config.latencyMs ?? 50;
    this.clientClock.advance(latency * 2);
    this.serverClock.advance(latency);
    this.deliverServerToClient();
  }

  getClientPosition(): [number, number, number] {
    return this.client.getPosition();
  }

  getServerPosition(playerId?: number): [number, number, number] {
    const player = this.serverPlayers.get(playerId ?? this.playerId);
    if (!player) throw new Error(`Player ${playerId ?? this.playerId} not found on server`);
    return [...player.position] as [number, number, number];
  }

  getClientServerDivergence(playerId?: number): number {
    const cp = this.getClientPosition();
    const sp = this.getServerPosition(playerId);
    return Math.hypot(cp[0] - sp[0], cp[1] - sp[1], cp[2] - sp[2]);
  }

  getCorrectionOffset(): [number, number, number] {
    return this.client.getCorrectionOffset();
  }

  getPendingInputCount(): number {
    return this.client.getPendingInputCount();
  }

  getServerTick(): number {
    return this.serverTick;
  }

  setClientToServerConfig(config: Partial<TransportConfig>): void {
    this.clientToServer.setConfig(config);
  }

  setServerToClientConfig(config: Partial<TransportConfig>): void {
    this.serverToClient.setConfig(config);
  }

  addRemotePlayer(id: number, position: [number, number, number]): void {
    this.serverPlayers.set(id, createSimulatedPlayer(position, this.floorY));
  }

  removeRemotePlayer(id: number): void {
    this.serverPlayers.get(id)?.sim.free();
    this.serverPlayers.delete(id);
  }

  private buildSnapshot(): SnapshotPacket {
    const serverTimeUs = this.serverTick * Math.round(1_000_000 / 60);
    const playerStates: NetPlayerState[] = [];

    for (const [id, player] of this.serverPlayers) {
      playerStates.push({
        id,
        pxMm: metersToMm(player.position[0]),
        pyMm: metersToMm(player.position[1]),
        pzMm: metersToMm(player.position[2]),
        vxCms: Math.round(player.velocity[0] * 100),
        vyCms: Math.round(player.velocity[1] * 100),
        vzCms: Math.round(player.velocity[2] * 100),
        yawI16: angleToI16(player.yaw),
        pitchI16: angleToI16(player.pitch),
        hp: 100,
        flags: player.onGround ? FLAG_ON_GROUND : 0,
      });
    }

    const localPlayer = this.serverPlayers.get(this.playerId);
    return {
      type: 'snapshot',
      serverTimeUs,
      serverTick: this.serverTick,
      ackInputSeq: localPlayer?.lastAckedSeq ?? 0,
      playerStates,
      projectileStates: [],
      dynamicBodyStates: [],
      vehicleStates: [],
    };
  }

  private injectGroundChunk(): void {
    const blocks: BlockCell[] = [];
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        blocks.push({ x, y: 15, z, material: 1 });
      }
    }

    const groundChunk: ChunkFullPacket = {
      type: 'chunkFull',
      chunk: [0, -1, 0],
      version: 1,
      blocks,
    };
    this.client.applyWorldPacket(groundChunk);
  }

  private emit(type: string, detail: string): void {
    this.log.push({ timeMs: this.clientClock.now(), type, detail });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const player of this.serverPlayers.values()) {
      player.sim.free();
    }
    this.serverPlayers.clear();
    this.client.dispose();
  }

  printLog(): void {
    for (const event of this.log) {
      console.log(`[${event.timeMs.toFixed(1)}ms] ${event.type}: ${event.detail}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────

export function makeNetState(opts: {
  id?: number;
  position?: [number, number, number];
  velocity?: [number, number, number];
  yaw?: number;
  pitch?: number;
  hp?: number;
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
    hp: opts.hp ?? 100,
    flags: opts.flags ?? 0,
  };
}

export function makeSnapshot(opts: {
  serverTick?: number;
  ackInputSeq?: number;
  players: NetPlayerState[];
}): SnapshotPacket {
  const serverTick = opts.serverTick ?? 1;
  return {
    type: 'snapshot',
    serverTimeUs: serverTick * Math.round(1_000_000 / 60),
    serverTick,
    ackInputSeq: opts.ackInputSeq ?? 0,
    playerStates: opts.players,
    projectileStates: [],
    dynamicBodyStates: [],
    vehicleStates: [],
  };
}

export function makeGroundChunk(
  chunkX = 0,
  chunkZ = 0,
  chunkY = -1,
  version = 1,
): ChunkFullPacket {
  const blocks: BlockCell[] = [];
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      blocks.push({ x, y: 15, z, material: 1 });
    }
  }
  return {
    type: 'chunkFull',
    chunk: [chunkX, chunkY, chunkZ],
    version,
    blocks,
  };
}
