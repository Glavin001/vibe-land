import { describe, it, expect } from 'vitest';
import { NetcodeClient } from './netcodeClient';
import {
  type SnapshotPacket,
  type WelcomePacket,
  type NetPlayerState,
  metersToMm,
  angleToI16,
  FLAG_ON_GROUND,
} from './protocol';

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

function makeWelcome(playerId = 1): WelcomePacket {
  return {
    type: 'welcome',
    playerId,
    simHz: 60,
    snapshotHz: 30,
    serverTimeUs: 1_000_000,
    interpolationDelayMs: 66,
  };
}

function makeSnapshot(opts: {
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
  };
}

describe('NetcodeClient', () => {
  // ──────────────────────────────────────────────
  // Welcome packet
  // ──────────────────────────────────────────────

  describe('welcome', () => {
    it('sets playerId from welcome packet', () => {
      let receivedId = 0;
      const client = new NetcodeClient({
        onWelcome: (id) => { receivedId = id; },
      });

      client.handlePacket(makeWelcome(42));

      expect(client.playerId).toBe(42);
      expect(receivedId).toBe(42);
    });

    it('sets interpolation delay from welcome packet', () => {
      const client = new NetcodeClient({});
      const welcome = makeWelcome(1);
      welcome.interpolationDelayMs = 100;

      client.handlePacket(welcome);

      expect(client.interpolationDelayMs).toBe(100);
    });
  });

  // ──────────────────────────────────────────────
  // Snapshot processing
  // ──────────────────────────────────────────────

  describe('snapshot processing', () => {
    it('routes local player state to onLocalSnapshot', () => {
      let receivedAck = -1;
      let receivedState: NetPlayerState | null = null;
      const client = new NetcodeClient({
        onLocalSnapshot: (ack, state) => {
          receivedAck = ack;
          receivedState = state;
        },
      });
      client.handlePacket(makeWelcome(1));

      const localState = makeNetState({ id: 1, position: [5, 1, 3] });
      client.handlePacket(makeSnapshot({
        serverTick: 10,
        ackInputSeq: 42,
        players: [localState],
      }));

      expect(receivedAck).toBe(42);
      expect(receivedState).not.toBeNull();
      expect(receivedState!.id).toBe(1);
    });

    it('adds remote players to remotePlayers map', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));

      const snapshot = makeSnapshot({
        serverTick: 1,
        players: [
          makeNetState({ id: 1, position: [0, 0, 0] }),
          makeNetState({ id: 2, position: [5, 0, 5] }),
          makeNetState({ id: 3, position: [10, 0, 10] }),
        ],
      });
      client.handlePacket(snapshot);

      expect(client.remotePlayers.size).toBe(2); // excludes local player
      expect(client.remotePlayers.has(2)).toBe(true);
      expect(client.remotePlayers.has(3)).toBe(true);
      expect(client.remotePlayers.has(1)).toBe(false); // local player excluded
    });

    it('removes disconnected remote players', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));

      // First snapshot with players 2 and 3
      client.handlePacket(makeSnapshot({
        serverTick: 1,
        players: [
          makeNetState({ id: 1 }),
          makeNetState({ id: 2, position: [5, 0, 0] }),
          makeNetState({ id: 3, position: [10, 0, 0] }),
        ],
      }));
      expect(client.remotePlayers.size).toBe(2);

      // Second snapshot: player 3 disconnected
      client.handlePacket(makeSnapshot({
        serverTick: 2,
        players: [
          makeNetState({ id: 1 }),
          makeNetState({ id: 2 }),
        ],
      }));
      expect(client.remotePlayers.size).toBe(1);
      expect(client.remotePlayers.has(3)).toBe(false);
    });

    it('updates latestServerTick', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));

      client.handlePacket(makeSnapshot({
        serverTick: 100,
        players: [makeNetState({ id: 1 })],
      }));

      expect(client.latestServerTick).toBe(100);
    });
  });

  // ──────────────────────────────────────────────
  // Interpolation
  // ──────────────────────────────────────────────

  describe('interpolation', () => {
    it('pushes remote player samples to interpolator', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));

      client.handlePacket(makeSnapshot({
        serverTick: 1,
        players: [
          makeNetState({ id: 1 }),
          makeNetState({ id: 2, position: [5, 0, 5] }),
        ],
      }));

      // Interpolator should have entity 2
      const sample = client.interpolator.sample(2, client.serverClock.serverNowUs());
      expect(sample).not.toBeNull();
    });

    it('sampleRemotePlayer returns null for unknown player', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));

      expect(client.sampleRemotePlayer(999)).toBeNull();
    });
  });

  // ──────────────────────────────────────────────
  // World packets
  // ──────────────────────────────────────────────

  describe('world packets', () => {
    it('routes chunk packets to onWorldPacket callback', () => {
      let received = false;
      const client = new NetcodeClient({
        onWorldPacket: () => { received = true; },
      });

      client.handlePacket({
        type: 'chunkFull',
        chunk: [0, 0, 0],
        version: 1,
        blocks: [{ x: 0, y: 0, z: 0, material: 1 }],
      });

      expect(received).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // Reset
  // ──────────────────────────────────────────────

  describe('reset', () => {
    it('clears all state', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(5));
      client.handlePacket(makeSnapshot({
        serverTick: 10,
        players: [
          makeNetState({ id: 5 }),
          makeNetState({ id: 6 }),
        ],
      }));

      expect(client.playerId).toBe(5);
      expect(client.remotePlayers.size).toBe(1);
      expect(client.latestServerTick).toBe(10);

      client.reset();

      expect(client.playerId).toBe(0);
      expect(client.remotePlayers.size).toBe(0);
      expect(client.latestServerTick).toBe(0);
    });
  });
});
