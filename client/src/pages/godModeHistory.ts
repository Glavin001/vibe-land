import {
  cloneWorldDocument,
  serializeWorldDocument,
  type WorldDocument,
} from '../world/worldDocument';

export const GOD_MODE_UNDO_LIMIT = 64;

export type CommitEntry = {
  commitId: string;
  commitMessage: string;
  world: WorldDocument;
  timestamp: number;
  source: 'human' | 'ai' | 'rollback';
};

export type WorldEditHistory = {
  undoStack: CommitEntry[];
  redoStack: CommitEntry[];
};

export type WorldEditTransition = {
  changed: boolean;
  history: WorldEditHistory;
};

export type AppliedWorldEditTransition = WorldEditTransition & {
  world: WorldDocument;
  commitEntry?: CommitEntry;
};

export function generateCommitId(): string {
  return Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6);
}

export function createEmptyWorldEditHistory(): WorldEditHistory {
  return {
    undoStack: [],
    redoStack: [],
  };
}

export function commitWorldEdit(
  history: WorldEditHistory,
  previousWorld: WorldDocument,
  nextWorld: WorldDocument,
  commit: { commitId: string; commitMessage: string; source: CommitEntry['source'] },
  limit = GOD_MODE_UNDO_LIMIT,
): WorldEditTransition {
  if (worldDocumentsEqual(previousWorld, nextWorld)) {
    return {
      changed: false,
      history,
    };
  }

  const entry: CommitEntry = {
    commitId: commit.commitId,
    commitMessage: commit.commitMessage,
    world: cloneWorldDocument(previousWorld),
    timestamp: Date.now(),
    source: commit.source,
  };

  return {
    changed: true,
    history: {
      undoStack: [entry, ...history.undoStack].slice(0, limit),
      redoStack: [],
    },
  };
}

export function undoWorldEdit(
  history: WorldEditHistory,
  currentWorld: WorldDocument,
  limit = GOD_MODE_UNDO_LIMIT,
): AppliedWorldEditTransition {
  const entry = history.undoStack[0];
  if (!entry) {
    return {
      changed: false,
      history,
      world: currentWorld,
    };
  }

  // Create a redo entry carrying the undone commit's metadata so the
  // commit history UI can show what was undone/redone.
  const redoEntry: CommitEntry = {
    commitId: entry.commitId,
    commitMessage: entry.commitMessage,
    world: cloneWorldDocument(currentWorld),
    timestamp: entry.timestamp,
    source: entry.source,
  };

  return {
    changed: true,
    history: {
      undoStack: history.undoStack.slice(1),
      redoStack: [redoEntry, ...history.redoStack].slice(0, limit),
    },
    world: cloneWorldDocument(entry.world),
    commitEntry: entry,
  };
}

export function redoWorldEdit(
  history: WorldEditHistory,
  currentWorld: WorldDocument,
  limit = GOD_MODE_UNDO_LIMIT,
): AppliedWorldEditTransition {
  const entry = history.redoStack[0];
  if (!entry) {
    return {
      changed: false,
      history,
      world: currentWorld,
    };
  }

  // Push current state onto undo stack, carrying the redo entry's metadata.
  const undoEntry: CommitEntry = {
    commitId: entry.commitId,
    commitMessage: entry.commitMessage,
    world: cloneWorldDocument(currentWorld),
    timestamp: entry.timestamp,
    source: entry.source,
  };

  return {
    changed: true,
    history: {
      undoStack: [undoEntry, ...history.undoStack].slice(0, limit),
      redoStack: history.redoStack.slice(1),
    },
    world: cloneWorldDocument(entry.world),
    commitEntry: entry,
  };
}

function worldDocumentsEqual(a: WorldDocument, b: WorldDocument): boolean {
  if (a === b) {
    return true;
  }
  return serializeWorldDocument(a) === serializeWorldDocument(b);
}
