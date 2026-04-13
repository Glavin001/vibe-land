import { describe, it, expect, vi } from 'vitest';
import { NetcodeClient } from './netcodeClient';
import {
  type NetDynamicBodyState,
  type NetVehicleState,
  type SnapshotPacket,
  type ShotResultPacket,
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
  dynamicBodyStates?: NetDynamicBodyState[];
  vehicleStates?: NetVehicleState[];
}): SnapshotPacket {
  const serverTick = opts.serverTick ?? 1;
  return {
    type: 'snapshot',
    serverTimeUs: serverTick * Math.round(1_000_000 / 60),
    serverTick,
    ackInputSeq: opts.ackInputSeq ?? 0,
    playerStates: opts.players,
    projectileStates: [],
    dynamicBodyStates: opts.dynamicBodyStates ?? [],
    vehicleStates: opts.vehicleStates ?? [],
  };
}

function makeDynamicBodyState(opts: {
  id?: number;
  position?: [number, number, number];
  halfExtents?: [number, number, number];
  velocity?: [number, number, number];
  shapeType?: number;
}): NetDynamicBodyState {
  const pos = opts.position ?? [0, 0, 0];
  const halfExtents = opts.halfExtents ?? [0.5, 0.5, 0.5];
  const vel = opts.velocity ?? [0, 0, 0];
  return {
    id: opts.id ?? 1,
    shapeType: opts.shapeType ?? 1,
    pxMm: metersToMm(pos[0]),
    pyMm: metersToMm(pos[1]),
    pzMm: metersToMm(pos[2]),
    qxSnorm: 0,
    qySnorm: 0,
    qzSnorm: 0,
    qwSnorm: 32767,
    hxCm: Math.round(halfExtents[0] * 100),
    hyCm: Math.round(halfExtents[1] * 100),
    hzCm: Math.round(halfExtents[2] * 100),
    vxCms: Math.round(vel[0] * 100),
    vyCms: Math.round(vel[1] * 100),
    vzCms: Math.round(vel[2] * 100),
    wxMrads: 0,
    wyMrads: 0,
    wzMrads: 0,
  };
}

function makeVehicleState(opts: {
  id?: number;
  driverId?: number;
  position?: [number, number, number];
  velocity?: [number, number, number];
}): NetVehicleState {
  const pos = opts.position ?? [0, 0, 0];
  const vel = opts.velocity ?? [0, 0, 0];
  return {
    id: opts.id ?? 200,
    vehicleType: 0,
    flags: 0,
    driverId: opts.driverId ?? 0,
    pxMm: metersToMm(pos[0]),
    pyMm: metersToMm(pos[1]),
    pzMm: metersToMm(pos[2]),
    qxSnorm: 0,
    qySnorm: 0,
    qzSnorm: 0,
    qwSnorm: 32767,
    vxCms: Math.round(vel[0] * 100),
    vyCms: Math.round(vel[1] * 100),
    vzCms: Math.round(vel[2] * 100),
    wxMrads: 0,
    wyMrads: 0,
    wzMrads: 0,
    wheelData: [0, 0, 0, 0],
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

    it('keeps remote-player interpolation at least half a snapshot interval behind', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));
      vi.spyOn(client.serverClock, 'getInterpolationDelayMs').mockReturnValue(5);

      client.handlePacket(makeSnapshot({
        serverTick: 10,
        players: [makeNetState({ id: 1 })],
      }));

      expect(client.interpolationDelayMs).toBeCloseTo((1000 / 30) * 0.5, 2);
    });

    it('keeps dynamic body render delay responsive even when player interpolation stays buffered', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));
      vi.spyOn(client.serverClock, 'getInterpolationDelayMs').mockReturnValue(5);

      client.handlePacket(makeSnapshot({
        serverTick: 10,
        players: [makeNetState({ id: 1 })],
        dynamicBodyStates: [makeDynamicBodyState({ id: 7, position: [1, 0, 0] })],
      }));

      expect(client.interpolationDelayMs).toBeCloseTo((1000 / 30) * 0.5, 2);
      expect(client.dynamicBodyInterpolationDelayMs).toBe(5);
    });

    it('still uses larger adaptive delays when jitter requires more buffering', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));
      vi.spyOn(client.serverClock, 'getInterpolationDelayMs').mockReturnValue(48);

      client.handlePacket(makeSnapshot({
        serverTick: 10,
        players: [makeNetState({ id: 1 })],
      }));

      expect(client.interpolationDelayMs).toBe(48);
    });

    it('ignores stale and duplicate snapshots', () => {
      let localSnapshotCount = 0;
      let localVehicleSnapshotCount = 0;
      const client = new NetcodeClient({
        onLocalSnapshot: () => {
          localSnapshotCount += 1;
        },
        onLocalVehicleSnapshot: () => {
          localVehicleSnapshotCount += 1;
        },
      });
      client.handlePacket(makeWelcome(1));

      client.handlePacket(makeSnapshot({
        serverTick: 10,
        ackInputSeq: 10,
        players: [makeNetState({ id: 1, position: [1, 0, 0] })],
        dynamicBodyStates: [makeDynamicBodyState({ id: 7, position: [1, 0, 0] })],
        vehicleStates: [makeVehicleState({ id: 200, driverId: 1, position: [5, 0, 0] })],
      }));
      client.handlePacket(makeSnapshot({
        serverTick: 9,
        ackInputSeq: 9,
        players: [makeNetState({ id: 1, position: [9, 0, 0] })],
        dynamicBodyStates: [makeDynamicBodyState({ id: 7, position: [9, 0, 0] })],
        vehicleStates: [makeVehicleState({ id: 200, driverId: 1, position: [9, 0, 0] })],
      }));
      client.handlePacket(makeSnapshot({
        serverTick: 10,
        ackInputSeq: 10,
        players: [makeNetState({ id: 1, position: [10, 0, 0] })],
        dynamicBodyStates: [makeDynamicBodyState({ id: 7, position: [10, 0, 0] })],
        vehicleStates: [makeVehicleState({ id: 200, driverId: 1, position: [10, 0, 0] })],
      }));

      expect(client.latestServerTick).toBe(10);
      expect(localSnapshotCount).toBe(1);
      expect(localVehicleSnapshotCount).toBe(1);
      expect(client.dynamicBodies.get(7)?.position[0]).toBeCloseTo(1);
      expect(client.vehicles.get(200)?.position[0]).toBeCloseTo(5);
    });

    it('stores replicated hp for local and remote players', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));

      client.handlePacket(makeSnapshot({
        serverTick: 5,
        players: [
          makeNetState({ id: 1, hp: 60 }),
          makeNetState({ id: 2, hp: 25 }),
        ],
      }));

      expect(client.localPlayerHp).toBe(60);
      expect(client.remotePlayers.get(2)?.hp).toBe(25);
    });

    it('retains dynamic bodies across partial snapshots', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));

      client.handlePacket(makeSnapshot({
        serverTick: 10,
        players: [makeNetState({ id: 1 })],
        dynamicBodyStates: [makeDynamicBodyState({ id: 7, position: [1, 2, 3] })],
      }));
      expect(client.dynamicBodies.has(7)).toBe(true);

      client.handlePacket(makeSnapshot({
        serverTick: 20,
        players: [makeNetState({ id: 1 })],
        dynamicBodyStates: [],
      }));
      expect(client.dynamicBodies.has(7)).toBe(true);
    });

    it('expires dynamic bodies after prolonged absence', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));

      client.handlePacket(makeSnapshot({
        serverTick: 10,
        players: [makeNetState({ id: 1 })],
        dynamicBodyStates: [makeDynamicBodyState({ id: 7 })],
      }));
      client.handlePacket(makeSnapshot({
        serverTick: 131,
        players: [makeNetState({ id: 1 })],
        dynamicBodyStates: [],
      }));

      expect(client.dynamicBodies.has(7)).toBe(false);
      expect(client.sampleRemoteDynamicBody(7)).toBeNull();
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

    it('interpolates dynamic body samples between snapshots', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));

      client.handlePacket(makeSnapshot({
        serverTick: 10,
        players: [makeNetState({ id: 1 })],
        dynamicBodyStates: [makeDynamicBodyState({ id: 7, position: [0, 0, 0], velocity: [6, 0, 0] })],
      }));
      client.handlePacket(makeSnapshot({
        serverTick: 12,
        players: [makeNetState({ id: 1 })],
        dynamicBodyStates: [makeDynamicBodyState({ id: 7, position: [0.2, 0, 0], velocity: [6, 0, 0] })],
      }));

      const t0 = 10 * Math.round(1_000_000 / 60);
      const t1 = 12 * Math.round(1_000_000 / 60);
      const sample = client.sampleRemoteDynamicBody(7, Math.round((t0 + t1) / 2));

      expect(sample).not.toBeNull();
      expect(sample!.position[0]).toBeGreaterThan(0.05);
      expect(sample!.position[0]).toBeLessThan(0.15);
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

  describe('shot results', () => {
    it('routes authoritative hit zone to onShotResult callback', () => {
      let received: ShotResultPacket | null = null;
      const client = new NetcodeClient({
        onShotResult: (packet) => {
          if (packet.type === 'shotResult') {
            received = packet;
          }
        },
      });

      client.handlePacket({
        type: 'shotResult',
        shotId: 7,
        weapon: 1,
        confirmed: true,
        hitPlayerId: 9,
        hitZone: 2,
        serverResolution: 1,
        serverDynamicBodyId: 0,
        serverDynamicHitToiCm: 0,
        serverDynamicImpulseCenti: 0,
      });

      expect(received).not.toBeNull();
      expect(received?.hitZone).toBe(2);
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
