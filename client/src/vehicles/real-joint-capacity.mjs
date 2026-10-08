/**
 * Real joint capacities for the vehicles (VIBE_REAL_VEHICLE_JOINTS=1, opt-in;
 * docs/verification/SCENARIOS.md, "Recalibrations").
 *
 * The joint profile (strength-profile.mjs) gives each joint an effective stress
 * (parent metal x joint efficiency, reality.mjs jointReferences) and the stage
 * multiplies it by the bond's measured contact area. For two members that
 * merely touch over a face -- a roof panel lying on its cage, a fascia on its
 * grille -- that area is the face, up to 0.24 m2, and the joint reads as 70 MN:
 * 1,400 times the truck's weight and ~100-1000 times what the welds or bolts
 * that really hold it can carry (spot welds 4-10 kN each, AWS D8.9M / ISO 14273
 * tensile-shear; M10 8.8 bolts 46 kN, EN 1993-1-8 Table 3.4). The vehicle then
 * cannot lose a panel, while its wheels -- whose lug studs are modelled at
 * their real section (ISO 898-1) -- are the weakest joints it has.
 *
 * A joint can never carry more than the members it joins: a weld or a bolt
 * group fails no later than the parent metal beside it (EN 1993-1-8 4.5.2,
 * 4.7: a full-strength weld develops the connected part's resistance; 3.6.1:
 * net-section rupture of the connected part). So each joint's capacity is
 * bounded by the smaller of its two members' cross-sections at the joint's
 * stress: section = the member's material volume over its length (a tube's
 * annulus, a panel's thickness x width), its volume from its (budgeted) mass
 * and its material's density. Stiffness keeps the measured area (geometry).
 * A wheel's mount keeps its counted studs.
 */
// Opt-in on its own, not yet part of the high profile's VIBE_REAL_CAPACITIES:
// under it the monster truck broke its rear corner while coasting on a flat
// street (vehicle lab `coast`, 2026-10-08: upright-wishbone utilisation 0.28
// to past 1 within 5 ticks at steady 10-14 kN wheel loads). The stage's loads
// on the corner spike several-fold with nothing hitting it, and vehicle joints
// cannot be ductile yet (StressMaterialDesc carries no ductileSlip), so at real
// capacities a brittle cascade follows. Both are routed to the stage owners
// (docs/verification/SCENARIOS.md, "Engine or authoring").
export const realJointCapacitiesEnabled = () => (globalThis.process?.env?.VIBE_REAL_VEHICLE_JOINTS ?? '0') === '1';
export const REAL_JOINT_CAPACITY_VERSION = 'section-bound-1';

/** Density of each structural category's material (kg/m3). */
export const DENSITY = Object.freeze({
  frame: 7850, orange: 7850, steel: 7850, dark: 7850,         // steel (EN 10025: 7850)
  alloy: 2700,                                               // aluminium alloys (EN 573: 2650-2800)
  rubber: 1150,                                              // vulcanised rubber 1100-1200
  seat: 1800, red: 1800, race: 1800, housing: 1800,          // glass-fibre composite (FRP 1500-2000)
  belt: 1380,                                                // polyester webbing
  glass: 2500, lens: 1200,                                   // soda-lime glass; polycarbonate lens
});

/** Mean cross-section (m2) of a part: its material volume over its longest extent. */
export function memberSection(part) {
  const rho = DENSITY[part.material];
  if (!rho || !(part.mass > 0)) return Infinity;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const shape of part.shapes ?? []) for (const v of shape.vertices ?? []) for (let k = 0; k < 3; k += 1) {
    const x = (part.position?.[k] ?? 0) + (shape.position?.[k] ?? 0) + v[k];
    lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x);
  }
  const length = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return length > 0 && Number.isFinite(length) ? part.mass / rho / length : Infinity;
}

const LIMITS = ['compressionElastic', 'compressionFatal', 'tensionElastic', 'tensionFatal', 'shearElastic', 'shearFatal'];

/**
 * Bound each bond's capacity by its members' sections: where the smaller
 * section is under the bond's area, its stress limits scale by section / area
 * (so limit x area = joint stress x section). Returns the bonds changed.
 */
export function applySectionBound(parts, bonds) {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const section = new Map(parts.map((p) => [p.id, memberSection(p)]));
  const changed = [];
  for (const bond of bonds) {
    if (bond.attachment === 'wheel-mount') continue;
    if (!byId.has(bond.a) || !byId.has(bond.b)) continue;
    const limit = Math.min(section.get(bond.a), section.get(bond.b));
    if (!(limit < bond.area)) continue;
    const scale = limit / bond.area;
    bond.strength = { ...bond.strength, ...Object.fromEntries(LIMITS.map((k) => [k, bond.strength[k] * scale])) };
    bond.realCapacity = { version: REAL_JOINT_CAPACITY_VERSION, sectionM2: limit, scale };
    changed.push(bond);
  }
  return changed;
}
