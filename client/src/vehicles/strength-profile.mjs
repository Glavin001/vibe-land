/**
 * Initial effective joint limits, in Pa, for the authored assembly.
 * These are tuning inputs, NOT a vehicle qualification result. Joint failure
 * depends on measured mating area and solver loads, never paint color or a
 * projectile-name switch. All joints can fail; there is no residual-area floor
 * to manufacture an intact wreck after a severe impact.
 */
const MPa = 1e6;
function profile(elastic, fatal, shearRatio, modulus) {
  return Object.freeze({
    compressionElastic: elastic * MPa, compressionFatal: fatal * MPa,
    tensionElastic: elastic * MPa, tensionFatal: fatal * MPa,
    shearElastic: elastic * shearRatio * MPa, shearFatal: fatal * shearRatio * MPa,
    elasticModulus: modulus * MPa, residualAreaFraction: 0,
  });
}
export const STRENGTH_PROFILE_VERSION = 'vehicle-joints-1';
export const jointMaterials = Object.freeze({
  steel: profile(120, 300, .58, 200000),
  alloy: profile(55, 140, .58, 69000),
  rubber: profile(2, 12, .7, 10),
  upholstery: profile(.08, .4, .6, 2),
  belt: profile(12, 60, .5, 3000),
  composite: profile(8, 35, .5, 4000),
  glazing: profile(3, 12, .6, 70000),
});
const categories = Object.freeze({ frame:'steel', orange:'steel', steel:'steel', dark:'steel',
  alloy:'alloy', rubber:'rubber', seat:'upholstery', belt:'belt', red:'composite',
  glass:'glazing', lens:'glazing', race:'composite' });

/** A dissimilar joint is limited by its weaker constituent in each mode. */
export function jointStrength(a, b) {
  const first=jointMaterials[categories[a]], second=jointMaterials[categories[b]];
  if (!first || !second) throw new Error(`Unknown structural material: ${a}/${b}`);
  return Object.fromEntries(Object.keys(first).map(key=>[key, Math.min(first[key], second[key])]));
}

export function structuralBonds(parts, contacts) {
  const byId=new Map(parts.map(part=>[part.id,part]));
  return contacts.filter(contact=>contact.validatedSurface && contact.area>0).map(contact=>{
    const a=byId.get(contact.a), b=byId.get(contact.b);
    if (!a || !b) throw new Error('Bond references an unknown part');
    if (!Number.isFinite(contact.area) || !contact.normal?.every(Number.isFinite)) throw new Error('Invalid measured bond surface');
    return {...contact, strength:jointStrength(a.material,b.material)};
  });
}

/** Fail preparation if discarding edge-only contacts leaves unattached parts. */
export function requireConnectedAssembly(parts, bonds) {
  if (!parts.length) throw new Error('Vehicle assembly has no parts');
  const parents=new Map(parts.map(part=>[part.id,part.id]));
  if (parents.size!==parts.length) throw new Error('Duplicate vehicle part identity');
  function root(id) {
    if (!parents.has(id)) throw new Error('Bond references an unknown part');
    let result=id;
    while (parents.get(result)!==result) result=parents.get(result);
    while (id!==result) {const next=parents.get(id);parents.set(id,result);id=next;}
    return result;
  }
  for (const bond of bonds) parents.set(root(bond.a),root(bond.b));
  const components=new Set(parts.map(part=>root(part.id))).size;
  if (components!==1) throw new Error(`Measured vehicle joints leave ${components} disconnected assemblies`);
}
