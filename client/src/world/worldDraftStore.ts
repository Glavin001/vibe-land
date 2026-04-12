import {
  DEFAULT_WORLD_DOCUMENT,
  DEFAULT_WORLD_HISTORY_LIMIT,
  type WorldDocument,
  type WorldDraftRevision,
  buildDraftRevision,
  cloneWorldDocument,
  parseWorldDocument,
} from './worldDocument';

const CURRENT_DRAFT_KEY = 'vibe-land/godmode/current-draft';
const REVISION_HISTORY_KEY = 'vibe-land/godmode/revision-history';
const LAST_IMPORT_NAME_KEY = 'vibe-land/godmode/last-import-name';
const LAST_AUTOSAVE_BACKUP_AT_KEY = 'vibe-land/godmode/last-autosave-backup-at';

export function loadCurrentDraft(): WorldDocument | null {
  const raw = window.localStorage.getItem(CURRENT_DRAFT_KEY);
  if (!raw) {
    return null;
  }
  try {
    return parseWorldDocument(JSON.parse(raw));
  } catch (error) {
    console.warn('Failed to restore godmode draft', error);
    return null;
  }
}

export function saveCurrentDraft(world: WorldDocument): void {
  try {
    window.localStorage.setItem(CURRENT_DRAFT_KEY, JSON.stringify(world));
  } catch (error) {
    console.warn('Failed to persist current godmode draft', error);
  }
}

export function loadRevisionHistory(): WorldDraftRevision[] {
  const raw = window.localStorage.getItem(REVISION_HISTORY_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as WorldDraftRevision[];
    return parsed.map((entry) => ({
      ...entry,
      world: parseWorldDocument(entry.world),
    }));
  } catch (error) {
    console.warn('Failed to restore godmode revision history', error);
    return [];
  }
}

export function pushRevisionHistory(
  world: WorldDocument,
  summary: string,
  limit = DEFAULT_WORLD_HISTORY_LIMIT,
): WorldDraftRevision[] {
  const nextEntry = buildDraftRevision(world, summary);
  let nextHistory = [nextEntry, ...loadRevisionHistory()].slice(0, limit);

  while (nextHistory.length > 0) {
    try {
      window.localStorage.setItem(REVISION_HISTORY_KEY, JSON.stringify(nextHistory));
      return nextHistory;
    } catch (error) {
      nextHistory = nextHistory.slice(0, -1);
      if (nextHistory.length === 0) {
        console.warn('Failed to persist godmode revision history', error);
        window.localStorage.removeItem(REVISION_HISTORY_KEY);
        return [];
      }
    }
  }

  window.localStorage.removeItem(REVISION_HISTORY_KEY);
  return [];
}

export function setLastImportName(fileName: string): void {
  window.localStorage.setItem(LAST_IMPORT_NAME_KEY, fileName);
}

export function getLastImportName(): string {
  return window.localStorage.getItem(LAST_IMPORT_NAME_KEY) ?? '';
}

export function clearDraftStorage(): void {
  window.localStorage.removeItem(CURRENT_DRAFT_KEY);
  window.localStorage.removeItem(REVISION_HISTORY_KEY);
  window.localStorage.removeItem(LAST_IMPORT_NAME_KEY);
  window.localStorage.removeItem(LAST_AUTOSAVE_BACKUP_AT_KEY);
}

export function getInitialGodModeWorld(): WorldDocument {
  return cloneWorldDocument(loadCurrentDraft() ?? DEFAULT_WORLD_DOCUMENT);
}

export function shouldCreateAutosaveBackup(
  nowMs: number,
  minIntervalMs = 30_000,
): boolean {
  const lastRaw = window.localStorage.getItem(LAST_AUTOSAVE_BACKUP_AT_KEY);
  const lastMs = lastRaw ? Number(lastRaw) : 0;
  return !Number.isFinite(lastMs) || nowMs - lastMs >= minIntervalMs;
}

export function markAutosaveBackup(nowMs: number): void {
  window.localStorage.setItem(LAST_AUTOSAVE_BACKUP_AT_KEY, String(nowMs));
}
