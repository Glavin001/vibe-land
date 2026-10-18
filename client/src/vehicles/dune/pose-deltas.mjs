import * as T from 'three';
import { VisualRig } from './visual-rig.mjs';
import { cornerIds, neutralPose } from './vehicle-rig.mjs';
/** Physical motion of each authored suspension role, as the source-frame map
 * from the neutral solid to the posed solid. Visual beams stretch a unit tube
 * between moving hardpoints; that is only equivalent for an axisymmetric
 * render. Chunks are rigid, so each map is the real rigid motion of its
 * chunk: arms rotate about their pivot lines, the upright and caliper follow
 * the steered knuckle, the coil-over rides with its damper about the top
 * mount, and the drive shaft turns about its inner joint (CV plunge is not
 * modelled).
 * Every map depends only on (role, corner), so visual parts sharing a chunk
 * move as one body. The server port must reproduce these maps exactly.
 */
export const roleMotion = { lowerArm: 'lowerArm', shockEye: 'lowerArm', upperArm: 'upperArm',
  upright: 'steer', knuckle: 'steer', hub: 'wheel', wheel: 'wheel', damper: 'damper', topSeat: 'damper',
  piston: 'piston', bottomSeat: 'piston', spring: 'damper', tieRod: 'tieRod', axle: 'axle',
  // Rubber bellows ribs grip the shaft along its length.
  cvBoot: 'axle' };
/** Motion name for a role; articulated trailer roles keep their own names.
 * Their kinematics are not ported: the semi is excluded from native fracture. */
export const trailerRoles = ['trailer', 'trailerWheel'];
export const physicalMotion = role => !role ? 'fixed' : role === 'steering' || trailerRoles.includes(role) ? role : roleMotion[role];
export const motionNames = ['lowerArm', 'upperArm', 'steer', 'wheel', 'damper', 'piston', 'tieRod', 'axle'];
const Z = new T.Vector3(0, 0, 1);
const v = a => new T.Vector3(...a);
const about = (point, rotation) => new T.Matrix4().makeTranslation(point.x, point.y, point.z)
  .multiply(new T.Matrix4().makeRotationFromQuaternion(rotation)).multiply(new T.Matrix4().makeTranslation(-point.x, -point.y, -point.z));
// Carry `from` to `to` while turning direction a onto b by the minimal rotation.
const carry = (from, to, a, b) => new T.Matrix4().makeTranslation(to.x, to.y, to.z)
  .multiply(new T.Matrix4().makeRotationFromQuaternion(new T.Quaternion().setFromUnitVectors(a, b))).multiply(new T.Matrix4().makeTranslation(-from.x, -from.y, -from.z));
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
      const rodDir = x => x.tieOuter.clone().sub(x.tieInner).normalize();
      const tieRod = carry(n.tieInner, s.tieInner, rodDir(n), rodDir(s));
      // The shaft aims at the hub from its inner joint and turns with the wheel.
      const inner = v(h.axleInner), axleDir0 = n.hub.clone().sub(inner).normalize();
      const axle = carry(inner, inner, axleDir0, s.hub.clone().sub(inner).normalize())
        .multiply(about(inner, new T.Quaternion().setFromAxisAngle(axleDir0, s.rotation * side)));
      this.corners[id] = { lowerArm: lower, upperArm: upper, steer, wheel, damper, piston, tieRod, axle };
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
 * the coil-over group carries its piston-side spring seat inside the coil.
 */
export function requireChunkMotion(chunk, visualMotions) {
  const own = physicalMotion(chunk.motion?.role);
  if (!own) throw Error(`${chunk.name}: no physical motion for role ${chunk.motion.role}`);
  for (const m of visualMotions) {
    const name = physicalMotion(m?.role);
    const coilOver = chunk.motion?.role === 'spring' && name === 'piston';
    if (name !== own && !coilOver) throw Error(`${chunk.name}: visual ${m?.role ?? 'fixed'} part cannot move with ${own} chunk`);
    if (m?.corner && m.corner !== chunk.motion?.corner) throw Error(`${chunk.name}: visual part belongs to corner ${m.corner}`);
  }
}
