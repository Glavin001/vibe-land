// Frame-by-frame simulation of a falling island's fracture, driving the real
// CityClient the way the wire does: support streams, promotion arrives with a
// pose ahead of what is drawn, datagrams follow every 2 ticks, the render
// clock advances (and re-anchors) like samplePresentation's estimator.
//
// Asserts the per-frame presented step of a promoted chunk stays inside what
// its physical motion explains. This is the deterministic repro surface for
// the post-fix teleport regression: if the glide machinery produces a visible
// jump under any arrival pattern, this harness can replay it exactly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CityClient } from './cityClient';
import type { LoadedCityManifest, CityManifest } from './manifest';
import { bodyKey } from './topology';
import { RecordMode } from './wire';
import type { ChunksDatagram, TopologyMessage } from './wire';
import type { Vec3 } from './vec';

const IDENTITY: [number, number, number, number] = [0, 0, 0, 1];

interface CityClientInternals {
  handleChunks(datagram: ChunksDatagram): void;
  captureDrawnPoses(message: TopologyMessage): void;
  seedPromotions(message: TopologyMessage): void;
}
const internals = (client: CityClient): CityClientInternals =>
  client as unknown as CityClientInternals;

/** The PKT_CITY_TOPOLOGY branch of handlePacket, minus the byte decode. */
function applyTopology(client: CityClient, message: TopologyMessage): void {
  internals(client).captureDrawnPoses(message);
  const applied = client.topology.apply(message);
  expect(applied).toBe(true);
  internals(client).seedPromotions(message);
}

const manifest = (): CityManifest => ({
  version: 1,
  structures: [
    {
      structureId: 0,
      worldPosition: [0, 20, 0],
      worldRotation: [0, 0, 0, 1],
      chunks: [0, 1, 2, 3].map((node) => ({
        nodeIndex: node,
        centroid: [0, node + 0.5, 0],
        mass: node === 0 ? 0 : 10,
        volume: 1,
        size: [1, 1, 1],
        geometry: { kind: 'Cuboid', halfExtents: [0.5, 0.5, 0.5] },
        radius: 0.87,
        support: node === 0,
      })),
      bonds: [0, 1, 2].map((i) => ({
        bondIndex: i,
        node0: i,
        node1: i + 1,
        centroid: [0, i + 1, 0],
        normal: [0, 1, 0],
        area: 1,
      })),
    },
  ],
});

const loaded = (): LoadedCityManifest => ({
  manifest: manifest(),
  hashHex: 'b'.repeat(64),
  totalChunks: 4,
  totalBonds: 3,
});

/** Deterministic wall clock the client's performance.now() reads. */
let nowMs = 0;

beforeEach(() => {
  nowMs = 100_000;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fallingDatagram(simTick: number, key: number, fractureTick: number): ChunksDatagram {
  // Parent island falls at 10 m/s from y=10 at the fracture tick.
  const y = 10 - ((simTick - fractureTick) / 60) * 10;
  return {
    sequence: simTick,
    baselineId: 0,
    simTick,
    records: [
      {
        bodyEntity: key,
        mode: RecordMode.MotionAbsolute,
        flags: 0,
        position: [0, y, 0] as Vec3,
        rotation: IDENTITY,
        linearVelocity: [0, -10, 0] as Vec3,
        angularVelocity: [0, 0, 0] as Vec3,
      } as ChunksDatagram['records'][number],
    ],
  };
}

describe('promotion glide continuity (post-fix regression surface)', () => {
  it('keeps every per-frame presented step of a fractured chunk physically explainable', () => {
    const client = new CityClient(loaded(), () => {});
    const parentKey = bodyKey(0, 1);
    const childKey = bodyKey(0, 2);
    const FRACTURE0 = 600; // parent island born
    const FRACTURE1 = 660; // child splits off 1s later, parent falling 10 m/s

    // Parent island promotion + steady datagrams while it falls.
    client.topology.apply({
      topoSeq: 1,
      simTick: FRACTURE0,
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [0],
          promotions: [
            {
              structureId: 0,
              islandId: 1,
              nodes: [1, 2, 3],
              position: [0, 10, 0],
              rotation: IDENTITY,
              linearVelocity: [0, -10, 0],
              angularVelocity: [0, 0, 0],
            },
          ],
          retiredIslandIds: [],
          migrations: [],
        },
      ],
      settled: [],
      wakes: [],
    } as unknown as TopologyMessage);

    const chunkSlot = client.topology.slotOf(0, 3);
    const stepLog: Array<{ frame: number; step: number; note: string }> = [];
    let prevDrawn: Vec3 | null = null;
    let frame = 0;

    // 60 fps loop; datagrams land every 2 ticks with ~15 ms one-way transit.
    // The child's promotion topology arrives at FRACTURE1 (+transit); its
    // first datagram one send later — the real arrival pattern.
    const sampleFrame = (note: string): void => {
      frame += 1;
      nowMs += 1000 / 60;
      const live = client.samplePresentation(nowMs);
      void live;
      const pose = client.topology.chunkWorldPose(chunkSlot);
      if (prevDrawn) {
        const step = Math.hypot(
          pose.position[0] - prevDrawn[0],
          pose.position[1] - prevDrawn[1],
          pose.position[2] - prevDrawn[2],
        );
        stepLog.push({ frame, step, note });
      }
      prevDrawn = [pose.position[0], pose.position[1], pose.position[2]];
    };

    // Warm-up: parent streams for 60 ticks (30 datagrams), sampling each frame.
    for (let tick = FRACTURE0; tick < FRACTURE1; tick += 2) {
      internals(client).handleChunks(fallingDatagram(tick, parentKey, FRACTURE0));
      sampleFrame('parent-falling');
      sampleFrame('parent-falling');
    }

    // Child fracture: topology (reliable) carries the tick-T pose; the parent
    // keeps streaming; the child's first record arrives one send later.
    const childY = 10 - ((FRACTURE1 - FRACTURE0) / 60) * 10; // = 0
    applyTopology(client, {
      topoSeq: 2,
      simTick: FRACTURE1,
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [2],
          promotions: [
            {
              structureId: 0,
              islandId: 2,
              nodes: [3],
              position: [0, childY + 3.5 - 2, 0], // COM of node 3 in world, at tick T
              rotation: IDENTITY,
              linearVelocity: [0, -10, 0],
              angularVelocity: [0, 0, 0],
            },
          ],
          retiredIslandIds: [],
          migrations: [],
        },
      ],
      settled: [],
      wakes: [],
    } as unknown as TopologyMessage);
    sampleFrame('fracture-frame');

    // Child + parent stream on; child's records track its own fall.
    for (let tick = FRACTURE1 + 2; tick < FRACTURE1 + 40; tick += 2) {
      const childRecordY = childY + 1.5 - ((tick - FRACTURE1) / 60) * 10;
      internals(client).handleChunks({
        sequence: tick,
        baselineId: 0,
        simTick: tick,
        records: [
          fallingDatagram(tick, parentKey, FRACTURE0).records[0],
          {
            bodyEntity: childKey,
            mode: RecordMode.MotionAbsolute,
            flags: 0,
            position: [0, childRecordY, 0] as Vec3,
            rotation: IDENTITY,
            linearVelocity: [0, -10, 0] as Vec3,
            angularVelocity: [0, 0, 0] as Vec3,
          } as ChunksDatagram['records'][number],
        ],
      });
      sampleFrame('post-fracture');
      sampleFrame('post-fracture');
    }

    // Physical bound: 10 m/s fall at 60 fps is 0.167 m/frame. The correction
    // glide may add its own motion; 3x physical is already visibly wrong, and
    // the measured regression was steps >1.5 m.
    const worst = stepLog.reduce((a, b) => (b.step > a.step ? b : a));
    const context = stepLog
      .filter((s) => s.step > 0.3)
      .map((s) => `f${s.frame} ${s.note} ${s.step.toFixed(3)}m`)
      .join('; ');
    expect(worst.step, `worst step ${worst.step.toFixed(3)}m at frame ${worst.frame} (${worst.note}); all >0.3m: ${context}`).toBeLessThan(0.5);
  });
});
