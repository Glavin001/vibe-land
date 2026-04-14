import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_DOCUMENT } from '../../world/worldDocument';
import { buildWorldGeometry } from './worldGeometry';

describe('buildWorldGeometry', () => {
  it('produces a non-empty triangle soup from the default world', () => {
    const geom = buildWorldGeometry(DEFAULT_WORLD_DOCUMENT);
    expect(geom.triangleCount).toBeGreaterThan(0);
    expect(geom.vertexCount).toBeGreaterThan(0);
    expect(geom.positions.length).toBe(geom.vertexCount * 3);
    expect(geom.indices.length).toBe(geom.triangleCount * 3);
  });

  it('bounds encompass every emitted vertex', () => {
    const geom = buildWorldGeometry(DEFAULT_WORLD_DOCUMENT);
    const [minX, minY, minZ] = geom.boundsMin;
    const [maxX, maxY, maxZ] = geom.boundsMax;
    for (let i = 0; i < geom.vertexCount; i += 1) {
      const x = geom.positions[i * 3];
      const y = geom.positions[i * 3 + 1];
      const z = geom.positions[i * 3 + 2];
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(y).toBeGreaterThanOrEqual(minY);
      expect(z).toBeGreaterThanOrEqual(minZ);
      expect(x).toBeLessThanOrEqual(maxX);
      expect(y).toBeLessThanOrEqual(maxY);
      expect(z).toBeLessThanOrEqual(maxZ);
    }
  });

  it('emits 12 triangles per static cuboid prop', () => {
    const world = {
      ...DEFAULT_WORLD_DOCUMENT,
      terrain: {
        ...DEFAULT_WORLD_DOCUMENT.terrain,
        tiles: [],
      },
      staticProps: [
        {
          id: 1,
          kind: 'cuboid' as const,
          position: [0, 1, 0] as [number, number, number],
          rotation: [0, 0, 0, 1] as [number, number, number, number],
          halfExtents: [1, 1, 1] as [number, number, number],
        },
      ],
      dynamicEntities: [],
    };
    const geom = buildWorldGeometry(world);
    expect(geom.triangleCount).toBe(12);
    expect(geom.vertexCount).toBe(8);
    // Axis-aligned unit cuboid centered on [0,1,0]: bounds should be [-1,0,-1]..[1,2,1]
    expect(geom.boundsMin).toEqual([-1, 0, -1]);
    expect(geom.boundsMax).toEqual([1, 2, 1]);
  });

  it('indices stay within vertex range', () => {
    const geom = buildWorldGeometry(DEFAULT_WORLD_DOCUMENT);
    const upper = geom.vertexCount;
    let maxIndex = -1;
    let minIndex = Number.POSITIVE_INFINITY;
    for (let i = 0; i < geom.indices.length; i += 1) {
      const idx = geom.indices[i];
      if (idx > maxIndex) maxIndex = idx;
      if (idx < minIndex) minIndex = idx;
    }
    expect(minIndex).toBeGreaterThanOrEqual(0);
    expect(maxIndex).toBeLessThan(upper);
  });
});
