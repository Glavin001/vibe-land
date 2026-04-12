import { beforeAll, describe, expect, it } from 'vitest';
import { serializeWorldDocument } from './worldDocument';
import { decodeServerPacket } from '../net/protocol';
import { initWasmForTests, WasmLocalSession, WasmSimWorld } from '../wasm/testInit';

beforeAll(() => {
  initWasmForTests();
});

function makeFlatWorldJson(): string {
  return serializeWorldDocument({
    version: 1,
    meta: {
      name: 'Flat Test World',
      description: 'Minimal world for wasm terrain collision tests.',
    },
    terrain: {
      gridSize: 8,
      halfExtentM: 10,
      heights: Array.from({ length: 8 * 8 }, () => 0),
    },
    staticProps: [],
    dynamicEntities: [],
  });
}

describe('WorldDocument wasm terrain collisions', () => {
  it('dynamic body stays above loaded world terrain', () => {
    const sim = new WasmSimWorld();
    sim.loadWorldDocument(makeFlatWorldJson());
    sim.syncDynamicBody(1, 1, 0.5, 0.5, 0.5, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0);
    sim.rebuildBroadPhase();

    for (let step = 0; step < 240; step += 1) {
      sim.stepDynamics(1 / 60);
    }

    const state = sim.getDynamicBodyState(1);
    expect(state.length).toBeGreaterThan(0);
    expect(state[1]).toBeGreaterThan(-0.1);
  });

  it('vehicle chassis stays above loaded world terrain', () => {
    const sim = new WasmSimWorld();
    sim.loadWorldDocument(makeFlatWorldJson());
    sim.spawnVehicle(7, 0, 0, 3, 0, 0, 0, 0, 1);
    sim.rebuildBroadPhase();

    for (let step = 0; step < 240; step += 1) {
      sim.stepDynamics(1 / 60);
    }

    const debug = sim.getVehicleDebug(7);
    expect(debug.length).toBeGreaterThan(0);
    expect(debug[0]).toBeGreaterThan(-0.1);
  });

  it('local preview session snapshots keep authored dynamics above terrain', () => {
    const worldJson = serializeWorldDocument({
      version: 1,
      meta: {
        name: 'Flat Preview World',
        description: 'Authoritative local-preview collision regression test.',
      },
      terrain: {
        gridSize: 8,
        halfExtentM: 10,
        heights: Array.from({ length: 8 * 8 }, () => 0),
      },
      staticProps: [],
      dynamicEntities: [
        {
          id: 11,
          kind: 'ball',
          position: [0, 3, 0],
          rotation: [0, 0, 0, 1],
          radius: 0.5,
        },
        {
          id: 12,
          kind: 'box',
          position: [2, 3, 0],
          rotation: [0, 0, 0, 1],
          halfExtents: [0.5, 0.5, 0.5],
        },
        {
          id: 13,
          kind: 'vehicle',
          position: [-2, 3, 0],
          rotation: [0, 0, 0, 1],
          vehicleType: 0,
        },
      ],
    });

    const session = new WasmLocalSession(worldJson);
    session.connect();

    let latestSnapshot: ReturnType<typeof decodeServerPacket> | null = null;
    for (let step = 0; step < 240; step += 1) {
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
    if (!latestSnapshot || latestSnapshot.type !== 'snapshot') {
      return;
    }

    expect(latestSnapshot.dynamicBodyStates.length).toBe(2);
    expect(latestSnapshot.dynamicBodyStates.every((body) => body.pyMm > -100)).toBe(true);
    expect(latestSnapshot.vehicleStates.length).toBe(1);
    expect(latestSnapshot.vehicleStates[0]?.pyMm).toBeGreaterThan(-100);
  });
});
