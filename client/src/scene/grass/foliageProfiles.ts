/** Stable IDs are part of the published layout format. Append; never reorder. */
export const FOLIAGE_SPECIES = ['grass', 'reed', 'wheat', 'corn', 'fern'] as const;
export type FoliageSpecies = typeof FOLIAGE_SPECIES[number];
export const FOLIAGE_PROFILES = {
  grass: { label: 'Grass', density: 150, width: 1, stiffness: 0.3 },
  reed: { label: 'Reeds', density: 28, width: 1.5, stiffness: 0.7 },
  wheat: { label: 'Wheat', density: 55, width: 0.7, stiffness: 0.55 },
  corn: { label: 'Corn', density: 3, width: 5, stiffness: 0.8 },
  fern: { label: 'Ferns', density: 5, width: 2.5, stiffness: 0.4 },
} as const;
export const foliageSpeciesId = (species: FoliageSpecies = 'grass'): number => Math.max(0, FOLIAGE_SPECIES.indexOf(species));
