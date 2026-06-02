// Test-only helper: builds a synthetic UAL-style THREE.Bone skeleton with the
// exact bone names the ragdoll system looks up, laid out roughly anatomically so
// that body half-extents (from PART_CONFIG) line up with the bone lengths. Used by
// Ragdoll.test.ts (calibration round-trip) and ragdollPhysics.test.ts (stability).
import * as THREE from 'three';

export interface SyntheticSkeleton {
  root: THREE.Object3D;
  bones: Map<string, THREE.Bone>;
}

interface BoneSpec {
  name: string;
  pos: [number, number, number];
  children?: BoneSpec[];
}

// Upright A-pose-ish layout. Segment lengths chosen to match 2*hy in PART_CONFIG
// so the spawned boxes span their bones. Arms hang straight down.
const SKELETON: BoneSpec = {
  name: 'pelvis',
  pos: [0, 1.0, 0],
  children: [
    {
      name: 'spine_01',
      pos: [0, 0.1, 0],
      children: [
        {
          name: 'spine_02',
          pos: [0, 0.2, 0],
          children: [
            {
              name: 'neck_01',
              pos: [0, 0.45, 0],
              children: [{ name: 'Head', pos: [0, 0.12, 0] }],
            },
            {
              // UAL '_l' bodies anchor on the torso's -X side, so left limbs sit at -X.
              name: 'upperarm_l',
              pos: [-0.2, 0.4, 0],
              children: [
                {
                  name: 'lowerarm_l',
                  pos: [0, -0.32, 0],
                  children: [{ name: 'hand_l', pos: [0, -0.28, 0] }],
                },
              ],
            },
            {
              name: 'upperarm_r',
              pos: [0.2, 0.4, 0],
              children: [
                {
                  name: 'lowerarm_r',
                  pos: [0, -0.32, 0],
                  children: [{ name: 'hand_r', pos: [0, -0.28, 0] }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'thigh_l',
      pos: [-0.1, -0.05, 0],
      children: [
        {
          name: 'calf_l',
          pos: [0, -0.42, 0],
          children: [{ name: 'foot_l', pos: [0, -0.42, 0] }],
        },
      ],
    },
    {
      name: 'thigh_r',
      pos: [0.1, -0.05, 0],
      children: [
        {
          name: 'calf_r',
          pos: [0, -0.42, 0],
          children: [{ name: 'foot_r', pos: [0, -0.42, 0] }],
        },
      ],
    },
  ],
};

// Per-bone local rotations (Euler radians) to simulate a non-trivial "death pose".
// Only used when `pose` is requested; keeps the round-trip test honest (not identity).
const POSE: Record<string, [number, number, number]> = {
  pelvis: [0.15, 0.3, -0.1],
  spine_02: [-0.25, 0.1, 0.2],
  Head: [0.2, -0.3, 0.1],
  upperarm_l: [0.4, 0.0, 0.5],
  lowerarm_l: [-0.6, 0.2, 0.0],
  upperarm_r: [-0.3, 0.0, -0.4],
  lowerarm_r: [-0.5, -0.2, 0.0],
  thigh_l: [0.5, 0.0, 0.1],
  calf_l: [-0.7, 0.0, 0.0],
  thigh_r: [-0.2, 0.0, -0.1],
  calf_r: [-0.4, 0.0, 0.0],
};

export interface BuildOptions {
  /** Uniform scale applied to the root (mimics CharacterModel capsule scaling). */
  scale?: number;
  /** Apply non-trivial per-bone rotations to simulate a death pose. */
  pose?: boolean;
  /** World Y position of the root. */
  rootY?: number;
}

export function buildSyntheticSkeleton(opts: BuildOptions = {}): SyntheticSkeleton {
  const { scale = 1, pose = false, rootY = 0 } = opts;
  const bones = new Map<string, THREE.Bone>();

  const build = (spec: BoneSpec): THREE.Bone => {
    const bone = new THREE.Bone();
    bone.name = spec.name;
    bone.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    if (pose && POSE[spec.name]) {
      const [rx, ry, rz] = POSE[spec.name];
      bone.quaternion.setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
    }
    bones.set(spec.name, bone);
    for (const child of spec.children ?? []) {
      bone.add(build(child));
    }
    return bone;
  };

  const root = new THREE.Object3D();
  root.name = 'SyntheticCharacterRoot';
  root.position.y = rootY;
  root.scale.setScalar(scale);
  root.add(build(SKELETON));
  root.updateMatrixWorld(true);

  return { root, bones };
}
