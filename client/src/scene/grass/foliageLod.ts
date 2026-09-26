import type { GrassQuality } from './grassPlacement';
/** Common to both representations. Distance changes detail, never canopy height. */
export const FOLIAGE_HANDOFF = { fast: [12, 22], pretty: [22, 36] } as const;
export function foliageHandoff(distance: number, quality: GrassQuality): number {
  const [start,end] = FOLIAGE_HANDOFF[quality];
  const t = Math.max(0,Math.min(1,(distance-start)/(end-start)));
  return t*t*(3-2*t);
}
export function hasFoliageCanopy(species: number, height: number): boolean {
  return species > 0 || height >= 0.75;
}
