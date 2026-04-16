import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPublishedHistory,
  isWorldInPublishedHistory,
  loadPublishedHistory,
  recordPublishedWorld,
} from './publishedHistory';

// The module reads `window.localStorage` directly. Vitest's default node
// environment doesn't ship a DOM, so stand up a tiny in-memory Storage stub.
class InMemoryStorage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  key(index: number) {
    return Array.from(this.data.keys())[index] ?? null;
  }
}

describe('publishedHistory', () => {
  beforeEach(() => {
    const storage = new InMemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an empty list before anything is recorded', () => {
    expect(loadPublishedHistory()).toEqual([]);
    expect(isWorldInPublishedHistory('abc')).toBe(false);
  });

  it('records and retrieves an entry', () => {
    recordPublishedWorld({ id: 'abc', name: 'Alpha', publishedAt: 1 });
    expect(loadPublishedHistory()).toEqual([
      { id: 'abc', name: 'Alpha', publishedAt: 1 },
    ]);
    expect(isWorldInPublishedHistory('abc')).toBe(true);
  });

  it('sorts by publishedAt descending', () => {
    recordPublishedWorld({ id: 'a', name: 'First', publishedAt: 100 });
    recordPublishedWorld({ id: 'b', name: 'Second', publishedAt: 200 });
    recordPublishedWorld({ id: 'c', name: 'Third', publishedAt: 150 });
    const ids = loadPublishedHistory().map((entry) => entry.id);
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('deduplicates entries by id on repeated record', () => {
    recordPublishedWorld({ id: 'abc', name: 'Old', publishedAt: 1 });
    recordPublishedWorld({ id: 'abc', name: 'Renamed', publishedAt: 2 });
    const history = loadPublishedHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({ id: 'abc', name: 'Renamed', publishedAt: 2 });
  });

  it('clearPublishedHistory removes all entries', () => {
    recordPublishedWorld({ id: 'abc', name: 'Alpha', publishedAt: 1 });
    clearPublishedHistory();
    expect(loadPublishedHistory()).toEqual([]);
  });

  it('tolerates corrupted JSON in storage', () => {
    localStorage.setItem('vibe-land/published-history/v1', 'not-json');
    expect(loadPublishedHistory()).toEqual([]);
  });
});
