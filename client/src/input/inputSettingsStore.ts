// Singleton store for calibratable input settings. Persists to localStorage,
// supports pub/sub so the wizard can live-preview values during drills, and
// exposes a React hook for UI components.
//
// The game loop (keyboardMouse.ts, gamepad.ts) reads via `getInputSettings()`
// on every sample — a single object fetch plus a few field reads per frame,
// which is negligible vs the rest of the per-frame work.

import { useSyncExternalStore } from 'react';
import {
  cloneInputSettings,
  DEFAULT_INPUT_SETTINGS,
  parseInputSettings,
  type InputSettings,
} from './inputSettings';

const STORAGE_KEY = 'vibe-land/input-settings';

let current: InputSettings = DEFAULT_INPUT_SETTINGS;
let loaded = false;
const listeners = new Set<(settings: InputSettings) => void>();

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
    console.warn('Failed to persist input settings', error);
  }
}

export function loadInputSettings(): InputSettings {
  if (loaded) return current;
  loaded = true;
  const raw = safeReadStorage();
  if (raw) {
    try {
      const parsed = parseInputSettings(JSON.parse(raw));
      if (parsed) {
        current = parsed;
      }
    } catch (error) {
      console.warn('Failed to restore input settings', error);
    }
  }
  return current;
}

/**
 * Synchronous read used by per-frame input samplers. Auto-loads from storage
 * on first call so callers don't need to worry about initialization order.
 */
export function getInputSettings(): InputSettings {
  if (!loaded) loadInputSettings();
  return current;
}

export function saveInputSettings(next: InputSettings): void {
  current = next;
  if (!loaded) loaded = true;
  safeWriteStorage(JSON.stringify(next));
  for (const fn of listeners) fn(current);
}

/**
 * Mutate the current settings in a callback style. Returns the new object.
 * The callback receives a clone; it must return a new settings object (can
 * mutate the clone in place and return it).
 */
export function updateInputSettings(
  mutate: (draft: InputSettings) => InputSettings,
): InputSettings {
  const draft = cloneInputSettings(getInputSettings());
  const next = mutate(draft);
  saveInputSettings(next);
  return next;
}

export function subscribeInputSettings(fn: (settings: InputSettings) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * True if the localStorage key already exists — used by the firing range's
 * first-run flow to decide whether to show the "Want to calibrate?" prompt.
 */
export function hasStoredInputSettings(): boolean {
  return safeReadStorage() != null;
}

// Test-only / reset helper. Not exported from the module index; safe to call
// from tests or from a future "reset to defaults" button.
export function resetInputSettingsForTesting(): void {
  current = DEFAULT_INPUT_SETTINGS;
  loaded = false;
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

/**
 * React hook that subscribes a component to settings changes. Uses
 * `useSyncExternalStore` for concurrent-safe reads.
 */
export function useInputSettings(): InputSettings {
  return useSyncExternalStore(
    (onStoreChange) => subscribeInputSettings(onStoreChange),
    () => getInputSettings(),
    () => DEFAULT_INPUT_SETTINGS,
  );
}
