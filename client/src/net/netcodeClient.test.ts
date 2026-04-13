import { describe, it, expect, vi } from 'vitest';
import { NetcodeClient } from './netcodeClient';
import {
  type DynamicBodyMetaPacket,
  type NetDynamicBodyState,
  type NetVehicleState,
  type PlayerRosterPacket,
  type SnapshotPacket,
  type SnapshotV2Packet,
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

function makePlayerRoster(entries: Array<{ handle: number; playerId: number }>): PlayerRosterPacket {
  return {
    type: 'playerRoster',
    entries,
  };
}

function makeDynamicBodyMeta(
  entries: Array<{ handle: number; bodyId: number; shapeType?: number; halfExtents?: [number, number, number] }>,
): DynamicBodyMetaPacket {
  return {
    type: 'dynamicBodyMeta',
    entries: entries.map((entry) => ({
      handle: entry.handle,
      bodyId: entry.bodyId,
      shapeType: entry.shapeType ?? 1,
      halfExtents: entry.halfExtents ?? [0.5, 0.5, 0.5],
    })),
  };
}

function makeSnapshotV2(opts: {
  serverTick?: number;
  ackInputSeq?: number;
  anchorPosition?: [number, number, number];
  selfVelocity?: [number, number, number];
  remotePlayers?: Array<{
    handle: number;
    offset: [number, number, number];
    velocity?: [number, number, number];
    hp?: number;
    flags?: number;
  }>;
  sphereStates?: Array<{
    handle: number;
    offset: [number, number, number];
    velocity?: [number, number, number];
    angularVelocity?: [number, number, number];
  }>;
  boxStates?: Array<{
    handle: number;
    offset: [number, number, number];
    velocity?: [number, number, number];
    angularVelocity?: [number, number, number];
  }>;
  vehicleStates?: Array<{
    handle: number;
    driverHandle?: number;
    offset: [number, number, number];
    velocity?: [number, number, number];
  }>;
}): SnapshotV2Packet {
  const serverTick = opts.serverTick ?? 1;
  const anchor = opts.anchorPosition ?? [0, 0, 0];
  const selfVel = opts.selfVelocity ?? [0, 0, 0];
  return {
    type: 'snapshotV2',
    serverTimeUs: serverTick * Math.round(1_000_000 / 60),
    serverTick,
    ackInputSeq: opts.ackInputSeq ?? 0,
    anchorPxMm: metersToMm(anchor[0]),
    anchorPyMm: metersToMm(anchor[1]),
    anchorPzMm: metersToMm(anchor[2]),
    selfState: {
      vxCms: Math.round(selfVel[0] * 100),
      vyCms: Math.round(selfVel[1] * 100),
      vzCms: Math.round(selfVel[2] * 100),
      yawI16: angleToI16(0),
      pitchI16: angleToI16(0),
      hp: 100,
      flags: FLAG_ON_GROUND,
    },
    remotePlayers: (opts.remotePlayers ?? []).map((player) => ({
      handle: player.handle,
      dxQ2_5mm: Math.round((player.offset[0] * 1000) / 2.5),
      dyQ2_5mm: Math.round((player.offset[1] * 1000) / 2.5),
      dzQ2_5mm: Math.round((player.offset[2] * 1000) / 2.5),
      vxCms: Math.round((player.velocity?.[0] ?? 0) * 100),
      vyCms: Math.round((player.velocity?.[1] ?? 0) * 100),
      vzCms: Math.round((player.velocity?.[2] ?? 0) * 100),
      yawI16: angleToI16(0),
      pitchI16: angleToI16(0),
      hp: player.hp ?? 100,
      flags: player.flags ?? FLAG_ON_GROUND,
    })),
    sphereStates: (opts.sphereStates ?? []).map((body) => ({
      handle: body.handle,
      dxQ2_5mm: Math.round((body.offset[0] * 1000) / 2.5),
      dyQ2_5mm: Math.round((body.offset[1] * 1000) / 2.5),
      dzQ2_5mm: Math.round((body.offset[2] * 1000) / 2.5),
      vxCms: Math.round((body.velocity?.[0] ?? 0) * 100),
      vyCms: Math.round((body.velocity?.[1] ?? 0) * 100),
      vzCms: Math.round((body.velocity?.[2] ?? 0) * 100),
      wxMrads: Math.round((body.angularVelocity?.[0] ?? 0) * 1000),
      wyMrads: Math.round((body.angularVelocity?.[1] ?? 0) * 1000),
      wzMrads: Math.round((body.angularVelocity?.[2] ?? 0) * 1000),
    })),
    boxStates: (opts.boxStates ?? []).map((body) => ({
      handle: body.handle,
      dxQ2_5mm: Math.round((body.offset[0] * 1000) / 2.5),
      dyQ2_5mm: Math.round((body.offset[1] * 1000) / 2.5),
      dzQ2_5mm: Math.round((body.offset[2] * 1000) / 2.5),
      qxSnorm: 0,
      qySnorm: 0,
      qzSnorm: 0,
      qwSnorm: 32767,
      vxCms: Math.round((body.velocity?.[0] ?? 0) * 100),
      vyCms: Math.round((body.velocity?.[1] ?? 0) * 100),
      vzCms: Math.round((body.velocity?.[2] ?? 0) * 100),
      wxMrads: Math.round((body.angularVelocity?.[0] ?? 0) * 1000),
      wyMrads: Math.round((body.angularVelocity?.[1] ?? 0) * 1000),
      wzMrads: Math.round((body.angularVelocity?.[2] ?? 0) * 1000),
    })),
    vehicleStates: (opts.vehicleStates ?? []).map((vehicle) => ({
      handle: vehicle.handle,
      vehicleType: 0,
      driverHandle: vehicle.driverHandle ?? 0,
      flags: 0,
      dxQ2_5mm: Math.round((vehicle.offset[0] * 1000) / 2.5),
      dyQ2_5mm: Math.round((vehicle.offset[1] * 1000) / 2.5),
      dzQ2_5mm: Math.round((vehicle.offset[2] * 1000) / 2.5),
      qxSnorm: 0,
      qySnorm: 0,
      qzSnorm: 0,
      qwSnorm: 32767,
      vxCms: Math.round((vehicle.velocity?.[0] ?? 0) * 100),
      vyCms: Math.round((vehicle.velocity?.[1] ?? 0) * 100),
      vzCms: Math.round((vehicle.velocity?.[2] ?? 0) * 100),
      wxMrads: 0,
      wyMrads: 0,
      wzMrads: 0,
    })),
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
        serverTick: 251,
        players: [makeNetState({ id: 1 })],
        dynamicBodyStates: [],
      }));

      expect(client.dynamicBodies.has(7)).toBe(false);
      expect(client.sampleRemoteDynamicBody(7)).toBeNull();
    });

    it('applies V2 roster, metadata, and relative snapshot state', () => {
      let localAck = -1;
      const client = new NetcodeClient({
        onLocalSnapshot: (ack) => {
          localAck = ack;
        },
      });
      client.handlePacket(makeWelcome(1));
      client.handlePacket(makePlayerRoster([
        { handle: 1, playerId: 1 },
        { handle: 2, playerId: 44 },
      ]));
      client.handlePacket(makeDynamicBodyMeta([
        { handle: 7, bodyId: 7001, shapeType: 1, halfExtents: [0.3, 0.3, 0.3] },
      ]));

      client.handlePacket(makeSnapshotV2({
        serverTick: 25,
        ackInputSeq: 9,
        anchorPosition: [10, 2, -4],
        selfVelocity: [1, 0, 0],
        remotePlayers: [{ handle: 2, offset: [5, 0, 1], velocity: [0, 0, 2] }],
        sphereStates: [{ handle: 7, offset: [3, 0, -2], velocity: [0, 0, 1] }],
        vehicleStates: [{ handle: 3, offset: [8, 0, 0], velocity: [0, 0, 0] }],
      }));

      expect(localAck).toBe(9);
      expect(client.latestServerTick).toBe(25);
      expect(client.remotePlayers.has(44)).toBe(true);
      expect(client.remotePlayers.get(44)?.position[0]).toBeCloseTo(15);
      expect(client.dynamicBodies.has(7001)).toBe(true);
      expect(client.dynamicBodies.get(7001)?.position[0]).toBeCloseTo(13);
      expect(client.vehicles.has(3)).toBe(true);
      expect(client.vehicles.get(3)?.position[0]).toBeCloseTo(18);
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
