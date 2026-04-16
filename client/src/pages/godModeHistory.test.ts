import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORLD_DOCUMENT,
  cloneWorldDocument,
} from '../world/worldDocument';
import {
  commitWorldEdit,
  createEmptyWorldEditHistory,
  redoWorldEdit,
  undoWorldEdit,
} from './godModeHistory';

const testCommit = { commitId: 'test0001', commitMessage: 'test edit', source: 'human' as const };

describe('godModeHistory', () => {
  it('records a changed world on the undo stack and clears redo', () => {
    const current = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    const next = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    next.terrain.tiles[0].heights[0] += 1;

    const transition = commitWorldEdit(createEmptyWorldEditHistory(), current, next, testCommit);

    expect(transition.changed).toBe(true);
    expect(transition.history.undoStack).toHaveLength(1);
    expect(transition.history.redoStack).toHaveLength(0);
    expect(transition.history.undoStack[0].world).toEqual(current);
    expect(transition.history.undoStack[0].commitId).toBe('test0001');
    expect(transition.history.undoStack[0].commitMessage).toBe('test edit');
  });

  it('ignores no-op edits', () => {
    const current = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);

    const transition = commitWorldEdit(createEmptyWorldEditHistory(), current, cloneWorldDocument(current), testCommit);

    expect(transition.changed).toBe(false);
    expect(transition.history.undoStack).toHaveLength(0);
    expect(transition.history.redoStack).toHaveLength(0);
  });

  it('round-trips undo and redo with cloned snapshots', () => {
    const current = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    const next = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    next.terrain.tiles[0].heights[0] += 2;
    const committed = commitWorldEdit(createEmptyWorldEditHistory(), current, next, testCommit);

    const undone = undoWorldEdit(committed.history, next);
    expect(undone.changed).toBe(true);
    expect(undone.world).toEqual(current);
    expect(undone.history.redoStack).toHaveLength(1);

    const redone = redoWorldEdit(undone.history, undone.world);
    expect(redone.changed).toBe(true);
    expect(redone.world).toEqual(next);
    expect(redone.history.undoStack).toHaveLength(1);
  });
});
