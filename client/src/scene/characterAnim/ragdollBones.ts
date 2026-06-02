// Ragdoll body configuration for Quaternius Universal Animation Library (UAL) rig.
// 13 box bodies, 12 impulse joints — mirroring vibe-city Ragdoll.tsx topology,
// plus a foot body per leg so the feet collide with the ground instead of the
// foot mesh poking through below the shin collider.
//
// Note: body/joint IDs pack the index into 4 bits, so keep both lists ≤ 16.

export const RAGDOLL_PARTS = [
  'pelvis',
  'torso',
  'head',
  'upperArmL',
  'lowerArmL',
  'upperArmR',
  'lowerArmR',
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR',
] as const;

export type RagdollPart = (typeof RAGDOLL_PARTS)[number];

/**
 * Per-part config (scale=1 half-extents).
 * `tipBone`: UAL bone name whose world position defines the body's +Y direction.
 *            'up' means world +Y (used when no natural next bone exists).
 * `hx/hy/hz`: box half-extents — hy is along the bone-to-tip (+Y) axis.
 */
export interface PartConfig {
  bone: string;
  tipBone: string | 'up';
  hx: number;
  hy: number;
  hz: number;
}

export const PART_CONFIG: Record<RagdollPart, PartConfig> = {
  pelvis:    { bone: 'pelvis',     tipBone: 'spine_01',  hx: 0.16,  hy: 0.11,  hz: 0.11 },
  torso:     { bone: 'spine_02',   tipBone: 'neck_01',   hx: 0.175, hy: 0.225, hz: 0.11 },
  head:      { bone: 'Head',       tipBone: 'up',        hx: 0.11,  hy: 0.11,  hz: 0.11 },
  upperArmL: { bone: 'upperarm_l', tipBone: 'lowerarm_l',hx: 0.07,  hy: 0.16,  hz: 0.07 },
  lowerArmL: { bone: 'lowerarm_l', tipBone: 'hand_l',    hx: 0.07,  hy: 0.14,  hz: 0.07 },
  upperArmR: { bone: 'upperarm_r', tipBone: 'lowerarm_r',hx: 0.07,  hy: 0.16,  hz: 0.07 },
  lowerArmR: { bone: 'lowerarm_r', tipBone: 'hand_r',    hx: 0.07,  hy: 0.14,  hz: 0.07 },
  thighL:    { bone: 'thigh_l',    tipBone: 'calf_l',    hx: 0.08,  hy: 0.21,  hz: 0.08 },
  shinL:     { bone: 'calf_l',     tipBone: 'foot_l',    hx: 0.08,  hy: 0.21,  hz: 0.08 },
  // Foot: +Y runs ankle(foot_l)→toe(ball_l); hz gives it a little sole thickness.
  footL:     { bone: 'foot_l',     tipBone: 'ball_l',    hx: 0.05,  hy: 0.10,  hz: 0.06 },
  thighR:    { bone: 'thigh_r',    tipBone: 'calf_r',    hx: 0.08,  hy: 0.21,  hz: 0.08 },
  shinR:     { bone: 'calf_r',     tipBone: 'foot_r',    hx: 0.08,  hy: 0.21,  hz: 0.08 },
  footR:     { bone: 'foot_r',     tipBone: 'ball_r',    hx: 0.05,  hy: 0.10,  hz: 0.06 },
};

// Part index in RAGDOLL_PARTS array — used for stable ID computation.
export const PART_INDEX: Record<RagdollPart, number> = Object.fromEntries(
  RAGDOLL_PARTS.map((p, i) => [p, i]),
) as Record<RagdollPart, number>;

// ── Joint definitions ────────────────────────────────────────────────────────
//
// Anchors are NOT specified here. At activation Ragdoll computes each joint's
// pivot from the real bone position (the b1 bone's world origin = the anatomical
// joint) and expresses it in both bodies' local frames, so the two anchors
// coincide exactly on whatever rig is loaded. This removes the hand-tuned
// shoulder/hip heuristics that didn't match real UAL proportions (and the
// on-death tug they caused).

export type SphericalJointDef = {
  type: 'spherical';
  b1: RagdollPart;
  b2: RagdollPart;
  // Cone/twist angular limits (radians), measured relative to the death pose.
  // `swing` is the cone half-angle off the b1 bone axis (lift/spread); `twist`
  // is the half-range of rotation about the b1 bone axis. These keep ball joints
  // (neck/shoulders/hips/spine) from rotating into anatomically impossible poses.
  swing: number;
  twist: number;
};

export type RevoluteJointDef = {
  type: 'revolute';
  b1: RagdollPart;
  b2: RagdollPart;
  // Hinge axis in the b1 body-local frame (Z = perpendicular to the limb plane).
  axis: [number, number, number];
  limits: [number, number]; // radians, relative to the death pose
};

export type JointDef = SphericalJointDef | RevoluteJointDef;

// The pivot for each joint is the b1 bone's world origin (the anatomical joint):
// torso→spine base, head→neck, upperArm→shoulder, lowerArm→elbow, thigh→hip,
// shin→knee.
export const JOINT_DEFS: JointDef[] = [
  // Spine: torso ↔ pelvis
  { type: 'spherical', b1: 'torso', b2: 'pelvis', swing: 0.6, twist: 0.5 },
  // Neck: head ↔ torso
  { type: 'spherical', b1: 'head', b2: 'torso', swing: 0.7, twist: 0.8 },
  // Shoulders: upperArm ↔ torso
  { type: 'spherical', b1: 'upperArmL', b2: 'torso', swing: 1.4, twist: 1.0 },
  { type: 'spherical', b1: 'upperArmR', b2: 'torso', swing: 1.4, twist: 1.0 },
  // Elbows (hinge about b1 body-local Z)
  { type: 'revolute', b1: 'lowerArmL', b2: 'upperArmL', axis: [0, 0, 1], limits: [-2.4, 0.1] },
  { type: 'revolute', b1: 'lowerArmR', b2: 'upperArmR', axis: [0, 0, 1], limits: [-2.4, 0.1] },
  // Hips: thigh ↔ pelvis
  { type: 'spherical', b1: 'thighL', b2: 'pelvis', swing: 1.1, twist: 0.5 },
  { type: 'spherical', b1: 'thighR', b2: 'pelvis', swing: 1.1, twist: 0.5 },
  // Knees (hinge about b1 body-local Z)
  { type: 'revolute', b1: 'shinL', b2: 'thighL', axis: [0, 0, 1], limits: [-2.6, 0.05] },
  { type: 'revolute', b1: 'shinR', b2: 'thighR', axis: [0, 0, 1], limits: [-2.6, 0.05] },
  // Ankles: foot ↔ shin (hinge about b1 body-local Z, modest range)
  { type: 'revolute', b1: 'footL', b2: 'shinL', axis: [0, 0, 1], limits: [-0.7, 0.7] },
  { type: 'revolute', b1: 'footR', b2: 'shinR', axis: [0, 0, 1], limits: [-0.7, 0.7] },
];
