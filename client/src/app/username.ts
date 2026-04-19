// Client-side username store. Persists the player's preferred display name to
// localStorage, publishes changes to subscribers, and exposes a React hook for
// UI components. The server only accepts printable ASCII up to 20 bytes, so
// `sanitizeUsername` mirrors the server-side rules to keep wire traffic clean.

import { useSyncExternalStore } from 'react';
import { MAX_USERNAME_LEN, sanitizeUsername } from '../net/protocol';

const STORAGE_KEY = 'vibe-land/username';

function randomDefault(): string {
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `Player-${suffix}`;
}

let current: string | null = null;
const listeners = new Set<(name: string) => void>();

function safeReadStorage(): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

function safeWriteStorage(value: string): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, value);
    }
  } catch (error) {
    console.warn('Failed to persist username', error);
  }
}

function ensureLoaded(): string {
  if (current !== null) return current;
  const raw = safeReadStorage();
  if (raw) {
    const sanitized = sanitizeUsername(raw);
    if (sanitized.length > 0) {
      current = sanitized;
      return current;
    }
  }
  current = randomDefault();
  safeWriteStorage(current);
  return current;
}

export function getUsername(): string {
  return ensureLoaded();
}

export function setUsername(next: string): string {
  const sanitized = sanitizeUsername(next);
  const value = sanitized.length > 0 ? sanitized : randomDefault();
  current = value;
  safeWriteStorage(value);
  for (const fn of listeners) fn(value);
  return value;
}

export function subscribeUsername(fn: (name: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useUsername(): string {
  return useSyncExternalStore(
    (onStoreChange) => subscribeUsername(onStoreChange),
    () => getUsername(),
    () => '',
  );
}

export { MAX_USERNAME_LEN };
