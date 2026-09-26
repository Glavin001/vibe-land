/** Group already audited hulls without changing their world geometry. Vehicle2
 * owns one functional wheel per corner: the tire, rim and rotating hub form one
 * fracture chunk. Axles, uprights, calipers and suspension stay independent.
 * This is also the browser's exploded-view grouping, not a second server recipe.
 */
export function vehicleFractureGroups(collision) {
  const groups = new Map(), owner = new Map();
  for (const part of collision.parts) {
    const key = part.motion?.role === 'wheel' ? `wheel:${part.motion.corner}` : part.id;
    if (key === 'wheel:undefined') throw Error('Wheel collider has no corner');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
  }
  const parts = [...groups.values()].map(members => {
    // Retain the tire's identity and origin. Never expand the cylinder to swallow
    // the hub: retain every clipped hull and its exact placement instead.
    const root = members.find(p => p.source === 'cylinder' && p.name.endsWith('wheel assembly')) ?? members[0];
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
    functionalGrouping: 'one-wheel-per-corner',
  }};
}
