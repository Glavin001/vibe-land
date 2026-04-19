// Ragdoll body configuration for Quaternius Universal Animation Library (UAL) rig.
// 11 box bodies, 10 impulse joints — mirroring vibe-city Ragdoll.tsx topology.

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
  'thighR',
  'shinR',
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
  thighR:    { bone: 'thigh_r',    tipBone: 'calf_r',    hx: 0.08,  hy: 0.21,  hz: 0.08 },
  shinR:     { bone: 'calf_r',     tipBone: 'foot_r',    hx: 0.08,  hy: 0.21,  hz: 0.08 },
};

// Part index in RAGDOLL_PARTS array — used for stable ID computation.
export const PART_INDEX: Record<RagdollPart, number> = Object.fromEntries(
  RAGDOLL_PARTS.map((p, i) => [p, i]),
) as Record<RagdollPart, number>;

// ── Joint definitions ────────────────────────────────────────────────────────

const C = 0.025; // joint clearance (metres, at scale=1)

export type SphericalJointDef = {
  type: 'spherical';
  b1: RagdollPart;
  b2: RagdollPart;
  // Anchors in body-local frame where +Y = bone→tip.
  // Positive Y = toward tip, negative Y = toward bone origin.
  a1: [number, number, number]; // on b1
  a2: [number, number, number]; // on b2
};

export type RevoluteJointDef = {
  type: 'revolute';
  b1: RagdollPart;
  b2: RagdollPart;
  a1: [number, number, number];
  a2: [number, number, number];
  // Rotation axis in world-aligned body-local frame (Z = perpendicular to limb plane).
  axis: [number, number, number];
  limits: [number, number]; // radians
};

export type JointDef = SphericalJointDef | RevoluteJointDef;

// Each anchor uses the body's hy at scale=1; caller must multiply by scale.
// Convention: +Y = toward distal (tip) end of the limb.
export const JOINT_DEFS: JointDef[] = [
  // Spine: torso bottom ↔ pelvis top
  {
    type: 'spherical',
    b1: 'torso', b2: 'pelvis',
    a1: [0, -(PART_CONFIG.torso.hy + C),  0],
    a2: [0,  (PART_CONFIG.pelvis.hy + C), 0],
  },
  // Neck: head bottom ↔ torso top
  {
    type: 'spherical',
    b1: 'head', b2: 'torso',
    a1: [0, -(PART_CONFIG.head.hy + C),  0],
    a2: [0,  (PART_CONFIG.torso.hy + C), 0],
  },
  // Left shoulder: upperArmL proximal ↔ torso left side
  {
    type: 'spherical',
    b1: 'upperArmL', b2: 'torso',
    a1: [0, (PART_CONFIG.upperArmL.hy + C), 0],
    a2: [-(PART_CONFIG.torso.hx + C), PART_CONFIG.torso.hy * 0.6, 0],
  },
  // Right shoulder: upperArmR proximal ↔ torso right side
  {
    type: 'spherical',
    b1: 'upperArmR', b2: 'torso',
    a1: [0, (PART_CONFIG.upperArmR.hy + C), 0],
    a2: [(PART_CONFIG.torso.hx + C), PART_CONFIG.torso.hy * 0.6, 0],
  },
  // Left elbow (revolute Z)
  {
    type: 'revolute',
    b1: 'lowerArmL', b2: 'upperArmL',
    a1: [0, (PART_CONFIG.lowerArmL.hy + C), 0],
    a2: [0, -(PART_CONFIG.upperArmL.hy + C), 0],
    axis: [0, 0, 1],
    limits: [-2.4, 0.1],
  },
  // Right elbow (revolute Z)
  {
    type: 'revolute',
    b1: 'lowerArmR', b2: 'upperArmR',
    a1: [0, (PART_CONFIG.lowerArmR.hy + C), 0],
    a2: [0, -(PART_CONFIG.upperArmR.hy + C), 0],
    axis: [0, 0, 1],
    limits: [-2.4, 0.1],
  },
  // Left hip: thighL proximal ↔ pelvis left-bottom
  {
    type: 'spherical',
    b1: 'thighL', b2: 'pelvis',
    a1: [0, -(PART_CONFIG.thighL.hy + C), 0],
    a2: [-(PART_CONFIG.pelvis.hx * 0.5), -(PART_CONFIG.pelvis.hy + C), 0],
  },
  // Right hip: thighR proximal ↔ pelvis right-bottom
  {
    type: 'spherical',
    b1: 'thighR', b2: 'pelvis',
    a1: [0, -(PART_CONFIG.thighR.hy + C), 0],
    a2: [(PART_CONFIG.pelvis.hx * 0.5), -(PART_CONFIG.pelvis.hy + C), 0],
  },
  // Left knee (revolute Z)
  {
    type: 'revolute',
    b1: 'shinL', b2: 'thighL',
    a1: [0, -(PART_CONFIG.shinL.hy + C), 0],
    a2: [0,  (PART_CONFIG.thighL.hy + C), 0],
    axis: [0, 0, 1],
    limits: [-2.6, 0.05],
  },
  // Right knee (revolute Z)
  {
    type: 'revolute',
    b1: 'shinR', b2: 'thighR',
    a1: [0, -(PART_CONFIG.shinR.hy + C), 0],
    a2: [0,  (PART_CONFIG.thighR.hy + C), 0],
    axis: [0, 0, 1],
    limits: [-2.6, 0.05],
  },
];
