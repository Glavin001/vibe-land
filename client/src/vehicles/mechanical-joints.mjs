import { physicalMotion, trailerRoles } from './dune/pose-deltas.mjs';
/** Physical attachment topology for authored moving parts. A collision contact
 * is not necessarily a structural joint: brake pads touch a rotating rotor,
 * and closely packed arms may touch a hub, without being welded to it.
 *
 * This selects measured interfaces only; it does not create bonds across gaps,
 * reduce their area, or change materials. Vehicle2 remains responsible for
 * wheel rotation/braking. Bearing compliance and moving graph frames are not
 * implemented by this classification.
 */
export function mechanicalJoints(parts, contacts) {
  const byId = new Map(parts.map(part => [part.id, part]));
  const joints = [], excluded = [];
  for (const contact of contacts) {
    const a = byId.get(contact.a), b = byId.get(contact.b);
    if (!a || !b) throw Error('Mechanical contact references an unknown part');
    const A = a.motion, B = b.motion;
    let attachment = 'fixed-contact', reason = null;
    if (A?.role === 'wheel' || B?.role === 'wheel') {
      const wheel = A?.role === 'wheel' ? A : B;
      const other = wheel === A ? B : A;
      if (!wheel.corner || wheel.corner !== other?.corner) {
        reason = 'wheel-contact-without-mount';
      } else if (other.role === 'wheel') {
        attachment = 'wheel-internal';
      } else if (other.role === 'hub' && other.component === 'hub') {
        attachment = 'wheel-mount';
      } else {
        reason = 'rotating-wheel-contact';
      }
    } else if (A?.role === 'hub' || B?.role === 'hub') {
      const hub = A?.role === 'hub' ? A : B;
      const other = hub === A ? B : A;
      if (!hub.corner || hub.corner !== other?.corner) {
        reason = 'hub-contact-without-mount';
      } else if (other.role === 'hub') {
        attachment = 'hub-internal';
      } else if (hub.component === 'hub' && other.role === 'upright') {
        attachment = 'wheel-bearing';
      } else if (hub.component === 'hub' && other.role === 'axle') {
        attachment = 'drive-spline';
      } else {
        reason = 'rotating-hub-contact';
      }
    } else if (A?.component === 'caliper' || B?.component === 'caliper') {
      const caliper = A?.component === 'caliper' ? A : B;
      const other = caliper === A ? B : A;
      if (caliper.corner && caliper.corner === other?.corner && other.role === 'upright') {
        attachment = 'caliper-mount';
      } else {
        reason = 'caliper-contact-without-mount';
      }
    }
    if (reason) excluded.push({...contact, reason});
    else joints.push({...contact, attachment});
  }
  return {joints, excluded};
}

/** Largest distance from a measured interface to the joint it may represent:
 * about the combined radii of the members meeting there (tubes, eyes, seats).
 */
export const JOINT_NEIGHBOURHOOD_M = .08;
const sub = (a, b) => a.map((x, i) => x - b[i]), add = (a, b) => a.map((x, i) => x + b[i]);
const scale = (a, s) => a.map(x => x * s), dot = (a, b) => a.reduce((n, x, i) => n + x * b[i], 0), length = a => Math.hypot(...a);
const point = p => c => p;
const line = (p, d) => c => { const u = scale(d, 1 / length(d)); return add(p, scale(u, dot(sub(c, p), u))); };
const chunkMotion = part => physicalMotion(part.motion?.role);
/** Kinematic joints between differently moving chunks, in the source frame.
 * Each anchor is a point (or line) both sides' physical motions keep
 * coincident; the rack end is prismatic and slides with steering.
 */
function jointAnchors(h, steering) {
  const top = h.shockTop, shock = sub(h.shockBottom, h.shockTop), seat = add(top, scale(shock, .68));
  return {
    'fixed+lowerArm': ['lower-arm-pivot', line(h.lowerPivot, [0, 0, 1])],
    'fixed+upperArm': ['upper-arm-pivot', line(h.upperPivot, [0, 0, 1])],
    'lowerArm+steer': ['lower-ball-joint', point(h.lower)],
    'steer+upperArm': ['upper-ball-joint', point(h.upper)],
    'lowerArm+piston': ['shock-eye', point(h.shockBottom)],
    'fixed+spring': ['shock-top-mount', point(top)],
    'piston+spring': ['spring-seat', point(seat)],
    'steer+tieRod': ['tie-rod-end', point(h.tieOuter)],
    'fixed+tieRod': ['steering-rack', point(h.tieInner)],
    'steer+wheel': ['wheel-bearing', line(h.hub, [1, 0, 0])],
    'axle+wheel': ['outer-cv', point(h.hub)],
    'axle+fixed': ['inner-cv', point(h.axleInner)],
    ...(steering && { 'fixed+steering': ['steering-column', line(steering.columnEnd, sub(steering.columnEnd, steering.columnStart))] }),
  };
}
/** Anchor chunk bonds at the rig's kinematic joints. A measured interface
 * between chunks that move relative to one another is kept only when it lies
 * at a joint; its load then acts at that joint, which both sides' motions
 * keep coincident. Other such contacts would be torn apart by suspension
 * travel alone and are excluded. Area, normal and strength stay measured.
 */
export function anchorRigJoints(parts, bonds, rig) {
  const byId = new Map(parts.map(p => [p.id, p]));
  const kept = [], excluded = [];
  for (const bond of bonds) {
    const a = byId.get(bond.a), b = byId.get(bond.b);
    if (!a || !b) throw Error('Rig joint references an unknown chunk');
    const ma = chunkMotion(a), mb = chunkMotion(b);
    if (ma === undefined || mb === undefined) throw Error(`No physical motion for ${a.name} or ${b.name}`);
    // Trailer articulation is unported and the semi is never fractured.
    if (trailerRoles.includes(ma) || trailerRoles.includes(mb)) { kept.push(bond); continue; }
    const corners = [a, b].map(p => p.motion?.corner).filter(Boolean);
    if (ma === mb && new Set(corners).size <= 1) { kept.push(bond); continue; }
    const corner = corners[0], anchors = corner && new Set(corners).size === 1 ? jointAnchors(rig.corners[corner], rig.steering)
      : ma === 'steering' || mb === 'steering' ? jointAnchors(Object.values(rig.corners)[0], rig.steering) : {};
    const joint = anchors[[ma, mb].sort().join('+')];
    const anchor = joint?.[1](bond.centroid), distance = anchor ? length(sub(anchor, bond.centroid)) : Infinity;
    if (distance <= JOINT_NEIGHBOURHOOD_M) kept.push({ ...bond, joint: joint[0], measuredCentroid: bond.centroid, centroid: anchor });
    else excluded.push({ a: bond.visualA ?? bond.a, b: bond.visualB ?? bond.b, reason: joint ? 'contact-away-from-joint' : 'relative-motion-contact' });
  }
  return { bonds: kept, excluded };
}
