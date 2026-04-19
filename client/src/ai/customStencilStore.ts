import { useSyncExternalStore } from 'react';
import { validateCustomStencilDefinition, type CustomStencilDefinition } from './customStencil';

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'vibe-land:godmode-custom-stencils:v1';

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function loadPersistedStencils(): CustomStencilDefinition[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const valid: CustomStencilDefinition[] = [];
    for (const entry of parsed) {
      if (validateCustomStencilDefinition(entry) === null) {
        valid.push(entry as CustomStencilDefinition);
      }
    }
    return valid;
  } catch {
    return [];
  }
}

function persistStencils(values: CustomStencilDefinition[]): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Ignore quota / privacy errors — stencils just won't persist this session.
  }
}

// ---------------------------------------------------------------------------
// Module-scoped store
// ---------------------------------------------------------------------------

const stencils = new Map<string, CustomStencilDefinition>();
for (const def of loadPersistedStencils()) {
  stencils.set(def.id, def);
}
const listeners = new Set<() => void>();
let snapshot: CustomStencilDefinition[] = Array.from(stencils.values());

function notifyListeners(): void {
  snapshot = Array.from(stencils.values());
  persistStencils(snapshot);
  for (const listener of listeners) {
    listener();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerStencil(definition: CustomStencilDefinition): { registered: boolean; error?: string } {
  const error = validateCustomStencilDefinition(definition);
  if (error) return { registered: false, error };

  stencils.set(definition.id, definition);
  notifyListeners();
  return { registered: true };
}

export function unregisterStencil(id: string): boolean {
  const existed = stencils.delete(id);
  if (existed) notifyListeners();
  return existed;
}

export function getStencil(id: string): CustomStencilDefinition | undefined {
  return stencils.get(id);
}

export function getAllStencils(): CustomStencilDefinition[] {
  return snapshot;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

function getSnapshot(): CustomStencilDefinition[] {
  return snapshot;
}

export function useCustomStencils(): CustomStencilDefinition[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
