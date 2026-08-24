// Ledger tests: promotion re-parenting math, bond bitsets, bootstrap rebuild,
// and sequence-gap detection.

import { describe, expect, it } from 'vitest';

import type { CityManifest } from './manifest';
import { CityTopology, bodyKey } from './topology';
import type { TopologyMessage } from './wire';

const manifest = (): CityManifest => ({
  version: 1,
  structures: [
    {
      structureId: 0,
      worldPosition: [10, 0, 0],
      worldRotation: [0, 0, 0, 1],
      chunks: [0, 1, 2].map((node) => ({
        nodeIndex: node,
        centroid: [0, node + 0.5, 0],
        mass: node === 0 ? 0 : 10,
        volume: 1,
        size: [1, 1, 1],
        geometry: { kind: 'Cuboid', halfExtents: [0.5, 0.5, 0.5] },
        radius: 0.87,
        support: node === 0,
      })),
      bonds: [
        { bondIndex: 0, node0: 0, node1: 1, centroid: [0, 1, 0], normal: [0, 1, 0], area: 1 },
        { bondIndex: 1, node0: 1, node1: 2, centroid: [0, 2, 0], normal: [0, 1, 0], area: 1 },
      ],
    },
  ],
});

const fractureMessage = (topoSeq: number): TopologyMessage => ({
  topoSeq,
  simTick: 10,
  batches: [
    {
      structureId: 0,
      brokenBondIndices: [1],
      promotions: [
        {
          structureId: 0,
          islandId: 1,
          nodes: [2],
          // The adapter re-centres a split child on its centre of mass, so a
          // promotion pose is the island COM in world: structure origin
          // (10,0,0) + the single member's rest centroid (0,2.5,0).
          position: [10, 2.5, 0],
          rotation: [0, 0, 0, 1],
          linearVelocity: [1, 0, 0],
          angularVelocity: [0, 0, 0],
        },
      ],
      retiredIslandIds: [],
      migrations: [],
    },
  ],
  settled: [],
  wakes: [],
});

describe('CityTopology', () => {
  it('starts with every chunk on the intact support body', () => {
    const topology = new CityTopology(manifest());
    expect(topology.chunkCount).toBe(3);
    const pose = topology.chunkWorldPose(2);
    expect(pose.position).toEqual([10, 2.5, 0]); // world offset + rest centroid
  });

  it('promotion re-parents chunks with correct local offsets', () => {
    const topology = new CityTopology(manifest());
    expect(topology.apply(fractureMessage(1))).toBe(true);
    const key = bodyKey(0, 1);
    const body = topology.body(key);
    expect(body).toBeDefined();
    expect(body!.chunkSlots).toEqual([2]);
    // World pose unchanged at the promotion instant.
    const before = topology.chunkWorldPose(2);
    expect(before.position[1]).toBeCloseTo(2.5, 5);
    // Moving the body moves the chunk rigidly.
    topology.updateBodyPose(key, [10, 1.5, 0], [0, 0, 0, 1]);
    const after = topology.chunkWorldPose(2);
    expect(after.position[1]).toBeCloseTo(1.5, 5);
    // The support body keeps the remaining chunks.
    const support = topology.body(bodyKey(0, 0));
    expect(support!.chunkSlots).toHaveLength(2);
    expect(topology.stats().brokenBonds).toBe(1);
  });

  // The bug this pins: offsets used to be derived from `chunkWorldPose(slot)`
  // at the promotion instant, so they silently absorbed however wrong this
  // client's view was. Topology is reliable and immediate; the parent's
  // kinematic poses are unreliable, rate limited and interest culled, and a
  // chunk re-parented by physics without a promotion is not tracked at all.
  // Islands are rigid, so any error was frozen in for the match — chunks ended
  // up rendering metres under the floor while the server had every body
  // resting at y ≈ 0.
  it('derives island offsets independently of the client\'s prior view', () => {
    const clean = new CityTopology(manifest());
    clean.apply(fractureMessage(1));
    const expected = clean.chunkWorldPose(2).position;

    // Same promotion, but this client's view of the parent is badly stale.
    const stale = new CityTopology(manifest());
    stale.updateBodyPose(bodyKey(0, 0), [999, -500, 999], [0, 0, 0, 1]);
    stale.apply(fractureMessage(1));

    expect(stale.chunkWorldPose(2).position[0]).toBeCloseTo(expected[0], 5);
    expect(stale.chunkWorldPose(2).position[1]).toBeCloseTo(expected[1], 5);
    expect(stale.chunkWorldPose(2).position[2]).toBeCloseTo(expected[2], 5);
  });

  it('weights an island centre of mass by chunk mass', () => {
    const topology = new CityTopology(manifest());
    // Nodes 1 and 2 (mass 10 each, rest y 1.5 and 2.5) -> COM y = 2.0.
    topology.apply({
      topoSeq: 1,
      simTick: 10,
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [0],
          promotions: [
            {
              structureId: 0,
              islandId: 1,
              nodes: [1, 2],
              position: [10, 2, 0],
              rotation: [0, 0, 0, 1],
              linearVelocity: [0, 0, 0],
              angularVelocity: [0, 0, 0],
            },
          ],
          retiredIslandIds: [],
      migrations: [],
        },
      ],
      settled: [],
      wakes: [],
    });
    // Both chunks keep their rest separation and straddle the body origin.
    expect(topology.chunkWorldPose(1).position[1]).toBeCloseTo(1.5, 5);
    expect(topology.chunkWorldPose(2).position[1]).toBeCloseTo(2.5, 5);
  });

  // The bug this pins: an island body's chunks were re-offset only when
  // GAINED, never when LOST. A body's wire pose is its centre of mass
  // (com_world_position in physx-bridge/src/destruction.cc), so shedding a
  // member moves that pose even though the rigid body itself did not -- and
  // leaving the remaining chunks' offsets keyed on the old centre of mass
  // displaced them by exactly that delta the instant a further split landed.
  // Reported as "the building translates as it fractures".
  it('re-offsets a body\'s surviving chunks when it sheds a member', () => {
    const topology = new CityTopology(manifest());
    // Stage 1: break bond 0, promoting nodes 1 and 2 (equal mass) together.
    // COM y = 2.0, so node 1 (rest y 1.5) sits at local offset -0.5 within
    // this body.
    topology.apply({
      topoSeq: 1,
      simTick: 10,
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [0],
          promotions: [
            {
              structureId: 0,
              islandId: 1,
              nodes: [1, 2],
              position: [10, 2, 0],
              rotation: [0, 0, 0, 1],
              linearVelocity: [0, 0, 0],
              angularVelocity: [0, 0, 0],
            },
          ],
          retiredIslandIds: [],
      migrations: [],
        },
      ],
      settled: [],
      wakes: [],
    });
    const before = topology.body(bodyKey(0, 1))!;
    expect(before.chunkSlots).toEqual([1, 2]);

    // Stage 2: bond 1 (node 1 - node 2) breaks, and node 2 secedes into a new
    // island. Body 1 keeps only node 1. The server now reports body 1's pose
    // as node 1's own rest centroid (its centre of mass with one member),
    // not the stale two-node COM.
    topology.apply({
      topoSeq: 2,
      simTick: 20,
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [1],
          promotions: [
            {
              structureId: 0,
              islandId: 2,
              nodes: [2],
              position: [10, 2.5, 0],
              rotation: [0, 0, 0, 1],
              linearVelocity: [0, 0, 0],
              angularVelocity: [0, 0, 0],
            },
          ],
          retiredIslandIds: [],
      migrations: [],
        },
      ],
      settled: [],
      wakes: [],
    });

    const shrunk = topology.body(bodyKey(0, 1))!;
    expect(shrunk.chunkSlots).toEqual([1]);

    // If body 1 now reports its pose as node 1's rest centroid (origin +
    // (0, 1.5, 0)) -- the only physically consistent pose for a one-member
    // body -- node 1 must land exactly on its rest position. Before the fix
    // this failed by 0.5 m: the stale offset (-0.5) was still applied on top
    // of the new pose.
    topology.updateBodyPose(bodyKey(0, 1), [10, 1.5, 0], [0, 0, 0, 1]);
    const pose = topology.chunkWorldPose(1).position;
    expect(pose[0]).toBeCloseTo(10, 5);
    expect(pose[1]).toBeCloseTo(1.5, 5);
    expect(pose[2]).toBeCloseTo(0, 5);
  });

  it('bootstrap and live promotion agree chunk for chunk', () => {
    // A late joiner rebuilding from bootstrap must land on the same world
    // poses as a client that watched the collapse happen.
    const live = new CityTopology(manifest());
    live.apply(fractureMessage(1));
    live.updateBodyPose(bodyKey(0, 1), [10, 0.5, 0], [0, 0, 0, 1]);

    const late = new CityTopology(manifest());
    late.applyBootstrap({
      simTick: 99,
      manifestHashHex: 'aa',
      baselineId: 4,
      topoSeq: 41,
      structures: [{ structureId: 0, bondCount: 2, aliveBonds: new Uint8Array([0b01]) }],
      islands: [
        {
          structureId: 0,
          islandId: 1,
          nodes: [2],
          position: [10, 0.5, 0],
          rotation: [0, 0, 0, 1],
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          settled: true,
        },
      ],
    });

    const a = live.chunkWorldPose(2).position;
    const b = late.chunkWorldPose(2).position;
    expect(b[0]).toBeCloseTo(a[0], 5);
    expect(b[1]).toBeCloseTo(a[1], 5);
    expect(b[2]).toBeCloseTo(a[2], 5);
  });

  it('detects topology sequence gaps and flags resync', () => {
    const topology = new CityTopology(manifest());
    expect(topology.apply(fractureMessage(1))).toBe(true);
    expect(topology.apply(fractureMessage(3))).toBe(false);
    expect(topology.needsResync).toBe(true);
    expect(topology.stats().topoSeqGaps).toBe(1);
    // Duplicates of already-applied sequences are fine.
    expect(topology.apply(fractureMessage(1))).toBe(true);
  });

  it('rebuilds from bootstrap including bitsets and islands', () => {
    const topology = new CityTopology(manifest());
    topology.apply(fractureMessage(1));
    topology.applyBootstrap({
      simTick: 99,
      manifestHashHex: 'aa',
      baselineId: 4,
      topoSeq: 41,
      structures: [
        { structureId: 0, bondCount: 2, aliveBonds: new Uint8Array([0b01]) }, // bond 1 broken
      ],
      islands: [
        {
          structureId: 0,
          islandId: 1,
          nodes: [2],
          // COM frame again: the island has fallen 2 m from its rest COM.
          position: [10, 0.5, 0],
          rotation: [0, 0, 0, 1],
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          settled: true,
        },
      ],
    });
    expect(topology.lastSeq()).toBe(41);
    expect(topology.needsResync).toBe(false);
    expect(topology.stats().brokenBonds).toBe(1);
    const body = topology.body(bodyKey(0, 1));
    expect(body!.settled).toBe(true);
    expect(topology.chunkWorldPose(2).position[1]).toBeCloseTo(0.5, 5); // 2.5 - 2 fell
  });
});

// A body's pose is stated about its centre of mass, so an island that sheds a
// member changes frame: every surviving offset shifts by -delta. The ledger
// has to move the pose by +delta in the same breath, or the composed world
// placement jumps by the centre-of-mass delta -- which is what made buildings
// visibly hop on every hit.
describe('CityTopology centre-of-mass re-offset', () => {
  // Split node 2 away from an island holding nodes 1 and 2, leaving node 1.
  const secondSplit = (topoSeq: number): TopologyMessage => ({
    topoSeq,
    simTick: 20,
    batches: [
      {
        structureId: 0,
        brokenBondIndices: [],
        promotions: [
          {
            structureId: 0,
            islandId: 2,
            nodes: [2],
            position: [10, 2.5, 0],
            rotation: [0, 0, 0, 1],
            linearVelocity: [0, 0, 0],
            angularVelocity: [0, 0, 0],
          },
        ],
        retiredIslandIds: [],
      migrations: [],
      },
    ],
    settled: [],
    wakes: [],
  });

  const firstSplit = (topoSeq: number): TopologyMessage => ({
    topoSeq,
    simTick: 10,
    batches: [
      {
        structureId: 0,
        brokenBondIndices: [0],
        promotions: [
          {
            structureId: 0,
            islandId: 1,
            nodes: [1, 2],
            // COM of nodes 1 and 2 (equal mass): rest y 1.5 and 2.5 -> 2.0.
            position: [10, 2, 0],
            rotation: [0, 0, 0, 1],
            linearVelocity: [0, 0, 0],
            angularVelocity: [0, 0, 0],
          },
        ],
        retiredIslandIds: [],
      migrations: [],
      },
    ],
    settled: [],
    wakes: [],
  });

  it('keeps the surviving chunk world-fixed when its island sheds a member', () => {
    const topology = new CityTopology(manifest());
    expect(topology.apply(firstSplit(1))).toBe(true);
    const before = topology.chunkWorldPose(1);
    expect(topology.apply(secondSplit(2))).toBe(true);
    const after = topology.chunkWorldPose(1);
    expect(after.position[0]).toBeCloseTo(before.position[0], 5);
    expect(after.position[1]).toBeCloseTo(before.position[1], 5);
    expect(after.position[2]).toBeCloseTo(before.position[2], 5);
  });

  it('reports the body-local delta so buffered poses can follow', () => {
    const topology = new CityTopology(manifest());
    const seen: Array<{ key: number; delta: number[] }> = [];
    topology.onReoffset = (key, delta) => seen.push({ key, delta: [...delta] });
    expect(topology.apply(firstSplit(1))).toBe(true);
    seen.length = 0;
    expect(topology.apply(secondSplit(2))).toBe(true);
    const shed = seen.find((entry) => entry.key === bodyKey(0, 1));
    expect(shed).toBeDefined();
    // COM falls from y=2.0 (nodes 1+2) to y=1.5 (node 1 alone).
    expect(shed!.delta[1]).toBeCloseTo(-0.5, 5);
  });
});

// Physics reparents chunks between existing islands thousands of times over a
// demolition and issues no promotion for it. If the client is not told, the
// chunk stays on its old body and BOTH islands carry a centre of mass computed
// from the wrong membership -- which is how a chunk ends up composed against a
// frame it does not belong to.
describe('CityTopology chunk migration', () => {
  const promoteTwo = (topoSeq: number): TopologyMessage => ({
    topoSeq,
    simTick: 10,
    batches: [
      {
        structureId: 0,
        brokenBondIndices: [0, 1],
        promotions: [
          {
            structureId: 0,
            islandId: 1,
            nodes: [1],
            position: [10, 1.5, 0],
            rotation: [0, 0, 0, 1],
            linearVelocity: [0, 0, 0],
            angularVelocity: [0, 0, 0],
          },
          {
            structureId: 0,
            islandId: 2,
            nodes: [2],
            position: [10, 2.5, 0],
            rotation: [0, 0, 0, 1],
            linearVelocity: [0, 0, 0],
            angularVelocity: [0, 0, 0],
          },
        ],
        retiredIslandIds: [],
        migrations: [],
      },
    ],
    settled: [],
    wakes: [],
  });

  const migrate = (topoSeq: number): TopologyMessage => ({
    topoSeq,
    simTick: 20,
    batches: [
      {
        structureId: 0,
        brokenBondIndices: [],
        promotions: [],
        retiredIslandIds: [],
        migrations: [{ node: 2, fromIslandSerial: 2, toIslandSerial: 1 }],
      },
    ],
    settled: [],
    wakes: [],
  });

  it('rebinds the chunk to its new body', () => {
    const topology = new CityTopology(manifest());
    expect(topology.apply(promoteTwo(1))).toBe(true);
    const slot = topology.slotOf(0, 2);
    expect(topology.bodyKeyOf(slot)).toBe(bodyKey(0, 2));
    expect(topology.apply(migrate(2))).toBe(true);
    expect(topology.bodyKeyOf(slot)).toBe(bodyKey(0, 1));
    expect(topology.body(bodyKey(0, 1))!.chunkSlots).toContain(slot);
    expect(topology.body(bodyKey(0, 2))!.chunkSlots).not.toContain(slot);
  });

  // The destination's frame must be read before the arriving chunk joins it:
  // that chunk still carries the source body's frame, so deriving the old
  // centre of mass from it would corrupt the very offsets being fixed.
  it('leaves the destination chunks world-fixed', () => {
    const topology = new CityTopology(manifest());
    expect(topology.apply(promoteTwo(1))).toBe(true);
    const survivor = topology.slotOf(0, 1);
    const before = topology.chunkWorldPose(survivor);
    expect(topology.apply(migrate(2))).toBe(true);
    const after = topology.chunkWorldPose(survivor);
    expect(after.position[0]).toBeCloseTo(before.position[0], 5);
    expect(after.position[1]).toBeCloseTo(before.position[1], 5);
    expect(after.position[2]).toBeCloseTo(before.position[2], 5);
  });

  it('asks for a resync rather than guessing at an unknown destination', () => {
    const topology = new CityTopology(manifest());
    expect(topology.apply(promoteTwo(1))).toBe(true);
    topology.apply({
      ...migrate(2),
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [],
          promotions: [],
          retiredIslandIds: [],
          migrations: [{ node: 2, fromIslandSerial: 2, toIslandSerial: 99 }],
        },
      ],
    });
    expect(topology.needsResync).toBe(true);
  });
});

describe('CityTopology migration into an emptied body', () => {
  /**
   * Four chunks so an island can be reduced to zero members and still have a
   * migrating chunk arrive from a body whose frame is genuinely different.
   */
  const manifest4 = (): CityManifest => ({
    version: 1,
    structures: [
      {
        structureId: 0,
        worldPosition: [10, 0, 0],
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

  const promotion = (
    islandId: number,
    nodes: number[],
    position: [number, number, number],
  ) => ({
    structureId: 0,
    islandId,
    nodes,
    position,
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    linearVelocity: [0, 0, 0] as [number, number, number],
    angularVelocity: [0, 0, 0] as [number, number, number],
  });

  it('does not shift the destination by a delta read from the source frame', () => {
    const topology = new CityTopology(manifest4());
    // Island 1 holds two members; island 2 holds one, far away.
    topology.apply({
      topoSeq: 1,
      simTick: 1,
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [0, 1, 2],
          promotions: [promotion(1, [1, 2], [0, 2, 0]), promotion(2, [3], [0, 40, 0])],
          retiredIslandIds: [],
          migrations: [],
        },
      ],
      settled: [],
      wakes: [],
    } as unknown as TopologyMessage);

    // Empty island 2 by moving its only member to island 1, then move a chunk
    // back into the now-empty island 2.
    topology.apply({
      topoSeq: 2,
      simTick: 2,
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [],
          promotions: [],
          retiredIslandIds: [],
          migrations: [{ node: 3, fromIslandSerial: 2, toIslandSerial: 1 }],
        },
      ],
      settled: [],
      wakes: [],
    } as unknown as TopologyMessage);

    const emptied = topology.body(bodyKey(0, 2));
    expect(emptied?.chunkSlots.length).toBe(0);
    const poseBefore = [...(emptied?.position ?? [])];

    topology.apply({
      topoSeq: 3,
      simTick: 3,
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [],
          promotions: [],
          retiredIslandIds: [],
          migrations: [{ node: 1, fromIslandSerial: 1, toIslandSerial: 2 }],
        },
      ],
      settled: [],
      wakes: [],
    } as unknown as TopologyMessage);

    const destination = topology.body(bodyKey(0, 2));
    expect(destination?.chunkSlots.length).toBe(1);
    // Sole member of a body sits at its own centre of mass: offset zero.
    const slot = topology.slotOf(0, 1);
    const offset = topology.chunkLocalOffset(slot).position;
    expect(Math.hypot(offset[0], offset[1], offset[2])).toBeLessThan(1e-6);
    // And the pose must not have been dragged by a source-frame delta.
    expect(destination?.position[1]).toBeCloseTo(poseBefore[1] as number, 5);
  });
});

describe('CityTopology allocation-free pose compose', () => {
  it('matches chunkWorldPose exactly, including under body rotation', () => {
    const topology = new CityTopology(manifest());
    topology.apply(fractureMessage(1));
    // A rotation with all four components non-trivial: an identity or an
    // axis-aligned quarter turn would pass even with a transposed rotate or a
    // swapped Hamilton product.
    const body = topology.body(bodyKey(0, 1));
    expect(body).toBeDefined();
    const n = Math.hypot(0.3, -0.5, 0.2, 0.79);
    body!.rotation = [0.3 / n, -0.5 / n, 0.2 / n, 0.79 / n];
    body!.position = [3.25, -1.5, 7.75];

    const out = new Float32Array(7);
    for (let slot = 0; slot < topology.chunkCount; slot += 1) {
      const expected = topology.chunkWorldPose(slot);
      topology.chunkWorldPoseInto(slot, topology.body(topology.bodyKeyOf(slot)), out, 0);
      for (let i = 0; i < 3; i += 1) {
        expect(out[i]).toBeCloseTo(expected.position[i], 5);
      }
      for (let i = 0; i < 4; i += 1) {
        // Same quaternion, same sign convention -- not merely the same
        // rotation, since callers compare components.
        expect(out[3 + i]).toBeCloseTo(expected.rotation[i], 5);
      }
    }
  });

  it('falls back to the local offset when the body is gone, like the allocating form', () => {
    const topology = new CityTopology(manifest());
    const out = new Float32Array(7);
    const slot = 0;
    topology.chunkWorldPoseInto(slot, undefined, out, 0);
    const local = topology.chunkLocalOffset(slot);
    expect(Array.from(out.slice(0, 3))).toEqual(local.position.map((v) => Math.fround(v)));
  });
});

describe('CityTopology pose compose during membership churn', () => {
  it('composes against the slot owner even when handed a stale body', () => {
    const topology = new CityTopology(manifest());
    topology.apply(fractureMessage(1));
    const slot = topology.slotOf(0, 2);
    const owner = topology.body(topology.bodyKeyOf(slot));
    expect(owner).toBeDefined();
    owner!.position = [40, 9, -3];

    // A body that no longer owns this slot -- the state a caller iterating a
    // stale chunkSlots list would hand in mid-migration.
    const stale = topology.body(bodyKey(0, 0));
    expect(stale).toBeDefined();
    stale!.position = [-500, -500, -500];

    const out = new Float32Array(7);
    topology.chunkWorldPoseInto(slot, stale, out, 0);
    const expected = topology.chunkWorldPose(slot);
    for (let i = 0; i < 3; i += 1) {
      expect(out[i]).toBeCloseTo(expected.position[i], 4);
    }
    // Specifically: it must NOT have been drawn at the stale body's position.
    expect(out[0]).toBeGreaterThan(0);
  });
});

/**
 * At the instant of fracture, nothing has moved.
 *
 * The server splits a body and reports it; no time has passed and no physics
 * has run. So every chunk -- the ones promoted into the new island AND the
 * ones left behind -- must still compose to exactly the world pose it had a
 * moment earlier. Any deviation is a visible discontinuity at the exact frame
 * the player is looking at the impact, which is the worst possible moment for
 * one: reported as the building showing its post-fracture cutout before the
 * fractured pieces appear.
 */
describe('CityTopology fracture is pose-neutral', () => {
  /** A slab of `count` stacked unit chunks on one support, at a world offset. */
  const tower = (count: number): CityManifest => ({
    version: 1,
    structures: [
      {
        structureId: 0,
        worldPosition: [10, 0, -4],
        worldRotation: [0, 0, 0, 1],
        chunks: Array.from({ length: count }, (_, node) => ({
          nodeIndex: node,
          centroid: [0, node + 0.5, 0],
          mass: node === 0 ? 0 : 10,
          volume: 1,
          size: [1, 1, 1],
          geometry: { kind: 'Cuboid', halfExtents: [0.5, 0.5, 0.5] },
          radius: 0.87,
          support: node === 0,
        })),
        bonds: Array.from({ length: count - 1 }, (_, i) => ({
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

  /** Island COM in world, exactly as the adapter re-centres a split child. */
  const islandPose = (m: CityManifest, nodes: number[]): [number, number, number] => {
    const s = m.structures[0];
    let x = 0, y = 0, z = 0, w = 0;
    for (const node of nodes) {
      const chunk = s.chunks[node];
      const weight = chunk.mass > 0 ? chunk.mass : 1;
      x += chunk.centroid[0] * weight;
      y += chunk.centroid[1] * weight;
      z += chunk.centroid[2] * weight;
      w += weight;
    }
    return [
      s.worldPosition[0] + x / w,
      s.worldPosition[1] + y / w,
      s.worldPosition[2] + z / w,
    ];
  };

  it('leaves every chunk exactly where it was when a blast radius is promoted', () => {
    const m = tower(12);
    const topology = new CityTopology(m);
    const before = Array.from({ length: topology.chunkCount }, (_, slot) =>
      topology.chunkWorldPose(slot).position.slice() as number[]);

    // A shot mid-tower frees a contiguous group, exactly like a blast radius.
    const freed = [5, 6, 7];
    expect(topology.apply({
      topoSeq: 1,
      simTick: 10,
      batches: [{
        structureId: 0,
        brokenBondIndices: [4, 7],
        promotions: [{
          structureId: 0,
          islandId: 1,
          nodes: freed,
          position: islandPose(m, freed),
          rotation: [0, 0, 0, 1],
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
        }],
        retiredIslandIds: [],
        migrations: [],
      }],
      settled: [],
      wakes: [],
    } as unknown as TopologyMessage)).toBe(true);

    for (let slot = 0; slot < topology.chunkCount; slot += 1) {
      const after = topology.chunkWorldPose(slot).position;
      const moved = Math.hypot(
        after[0] - before[slot][0],
        after[1] - before[slot][1],
        after[2] - before[slot][2],
      );
      expect(moved, `chunk slot ${slot} moved ${moved.toFixed(3)} m at the fracture instant`)
        .toBeLessThan(1e-3);
    }
  });
});

/**
 * A chunk whose body the ledger cannot resolve has NO world pose.
 *
 * The allocating form answers that case with the chunk's body-local offset,
 * which for a structure sited away from the origin is a completely different
 * place -- so anything that draws it teleports the chunk, and a group of them
 * reads as a hole punched in the building. The into-form reports the failure
 * so the caller can leave the last known pose on screen instead.
 */
describe('CityTopology unresolved chunks', () => {
  it('reports failure rather than inventing a pose from the local offset', () => {
    const topology = new CityTopology(manifest());
    topology.apply(fractureMessage(1));
    const slot = topology.slotOf(0, 2);
    const key = topology.bodyKeyOf(slot);
    expect(topology.body(key)).toBeDefined();

    const out = new Float32Array(7);
    expect(topology.chunkWorldPoseInto(slot, topology.body(key), out, 0)).toBe(true);
    const resolved = [out[0], out[1], out[2]];

    // Retire the body without re-homing its chunks: the transient state a
    // migration or retire can leave between messages.
    const orphaned = new Float32Array(7);
    const bodies = topology as unknown as { bodies: Map<number, unknown> };
    bodies.bodies.delete(key);
    expect(topology.chunkWorldPoseInto(slot, undefined, orphaned, 0)).toBe(false);

    // And the pose it would have handed back is NOT where the chunk belongs,
    // which is exactly why drawing it is wrong.
    const invented = Math.hypot(
      orphaned[0] - resolved[0],
      orphaned[1] - resolved[1],
      orphaned[2] - resolved[2],
    );
    expect(invented).toBeGreaterThan(1);
  });
});
