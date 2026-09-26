import * as T from 'three';
import { VisualRig } from './visual-rig.mjs';
import { cornerIds, neutralPose } from './vehicle-rig.mjs';
/** Physical motion of each authored suspension role, as the source-frame map
 * from the neutral solid to the posed solid. Visual beams stretch a unit tube
 * between moving hardpoints; that is only equivalent for an axisymmetric
 * render. Destruction needs the real rigid motion of a chunk (and its bonds),
 * so arms rotate about their pivot lines, the upright and caliper follow the
 * steered knuckle, and only the coil spring and plunging drive shaft deform
 * (mass-preserving, axial).
 * Every map depends only on (role, corner), so visual parts sharing a chunk
 * move as one body. The server port must reproduce these maps exactly.
 */
export const roleMotion = { lowerArm: 'lowerArm', shockEye: 'lowerArm', upperArm: 'upperArm',
  upright: 'steer', knuckle: 'steer', hub: 'wheel', wheel: 'wheel', damper: 'damper', topSeat: 'damper',
  piston: 'piston', bottomSeat: 'piston', spring: 'spring', tieRod: 'tieRod', axle: 'axle',
  // Rubber bellows ribs grip the plunging shaft along its length, so they telescope with it.
  cvBoot: 'axle' };
/** Motion name for a role; articulated trailer roles keep their own names.
 * Their kinematics are not ported: the semi is excluded from native fracture. */
export const trailerRoles = ['trailer', 'trailerWheel'];
export const physicalMotion = role => !role ? 'fixed' : role === 'steering' || trailerRoles.includes(role) ? role : roleMotion[role];
export const deformingMotions = ['spring', 'axle'];
export const motionNames = ['lowerArm', 'upperArm', 'steer', 'wheel', 'damper', 'piston', 'spring', 'tieRod', 'axle'];
const Z = new T.Vector3(0, 0, 1);
const v = a => new T.Vector3(...a);
const about = (point, rotation) => new T.Matrix4().makeTranslation(point.x, point.y, point.z)
  .multiply(new T.Matrix4().makeRotationFromQuaternion(rotation)).multiply(new T.Matrix4().makeTranslation(-point.x, -point.y, -point.z));
// Carry `from` to `to` while turning direction a onto b by the minimal rotation.
const carry = (from, to, a, b) => new T.Matrix4().makeTranslation(to.x, to.y, to.z)
  .multiply(new T.Matrix4().makeRotationFromQuaternion(new T.Quaternion().setFromUnitVectors(a, b))).multiply(new T.Matrix4().makeTranslation(-from.x, -from.y, -from.z));
// Scale by k along unit direction d about point p (a telescoping or coil part).
const axialScale = (p, d, k) => new T.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(new T.Matrix4().set(
  1 + (k - 1) * d.x * d.x, (k - 1) * d.x * d.y, (k - 1) * d.x * d.z, 0,
  (k - 1) * d.y * d.x, 1 + (k - 1) * d.y * d.y, (k - 1) * d.y * d.z, 0,
  (k - 1) * d.z * d.x, (k - 1) * d.z * d.y, 1 + (k - 1) * d.z * d.z, 0, 0, 0, 0, 1)).multiply(new T.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
const planarAngle = (p, pivot, side) => Math.atan2(p[1] - pivot[1], side * (p[0] - pivot[0]));

export class PoseDeltas {
  constructor(parameters) {
    this.rig = new VisualRig({ parameters, parts: [] });
    this.neutral = new VisualRig({ parameters, parts: [] });
    this.definition = this.rig.definition;
    this.corners = {}; this.steering = new T.Matrix4();
    this.applyPose(neutralPose());
  }
  applyPose(pose) {
    this.rig.applyPose(pose);
    for (const id of cornerIds) {
      const s = this.rig.states[id], n = this.neutral.states[id], h = s.h, side = h.side;
      const lower = about(v(h.lowerPivot), new T.Quaternion().setFromAxisAngle(Z, side * (s.k.angle - h.neutralAngle)));
      const upperTurn = side * (planarAngle(s.k.upper, h.upperPivot, side) - planarAngle(h.upper, h.upperPivot, side));
      const upper = about(v(h.upperPivot), new T.Quaternion().setFromAxisAngle(Z, upperTurn));
      const steer = s.steer.clone().multiply(n.steer.clone().invert());
      const wheel = s.wheel.clone().multiply(n.wheel.clone().invert());
      const damper = carry(n.top, s.top, n.shockDir, s.shockDir);
      const piston = carry(n.bottom, s.bottom, n.shockDir, s.shockDir);
      // Coil: axial compression about the fixed top mount, then the damper turn.
      const spring = damper.clone().multiply(axialScale(n.top, n.shockDir, s.coilLength / n.coilLength));
      const rodDir = x => x.tieOuter.clone().sub(x.tieInner).normalize();
      const tieRod = carry(n.tieInner, s.tieInner, rodDir(n), rodDir(s));
      // The plunging CV shaft telescopes (mass-preserving) between its inner
      // joint and the hub, turning with the wheel. A rigid shaft misses the
      // steered hub by up to 18 cm on these geometries.
      const inner = v(h.axleInner), axleDir0 = n.hub.clone().sub(inner).normalize();
      const axle = carry(inner, inner, axleDir0, s.hub.clone().sub(inner).normalize())
        .multiply(axialScale(inner, axleDir0, s.hub.distanceTo(inner) / n.hub.distanceTo(inner)))
        .multiply(about(inner, new T.Quaternion().setFromAxisAngle(axleDir0, s.rotation * side)));
      this.corners[id] = { lowerArm: lower, upperArm: upper, steer, wheel, damper, piston, spring, tieRod, axle };
    }
    this.steering.copy(this.rig.steeringDelta).multiply(this.neutral.steeringDelta.clone().invert());
    return this;
  }
  /** Source-frame map for an authored binding, or identity for fixed parts. */
  delta(motion) {
    if (!motion?.role) return new T.Matrix4();
    if (motion.role === 'steering') return this.steering.clone();
    const name = roleMotion[motion.role];
    if (!name || !this.corners[motion.corner]) throw Error(`No physical motion for ${motion.role}/${motion.corner}`);
    return this.corners[motion.corner][name].clone();
  }
}
/** Vehicle2 wheel order and spin sign, as streamed [travel, steer, rotation]. */
export function poseFromVehicle2(wheels, sourceCornerForWheel) {
  const pose = neutralPose();
  sourceCornerForWheel.forEach((id, i) => Object.assign(pose.wheels[id], { ...wheels[i], rotationRad: -wheels[i].rotationRad }));
  return pose;
}
/** A collision chunk's hulls move with its own binding. Its visual solids may
 * only differ where they physically share the hull's motion at both ends:
 * the coil-over group carries its damper body and seats inside the coil.
 */
export function requireChunkMotion(chunk, visualMotions) {
  const own = physicalMotion(chunk.motion?.role);
  if (!own) throw Error(`${chunk.name}: no physical motion for role ${chunk.motion.role}`);
  for (const m of visualMotions) {
    const name = physicalMotion(m?.role);
    const coilOver = own === 'spring' && ['damper', 'piston'].includes(name);
    if (name !== own && !coilOver) throw Error(`${chunk.name}: visual ${m?.role ?? 'fixed'} part cannot move with ${own} chunk`);
    if (m?.corner && m.corner !== chunk.motion?.corner) throw Error(`${chunk.name}: visual part belongs to corner ${m.corner}`);
  }
}
