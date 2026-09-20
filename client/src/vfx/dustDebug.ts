// Sources injected from outside the wire -- the e2e bridge's dustBurst --
// drained by the dust layer exactly as the city client's are, so a debug
// burst goes through the same policy, the same store and the same fluid
// placement as a real fracture.

import type { DustSource } from '../city/destructionEvents';

const pending: DustSource[] = [];

export function pushDebugDustSource(source: DustSource): void {
  if (pending.length < 256) pending.push({ ...source });
}

export function drainDebugDustSources(visit: (source: DustSource) => void): number {
  const n = pending.length;
  for (const source of pending) visit(source);
  pending.length = 0;
  return n;
}
