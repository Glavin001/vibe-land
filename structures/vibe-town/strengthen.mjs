// Stronger bonds for a town-kit asset, for Vibe Town only. The kit tunes its
// trees and outdoor props for the playground's cannon (tree wood breaks at
// 8e4 Pa, outdoor seams at 0.1-0.001 of their material); in the city's native
// stress solve at 16 iterations they fall apart under their own weight
// (qualify_structures.py: trees 57-87% of bonds broken at rest, the bus shelter
// 40%, the market stall 17%). Scaling only the bonds' tension and shear limits
// keeps every chunk's mass, stiffness and compression support as authored.
// The smallest factor that stands (candidates.mjs --sweep) keeps them as easy
// to break as they can be.

const LIMITS = ['tensionElastic', 'tensionFatal', 'shearElastic', 'shearFatal'];

/** A copy of `asset` whose bond materials are `factor` times as strong. */
export function strengthen(asset, factor) {
  if (factor === 1) return asset;
  const pack = structuredClone(asset.pack);
  const table = pack.defaults.solver.materials;
  const stronger = new Map();
  for (const bond of pack.scenario.bonds) {
    if (!stronger.has(bond.m)) {
      const material = { ...table[bond.m], name: `${table[bond.m].name}-x${factor}` };
      for (const key of LIMITS) if (typeof material[key] === 'number') material[key] *= factor;
      stronger.set(bond.m, table.push(material) - 1);
    }
    bond.m = stronger.get(bond.m);
  }
  return { ...asset, pack };
}
