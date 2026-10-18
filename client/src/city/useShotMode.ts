import { useSyncExternalStore } from 'react';

import { onShotModeChange, shotMode, type ShotMode } from './shotMode';

/** The current weapon, re-rendering on every switch (shotMode.ts). */
export function useShotMode(): ShotMode {
  return useSyncExternalStore(onShotModeChange, shotMode, shotMode);
}
