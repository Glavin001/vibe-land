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
const DRAFT_DB_NAME = 'vibe-land-godmode';
const DRAFT_DB_VERSION = 1;
const DRAFT_STORE_NAME = 'drafts';

let draftDbPromise: Promise<IDBDatabase | null> | null = null;

export async function loadCurrentDraft(): Promise<WorldDocument | null> {
  const stored = await readStructuredValue(CURRENT_DRAFT_KEY);
  if (!stored) {
    return null;
  }
  try {
    return parseWorldDocument(stored);
  } catch (error) {
    console.warn('Failed to restore godmode draft', error);
    return null;
  }
}

export async function saveCurrentDraft(world: WorldDocument): Promise<void> {
  await writeStructuredValue(CURRENT_DRAFT_KEY, world);
}

export async function loadRevisionHistory(): Promise<WorldDraftRevision[]> {
  const stored = await readStructuredValue(REVISION_HISTORY_KEY);
  if (!Array.isArray(stored)) {
    return [];
  }
  try {
    return stored.map((entry) => ({
      ...(entry as WorldDraftRevision),
      world: parseWorldDocument((entry as WorldDraftRevision).world),
    }));
  } catch (error) {
    console.warn('Failed to restore godmode revision history', error);
    return [];
  }
}

export async function pushRevisionHistory(
  world: WorldDocument,
  summary: string,
  limit = DEFAULT_WORLD_HISTORY_LIMIT,
): Promise<WorldDraftRevision[]> {
  const nextEntry = buildDraftRevision(world, summary);
  let nextHistory = [nextEntry, ...(await loadRevisionHistory())].slice(0, limit);

  while (nextHistory.length > 0) {
    try {
      await writeStructuredValue(REVISION_HISTORY_KEY, nextHistory);
      return nextHistory;
    } catch (error) {
      nextHistory = nextHistory.slice(0, -1);
      if (nextHistory.length === 0) {
        console.warn('Failed to persist godmode revision history', error);
        await deleteStructuredValue(REVISION_HISTORY_KEY);
        return [];
      }
    }
  }

  await deleteStructuredValue(REVISION_HISTORY_KEY);
  return [];
}

export function setLastImportName(fileName: string): void {
  window.localStorage.setItem(LAST_IMPORT_NAME_KEY, fileName);
}

export function getLastImportName(): string {
  return window.localStorage.getItem(LAST_IMPORT_NAME_KEY) ?? '';
}

export async function clearDraftStorage(): Promise<void> {
  await Promise.all([
    deleteStructuredValue(CURRENT_DRAFT_KEY),
    deleteStructuredValue(REVISION_HISTORY_KEY),
  ]);
  window.localStorage.removeItem(LAST_IMPORT_NAME_KEY);
  window.localStorage.removeItem(LAST_AUTOSAVE_BACKUP_AT_KEY);
}

export function getInitialGodModeWorld(): WorldDocument {
  return cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
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

async function readStructuredValue(key: string): Promise<unknown | null> {
  const db = await openDraftDatabase();
  if (!db) {
    return readLegacyLocalStorage(key);
  }

  const value = await runIdbRequest<unknown | null>((store) => store.get(key));
  if (value != null) {
    return value;
  }

  const legacyValue = readLegacyLocalStorage(key);
  if (legacyValue != null) {
    await writeStructuredValue(key, legacyValue);
    window.localStorage.removeItem(key);
  }
  return legacyValue;
}

async function writeStructuredValue(key: string, value: unknown): Promise<void> {
  const db = await openDraftDatabase();
  if (!db) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn(`Failed to persist ${key}`, error);
    }
    return;
  }
  await runIdbRequest<IDBValidKey>((store) => store.put(value, key), 'readwrite');
}

async function deleteStructuredValue(key: string): Promise<void> {
  const db = await openDraftDatabase();
  if (!db) {
    window.localStorage.removeItem(key);
    return;
  }
  await runIdbRequest<undefined>((store) => store.delete(key), 'readwrite');
}

function readLegacyLocalStorage(key: string): unknown | null {
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Failed to parse legacy localStorage payload for ${key}`, error);
    return null;
  }
}

function openDraftDatabase(): Promise<IDBDatabase | null> {
  if (!draftDbPromise) {
    draftDbPromise = new Promise((resolve) => {
      if (!('indexedDB' in window)) {
        resolve(null);
        return;
      }

      const request = window.indexedDB.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DRAFT_STORE_NAME)) {
          db.createObjectStore(DRAFT_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn('Failed to open God Mode draft IndexedDB', request.error);
        resolve(null);
      };
    });
  }
  return draftDbPromise;
}

async function runIdbRequest<T>(
  operation: (store: IDBObjectStore) => IDBRequest<T>,
  mode: IDBTransactionMode = 'readonly',
): Promise<T> {
  const db = await openDraftDatabase();
  if (!db) {
    throw new Error('IndexedDB unavailable');
  }

  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(DRAFT_STORE_NAME, mode);
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}
