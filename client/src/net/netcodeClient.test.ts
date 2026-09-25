import { describe, it, expect, vi } from 'vitest';
import { NetcodeClient } from './netcodeClient';
import {
  type DynamicBodyMetaPacket,
  type NetDynamicBodyState,
  type NetVehicleState,
  type PlayerRosterPacket,
  type SnapshotPacket,
  type SnapshotV2Packet,
  type ShotFiredPacket,
  type ShotResultPacket,
  type WelcomePacket,
  type NetPlayerState,
  metersToMm,
  angleToI16,
  FLAG_ON_GROUND,
  FLAG_IN_VEHICLE,
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
    energyCenti: 0,
  };
}

function makeWelcome(playerId = 1): WelcomePacket {
  return {
    type: 'welcome',
    playerId,
    protocolVersion: 2,
    physicsBackend: 0,
    clientMovementMode: 0,
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
  selfFlags?: number;
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
      flags: opts.selfFlags ?? FLAG_ON_GROUND,
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

      expect(client.targetInterpolationDelayMs).toBeCloseTo((1000 / 30) * 0.5, 2);
    });

    it('uses the clock-recommended delay for dynamic bodies while players stay buffered', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));
      vi.spyOn(client.serverClock, 'getInterpolationDelayMs').mockReturnValue(5);

      client.handlePacket(makeSnapshot({
        serverTick: 10,
        players: [makeNetState({ id: 1 })],
        dynamicBodyStates: [makeDynamicBodyState({ id: 7, position: [1, 0, 0] })],
      }));

      expect(client.targetInterpolationDelayMs).toBeCloseTo((1000 / 30) * 0.5, 2);
      expect(client.targetDynamicBodyInterpolationDelayMs).toBe(5);
    });

    it('still uses larger adaptive delays when jitter requires more buffering', () => {
      const client = new NetcodeClient({});
      client.handlePacket(makeWelcome(1));
      vi.spyOn(client.serverClock, 'getInterpolationDelayMs').mockReturnValue(48);

      client.handlePacket(makeSnapshot({
        serverTick: 10,
        players: [makeNetState({ id: 1 })],
      }));

      expect(client.targetInterpolationDelayMs).toBe(48);
      expect(client.targetDynamicBodyInterpolationDelayMs).toBe(48);
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

    it('drops a moving body within the stale window once the stream stops carrying it', () => {
      // A cannonball at 30 m/s is retired (or leaves interest) after tick 20.
      let nowMs = 0;
      const client = new NetcodeClient({ nowMs: () => nowMs });
      client.handlePacket(makeWelcome(1));
      client.handlePacket(makeDynamicBodyMeta([{ handle: 7, bodyId: 7001 }]));
      const present: boolean[] = [];
      for (let tick = 1; tick <= 60; tick += 1) {
        nowMs = tick * (1000 / 60);
        client.handlePacket(makeSnapshotV2({
          serverTick: tick,
          sphereStates: tick <= 20 ? [{ handle: 7, offset: [tick * 0.5, 2, 0], velocity: [30, 0, 0] }] : [],
        }));
        present[tick] = client.dynamicBodies.has(7001);
      }
      expect(present[35]).toBe(true);
      expect(present[36]).toBe(false);
      expect(client.getInterpolatedDynamicBodyState(7001)).toBeNull();
    });

    it('keeps a resting body until its refresh is due, then drops it', () => {
      let nowMs = 0;
      const client = new NetcodeClient({ nowMs: () => nowMs });
      client.handlePacket(makeWelcome(1));
      client.handlePacket(makeDynamicBodyMeta([{ handle: 7, bodyId: 7001 }]));
      const present: boolean[] = [];
      for (let tick = 1; tick <= 120; tick += 1) {
        nowMs = tick * (1000 / 60);
        client.handlePacket(makeSnapshotV2({
          serverTick: tick,
          sphereStates: tick <= 10 ? [{ handle: 7, offset: [3, 0.3, 0], velocity: [0, 0, 0] }] : [],
        }));
        present[tick] = client.dynamicBodies.has(7001);
      }
      // The server re-sends a body at rest once a second: absent until then is normal.
      expect(present[69]).toBe(true);
      // The snapshot that should have carried the refresh did not.
      expect(present[70]).toBe(false);
    });

    // SnapshotV2 removals (server/src/snapshot_builder.rs `removals`): the
    // server names what its stream stopped carrying; nothing is inferred.
    it('holds a body named in a removals section until the render time reaches the removal, then drops it', () => {
      let nowMs = 0;
      const client = new NetcodeClient({ nowMs: () => nowMs });
      client.handlePacket(makeWelcome(1));
      client.handlePacket(makeDynamicBodyMeta([{ handle: 7, bodyId: 7001 }]));
      const present: boolean[] = [];
      for (let tick = 1; tick <= 80; tick += 1) {
        nowMs = tick * (1000 / 60);
        const snapshot = makeSnapshotV2({
          serverTick: tick,
          sphereStates: tick <= 10 ? [{ handle: 7, offset: [3, 0.3, 0], velocity: [0, 0, 0] }] : [],
        });
        // Retired at tick 30 while at rest; restated in six snapshots.
        const removals = tick >= 30 && tick < 36 ? [{ handle: 7, vehicle: false, removedTick: 30 }] : undefined;
        client.handlePacket({ ...snapshot, ...(removals ? { removals } : {}) });
        present[tick] = client.dynamicBodies.has(7001);
      }
      // Truth has it until tick 29: drawn while the render time is behind that.
      expect(present[30]).toBe(true);
      // Gone within a few ticks of the removal, not at the next cold refresh (tick 70).
      expect(present.findIndex((p, tick) => tick > 30 && !p)).toBeLessThanOrEqual(33);
      expect(present[40]).toBe(false);
    });

    it('does not hold a moving body named in a removals section past its last sample', () => {
      let nowMs = 0;
      const client = new NetcodeClient({ nowMs: () => nowMs });
      client.handlePacket(makeWelcome(1));
      client.handlePacket(makeDynamicBodyMeta([{ handle: 7, bodyId: 7001 }]));
      const present: boolean[] = [];
      for (let tick = 1; tick <= 40; tick += 1) {
        nowMs = tick * (1000 / 60);
        const snapshot = makeSnapshotV2({
          serverTick: tick,
          // Its samples after tick 20 were lost; the server retired it at 26.
          sphereStates: tick <= 20 ? [{ handle: 7, offset: [tick * 0.5, 2, 0], velocity: [30, 0, 0] }] : [],
        });
        const removals = tick >= 26 && tick < 32 ? [{ handle: 7, vehicle: false, removedTick: 26 }] : undefined;
        client.handlePacket({ ...snapshot, ...(removals ? { removals } : {}) });
        present[tick] = client.dynamicBodies.has(7001);
      }
      // Not frozen at tick 20's pose until tick 26: gone as soon as it is named.
      expect(present[26]).toBe(false);
    });

    it('ignores a removal older than a sample the body has had since', () => {
      let nowMs = 0;
      const client = new NetcodeClient({ nowMs: () => nowMs });
      client.handlePacket(makeWelcome(1));
      client.handlePacket(makeDynamicBodyMeta([{ handle: 7, bodyId: 7001 }]));
      for (let tick = 1; tick <= 40; tick += 1) {
        nowMs = tick * (1000 / 60);
        const snapshot = makeSnapshotV2({
          serverTick: tick,
          sphereStates: [{ handle: 7, offset: [3, 0.3, 0], velocity: [0, 0, 0] }],
        });
        // It left at tick 20 and came straight back: a late copy of that removal.
        const removals = tick >= 21 && tick < 27 ? [{ handle: 7, vehicle: false, removedTick: 20 }] : undefined;
        client.handlePacket({ ...snapshot, ...(removals ? { removals } : {}) });
      }
      expect(client.dynamicBodies.has(7001)).toBe(true);
    });

    it('drops a vehicle named in a removals section, where it used to stay drawn for 3 s', () => {
      let delayTicks = 0;
      const run = (withRemovals: boolean): boolean[] => {
        let nowMs = 0;
        const client = new NetcodeClient({ nowMs: () => nowMs });
        client.handlePacket(makeWelcome(1));
        const present: boolean[] = [];
        for (let tick = 1; tick <= 60; tick += 1) {
          nowMs = tick * (1000 / 60);
          const snapshot = makeSnapshotV2({
            serverTick: tick,
            vehicleStates: tick <= 10 ? [{ handle: 3, offset: [70 + tick, 0, 0], velocity: [20, 0, 0] }] : [],
          });
          const removals = withRemovals && tick >= 11 && tick < 17
            ? [{ handle: 3, vehicle: true, removedTick: 11 }]
            : undefined;
          client.handlePacket({ ...snapshot, ...(removals ? { removals } : {}) });
          present[tick] = client.vehicles.has(3);
        }
        delayTicks = Math.ceil(client.interpolationDelayMs / (1000 / 60));
        return present;
      };
      const told = run(true);
      // Drawn until the vehicle render clock (one interpolation delay behind)
      // reaches the removal tick, then gone.
      expect(told[11]).toBe(true);
      expect(told[11 + delayTicks - 1]).toBe(true);
      expect(told[11 + delayTicks + 1]).toBe(false);
      // A server without the section: the 180-tick stale rule still decides.
      expect(run(false)[60]).toBe(true);
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

    it('fires the V2 local snapshot callback after same-tick dynamic bodies are applied', () => {
      let observedDynamicBodyX: number | null = null;
      const client = new NetcodeClient({
        onLocalSnapshot: () => {
          observedDynamicBodyX = client.dynamicBodies.get(7001)?.position[0] ?? null;
        },
      });
      client.handlePacket(makeWelcome(1));
      client.handlePacket(makeDynamicBodyMeta([
        { handle: 7, bodyId: 7001, shapeType: 1, halfExtents: [0.3, 0.3, 0.3] },
      ]));

      client.handlePacket(makeSnapshotV2({
        serverTick: 25,
        ackInputSeq: 9,
        anchorPosition: [10, 2, -4],
        sphereStates: [{ handle: 7, offset: [3, 0, -2], velocity: [0, 0, 1] }],
      }));

      expect(observedDynamicBodyX).toBeCloseTo(13);
    });

    it('keeps multiplayer local-driver vehicle snapshots out of the remote vehicle interpolator', () => {
      let receivedAck = -1;
      let receivedVehicleId = 0;
      const client = new NetcodeClient({
        onLocalVehicleSnapshot: (vehicleState, ackInputSeq) => {
          receivedAck = ackInputSeq;
          receivedVehicleId = vehicleState.id;
        },
      });
      client.handlePacket(makeWelcome(1));

      client.handlePacket(makeSnapshot({
        serverTick: 10,
        ackInputSeq: 7,
        players: [makeNetState({ id: 1 })],
        vehicleStates: [makeVehicleState({ id: 200, driverId: 1, position: [5, 0, 0], velocity: [2, 0, 0] })],
      }));

      const sample = client.sampleRemoteVehicle(200, 0);
      expect(receivedAck).toBe(7);
      expect(receivedVehicleId).toBe(200);
      expect(sample).not.toBeNull();
      expect(sample?.driverPlayerId).toBe(1);
      expect(sample?.position[0]).toBeCloseTo(5);
    });

    it('continues routing V2 local vehicle acks when the compact driver handle is temporarily unresolved', () => {
      const receivedAcks: number[] = [];
      const client = new NetcodeClient({
        onLocalVehicleSnapshot: (_vehicleState, ackInputSeq) => {
          receivedAcks.push(ackInputSeq);
        },
      });
      client.handlePacket(makeWelcome(1));
      client.handlePacket(makePlayerRoster([
        { handle: 1, playerId: 1 },
      ]));

      client.handlePacket(makeSnapshotV2({
        serverTick: 25,
        ackInputSeq: 9,
        vehicleStates: [{ handle: 3, driverHandle: 1, offset: [8, 0, 0], velocity: [1, 0, 0] }],
      }));
      client.handlePacket(makePlayerRoster([]));

      client.handlePacket(makeSnapshotV2({
        serverTick: 26,
        ackInputSeq: 10,
        selfFlags: FLAG_ON_GROUND | FLAG_IN_VEHICLE,
        vehicleStates: [{ handle: 3, driverHandle: 1, offset: [8.1, 0, 0], velocity: [1, 0, 0] }],
      }));

      expect(receivedAcks).toEqual([9, 10]);
      expect(client.vehicles.get(3)?.driverId).toBe(1);
      expect(client.sampleRemoteVehicle(3, 0)?.driverPlayerId).toBe(1);

      client.handlePacket(makeSnapshotV2({
        serverTick: 27,
        ackInputSeq: 11,
        vehicleStates: [{ handle: 3, driverHandle: 0, offset: [8.2, 0, 0], velocity: [0, 0, 0] }],
      }));

      expect(receivedAcks).toEqual([9, 10]);
      expect(client.vehicles.get(3)?.driverId).toBe(0);
    });

    it('infers the local V2 driven vehicle from self vehicle state when roster metadata arrives late', () => {
      let receivedAck = -1;
      const client = new NetcodeClient({
        onLocalVehicleSnapshot: (_vehicleState, ackInputSeq) => {
          receivedAck = ackInputSeq;
        },
      });
      client.handlePacket(makeWelcome(1));

      client.handlePacket(makeSnapshotV2({
        serverTick: 25,
        ackInputSeq: 9,
        selfFlags: FLAG_ON_GROUND | FLAG_IN_VEHICLE,
        vehicleStates: [{ handle: 3, driverHandle: 1, offset: [8, 0, 0], velocity: [1, 0, 0] }],
      }));

      expect(receivedAck).toBe(9);
      expect(client.vehicles.get(3)?.driverId).toBe(1);
      expect(client.sampleRemoteVehicle(3, 0)?.driverPlayerId).toBe(1);
    });
  });

  // ──────────────────────────────────────────────
  // Interpolation
  // ──────────────────────────────────────────────

  describe('late (out-of-order) snapshots', () => {
    const TICK_US = Math.round(1_000_000 / 60);
    const client60 = () => {
      let nowMs = 0;
      const client = new NetcodeClient({ nowMs: () => nowMs });
      client.handlePacket(makeWelcome(1));
      client.handlePacket(makePlayerRoster([{ handle: 1, playerId: 1 }, { handle: 2, playerId: 44 }]));
      client.handlePacket(makeDynamicBodyMeta([{ handle: 7, bodyId: 7001 }]));
      const at = (tick: number, snapshot: SnapshotV2Packet) => {
        nowMs = Math.max(nowMs, tick * (1000 / 60) + 50);
        client.handlePacket(snapshot);
      };
      return { client, at };
    };

    it('applies a parked vehicle refresh that arrives after a newer snapshot without it', () => {
      const { client, at } = client60();
      at(10, makeSnapshotV2({ serverTick: 10, vehicleStates: [{ handle: 3, offset: [5, 0, 0] }] }));
      at(12, makeSnapshotV2({ serverTick: 12 }));
      // Tick 11 carried its cold refresh (it had been nudged 1 m) and arrived last.
      at(12, makeSnapshotV2({ serverTick: 11, vehicleStates: [{ handle: 3, offset: [6, 0, 0] }] }));
      expect(client.latestServerTick).toBe(12);
      expect(client.vehicles.get(3)?.position[0]).toBeCloseTo(6);
      expect(client.sampleRemoteVehicle(3, 11 * TICK_US)?.position[0]).toBeCloseTo(6);
    });

    it('adds a vehicle whose first sends all arrived late', () => {
      const { client, at } = client60();
      at(10, makeSnapshotV2({ serverTick: 10 }));
      at(13, makeSnapshotV2({ serverTick: 13 }));
      at(13, makeSnapshotV2({ serverTick: 11, vehicleStates: [{ handle: 3, offset: [5, 0, 0] }] }));
      expect(client.vehicles.has(3)).toBe(true);
    });

    it('fills interpolation gaps without moving the newest state back', () => {
      const { client, at } = client60();
      const snap = (tick: number, x: number) => makeSnapshotV2({
        serverTick: tick,
        remotePlayers: [{ handle: 2, offset: [x, 0, 0], velocity: [3, 0, 0] }],
        sphereStates: [{ handle: 7, offset: [x, 1, 0], velocity: [3, 0, 0] }],
        vehicleStates: [{ handle: 3, offset: [x, 0, 5], velocity: [3, 0, 0] }],
      });
      at(10, snap(10, 1));
      at(12, snap(12, 3));
      at(12, snap(11, 2.5));
      // The newest state is still tick 12's.
      expect(client.remotePlayers.get(44)?.position[0]).toBeCloseTo(3);
      expect(client.dynamicBodies.get(7001)?.position[0]).toBeCloseTo(3);
      expect(client.vehicles.get(3)?.position[0]).toBeCloseTo(3);
      // Tick 11 is drawn where tick 11 said, not halfway between 10 and 12.
      expect(client.sampleRemotePlayer(44, 11 * TICK_US)?.position[0]).toBeCloseTo(2.5);
      expect(client.sampleRemoteDynamicBody(7001, 11 * TICK_US)?.position[0]).toBeCloseTo(2.5);
      expect(client.sampleRemoteVehicle(3, 11 * TICK_US)?.position[0]).toBeCloseTo(2.5);
    });

    it('does not bring back a body the client dropped after the late snapshot', () => {
      const { client, at } = client60();
      for (let tick = 1; tick <= 40; tick += 1) {
        // A cannonball streamed until tick 10, then gone from the stream.
        at(tick, makeSnapshotV2({
          serverTick: tick,
          sphereStates: tick <= 10 ? [{ handle: 7, offset: [tick, 2, 0], velocity: [30, 0, 0] }] : [],
        }));
      }
      expect(client.dynamicBodies.has(7001)).toBe(false);
      at(40, makeSnapshotV2({ serverTick: 9, sphereStates: [{ handle: 7, offset: [9, 2, 0], velocity: [30, 0, 0] }] }));
      expect(client.dynamicBodies.has(7001)).toBe(false);
    });

    it('keeps a removal named after the late snapshot', () => {
      const { client, at } = client60();
      at(10, makeSnapshotV2({ serverTick: 10, vehicleStates: [{ handle: 3, offset: [5, 0, 0] }] }));
      at(20, { ...makeSnapshotV2({ serverTick: 20 }), removals: [{ handle: 3, vehicle: true, removedTick: 15 }] });
      at(20, makeSnapshotV2({ serverTick: 14, vehicleStates: [{ handle: 3, offset: [5, 0, 0] }] }));
      for (let tick = 21; tick <= 40; tick += 1) at(tick, makeSnapshotV2({ serverTick: tick }));
      expect(client.vehicles.has(3)).toBe(false);
    });
  });

  describe('rest holds (players and vehicles sent only when they change)', () => {
    const TICK_US = Math.round(1_000_000 / 60);
    const run = (restVelocity: [number, number, number], stepOff = true) => {
      let nowMs = 0;
      const client = new NetcodeClient({ nowMs: () => nowMs });
      client.handlePacket(makeWelcome(1));
      client.handlePacket(makePlayerRoster([{ handle: 1, playerId: 1 }, { handle: 2, playerId: 44 }]));
      for (let tick = 1; tick <= (stepOff ? 30 : 29); tick += 1) {
        nowMs = tick * (1000 / 60);
        // Standing (sent three times as it settles), not sent while it stands,
        // then the snapshot it steps off in: 5 cm in one tick at 3 m/s.
        const standing = tick <= 3;
        const moving = tick === 30;
        client.handlePacket(makeSnapshotV2({
          serverTick: tick,
          remotePlayers: standing || moving
            ? [{ handle: 2, offset: [moving ? 0.05 : 0, 0, 0], velocity: moving ? [3, 0, 0] : restVelocity }]
            : [],
          vehicleStates: standing || moving
            ? [{ handle: 3, offset: [moving ? 0.05 : 0, 0, 5], velocity: moving ? [3, 0, 0] : [0, 0, 0] }]
            : [],
        }));
      }
      return client;
    };

    it('holds a player and a vehicle where they stood until the snapshot before they moved', () => {
      const client = run([0, 0, 0]);
      // Tick 28: still standing in truth. Interpolating from tick 3 would put
      // them 4.6 cm along already.
      expect(client.sampleRemotePlayer(44, 28 * TICK_US)?.position[0]).toBeCloseTo(0, 4);
      expect(client.sampleRemoteVehicle(3, 28 * TICK_US)?.position[0]).toBeCloseTo(0, 4);
      expect(client.sampleRemotePlayer(44, 29 * TICK_US)?.position[0]).toBeCloseTo(0, 4);
      expect(client.sampleRemotePlayer(44, 29.5 * TICK_US)?.position[0]).toBeCloseTo(0.025, 3);
      expect(client.sampleRemotePlayer(44, 30 * TICK_US)?.position[0]).toBeCloseTo(0.05, 4);
    });

    it('lets a late snapshot inside the gap replace the hold', () => {
      const client = run([0, 0, 0]);
      client.handlePacket(makeSnapshotV2({
        serverTick: 29,
        remotePlayers: [{ handle: 2, offset: [0.02, 0, 0], velocity: [3, 0, 0] }],
      }));
      expect(client.sampleRemotePlayer(44, 29 * TICK_US)?.position[0]).toBeCloseTo(0.02, 4);
    });

    it('moves the hold before the first moving snapshot when that one arrives late', () => {
      // Tick 31 arrived first (the hold went to tick 30); then tick 30, the
      // first it moved in: the hold belongs at tick 29.
      const client = run([0, 0, 0], false);
      client.handlePacket(makeSnapshotV2({
        serverTick: 31,
        remotePlayers: [{ handle: 2, offset: [0.1, 0, 0], velocity: [3, 0, 0] }],
      }));
      client.handlePacket(makeSnapshotV2({
        serverTick: 30,
        remotePlayers: [{ handle: 2, offset: [0.05, 0, 0], velocity: [3, 0, 0] }],
      }));
      expect(client.sampleRemotePlayer(44, 28 * TICK_US)?.position[0]).toBeCloseTo(0, 4);
      expect(client.sampleRemotePlayer(44, 29 * TICK_US)?.position[0]).toBeCloseTo(0, 4);
      expect(client.sampleRemotePlayer(44, 30 * TICK_US)?.position[0]).toBeCloseTo(0.05, 4);
    });

    it('adds no hold after a sample that was moving (a player sent every snapshot by an older server)', () => {
      // An older server sends a grounded player's -0.5 m/s ground snap; its
      // gaps are lost snapshots, interpolated as before.
      const client = run([0, -0.5, 0]);
      expect(client.sampleRemotePlayer(44, 28 * TICK_US)?.position[0]).toBeGreaterThan(0.04);
    });
  });

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

    it('routes broadcast shot-fired packets to onShotFired callback', () => {
      let received: ShotFiredPacket | null = null;
      const client = new NetcodeClient({
        onShotFired: (packet) => {
          received = packet;
        },
      });

      client.handlePacket({
        type: 'shotFired',
        shooterPlayerId: 42,
        shotId: 99,
        weapon: 1,
        hitKind: 1,
        hitZone: 2,
        serverFireTimeUs: 1_234_567,
        originPxMm: 100,
        originPyMm: 2_000,
        originPzMm: -3_000,
        endPxMm: 4_500,
        endPyMm: 2_100,
        endPzMm: -3_050,
      });

      expect(received).not.toBeNull();
      expect(received?.shooterPlayerId).toBe(42);
      expect(received?.shotId).toBe(99);
      expect(received?.hitKind).toBe(1);
      expect(received?.hitZone).toBe(2);
      expect(received?.serverFireTimeUs).toBe(1_234_567);
      expect(received?.endPxMm).toBe(4_500);
    });
  });

  describe('energy and batteries', () => {
    it('applies owner-only energy updates', () => {
      const client = new NetcodeClient({});

      client.handlePacket({ type: 'localPlayerEnergy', energyCenti: 54321 });

      expect(client.localPlayerEnergy).toBe(543.21);
    });

    it('applies battery full resyncs and removals', () => {
      const client = new NetcodeClient({});

      client.handlePacket({
        type: 'batterySync',
        fullResync: true,
        batteryStates: [
          {
            id: 9,
            pxMm: 1500,
            pyMm: 250,
            pzMm: -2000,
            energyCenti: 4200,
            radiusCm: 60,
            heightCm: 140,
          },
        ],
        removedIds: [],
      });
      expect(client.batteries.get(9)).toEqual({
        id: 9,
        position: [1.5, 0.25, -2],
        energy: 42,
        radius: 0.6,
        height: 1.4,
      });

      client.handlePacket({
        type: 'batterySync',
        fullResync: false,
        batteryStates: [],
        removedIds: [9],
      });
      expect(client.batteries.has(9)).toBe(false);
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

describe('NetcodeClient render clocks on a slowed server', () => {
  const TICK_US = Math.round(1_000_000 / 60);

  /**
   * A server ticking at `hz(t)` ticks per wall second with occasional stalls,
   * one SnapshotV2 per tick carrying body 7001 falling in a straight line; the
   * client renders at 120 Hz on its own clock.
   */
  function drive(opts: { wall: boolean; seconds: number; hz: (wallS: number) => number; stallEvery?: number }) {
    let nowMs = 0;
    const client = new NetcodeClient({ nowMs: () => nowMs });
    client.handlePacket(makeWelcome(1));
    client.handlePacket(makeDynamicBodyMeta([{ handle: 7, bodyId: 7001 }]));
    const sends: Array<{ atMs: number; tick: number; wallUs: number }> = [];
    let t = 0;
    for (let tick = 1; t < opts.seconds * 1000; tick += 1) {
      t += 1000 / opts.hz(t / 1000);
      if (opts.stallEvery && tick % opts.stallEvery === 0) t += 500;
      sends.push({ atMs: t + 2 + (tick % 3) * 3, tick, wallUs: Math.round(t * 1000) });
    }
    const frames: Array<{ ms: number; dyn: number; player: number; self: number; newestUs: number; dynDelay: number }> = [];
    let next = 0;
    for (nowMs = sends[0].atMs; nowMs < sends[sends.length - 1].atMs; nowMs += 1000 / 120) {
      while (next < sends.length && sends[next].atMs <= nowMs) {
        const s = sends[next++];
        const packet = makeSnapshotV2({
          serverTick: s.tick,
          sphereStates: [{ handle: 7, offset: [0, 50 - s.tick * 0.01, 0], velocity: [0, -0.6, 0] }],
        });
        client.handlePacket(opts.wall ? { ...packet, serverWallUs: s.wallUs } : packet);
      }
      frames.push({
        ms: nowMs,
        dyn: client.getDynamicBodyRenderTimeUs(),
        player: client.getRenderTimeUs(),
        self: client.getLocalPlayerRenderTimeUs(),
        newestUs: client.latestServerTick * TICK_US,
        dynDelay: client.dynamicBodyInterpolationDelayMs,
      });
    }
    return { client, frames };
  }

  function backward(values: number[]): number {
    let n = 0;
    for (let i = 1; i < values.length; i += 1) if (values[i] < values[i - 1]) n += 1;
    return n;
  }

  it('35 Hz with 500 ms stalls: no render clock ever steps back, playout follows the sim rate', () => {
    for (const wall of [false, true]) {
      const { client, frames } = drive({ wall, seconds: 20, hz: () => 35, stallEvery: 200 });
      expect(backward(frames.map((f) => f.dyn))).toBe(0);
      expect(backward(frames.map((f) => f.player))).toBe(0);
      expect(backward(frames.map((f) => f.self))).toBe(0);
      expect(client.serverClock.hasServerWallClock()).toBe(wall);
      // Playout over 10 s tracks sim time over the same 10 s, stalls included.
      const a = frames.find((f) => f.ms > 5000)!;
      const b = frames.find((f) => f.ms > 15000)!;
      const playout = (b.dyn - a.dyn) / ((b.ms - a.ms) * 1000);
      const sim = (b.newestUs - a.newestUs) / ((b.ms - a.ms) * 1000);
      expect(Math.abs(playout - sim) / sim).toBeLessThan(0.05);
    }
  });

  it('keeps the dynamic-body delay at least one snapshot interval and mostly interpolates', () => {
    const { frames } = drive({ wall: true, seconds: 20, hz: (s) => [60, 20, 45, 30][Math.floor(s) % 4] });
    const settled = frames.filter((f) => f.ms > 2000);
    for (const f of settled) expect(f.dynDelay).toBeGreaterThanOrEqual(16.6);
    const extrapolating = settled.filter((f) => f.dyn > f.newestUs).length / settled.length;
    expect(extrapolating).toBeLessThan(0.1);
  });

  it('steady 60 Hz: render delay about one tick, rate 1', () => {
    const { client, frames } = drive({ wall: true, seconds: 10, hz: () => 60 });
    expect(client.serverClock.getRate()).toBeCloseTo(1, 2);
    const late = frames.filter((f) => f.ms > 3000);
    for (const f of late) {
      expect(f.dynDelay).toBeGreaterThanOrEqual(16.6);
      expect(f.dynDelay).toBeLessThan(26);
    }
    expect(backward(frames.map((f) => f.dyn))).toBe(0);
  });

  it('counts a body stale in server ticks, not while the server is stalled', () => {
    let nowMs = 0;
    const client = new NetcodeClient({ nowMs: () => nowMs });
    client.handlePacket(makeWelcome(1));
    client.handlePacket(makeDynamicBodyMeta([{ handle: 7, bodyId: 7001 }]));
    client.handlePacket(makeSnapshotV2({ serverTick: 10, sphereStates: [{ handle: 7, offset: [0, 5, 0], velocity: [0, -30, 0] }] }));
    nowMs = 800; // a long server stall: nothing new arrived
    expect(client.getDynamicBodyTicksSinceSeen(7001)).toBe(0);
    client.handlePacket(makeSnapshotV2({ serverTick: 20 }));
    expect(client.getDynamicBodyTicksSinceSeen(7001)).toBe(10);
    expect(client.getDynamicBodySamples(7001)).toHaveLength(1);
    // Past the stale window the moving body is out of the stream, and dropped.
    client.handlePacket(makeSnapshotV2({ serverTick: 26 }));
    expect(client.getDynamicBodyTicksSinceSeen(7001)).toBeNull();
    expect(client.getDynamicBodySamples(7001)).toHaveLength(0);
  });
});
