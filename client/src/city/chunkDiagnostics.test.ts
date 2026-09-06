import { describe, expect, it } from 'vitest';
import { CHUNK_SUNK_Y_M, compareDrawnChunkPositions, deepestChunkProvenance } from './chunkDiagnostics';
import { CityTopology, bodyKey } from './topology';

function rotatedChunk() {
  const topology = new CityTopology({
    version: 1,
    structures: [{
      structureId: 7, worldPosition: [10, 0, 20], worldRotation: [0, 0, 0, 1],
      chunks: [{ nodeIndex: 0, centroid: [0, 3, 0], mass: 10, volume: 1,
        size: [1, 1, 1], geometry: { kind: 'Cuboid', halfExtents: [0.5, 0.5, 0.5] },
        radius: 1, support: false }],
      bonds: [],
    }],
  });
  const key = bodyKey(7, 0);
  topology.watchPoseSources = true;
  // A body origin above ground can have a rotated chunk centroid below it.
  topology.updateBodyPose(key, [10, 1, 20], [1, 0, 0, 0], 'raw');
  const pose = new Float32Array(7);
  expect(topology.chunkWorldPoseInto(0, topology.body(key), pose, 0)).toBe(true);
  return { topology, positions: pose.subarray(0, 3), key };
}

describe('chunk diagnostic provenance', () => {
  it('identifies the reported two-metre depth even with a positive body origin', () => {
    const { topology, positions, key } = rotatedChunk();
    const result = deepestChunkProvenance(topology, 0, positions)!;
    expect(result.worldY).toBe(-2);
    expect(result.worldPosition).toEqual([10, -2, 20]);
    expect(result.bodyKey).toBe(key);
    expect(result.structure).toBe(7);
    expect(result.node).toBe(0);
    expect(result.bodyPos).toEqual([10, 1, 20]);
    expect(result.bodyRotation).toEqual([1, 0, 0, 0]);
    expect(result.localOffset).toEqual([0, 3, 0]);
    expect(result.localRotation).toEqual([0, 0, 0, 1]);
    expect(result.poseSourceTracking).toBe(true);
    expect(result.poseSource).toBe('raw');
  });

  it('uses the counting threshold instead of hiding shallow penetration', () => {
    const { topology, positions } = rotatedChunk();
    positions[1] = CHUNK_SUNK_Y_M;
    expect(deepestChunkProvenance(topology, 0, positions)).toBeNull();
    positions[1] = -0.26;
    expect(deepestChunkProvenance(topology, 0, positions)?.worldY).toBeCloseTo(-0.26);
  });

  it('keeps a snapshot after the ledger and sweep advance', () => {
    const { topology, positions, key } = rotatedChunk();
    const result = deepestChunkProvenance(topology, 0, positions)!;
    topology.body(key)!.position[1] = 100;
    topology.body(key)!.rotation[0] = 0;
    positions[1] = 103;
    expect(result.bodyPos).toEqual([10, 1, 20]);
    expect(result.bodyRotation).toEqual([1, 0, 0, 0]);
    expect(result.worldPosition).toEqual([10, -2, 20]);
  });

  it('does not treat disabled source tracking as current provenance', () => {
    const { topology, positions } = rotatedChunk();
    topology.watchPoseSources = false;
    const result = deepestChunkProvenance(topology, 0, positions)!;
    expect(result.poseSourceTracking).toBe(false);
    expect(result.poseSource).toBeNull();
  });

  it('does not label missing owners or nonfinite positions as physical penetration', () => {
    const { topology, positions } = rotatedChunk();
    expect(deepestChunkProvenance(topology, -1, positions)).toBeNull();
    expect(deepestChunkProvenance(topology, 1, positions)).toBeNull();
    positions[1] = Number.NaN;
    expect(deepestChunkProvenance(topology, 0, positions)).toBeNull();
    positions[1] = -2;
    topology.chunkBody[0] = bodyKey(7, 999);
    expect(deepestChunkProvenance(topology, 0, positions)).toBeNull();
  });
});

describe('drawn chunk diagnostic coverage', () => {
  it('counts actual comparisons, skips unknown poses and detects stale draws', () => {
    const current = new Float32Array([1, 2, 3, 1, 2, 3, NaN, NaN, NaN, 1, 2, 3]);
    const previous = new Float32Array([1, 2, 3, 1, 1, 3, 1, 2, 3, NaN, NaN, NaN]);
    expect(compareDrawnChunkPositions(current, previous, 4, 0.5)).toEqual({ checked: 2, stale: 1 });
  });

  it('does not report checks for untracked slots or unused scratch capacity', () => {
    const current = new Float32Array([1, 2, 3, 8, 8, 8]);
    expect(compareDrawnChunkPositions(current, new Float32Array(0), 2, 0.5))
      .toEqual({ checked: 0, stale: 0 });
    expect(compareDrawnChunkPositions(current, new Float32Array([1, 2, 3, 0, 0, 0]), 1, 0.5))
      .toEqual({ checked: 1, stale: 0 });
  });
});
