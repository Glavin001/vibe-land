import { beforeAll, describe, expect, it } from 'vitest';
import { decodeServerPacket, type DynamicBodyStateMeters, type SnapshotPacket, type VehicleStateMeters, netDynamicBodyStateToMeters, netVehicleStateToMeters } from '../net/protocol';
import { initWasmForTests, WasmLocalSession, WasmSimWorld } from '../wasm/testInit';
import brokenWorldDocumentJson from '../../../worlds/broken.world.json';
import {
  DEFAULT_WORLD_DOCUMENT,
  addTerrainTile,
  applyTerrainBrush,
  applyTerrainRampStencil,
  cloneWorldDocument,
  expandWorldTerrain,
  getAddableTerrainTiles,
  getTerrainTile,
  getTerrainWorldPosition,
  parseWorldDocument,
  removeTerrainTile,
  sampleTerrainHeightAtWorldPosition,
  serializeWorldDocument,
  shrinkWorldTerrain,
  type DynamicEntity,
  type WorldDocument,
} from './worldDocument';

beforeAll(() => {
  initWasmForTests();
});

type LocalPreviewResult = {
  snapshot: SnapshotPacket;
  dynamicBodies: Map<number, DynamicBodyStateMeters>;
  vehicles: Map<number, VehicleStateMeters>;
};

function makeFlatWorld(): WorldDocument {
  return makeFlatWorldWithGrid(8, 10);
}

function makeFlatWorldWithGrid(tileGridSize: number, tileHalfExtentM: number): WorldDocument {
  return {
    version: 2,
    meta: {
      name: 'Flat Test World',
      description: 'Minimal world for local-preview terrain tests.',
    },
    terrain: {
      tileGridSize,
      tileHalfExtentM,
      tiles: [{
        tileX: 0,
        tileZ: 0,
        heights: Array.from({ length: tileGridSize * tileGridSize }, () => 0),
      }],
    },
    staticProps: [],
    dynamicEntities: [],
  };
}

function makeSmoothHillWorld(): WorldDocument {
  const gridSize = 9;
  const heights = Array.from({ length: gridSize * gridSize }, () => 0);
  for (let row = 0; row < gridSize; row += 1) {
    for (let col = 0; col < gridSize; col += 1) {
      const dx = col - 4;
      const dz = row - 4;
      const dist = Math.hypot(dx, dz);
      heights[row * gridSize + col] = Math.max(0, 5 - dist * 1.25);
    }
  }
  return {
    version: 2,
    meta: {
      name: 'Smooth Hill',
      description: 'Brush-like hill for rigid body terrain tests.',
    },
    terrain: {
      tileGridSize: gridSize,
      tileHalfExtentM: 10,
      tiles: [{
        tileX: 0,
        tileZ: 0,
        heights,
      }],
    },
    staticProps: [],
    dynamicEntities: [],
  };
}

function makeAsymmetricWorld(): WorldDocument {
  const gridSize = 5;
  const heights = Array.from({ length: gridSize * gridSize }, () => 0);
  const row = 1;
  const col = 3;
  heights[row * gridSize + col] = 6;
  heights[row * gridSize + col - 1] = 3;
  heights[(row + 1) * gridSize + col] = 1.5;
  return {
    version: 2,
    meta: {
      name: 'Asymmetric Terrain',
      description: 'Useful for probing steep authored terrain edge-cases.',
    },
    terrain: {
      tileGridSize: gridSize,
      tileHalfExtentM: 10,
      tiles: [{
        tileX: 0,
        tileZ: 0,
        heights,
      }],
    },
    staticProps: [],
    dynamicEntities: [],
  };
}

function makeEntity(kind: DynamicEntity['kind'], id: number, x: number, y: number, z: number): DynamicEntity {
  if (kind === 'ball') {
    return {
      id,
      kind,
      position: [x, y, z],
      rotation: [0, 0, 0, 1],
      radius: 0.5,
    };
  }
  if (kind === 'box') {
    return {
      id,
      kind,
      position: [x, y, z],
      rotation: [0, 0, 0, 1],
      halfExtents: [0.5, 0.5, 0.5],
    };
  }
  return {
    id,
    kind,
    position: [x, y, z],
    rotation: [0, 0, 0, 1],
    vehicleType: 0,
  };
}

function makeWorldWithEntities(baseWorld: WorldDocument, entities: DynamicEntity[]): WorldDocument {
  return {
    ...cloneWorldDocument(baseWorld),
    dynamicEntities: entities,
  };
}

function runLocalPreview(world: WorldDocument, steps = 240): LocalPreviewResult {
  const session = new WasmLocalSession(serializeWorldDocument(world));
  session.connect();

  let latestSnapshot: SnapshotPacket | null = null;
  for (let step = 0; step < steps; step += 1) {
    session.tick(1 / 60);
    const blob = session.drainPackets();
    let offset = 0;
    while (offset + 4 <= blob.length) {
      const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      const packetLen = view.getUint32(offset, true);
      offset += 4;
      const packet = blob.slice(offset, offset + packetLen);
      offset += packetLen;
      const decoded = decodeServerPacket(packet);
      if (decoded.type === 'snapshot') {
        latestSnapshot = decoded;
      }
    }
  }

  expect(latestSnapshot).not.toBeNull();
  const snapshot = latestSnapshot as SnapshotPacket;
  const dynamicBodies = new Map(snapshot.dynamicBodyStates.map((body) => [body.id, netDynamicBodyStateToMeters(body)]));
  const vehicles = new Map(snapshot.vehicleStates.map((vehicle) => [vehicle.id, netVehicleStateToMeters(vehicle)]));
  return { snapshot, dynamicBodies, vehicles };
}

function raycastTerrainHeight(world: WorldDocument, x: number, z: number): number {
  const sim = new WasmSimWorld();
  sim.loadWorldDocument(serializeWorldDocument(world));
  sim.rebuildBroadPhase();
  const ray = sim.castRayAndGetNormal(x, 20, z, 0, -1, 0, 100);
  expect(ray.length).toBe(4);
  return 20 - ray[0];
}

function expectSupportedAboveTerrain(y: number, terrainY: number, epsilon = 0.1): void {
  expect(y).toBeGreaterThan(terrainY - epsilon);
}

function primaryTile(world: WorldDocument) {
  const tile = getTerrainTile(world, 0, 0);
  expect(tile).not.toBeNull();
  return tile!;
}

function applyRampRepeated(world: WorldDocument, count: number, overrides: Partial<Parameters<typeof applyTerrainRampStencil>[1]> = {}): WorldDocument {
  let next = cloneWorldDocument(world);
  for (let i = 0; i < count; i += 1) {
    next = applyTerrainRampStencil(next, {
      centerX: 0,
      centerZ: 0,
      width: 6,
      length: 12,
      gradePct: 50,
      yawRad: 0,
      mode: 'raise',
      strength: 0.25,
      targetHeight: 6,
      targetEdge: 'end',
      targetKind: 'max',
      sideFalloffM: 0,
      startFalloffM: 0,
      endFalloffM: 0,
      ...overrides,
    });
  }
  return next;
}

describe('WorldDocument local-preview scenarios', () => {
  it('flat world keeps ball, box, and vehicle supported', () => {
    const world = makeWorldWithEntities(makeFlatWorld(), [
      makeEntity('ball', 11, 0, 3, 0),
      makeEntity('box', 12, 2, 3, 0),
      makeEntity('vehicle', 13, -2, 3, 0),
    ]);

    const result = runLocalPreview(world);
    expect(result.dynamicBodies.size).toBe(2);
    expect(result.vehicles.size).toBe(1);

    const ball = result.dynamicBodies.get(11);
    const box = result.dynamicBodies.get(12);
    const vehicle = result.vehicles.get(13);
    expect(ball).toBeDefined();
    expect(box).toBeDefined();
    expect(vehicle).toBeDefined();

    expectSupportedAboveTerrain(ball!.position[1], 0);
    expectSupportedAboveTerrain(box!.position[1], 0);
    expectSupportedAboveTerrain(vehicle!.position[1], 0);
    expect(Math.abs(ball!.position[0])).toBeLessThan(0.5);
    expect(Math.abs(box!.position[0] - 2)).toBeLessThan(0.5);
    expect(Math.abs(vehicle!.position[0] + 2)).toBeLessThan(1.0);
  });

  it('default authored world supports custom box and vehicle on its known flat area', () => {
    const world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    world.dynamicEntities = [
      makeEntity('box', 1001, 0, sampleTerrainHeightAtWorldPosition(world, 0, 0) + 2, 0),
      makeEntity('vehicle', 1002, 14, sampleTerrainHeightAtWorldPosition(world, 14, 0) + 3, 0),
    ];

    const result = runLocalPreview(world);
    const box = result.dynamicBodies.get(1001);
    const vehicle = result.vehicles.get(1002);
    expect(box).toBeDefined();
    expect(vehicle).toBeDefined();

    expectSupportedAboveTerrain(box!.position[1], raycastTerrainHeight(world, 0, 0));
    expectSupportedAboveTerrain(vehicle!.position[1], raycastTerrainHeight(world, 14, 0));
  });

  it('snap-machine spawned in the air drops ~half its authored height', () => {
    // Swap the shipped machine for a clone positioned 5 m above the
    // flat terrain. Verifies gravity drags the chassis down by at least
    // 1 m within the first second (free-fall under g = 20 m/s² covers
    // 2.5 m in 0.5 s — plenty of budget).
    const world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    const shipped = world.dynamicEntities.find((e) => e.kind === 'snapMachine');
    expect(shipped).toBeDefined();
    const elevatedId = 80001;
    const elevated: DynamicEntity = {
      id: elevatedId,
      kind: 'snapMachine',
      position: [-10, 5, 0],
      rotation: [0, 0, 0, 1],
      envelope: shipped!.envelope,
    };
    world.dynamicEntities = world.dynamicEntities.filter(
      (e) => e.kind !== 'snapMachine',
    );
    world.dynamicEntities.push(elevated);

    const session = new WasmLocalSession(serializeWorldDocument(world));
    session.connect();
    session.drainPackets();

    let firstChassisY: number | null = null;
    let lastChassisY: number | null = null;

    for (let i = 0; i < 60; i += 1) {
      session.tick(1 / 60);
      const blob = session.drainPackets();
      let offset = 0;
      while (offset + 4 <= blob.length) {
        const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
        const packetLen = view.getUint32(offset, true);
        offset += 4;
        const packet = blob.slice(offset, offset + packetLen);
        offset += packetLen;
        const decoded = decodeServerPacket(packet);
        if (decoded.type === 'snapshot') {
          const machine = decoded.machineStates.find((m) => m.id === elevatedId);
          if (machine && machine.bodies.length > 0) {
            const y = machine.bodies[0].pyMm / 1000;
            if (firstChassisY === null) firstChassisY = y;
            lastChassisY = y;
          }
        }
      }
    }

    expect(firstChassisY).not.toBeNull();
    expect(lastChassisY).not.toBeNull();
    // First sample should be near the authored 5 m spawn (envelope
    // auto-shifted so its floor sits at entity.y = 5; chassis center is
    // then at 5 + ~0.81 ≈ 5.81 before any fall).
    expect(firstChassisY!).toBeGreaterThan(4.5);
    expect(firstChassisY!).toBeLessThan(7.0);
    // After 1 s of falling the chassis has dropped at least 1 m.
    expect(firstChassisY! - lastChassisY!).toBeGreaterThan(1.0);
  });

  it('default snap-machine falls under gravity and settles above the ground', () => {
    // Drive the loopback session with the real world document (which
    // ships a 4-wheel-car placed just above the ground) and watch the
    // chassis body's Y over time. The chassis must monotonically fall
    // in the first half-second, then settle well above terrain.
    const world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    const snapEntity = world.dynamicEntities.find((e) => e.kind === 'snapMachine');
    expect(snapEntity, 'default world should ship a snap-machine').toBeDefined();

    const session = new WasmLocalSession(serializeWorldDocument(world));
    session.connect();

    type Sample = { tick: number; chassisY: number | null };

    function readChassisY(): Sample {
      session.tick(1 / 60);
      const blob = session.drainPackets();
      let offset = 0;
      let chassisY: number | null = null;
      while (offset + 4 <= blob.length) {
        const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
        const packetLen = view.getUint32(offset, true);
        offset += 4;
        const packet = blob.slice(offset, offset + packetLen);
        offset += packetLen;
        const decoded = decodeServerPacket(packet);
        if (decoded.type === 'snapshot') {
          const machine = decoded.machineStates.find((m) => m.id === snapEntity!.id);
          if (machine && machine.bodies.length > 0) {
            // bodies are sorted by body id alphabetically; index 0 is
            // `body:0` which is the chassis.
            chassisY = machine.bodies[0].pyMm / 1000;
          }
        }
      }
      return { tick: -1, chassisY };
    }

    // Warm-up tick to flush the welcome packet.
    session.drainPackets();

    const samples: Array<{ elapsedMs: number; y: number }> = [];
    for (let i = 0; i < 300; i += 1) {
      const s = readChassisY();
      if (s.chassisY != null) {
        samples.push({ elapsedMs: (i + 1) * (1000 / 60), y: s.chassisY });
      }
    }
    expect(samples.length).toBeGreaterThan(30);

    // First sample is right after the first physics step; it should be
    // below the authored spawn y because gravity has already pulled the
    // chassis downward for one tick.
    const first = samples[0]!.y;
    const quarterSec = samples.find((s) => s.elapsedMs >= 250)?.y ?? first;
    const oneSec = samples.find((s) => s.elapsedMs >= 1000)?.y ?? quarterSec;
    const settled = samples[samples.length - 1]!.y;

    // Gravity is clearly active: the chassis moved downward between
    // the first post-spawn tick and a quarter second later. (The
    // authored spawn only leaves 20 cm of air so the full "drop"
    // distance is small — the point is that motion is downward, not
    // frozen.)
    expect(quarterSec).toBeLessThanOrEqual(first);
    expect(oneSec).toBeLessThanOrEqual(quarterSec);
    expect(first).toBeGreaterThan(quarterSec - 0.001);

    // Chassis must rest above the terrain (not tunnel through) and not
    // fly off to space. Terrain near (-4, 0) is effectively flat at
    // y ≈ 0; chassis center should settle between ~0.5 m and ~3 m
    // above depending on suspension + wheel geometry.
    expect(settled).toBeGreaterThan(0.1);
    expect(settled).toBeLessThan(5.0);
    // And the chassis must not keep sinking forever: late samples
    // should be within a few cm of each other.
    const lateSamples = samples.slice(-30);
    const minLate = Math.min(...lateSamples.map((s) => s.y));
    const maxLate = Math.max(...lateSamples.map((s) => s.y));
    expect(maxLate - minLate).toBeLessThan(0.1);
  });

  it('press-E machine enter sets driverId in the next snapshot', () => {
    const world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    const snapEntity = world.dynamicEntities.find((e) => e.kind === 'snapMachine');
    expect(snapEntity).toBeDefined();

    const session = new WasmLocalSession(serializeWorldDocument(world));
    session.connect();
    // Discard the initial welcome drain + a warm-up tick so the machine
    // is fully instantiated.
    session.drainPackets();
    session.tick(1 / 60);
    session.drainPackets();

    // Send PKT_MACHINE_ENTER for our machine id.
    const enterBytes = new Uint8Array(5);
    const enterView = new DataView(enterBytes.buffer);
    enterView.setUint8(0, 8 /* PKT_MACHINE_ENTER */);
    enterView.setUint32(1, snapEntity!.id >>> 0, true);
    session.handleClientPacket(enterBytes);

    // Tick once more and read the snapshot.
    session.tick(1 / 60);
    const blob = session.drainPackets();
    let offset = 0;
    let snapshot: SnapshotPacket | null = null;
    while (offset + 4 <= blob.length) {
      const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      const packetLen = view.getUint32(offset, true);
      offset += 4;
      const packet = blob.slice(offset, offset + packetLen);
      offset += packetLen;
      const decoded = decodeServerPacket(packet);
      if (decoded.type === 'snapshot') {
        snapshot = decoded;
      }
    }
    expect(snapshot).not.toBeNull();
    const machine = snapshot!.machineStates.find((m) => m.id === snapEntity!.id);
    expect(machine).toBeDefined();
    // LOCAL_PLAYER_ID in LocalPreviewSession is 1.
    expect(machine!.driverId).toBe(1);
  });

  it('default authored world includes a drivable snap-machine', () => {
    const world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    const snapMachines = world.dynamicEntities.filter((e) => e.kind === 'snapMachine');
    expect(snapMachines.length, 'trail.world.json should ship snapMachine entities').toBeGreaterThan(0);

    const result = runLocalPreview(world, 120);
    expect(result.snapshot.machineStates.length).toBeGreaterThan(0);
    for (const snapEntity of snapMachines) {
      const machine = result.snapshot.machineStates.find((m) => m.id === snapEntity.id);
      expect(machine, `machine ${snapEntity.id} should appear in snapshot.machineStates`).toBeDefined();
      expect(machine!.bodies.length).toBeGreaterThan(0);
      for (const body of machine!.bodies) {
        const x = body.pxMm / 1000;
        const y = body.pyMm / 1000;
        const z = body.pzMm / 1000;
        expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
        expect(Math.abs(x)).toBeLessThan(100);
        expect(Math.abs(z)).toBeLessThan(100);
        expect(y).toBeGreaterThan(-20);
        expect(y).toBeLessThan(50);
      }
    }
  });

  it('4-wheel-car actually drives when motorSpin is held', () => {
    // Sanity for the player experience: after entering the car and
    // holding +motorSpin for 3 seconds, the chassis should have moved
    // at least 3 metres along the XZ plane. This mirrors the Rust
    // `chassis_drives_forward_under_motor_input` test but exercises
    // the full loopback (InputBundle → PhysicsArena.step_machines →
    // snapshot encode → TS decode). Catches any future regression in
    // `MOTOR_MAX_FORCE_MULTIPLIER` / `MOTOR_DAMPING_MULTIPLIER` or
    // the input→channel plumbing.
    const world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    const car = world.dynamicEntities.find(
      (e) => e.kind === 'snapMachine'
        && typeof e.envelope === 'object'
        && e.envelope !== null
        && 'metadata' in e.envelope
        && (e.envelope as { metadata?: { presetName?: string } }).metadata?.presetName === '4-Wheel Car',
    );
    expect(car, 'trail.world.json should ship the 4-wheel car').toBeDefined();

    const session = new WasmLocalSession(serializeWorldDocument(world));
    session.connect();
    session.drainPackets();

    function decodeMachineChassisXZ(blob: Uint8Array): [number, number] | null {
      let offset = 0;
      let xz: [number, number] | null = null;
      while (offset + 4 <= blob.length) {
        const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
        const packetLen = view.getUint32(offset, true);
        offset += 4;
        const packet = blob.slice(offset, offset + packetLen);
        offset += packetLen;
        const decoded = decodeServerPacket(packet);
        if (decoded.type === 'snapshot') {
          const machine = decoded.machineStates.find((m) => m.id === car!.id);
          if (machine && machine.bodies.length > 0) {
            const body0 = machine.bodies[0];
            xz = [body0.pxMm / 1000, body0.pzMm / 1000];
          }
        }
      }
      return xz;
    }

    // Settle the chassis before we start driving so the measured
    // distance reflects motor-driven motion, not falling.
    for (let i = 0; i < 60; i += 1) {
      session.tick(1 / 60);
    }
    const settled = decodeMachineChassisXZ(session.drainPackets());
    expect(settled, 'machine snapshot should be present after settling').not.toBeNull();

    // Enter the machine (the local preview session treats player 1
    // as the operator) and send an InputBundle with motorSpin = +1.0.
    const enterBytes = new Uint8Array(5);
    new DataView(enterBytes.buffer).setUint8(0, 8 /* PKT_MACHINE_ENTER */);
    new DataView(enterBytes.buffer).setUint32(1, car!.id >>> 0, true);
    session.handleClientPacket(enterBytes);

    // Build a per-tick InputBundle with `machineChannels[0] = 127`
    // (the car has one action channel, `motorSpin`). Wire layout
    // matches `encodeInputBundle` — 1-byte kind, 1-byte count, then
    // per-frame `seq u16, buttons u16, mx i8, my i8, yaw i16, pitch
    // i16, channels[8] i8`. One frame is enough for the session to
    // pick up the channel value since it re-plays the last input.
    function buildInputBundlePacket(seq: number, channel0: number): Uint8Array {
      const frameSize = 10 + 8;
      const out = new Uint8Array(2 + frameSize);
      const view = new DataView(out.buffer);
      view.setUint8(0, 2 /* PKT_INPUT_BUNDLE */);
      view.setUint8(1, 1);
      view.setUint16(2, seq, true);
      view.setUint16(4, 0, true);
      view.setInt8(6, 0);
      view.setInt8(7, 0);
      view.setInt16(8, 0, true);
      view.setInt16(10, 0, true);
      view.setInt8(12, channel0);
      // channels 1..7 stay zero.
      return out;
    }

    for (let i = 0; i < 360; i += 1) {
      session.handleClientPacket(buildInputBundlePacket(i + 1, 127));
      session.tick(1 / 60);
    }

    const end = decodeMachineChassisXZ(session.drainPackets());
    expect(end, 'machine snapshot should be present after driving').not.toBeNull();

    const dx = end![0] - settled![0];
    const dz = end![1] - settled![1];
    const dist = Math.sqrt(dx * dx + dz * dz);
    // 6 s of +motorSpin through the real client wire path. The Rust
    // test asserts ≥ 3 m on a flat ground; the TS e2e sees a bit
    // more variance from heightfield friction + the single-substep
    // pipeline the loopback uses, so we assert ≥ 2 m here — still
    // well above the <0.2 m baseline we had before the motor tuning
    // fix landed.
    expect(
      dist,
      `car should drive at least 2 m (settled=${JSON.stringify(settled)}, end=${JSON.stringify(end)})`,
    ).toBeGreaterThanOrEqual(2.0);
  });

  it('crane is shipped with a unique display name and 3 distinct actions', () => {
    // The crane fixture has 3 revolute joints; we uniquify the
    // duplicated `armPitch` into `armPitchElbow` at inline time so
    // the operator can control each joint independently. Verify the
    // world document carries those 3 distinct actions.
    const world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    const crane = world.dynamicEntities.find(
      (e) => e.kind === 'snapMachine'
        && typeof e.envelope === 'object'
        && e.envelope !== null
        && 'metadata' in e.envelope
        && (e.envelope as { metadata?: { presetName?: string } }).metadata?.presetName === 'Crane',
    );
    expect(crane, 'trail.world.json should ship a Crane snap-machine').toBeDefined();

    const envelope = crane!.envelope as {
      plan: {
        joints: Array<{ motor?: { input?: { action: string } } }>;
      };
    };
    const actions = new Set<string>();
    for (const joint of envelope.plan.joints) {
      const action = joint.motor?.input?.action;
      if (action) actions.add(action);
    }
    expect(actions.has('armPitch')).toBe(true);
    expect(actions.has('armPitchElbow')).toBe(true);
    expect(actions.has('armYaw')).toBe(true);
    expect(actions.size).toBeGreaterThanOrEqual(3);

    // And verify the physics runtime installs the crane cleanly.
    const result = runLocalPreview(world, 60);
    const craneState = result.snapshot.machineStates.find((m) => m.id === crane!.id);
    expect(craneState, 'crane must be present in snapshot').toBeDefined();
    expect(craneState!.bodies.length).toBeGreaterThan(0);
  });

  it('terrain brush respects lower and upper plateaus', () => {
    const world = makeFlatWorld();
    const [x, z] = getTerrainWorldPosition(world, 4, 4);
    let lowered = cloneWorldDocument(world);
    primaryTile(lowered).heights.fill(2);
    for (let i = 0; i < 40; i += 1) {
      lowered = applyTerrainBrush(lowered, x, z, 4, 0.5, 'lower', { minHeight: 1, maxHeight: 6 });
    }
    expect(sampleTerrainHeightAtWorldPosition(lowered, x, z)).toBeGreaterThanOrEqual(1);
    expect(sampleTerrainHeightAtWorldPosition(lowered, x, z)).toBeLessThan(1.2);

    let raised = cloneWorldDocument(world);
    primaryTile(raised).heights.fill(2);
    for (let i = 0; i < 40; i += 1) {
      raised = applyTerrainBrush(raised, x, z, 4, 0.5, 'raise', { minHeight: -4, maxHeight: 3 });
    }
    expect(sampleTerrainHeightAtWorldPosition(raised, x, z)).toBeLessThanOrEqual(3);
    expect(sampleTerrainHeightAtWorldPosition(raised, x, z)).toBeGreaterThan(2.8);
  });

  it('terrain ramp stencil converges toward a stable raised target instead of stacking additively', () => {
    const world = makeFlatWorldWithGrid(33, 16);
    const onePass = applyRampRepeated(world, 1);
    const manyPasses = applyRampRepeated(world, 24);

    expect(sampleTerrainHeightAtWorldPosition(onePass, 0, 6)).toBeGreaterThan(0);
    expect(sampleTerrainHeightAtWorldPosition(onePass, 0, 6)).toBeLessThan(6);
    expect(sampleTerrainHeightAtWorldPosition(manyPasses, 0, 6)).toBeGreaterThan(sampleTerrainHeightAtWorldPosition(onePass, 0, 6));
    expect(sampleTerrainHeightAtWorldPosition(manyPasses, 0, 6)).toBeLessThanOrEqual(6);
    expect(sampleTerrainHeightAtWorldPosition(manyPasses, 0, 6)).toBeGreaterThan(5.9);
    expect(sampleTerrainHeightAtWorldPosition(manyPasses, 0, -6)).toBeCloseTo(0, 4);
  });

  it('terrain ramp stencil can raise toward a start-edge minimum target', () => {
    const world = makeFlatWorldWithGrid(33, 16);
    const raised = applyRampRepeated(world, 24, {
      targetEdge: 'start',
      targetKind: 'min',
      targetHeight: 2,
    });

    expect(sampleTerrainHeightAtWorldPosition(raised, 0, -6)).toBeGreaterThan(1.9);
    expect(sampleTerrainHeightAtWorldPosition(raised, 0, 6)).toBeGreaterThan(7.9);
  });

  it('terrain ramp stencil can cut toward a start-edge maximum target', () => {
    const world = makeFlatWorldWithGrid(33, 16);
    primaryTile(world).heights.fill(6);
    const cut = applyRampRepeated(world, 24, {
      mode: 'lower',
      targetEdge: 'start',
      targetKind: 'max',
      targetHeight: 0,
    });

    expect(sampleTerrainHeightAtWorldPosition(cut, 0, -6)).toBeLessThan(0.1);
    expect(sampleTerrainHeightAtWorldPosition(cut, 0, 6)).toBeLessThan(-5.9);
  });

  it('terrain ramp stencil uses independent side, start, and end falloffs', () => {
    const world = makeFlatWorldWithGrid(33, 16);
    const ramped = applyRampRepeated(world, 28, {
      width: 6,
      length: 10,
      gradePct: 50,
      targetHeight: 10,
      targetEdge: 'end',
      targetKind: 'max',
      sideFalloffM: 4,
      startFalloffM: 2,
      endFalloffM: 0,
    });

    expect(sampleTerrainHeightAtWorldPosition(ramped, 0, -6)).toBeGreaterThan(0.5);
    expect(sampleTerrainHeightAtWorldPosition(ramped, 4, 0)).toBeGreaterThan(0.5);
    expect(sampleTerrainHeightAtWorldPosition(ramped, 8, 0)).toBeCloseTo(0, 4);
    expect(sampleTerrainHeightAtWorldPosition(ramped, 0, 6)).toBeCloseTo(0, 4);
  });

  it('terrain expansion adds seamless eastward tiles', () => {
    const world = makeFlatWorld();
    primaryTile(world).heights.fill(2.5);
    const expanded = expandWorldTerrain(world, 'east');
    const originalTile = getTerrainTile(expanded, 0, 0);
    const eastTile = getTerrainTile(expanded, 1, 0);
    expect(originalTile).toBeTruthy();
    expect(eastTile).toBeTruthy();
    expect(expanded.terrain.tiles).toHaveLength(2);

    const seamWorldX = expanded.terrain.tileHalfExtentM;
    expect(sampleTerrainHeightAtWorldPosition(expanded, seamWorldX - 0.01, 0)).toBeCloseTo(2.5, 4);
    expect(sampleTerrainHeightAtWorldPosition(expanded, seamWorldX, 0)).toBeCloseTo(2.5, 4);
    expect(sampleTerrainHeightAtWorldPosition(expanded, seamWorldX + 3, 0)).toBeLessThan(2.5);
    expect(sampleTerrainHeightAtWorldPosition(expanded, seamWorldX + 3, 0)).toBeGreaterThan(0);
    expect(sampleTerrainHeightAtWorldPosition(expanded, seamWorldX + 6, 0)).toBeLessThan(0.1);
    expect(sampleTerrainHeightAtWorldPosition(expanded, seamWorldX + 20, 0)).toBeCloseTo(0, 4);
  });

  it('terrain expansion preserves the seam profile but tapers jagged edges back to ground', () => {
    const world = makeFlatWorld();
    const tile = primaryTile(world);
    const last = world.terrain.tileGridSize - 1;
    for (let row = 0; row < world.terrain.tileGridSize; row += 1) {
      tile.heights[row * world.terrain.tileGridSize + last] = row;
    }

    const expanded = expandWorldTerrain(world, 'east');
    const eastTile = getTerrainTile(expanded, 1, 0);
    expect(eastTile).toBeTruthy();

    for (let row = 0; row < world.terrain.tileGridSize; row += 1) {
      const seamIndex = row * world.terrain.tileGridSize;
      const midIndex = seamIndex + Math.floor(last / 2);
      const farEdgeIndex = seamIndex + last;
      expect(eastTile!.heights[seamIndex]).toBeCloseTo(row, 6);
      expect(eastTile!.heights[midIndex]).toBeLessThanOrEqual(row);
      expect(eastTile!.heights[midIndex]).toBeGreaterThanOrEqual(0);
      expect(eastTile!.heights[farEdgeIndex]).toBeCloseTo(0, 6);
    }
  });

  it('terrain shrink removes one outer strip without deleting the last remaining column', () => {
    let world = makeFlatWorld();
    world = expandWorldTerrain(world, 'east');
    world = expandWorldTerrain(world, 'east');
    expect(world.terrain.tiles).toHaveLength(3);

    const shrunk = shrinkWorldTerrain(world, 'east');
    expect(shrunk.terrain.tiles).toHaveLength(2);
    expect(getTerrainTile(shrunk, 2, 0)).toBeNull();
    expect(getTerrainTile(shrunk, 1, 0)).toBeTruthy();

    const unchanged = shrinkWorldTerrain(makeFlatWorld(), 'east');
    expect(unchanged.terrain.tiles).toHaveLength(1);
    expect(getTerrainTile(unchanged, 0, 0)).toBeTruthy();
  });

  it('addable terrain tiles are exposed on open edges and support sparse growth', () => {
    let world = makeFlatWorld();
    expect(getAddableTerrainTiles(world)).toEqual([
      { tileX: 0, tileZ: -1 },
      { tileX: -1, tileZ: 0 },
      { tileX: 1, tileZ: 0 },
      { tileX: 0, tileZ: 1 },
    ]);

    world = addTerrainTile(world, 1, 0);
    expect(getTerrainTile(world, 1, 0)).toBeTruthy();
    expect(getAddableTerrainTiles(world)).toContainEqual({ tileX: 2, tileZ: 0 });
    expect(getAddableTerrainTiles(world)).toContainEqual({ tileX: 1, tileZ: -1 });
    expect(getAddableTerrainTiles(world)).toContainEqual({ tileX: 1, tileZ: 1 });
  });

  it('removing a specific tile creates a real hole with default sampling', () => {
    let world = makeFlatWorld();
    world = addTerrainTile(world, 1, 0);
    world = removeTerrainTile(world, 1, 0);

    expect(getTerrainTile(world, 1, 0)).toBeNull();
    expect(sampleTerrainHeightAtWorldPosition(world, 20, 0)).toBeCloseTo(0, 6);
    expect(world.terrain.tiles).toHaveLength(1);
  });

  it('rotated static cuboids keep their authored collision footprint', () => {
    const world = makeFlatWorld();
    world.staticProps = [
      {
        id: 7001,
        kind: 'cuboid',
        position: [0, 1, 0],
        rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)],
        halfExtents: [2, 1, 0.25],
      },
    ];

    const sim = new WasmSimWorld();
    sim.loadWorldDocument(serializeWorldDocument(world));
    sim.rebuildBroadPhase();

    const ray = sim.castRayAndGetNormal(1.2, 20, -1.2, 0, -1, 0, 40);
    expect(ray.length).toBe(4);
    const hitY = 20 - ray[0];
    expect(hitY).toBeGreaterThan(1.5);
  });

  it('smooth hill terrain supports ball and vehicle above the sampled surface', () => {
    const world = makeSmoothHillWorld();
    const [hillX, hillZ] = getTerrainWorldPosition(world, 4, 4);
    const vehicleX = hillX + 1.5;
    world.dynamicEntities = [
      makeEntity('ball', 31, hillX, sampleTerrainHeightAtWorldPosition(world, hillX, hillZ) + 2, hillZ),
      makeEntity('vehicle', 32, vehicleX, sampleTerrainHeightAtWorldPosition(world, vehicleX, hillZ) + 3, hillZ),
    ];

    const result = runLocalPreview(world);
    const ball = result.dynamicBodies.get(31);
    const vehicle = result.vehicles.get(32);
    expect(ball).toBeDefined();
    expect(vehicle).toBeDefined();

    expectSupportedAboveTerrain(ball!.position[1], raycastTerrainHeight(world, hillX, hillZ));
    expectSupportedAboveTerrain(vehicle!.position[1], raycastTerrainHeight(world, vehicleX, hillZ));
  });

  it('terrain painted through the godmode brush flow still supports authored dynamics', () => {
    let world = makeFlatWorld();
    for (let i = 0; i < 24; i += 1) {
      world = applyTerrainBrush(world, 0, 0, 10, 0.12, 'raise');
    }
    world.dynamicEntities = [
      makeEntity('box', 41, 0, sampleTerrainHeightAtWorldPosition(world, 0, 0) + 2, 0),
      makeEntity('vehicle', 42, 2, sampleTerrainHeightAtWorldPosition(world, 2, 0) + 3, 0),
    ];

    const result = runLocalPreview(world);
    const box = result.dynamicBodies.get(41);
    const vehicle = result.vehicles.get(42);
    expect(box).toBeDefined();
    expect(vehicle).toBeDefined();

    expectSupportedAboveTerrain(box!.position[1], raycastTerrainHeight(world, 0, 0));
    expectSupportedAboveTerrain(vehicle!.position[1], raycastTerrainHeight(world, 2, 0));
  });

  it('default godmode world remains supported after broad terrain painting', () => {
    let world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    for (let i = 0; i < 18; i += 1) {
      world = applyTerrainBrush(world, 8, 8, 12, 0.12, 'raise');
      world = applyTerrainBrush(world, 0, 0, 10, 0.08, 'raise');
    }

    const result = runLocalPreview(world, 360);

    for (const entity of world.dynamicEntities) {
      if (entity.kind === 'vehicle') {
        const vehicle = result.vehicles.get(entity.id);
        expect(vehicle).toBeDefined();
        const terrainY = raycastTerrainHeight(world, vehicle!.position[0], vehicle!.position[2]);
        expect(
          vehicle!.position[1],
          `vehicle ${entity.id} final=(${vehicle!.position[0]}, ${vehicle!.position[1]}, ${vehicle!.position[2]})`,
        ).toBeGreaterThan(terrainY - 0.25);
      } else if (entity.kind === 'snapMachine') {
        // Snap-machines don't participate in the dynamic body map — their
        // bodies live in the machines table. The physics round-trip is
        // covered by the Rust `snap_machine::tests` instead.
        continue;
      } else {
        const body = result.dynamicBodies.get(entity.id);
        expect(body).toBeDefined();
        const terrainY = raycastTerrainHeight(world, body!.position[0], body!.position[2]);
        expect(
          body!.position[1],
          `${entity.kind} ${entity.id} final=(${body!.position[0]}, ${body!.position[1]}, ${body!.position[2]})`,
        ).toBeGreaterThan(terrainY - 0.25);
      }
    }
  });

  it('single ball above the painted pit terrain stays supported', () => {
    let world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    for (let i = 0; i < 18; i += 1) {
      world = applyTerrainBrush(world, 8, 8, 12, 0.12, 'raise');
      world = applyTerrainBrush(world, 0, 0, 10, 0.08, 'raise');
    }
    world.dynamicEntities = [
      makeEntity('ball', 5001, 9.5, sampleTerrainHeightAtWorldPosition(world, 9.5, 9.5) + 2, 9.5),
    ];

    const result = runLocalPreview(world, 360);
    const ball = result.dynamicBodies.get(5001);
    expect(ball).toBeDefined();

    const terrainY = raycastTerrainHeight(world, ball!.position[0], ball!.position[2]);
    expect(
      ball!.position[1],
      `single ball final=(${ball!.position[0]}, ${ball!.position[1]}, ${ball!.position[2]})`,
    ).toBeGreaterThan(terrainY - 0.25);
  });

  it('programmatic brushed demo world keeps a repro ball at the pit spawn supported', () => {
    let world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    for (let i = 0; i < 18; i += 1) {
      world = applyTerrainBrush(world, 8, 8, 12, 0.12, 'raise');
      world = applyTerrainBrush(world, 0, 0, 10, 0.08, 'raise');
    }
    world.dynamicEntities = [
      {
        id: 42001,
        kind: 'ball',
        position: [9.5, 4, 9.5],
        rotation: [0, 0, 0, 1],
        radius: 0.3,
      },
    ];

    const result = runLocalPreview(world, 360);
    const ball = result.dynamicBodies.get(42001);
    expect(ball).toBeDefined();
    const terrainY = raycastTerrainHeight(world, ball!.position[0], ball!.position[2]);
    expect(
      ball!.position[1],
      `programmatic repro ball final=(${ball!.position[0]}, ${ball!.position[1]}, ${ball!.position[2]}) terrain=${terrainY}`,
    ).toBeGreaterThan(terrainY - 0.25);
  });

  it('programmatic brushed demo world keeps the authored vehicle supported', () => {
    let world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    for (let i = 0; i < 18; i += 1) {
      world = applyTerrainBrush(world, 8, 8, 12, 0.12, 'raise');
      world = applyTerrainBrush(world, 0, 0, 10, 0.08, 'raise');
    }

    const result = runLocalPreview(world, 360);
    const vehicle = result.vehicles.get(200);
    expect(vehicle).toBeDefined();
    const terrainY = raycastTerrainHeight(world, vehicle!.position[0], vehicle!.position[2]);
    expect(
      vehicle!.position[1],
      `programmatic repro vehicle final=(${vehicle!.position[0]}, ${vehicle!.position[1]}, ${vehicle!.position[2]}) terrain=${terrainY}`,
    ).toBeGreaterThan(terrainY - 0.25);
  });

  it('broken exported world keeps its authored box, balls, and vehicle supported', () => {
    const world = cloneWorldDocument(parseWorldDocument(brokenWorldDocumentJson));
    const result = runLocalPreview(world, 360);

    for (const entity of world.dynamicEntities) {
      if (entity.kind === 'vehicle') {
        const vehicle = result.vehicles.get(entity.id);
        expect(vehicle).toBeDefined();
        const terrainY = raycastTerrainHeight(world, vehicle!.position[0], vehicle!.position[2]);
        expect(
          vehicle!.position[1],
          `vehicle ${entity.id} final=(${vehicle!.position[0]}, ${vehicle!.position[1]}, ${vehicle!.position[2]}) terrain=${terrainY}`,
        ).toBeGreaterThan(terrainY - 0.25);
        continue;
      }

      const body = result.dynamicBodies.get(entity.id);
      expect(body).toBeDefined();
      const terrainY = raycastTerrainHeight(world, body!.position[0], body!.position[2]);
      expect(
        body!.position[1],
        `${entity.kind} ${entity.id} final=(${body!.position[0]}, ${body!.position[1]}, ${body!.position[2]}) terrain=${terrainY}`,
      ).toBeGreaterThan(terrainY - 0.25);
    }
  });

  it('broken exported world supports a single box at the pit ball spawn', () => {
    const world = cloneWorldDocument(parseWorldDocument(brokenWorldDocumentJson));
    world.dynamicEntities = [
      makeEntity('box', 9001, 9.5, 4, 9.5),
    ];

    const result = runLocalPreview(world, 360);
    const box = result.dynamicBodies.get(9001);
    expect(box).toBeDefined();
    const terrainY = raycastTerrainHeight(world, box!.position[0], box!.position[2]);
    expect(box!.position[1]).toBeGreaterThan(terrainY - 0.25);
  });

  it('broken exported world supports a single ball at the pit ball spawn', () => {
    const world = cloneWorldDocument(parseWorldDocument(brokenWorldDocumentJson));
    world.dynamicEntities = [
      makeEntity('ball', 9002, 9.5, 4, 9.5),
    ];

    const result = runLocalPreview(world, 360);
    const ball = result.dynamicBodies.get(9002);
    expect(ball).toBeDefined();
    const terrainY = raycastTerrainHeight(world, ball!.position[0], ball!.position[2]);
    expect(ball!.position[1]).toBeGreaterThan(terrainY - 0.25);
  });

  it('world-document terrain raycasts match authored sample positions at vertices', () => {
    const world = makeAsymmetricWorld();
    const [x, z] = getTerrainWorldPosition(world, 1, 3);
    const expectedHeight = sampleTerrainHeightAtWorldPosition(world, x, z);
    const hitY = raycastTerrainHeight(world, x, z);

    expect(hitY).toBeCloseTo(expectedHeight, 1);
  });

  it('world-document terrain raycasts stay aligned with authored samples away from vertices', () => {
    const world = makeAsymmetricWorld();
    const [peakX, peakZ] = getTerrainWorldPosition(world, 1, 3);

    for (const [x, z] of [[peakX - 2, peakZ], [peakX + 2, peakZ]] as const) {
      const expectedHeight = sampleTerrainHeightAtWorldPosition(world, x, z);
      const hitY = raycastTerrainHeight(world, x, z);
      expect(Math.abs(hitY - expectedHeight)).toBeLessThan(0.05);
    }
  });

  it.skip('steep asymmetric terrain keeps rigid boxes and vehicles stably supported', () => {
    const world = makeAsymmetricWorld();
    const [peakX, peakZ] = getTerrainWorldPosition(world, 1, 3);
    const boxX = peakX - 2;
    const vehicleX = peakX + 2;
    world.dynamicEntities = [
      makeEntity('ball', 21, peakX, sampleTerrainHeightAtWorldPosition(world, peakX, peakZ) + 2, peakZ),
      makeEntity('box', 23, boxX, sampleTerrainHeightAtWorldPosition(world, boxX, peakZ) + 2, peakZ),
      makeEntity('vehicle', 22, vehicleX, sampleTerrainHeightAtWorldPosition(world, vehicleX, peakZ) + 3, peakZ),
    ];

    const result = runLocalPreview(world);
    expectSupportedAboveTerrain(result.dynamicBodies.get(21)!.position[1], raycastTerrainHeight(world, peakX, peakZ));
    expectSupportedAboveTerrain(result.dynamicBodies.get(23)!.position[1], raycastTerrainHeight(world, boxX, peakZ));
    expectSupportedAboveTerrain(result.vehicles.get(22)!.position[1], raycastTerrainHeight(world, vehicleX, peakZ));
  });
});
