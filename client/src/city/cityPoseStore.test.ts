import { describe, expect, it } from 'vitest';

import { CityGpuPoses } from '../scene/citySlotMesh';
import {
  advanceCityPoses,
  CHUNK_HIDE_Y_M,
  CityPoseStore,
  FLOATS_PER_BODY,
  initCityPoses,
  newCityPoseFrameState,
} from './cityPoseStore';
import type { CityClient } from './cityClient';
import type { LedgerBody } from './topology';

/** Rotate v by unit quaternion q (reference implementation, not the shader's form). */
function rotate(q: number[], v: number[]): number[] {
  const [x, y, z, w] = q;
  // q * v * q^-1 via the rotation matrix.
  return [
    (1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y - w * z) * v[1] + 2 * (x * z + w * y) * v[2],
    2 * (x * y + w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z - w * x) * v[2],
    2 * (x * z - w * y) * v[0] + 2 * (y * z + w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2],
  ];
}

function quatMul(a: number[], b: number[]): number[] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

const QY90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

/**
 * A two-structure ledger stand-in: the parts of CityClient the pose step
 * reads, with bodies that can move, settle, split and disappear.
 */
function fakeClient(chunkCount: number) {
  const bodies = new Map<number, LedgerBody>();
  const chunkBody = new Float64Array(chunkCount);
  const localPos = new Float32Array(chunkCount * 3);
  const localRot = new Float32Array(chunkCount * 4);
  let slotChanges: number[] = [];
  let repaint = { all: false, bodies: [] as number[] };
  let epoch = 0;
  let live = new Set<number>();
  const topology = {
    chunkCount,
    chunkBody,
    body: (key: number) => bodies.get(key),
    allBodies: () => bodies.values(),
    localOffsetInto: (slot: number, out: Float32Array) => { out.set(localPos.subarray(slot * 3, slot * 3 + 3)); },
    localRotationInto: (slot: number, out: Float32Array) => { out.set(localRot.subarray(slot * 4, slot * 4 + 4)); },
    drainSlotChanges: () => { const out = slotChanges; slotChanges = []; return out; },
  };
  const client = {
    topology,
    samplePresentation: (_now: number, _due?: unknown) => live,
    drainRepaint: () => { const out = repaint; repaint = { all: false, bodies: [] }; return out; },
    ledgerEpoch: () => epoch,
  } as unknown as CityClient;
  return {
    client,
    bodies,
    setChunk(slot: number, key: number, offset: number[], rot = [0, 0, 0, 1]) {
      chunkBody[slot] = key;
      localPos.set(offset, slot * 3);
      localRot.set(rot, slot * 4);
      slotChanges.push(slot);
    },
    setLive(keys: number[]) { live = new Set(keys); },
    bumpEpoch() { epoch += 1; },
  };
}

const SUPPORT = 0x8000_0000;
const ISLAND = 0x8000_0001;

function world(chunks = 4) {
  const w = fakeClient(chunks);
  w.bodies.set(SUPPORT, { key: SUPPORT, structureId: 0, islandSerial: 0, chunkSlots: [0, 1, 2, 3], position: [10, 0, 0], rotation: [0, 0, 0, 1], settled: true });
  for (let slot = 0; slot < chunks; slot += 1) w.setChunk(slot, SUPPORT, [slot, 1, 0]);
  return w;
}

describe('cityPoseStore', () => {
  it('composes a chunk exactly as body pose ∘ local offset (the shader)', () => {
    const store = new CityPoseStore(1, [0.5]);
    const index = store.bodyIndexFor(7);
    store.writeBody(index, [1, 2, 3], QY90, 1, 1, 1, 1);
    store.writeChunk(0, index, [2, 0.5, -1], [0, 0, Math.sin(0.3), Math.cos(0.3)], 0.5);
    const out = new Float32Array(7);
    expect(store.chunkWorldPoseInto(0, out)).toBe(true);
    const expected = rotate(QY90, [2, 0.5, -1]).map((v, k) => v + [1, 2, 3][k]);
    for (let k = 0; k < 3; k += 1) expect(out[k]).toBeCloseTo(expected[k], 5);
    const q = quatMul(QY90, [0, 0, Math.sin(0.3), Math.cos(0.3)]);
    for (let k = 0; k < 4; k += 1) expect(out[3 + k]).toBeCloseTo(q[k], 5);
    expect(store.keyOfIndex(index)).toBe(7);
  });

  it('does not draw a slot without a record, or one composed below the hide depth', () => {
    const store = new CityPoseStore(2, [0, 0]);
    const out = new Float32Array(7);
    expect(store.chunkWorldPoseInto(0, out)).toBe(false);
    const index = store.bodyIndexFor(1);
    store.writeBody(index, [0, CHUNK_HIDE_Y_M - 1, 0], [0, 0, 0, 1], 1, 1, 1, 1);
    store.writeChunk(1, index, [0, 0, 0], [0, 0, 0, 1], 0);
    expect(store.chunkWorldPoseInto(1, out)).toBe(false);
    expect(out[1]).toBeCloseTo(CHUNK_HIDE_Y_M - 1);
  });

  it('keeps a released index for the records still on it (a stale chunk is drawn at its last pose)', () => {
    const store = new CityPoseStore(1, [0]);
    const a = store.bodyIndexFor(100);
    store.writeBody(a, [5, 5, 5], [0, 0, 0, 1], 1, 1, 1, 1);
    store.writeChunk(0, a, [0, 0, 0], [0, 0, 0, 1], 0);
    store.releaseBody(100);
    const b = store.bodyIndexFor(200);
    expect(b).not.toBe(a);
    const out = new Float32Array(7);
    store.chunkWorldPoseInto(0, out);
    expect([out[0], out[1], out[2]]).toEqual([5, 5, 5]);
    expect(store.keyOfIndex(a)).toBe(100);
  });

  it('tracks written indices and slots only when asked, once per drain', () => {
    const store = new CityPoseStore(3, [0, 0, 0]);
    const i = store.bodyIndexFor(1);
    store.writeBody(i, [0, 0, 0], [0, 0, 0, 1], 1, 1, 1, 1);
    expect(store.drainChanges()).toEqual({ bodies: [], slots: [] });
    store.trackChanges();
    store.writeBody(i, [1, 0, 0], [0, 0, 0, 1], 1, 1, 1, 1);
    store.writeBody(i, [2, 0, 0], [0, 0, 0, 1], 1, 1, 1, 1);
    store.writeChunk(2, i, [0, 0, 0], [0, 0, 0, 1], 0);
    expect(store.drainChanges()).toEqual({ bodies: [i], slots: [2] });
    expect(store.drainChanges()).toEqual({ bodies: [], slots: [] });
  });

  it('grows the body table without moving what is drawn (and the GPU subclass follows with its texture)', () => {
    const gpu = new CityGpuPoses(1, new Float32Array(1));
    const first = gpu.bodyTexture;
    let replaced = 0;
    gpu.onBodyTextureReplaced(() => { replaced += 1; });
    const keep = gpu.bodyIndexFor(1);
    gpu.writeBody(keep, [3, 4, 5], [0, 0, 0, 1], 1, 1, 1, 1);
    gpu.writeChunk(0, keep, [1, 0, 0], [0, 0, 0, 1], 0);
    const capacity = gpu.bodyCapacity;
    for (let key = 2; key < capacity + 10; key += 1) gpu.bodyIndexFor(key);
    expect(replaced).toBe(1);
    expect(gpu.bodyTexture).not.toBe(first);
    expect(gpu.bodyTexture.image.data).toBe(gpu.bodyData);
    const out = new Float32Array(7);
    gpu.chunkWorldPoseInto(0, out);
    expect([out[0], out[1], out[2]]).toEqual([4, 4, 5]);
    expect(gpu.bodyData.length).toBeGreaterThanOrEqual(gpu.bodyCapacity * FLOATS_PER_BODY);
  });

  it('advances the tables the way the layer does: live bodies every due frame, a settled body once, a split re-parents', () => {
    const w = world();
    const store = new CityPoseStore(4, [0, 0, 0, 0]);
    initCityPoses(store, w.client, [0, 0, 0, 0]);
    const state = newCityPoseFrameState(w.client);
    const out = new Float32Array(7);
    store.chunkWorldPoseInto(2, out);
    expect([out[0], out[1], out[2]]).toEqual([12, 1, 0]);

    // Chunks 2 and 3 break off into an island centred on them, and it moves.
    const island: LedgerBody = { key: ISLAND, structureId: 0, islandSerial: 1, chunkSlots: [2, 3], position: [12.5, 1, 0], rotation: [0, 0, 0, 1], settled: false };
    w.bodies.set(ISLAND, island);
    w.bodies.get(SUPPORT)!.chunkSlots = [0, 1];
    w.setChunk(2, ISLAND, [-0.5, 0, 0]);
    w.setChunk(3, ISLAND, [0.5, 0, 0]);
    w.setLive([ISLAND]);
    island.position = [12.5, 3, 0];
    let frame = advanceCityPoses(store, w.client, [0, 0, 0, 0], state, 0);
    expect(frame.idle).toBe(false);
    store.chunkWorldPoseInto(3, out);
    expect([out[0], out[1], out[2]]).toEqual([13, 3, 0]);

    // Not due this frame (the distance stride): the table keeps last frame's pose.
    island.position = [12.5, 5, 0];
    advanceCityPoses(store, w.client, [0, 0, 0, 0], state, 16, { due: () => false });
    store.chunkWorldPoseInto(3, out);
    expect(out[1]).toBe(3);
    // Due again: it lands on the ledger pose of THIS frame.
    advanceCityPoses(store, w.client, [0, 0, 0, 0], state, 33, { due: () => true });
    store.chunkWorldPoseInto(3, out);
    expect(out[1]).toBe(5);

    // It stops streaming: one final write even when not due, then nothing.
    w.setLive([]);
    island.position = [12.5, 0.5, 0];
    island.settled = true;
    frame = advanceCityPoses(store, w.client, [0, 0, 0, 0], state, 50, { due: () => false });
    store.chunkWorldPoseInto(3, out);
    expect(out[1]).toBe(0.5);
    expect(state.dirty.size).toBe(0);
    frame = advanceCityPoses(store, w.client, [0, 0, 0, 0], state, 66);
    expect(frame.idle).toBe(true);
  });

  it('rewrites every record and body when the ledger is replaced (a bootstrap)', () => {
    const w = world();
    const store = new CityPoseStore(4, [0, 0, 0, 0]);
    initCityPoses(store, w.client, [0, 0, 0, 0]);
    const state = newCityPoseFrameState(w.client);
    store.trackChanges();
    w.bumpEpoch();
    const frame = advanceCityPoses(store, w.client, [0, 0, 0, 0], state, 0);
    expect(frame.rebuildRecords).toBe(true);
    expect(frame.recordsWritten).toBe(4);
    const changes = store.drainChanges();
    expect(changes.slots.sort()).toEqual([0, 1, 2, 3]);
    expect(changes.bodies.length).toBe(1);
  });
});
