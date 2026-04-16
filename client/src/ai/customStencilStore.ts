import { useSyncExternalStore } from 'react';
import { validateCustomStencilDefinition, type CustomStencilDefinition } from './customStencil';

// ---------------------------------------------------------------------------
// Module-scoped store
// ---------------------------------------------------------------------------

const stencils = new Map<string, CustomStencilDefinition>();
const listeners = new Set<() => void>();
let snapshot: CustomStencilDefinition[] = [];

function notifyListeners(): void {
  snapshot = Array.from(stencils.values());
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
