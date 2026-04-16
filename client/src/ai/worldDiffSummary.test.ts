import { describe, it, expect } from 'vitest';
import { summarizeWorldDiff } from './worldDiffSummary';
import {
  cloneWorldDocument,
  identityQuaternion,
  type WorldDocument,
} from '../world/worldDocument';

function blankWorld(): WorldDocument {
  return {
    version: 2,
    meta: { name: 'test', description: '' },
    terrain: {
      tileGridSize: 3,
      tileHalfExtentM: 8,
      tiles: [
        { tileX: 0, tileZ: 0, heights: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
      ],
    },
    staticProps: [],
    dynamicEntities: [],
  };
}

describe('summarizeWorldDiff', () => {
  it('returns null when nothing changed', () => {
    const a = blankWorld();
    const b = cloneWorldDocument(a);
    expect(summarizeWorldDiff(a, b)).toBeNull();
  });

  it('detects added static props with their ids', () => {
    const before = blankWorld();
    const after = cloneWorldDocument(before);
    after.staticProps.push({
      id: 7,
      kind: 'cuboid',
      position: [1, 2, 3],
      rotation: identityQuaternion(),
      halfExtents: [1, 1, 1],
    });
    const summary = summarizeWorldDiff(before, after);
    expect(summary).toContain('+1 static prop');
    expect(summary).toContain('#7');
  });

  it('detects removed dynamic entities', () => {
    const before = blankWorld();
    before.dynamicEntities.push({
      id: 9,
      kind: 'ball',
      position: [0, 0, 0],
      rotation: identityQuaternion(),
      radius: 0.5,
    });
    const after = cloneWorldDocument(before);
    after.dynamicEntities = [];
    const summary = summarizeWorldDiff(before, after);
    expect(summary).toContain('−1 dynamic entity');
    expect(summary).toContain('#9');
  });

  it('detects modified entity transforms', () => {
    const before = blankWorld();
    before.staticProps.push({
      id: 1,
      kind: 'cuboid',
      position: [0, 0, 0],
      rotation: identityQuaternion(),
      halfExtents: [1, 1, 1],
    });
    const after = cloneWorldDocument(before);
    after.staticProps[0] = { ...after.staticProps[0], position: [5, 0, 0] };
    const summary = summarizeWorldDiff(before, after);
    expect(summary).toContain('~1 static prop');
    expect(summary).toContain('#1');
  });

  it('detects sculpted terrain', () => {
    const before = blankWorld();
    const after = cloneWorldDocument(before);
    after.terrain.tiles[0] = {
      ...after.terrain.tiles[0],
      heights: [1, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    const summary = summarizeWorldDiff(before, after);
    expect(summary).toContain('sculpted 1 terrain tile');
  });

  it('detects added and removed terrain tiles', () => {
    const before = blankWorld();
    const afterAdd = cloneWorldDocument(before);
    afterAdd.terrain.tiles.push({
      tileX: 1,
      tileZ: 0,
      heights: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    expect(summarizeWorldDiff(before, afterAdd)).toContain('+1 terrain tile');

    const afterRemove = cloneWorldDocument(before);
    afterRemove.terrain.tiles = [];
    expect(summarizeWorldDiff(before, afterRemove)).toContain('−1 terrain tile');
  });

  it('joins multiple changes with semicolons', () => {
    const before = blankWorld();
    const after = cloneWorldDocument(before);
    after.meta.name = 'renamed';
    after.staticProps.push({
      id: 2,
      kind: 'cuboid',
      position: [0, 0, 0],
      rotation: identityQuaternion(),
      halfExtents: [1, 1, 1],
    });
    const summary = summarizeWorldDiff(before, after) ?? '';
    expect(summary).toContain(';');
    expect(summary).toContain('renamed');
    expect(summary).toContain('+1 static prop');
  });
});
