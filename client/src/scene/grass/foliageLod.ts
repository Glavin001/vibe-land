import type { GrassQuality } from './grassPlacement';
/** Common to both representations. Distance changes detail, never canopy height. */
export const FOLIAGE_HANDOFF = { fast: [12, 22], pretty: [22, 36] } as const;
/** Full-density close detail; merge overlapping narrow blades into wider ribbons
 * through the middle distance. Broad-leaf crops keep every plant. Far canopy
 * coverage is independent of this density and still has no distance cutoff.
 */
export const GRASS_CANOPY_DENSITY = { near: 8, far: 24, minimum: 0.4 } as const;
export function grassCanopyDensity(distance: number): number {
  const { near, far, minimum } = GRASS_CANOPY_DENSITY;
  const t = Math.max(0, Math.min(1, (distance-near)/(far-near)));
  return 1-(1-minimum)*t*t*(3-2*t);
}
export function foliageHandoff(distance: number, quality: GrassQuality): number {
  const [start,end] = FOLIAGE_HANDOFF[quality];
  const t = Math.max(0,Math.min(1,(distance-start)/(end-start)));
  return t*t*(3-2*t);
}
export function hasFoliageCanopy(species: number, height: number): boolean {
  return species > 0 || height >= 0.75;
}
