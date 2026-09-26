/** Group already audited hulls without changing their world geometry. Vehicle2
 * owns one functional tire/rim chunk per corner. The rotating hub and rotor
 * form a separate chunk so the rim can break away at its measured mount.
 * Axles, uprights, calipers and suspension stay independent.
 * This is also the browser's exploded-view grouping, not a second server recipe.
 */
export function vehicleFractureGroups(collision) {
  const groups = new Map(), owner = new Map();
  for (const part of collision.parts) {
    const role = part.motion?.role;
    const grouped = role === 'wheel' || role === 'hub';
    if (grouped && !part.motion.corner) throw Error('Rotating collider has no corner');
    const key = grouped ? `${role}:${part.motion.corner}` : part.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
  }
  const parts = [...groups.values()].map(members => {
    // Retain the tire's identity and origin, including its open-center compound.
    // Group hub/rotor independently, retaining their own hulls and placement.
    const root = members.find(p => p.name.endsWith('wheel assembly')) ?? members[0];
    for (const member of members) owner.set(member.id, root.id);
    const functions = [...new Set(members.map(p => p.functionality).filter(Boolean))];
    if (functions.length > 1) throw Error('Incompatible functional collider groups');
    return {...root, functionality: functions[0] ?? null,
      sourcePartIds: members.flatMap(p => p.sourcePartIds ?? [p.id]),
      visualIds: members.flatMap(p => p.visualIds ?? [p.id]),
      shapes: members.flatMap(p => p.shapes.map(shape => ({...shape,
        position: shape.position.map((v, i) => v + p.position[i] - root.position[i]),
      }))),
      volumeM3: members.reduce((n, p) => n + p.volumeM3, 0),
      massKg: members.reduce((n, p) => n + p.massKg, 0),
      bounds: {min: [0,1,2].map(i => Math.min(...members.map(p => p.bounds.min[i]))),
        max: [0,1,2].map(i => Math.max(...members.map(p => p.bounds.max[i])))},
    };
  });
  const chassis = parts.filter(p => p.functionality === 'chassis');
  if (chassis.length !== 1 || chassis[0].motion) throw Error('Expected one fixed chassis anchor');
  if (!parts.some(p => p.functionality === 'engine')) throw Error('Missing engine collider');
  // Native fracture retains chunk zero on the controller's original actor.
  // Pick the authored central chassis anchor, never a wheel or the heavy engine.
  parts.splice(parts.indexOf(chassis[0]), 1);
  parts.unshift(chassis[0]);
  const remap = bonds => bonds.flatMap(bond => {
    const a = owner.get(bond.a), b = owner.get(bond.b);
    if (!a || !b) throw Error('Unknown collider bond endpoint');
    return a === b ? [] : [{...bond, a, b}];
  });
  const bonds = remap(collision.bonds);
  return {...collision, parts, bonds, report: {...collision.report,
    ungroupedParts: collision.report.parts, parts: parts.length, bonds: bonds.length,
    // The audit covers the same shapes in the same positions before grouping.
    functionalGrouping: 'separate-wheel-and-hub-per-corner',
  }};
}

/** A simplified proxy must never turn a stationary carrier into wheel debris.
 * Check original visual motion roles after partitioning/aliasing, where an
 * entirely covered caliper or upright could otherwise disappear into a tire. */
export function validateWheelOwnership(parts, visuals) {
  const byId=new Map(visuals.map(part=>[part.id,part]));
  for(const wheel of parts.filter(part=>['wheel','hub'].includes(part.motion?.role))) {
    for(const id of wheel.visualIds??[wheel.id]) {
      const visual=byId.get(id);
      if(!visual || visual.motion?.role!==wheel.motion.role || visual.motion.corner!==wheel.motion.corner)
        throw Error(`Wheel collision group contains an incompatible part: ${visual?.name??id}`);
    }
  }
}
