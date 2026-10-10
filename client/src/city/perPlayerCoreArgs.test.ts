import { describe, expect, it } from 'vitest';
import type { LoadedCityManifest } from './manifest';
import { perPlayerCoreArgs } from './perPlayerCityClient';

type Manifest = LoadedCityManifest['manifest'];

const chunk = (nodeIndex: number, y: number, support: boolean) => ({
  nodeIndex, centroid: [0, y, 0], mass: 10, support, radius: 0.5,
});

function structure(bonds: 'json' | 'binary') {
  const base = {
    structureId: 3,
    worldPosition: [1, 2, 3],
    worldRotation: [0, 0, 0, 1],
    chunks: [chunk(0, 0, true), chunk(1, 1, false), chunk(2, 2, false)],
  };
  if (bonds === 'json') {
    // Out of index order on purpose: the JSON path places each by its index.
    return { ...base, bonds: [
      { bondIndex: 1, node0: 1, node1: 2, centroid: [0, 1.5, 0], normal: [0, 1, 0], area: 1 },
      { bondIndex: 0, node0: 0, node1: 1, centroid: [0, 0.5, 0], normal: [0, 1, 0], area: 1 },
    ] };
  }
  // The live server's binary manifest: endpoint arrays, indexed by position.
  return { ...base, bondCount: 2, bondNode0: Uint32Array.from([0, 1]), bondNode1: Uint32Array.from([1, 2]) };
}

describe('perPlayerCoreArgs', () => {
  it('reads bonds from the binary manifest the live server sends, as from JSON', () => {
    const json = perPlayerCoreArgs({ structures: [structure('json')] } as unknown as Manifest);
    const binary = perPlayerCoreArgs({ structures: [structure('binary')] } as unknown as Manifest);
    expect(Array.from(json.bondCounts)).toEqual([2]);
    expect(Array.from(json.bonds)).toEqual([0, 1, 1, 2]);
    expect(Array.from(binary.bondCounts)).toEqual([2]);
    expect(Array.from(binary.bonds)).toEqual(Array.from(json.bonds));
    expect(Array.from(binary.nodes)).toEqual(Array.from(json.nodes));
  });
});
