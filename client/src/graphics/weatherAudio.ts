// Stub hook for weather ambience audio. Currently a no-op — the wiring site
// exists so the future wind-loop asset can be dropped in without also
// re-plumbing `App.tsx` → `GameScene` → `GameWorld`. When the asset lands,
// replace the body with an `HTMLAudioElement` (or Web Audio graph) that
// crossfades between preset-specific loops and scales gain by wind strength.

import { useEffect } from 'react';
import type { WeatherPreset } from './weatherPresets';

export function useWeatherAmbience(
  _weather: WeatherPreset,
  _windStrengthMps: number,
): void {
  useEffect(() => {
    // no-op: insertion point for future ambient audio loop
  }, [_weather, _windStrengthMps]);
}
