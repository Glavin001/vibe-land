// Tracks the world IDs the current browser has successfully published to the
// cloud. Stored in localStorage so the user can see "their" worlds across
// sessions even though there is no account system behind the gallery.
//
// The history is purely a client-side convenience — nothing on the server
// knows about it. Clearing browser storage wipes it, and two browsers will
// show different sets.

const STORAGE_KEY = 'vibe-land/published-history/v1';
const MAX_ENTRIES = 200;

export type PublishedHistoryEntry = {
  id: string;
  name: string;
  publishedAt: number;
};

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    // localStorage can throw in some privacy modes.
    return null;
  }
}

function readRaw(): PublishedHistoryEntry[] {
  const storage = safeLocalStorage();
  if (!storage) return [];
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is PublishedHistoryEntry => (
        entry
        && typeof entry === 'object'
        && typeof entry.id === 'string'
        && typeof entry.name === 'string'
        && typeof entry.publishedAt === 'number'
      ))
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeRaw(entries: PublishedHistoryEntry[]): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Ignore quota errors – the history is best-effort.
  }
}

export function loadPublishedHistory(): PublishedHistoryEntry[] {
  return readRaw().sort((a, b) => b.publishedAt - a.publishedAt);
}

export function recordPublishedWorld(entry: PublishedHistoryEntry): void {
  const existing = readRaw();
  const filtered = existing.filter((candidate) => candidate.id !== entry.id);
  filtered.unshift(entry);
  writeRaw(filtered);
}

export function isWorldInPublishedHistory(id: string): boolean {
  return readRaw().some((entry) => entry.id === id);
}

export function clearPublishedHistory(): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore – best effort.
  }
}
