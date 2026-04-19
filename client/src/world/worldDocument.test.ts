import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORLD_DOCUMENT,
  cloneWorldDocument,
  createEmptyWorldDocument,
  MAX_CHUNKS_PER_STRUCTURE,
  parseWorldDocument,
  removeVehicleEntitiesFromWorldDocument,
  serializeWorldDocument,
  type StructureDestructible,
  type WorldDocument,
} from './worldDocument';

describe('WorldDocument helpers', () => {
  it('removes authored vehicles for multiplayer prediction worlds', () => {
    const world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    expect(world.dynamicEntities.some((entity) => entity.kind === 'vehicle')).toBe(true);

    const stripped = removeVehicleEntitiesFromWorldDocument(world);

    expect(stripped).not.toBe(world);
    expect(stripped.dynamicEntities.some((entity) => entity.kind === 'vehicle')).toBe(false);
    expect(stripped.dynamicEntities.length).toBeLessThan(world.dynamicEntities.length);
    expect(stripped.terrain).toBe(world.terrain);
    expect(stripped.staticProps).toBe(world.staticProps);
  });

  it('reuses worlds that do not contain authored vehicles', () => {
    const world = {
      ...cloneWorldDocument(DEFAULT_WORLD_DOCUMENT),
      dynamicEntities: [],
    };

    expect(removeVehicleEntitiesFromWorldDocument(world)).toBe(world);
  });
});

describe('Destructible schema parse / serialize', () => {
  function worldWithDestructibles(destructibles: WorldDocument['destructibles']): WorldDocument {
    return { ...createEmptyWorldDocument(), destructibles };
  }

  it('round-trips a legacy wall factory destructible unchanged', () => {
    const world = worldWithDestructibles([
      { id: 100, kind: 'wall', position: [1, 0, 2], rotation: [0, 0, 0, 1] },
    ]);
    const reparsed = parseWorldDocument(JSON.parse(serializeWorldDocument(world)));
    expect(reparsed.destructibles).toEqual(world.destructibles);
  });

  it('round-trips an authored structure with mixed-shape chunks', () => {
    const structure: StructureDestructible = {
      id: 200,
      kind: 'structure',
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      density: 1800,
      solverMaterialScale: 1.5,
      chunks: [
        {
          shape: 'box',
          position: [0, 0.25, 0],
          rotation: [0, 0, 0, 1],
          halfExtents: [0.25, 0.25, 0.25],
          anchor: true,
        },
        {
          shape: 'sphere',
          position: [0, 0.75, 0],
          rotation: [0, 0, 0, 1],
          radius: 0.25,
          mass: 5,
        },
        {
          shape: 'capsule',
          position: [0, 1.5, 0],
          rotation: [0, 0, 0, 1],
          radius: 0.2,
          height: 0.6,
        },
      ],
    };
    const world = worldWithDestructibles([structure]);
    const reparsed = parseWorldDocument(JSON.parse(serializeWorldDocument(world)));
    expect(reparsed.destructibles).toEqual([structure]);
  });

  it('rejects a box chunk missing halfExtents', () => {
    const raw = {
      ...JSON.parse(serializeWorldDocument(createEmptyWorldDocument())),
      destructibles: [
        {
          id: 300,
          kind: 'structure',
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          chunks: [{ shape: 'box', position: [0, 0, 0], rotation: [0, 0, 0, 1] }],
        },
      ],
    };
    expect(() => parseWorldDocument(raw)).toThrow(/halfExtents/);
  });

  it('rejects a sphere chunk missing radius', () => {
    const raw = {
      ...JSON.parse(serializeWorldDocument(createEmptyWorldDocument())),
      destructibles: [
        {
          id: 301,
          kind: 'structure',
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          chunks: [{ shape: 'sphere', position: [0, 0, 0], rotation: [0, 0, 0, 1] }],
        },
      ],
    };
    expect(() => parseWorldDocument(raw)).toThrow(/radius/);
  });

  it('rejects a capsule chunk missing height', () => {
    const raw = {
      ...JSON.parse(serializeWorldDocument(createEmptyWorldDocument())),
      destructibles: [
        {
          id: 302,
          kind: 'structure',
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          chunks: [
            { shape: 'capsule', position: [0, 0, 0], rotation: [0, 0, 0, 1], radius: 0.2 },
          ],
        },
      ],
    };
    expect(() => parseWorldDocument(raw)).toThrow(/height/);
  });

  it('rejects structures that exceed MAX_CHUNKS_PER_STRUCTURE', () => {
    const tooMany = Array.from({ length: MAX_CHUNKS_PER_STRUCTURE + 1 }, (_, i) => ({
      shape: 'box',
      position: [i, 0, 0],
      rotation: [0, 0, 0, 1],
      halfExtents: [0.1, 0.1, 0.1],
    }));
    const raw = {
      ...JSON.parse(serializeWorldDocument(createEmptyWorldDocument())),
      destructibles: [
        {
          id: 303,
          kind: 'structure',
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          chunks: tooMany,
        },
      ],
    };
    expect(() => parseWorldDocument(raw)).toThrow(/max/);
  });

  it('rejects an unknown destructible kind', () => {
    const raw = {
      ...JSON.parse(serializeWorldDocument(createEmptyWorldDocument())),
      destructibles: [
        { id: 304, kind: 'rampart', position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      ],
    };
    expect(() => parseWorldDocument(raw)).toThrow(/unknown kind/);
  });
});
