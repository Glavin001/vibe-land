import {
  cloneWorldDocument,
  serializeWorldDocument,
  type WorldDocument,
} from '../world/worldDocument';

export const GOD_MODE_UNDO_LIMIT = 64;

export type WorldEditHistory = {
  undoStack: WorldDocument[];
  redoStack: WorldDocument[];
};

export type WorldEditTransition = {
  changed: boolean;
  history: WorldEditHistory;
};

export type AppliedWorldEditTransition = WorldEditTransition & {
  world: WorldDocument;
};

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
  limit = GOD_MODE_UNDO_LIMIT,
): WorldEditTransition {
  if (worldDocumentsEqual(previousWorld, nextWorld)) {
    return {
      changed: false,
      history,
    };
  }

  return {
    changed: true,
    history: {
      undoStack: [cloneWorldDocument(previousWorld), ...history.undoStack].slice(0, limit),
      redoStack: [],
    },
  };
}

export function undoWorldEdit(
  history: WorldEditHistory,
  currentWorld: WorldDocument,
  limit = GOD_MODE_UNDO_LIMIT,
): AppliedWorldEditTransition {
  const previousWorld = history.undoStack[0];
  if (!previousWorld) {
    return {
      changed: false,
      history,
      world: currentWorld,
    };
  }

  return {
    changed: true,
    history: {
      undoStack: history.undoStack.slice(1),
      redoStack: [cloneWorldDocument(currentWorld), ...history.redoStack].slice(0, limit),
    },
    world: cloneWorldDocument(previousWorld),
  };
}

export function redoWorldEdit(
  history: WorldEditHistory,
  currentWorld: WorldDocument,
  limit = GOD_MODE_UNDO_LIMIT,
): AppliedWorldEditTransition {
  const nextWorld = history.redoStack[0];
  if (!nextWorld) {
    return {
      changed: false,
      history,
      world: currentWorld,
    };
  }

  return {
    changed: true,
    history: {
      undoStack: [cloneWorldDocument(currentWorld), ...history.undoStack].slice(0, limit),
      redoStack: history.redoStack.slice(1),
    },
    world: cloneWorldDocument(nextWorld),
  };
}

function worldDocumentsEqual(a: WorldDocument, b: WorldDocument): boolean {
  if (a === b) {
    return true;
  }
  return serializeWorldDocument(a) === serializeWorldDocument(b);
}
