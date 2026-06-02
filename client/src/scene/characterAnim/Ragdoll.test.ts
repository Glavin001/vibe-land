// Pure-TS (no WASM) verification of the animated → ragdoll conversion.
//
// These tests pin down the two correctness properties the death transition needs:
//   1. The snapshot/reconstruct round-trip is *pixel precise* — when physics has
//      not moved the bodies, Ragdoll.update() must reproduce the exact death pose.
//      (Guards the scaled-matrix calibration bug: setFromRotationMatrix on a scaled
//      bone matrix yields a non-unit quaternion and warps the pose.)
//   2. Every joint's two anchors coincide in world space at activation, i.e. the
//      bodies are wired together at the right ends. (Guards the flipped arm anchors
//      that folded the arms inside-out.)
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Ragdoll } from './Ragdoll';
import { RAGDOLL_PARTS, PART_CONFIG, JOINT_DEFS, PART_INDEX } from './ragdollBones';
import type { CharacterModel } from './CharacterModel';
import type { GameRuntimeClient } from '../../runtime/gameRuntime';
import { buildSyntheticSkeleton } from './ragdollTestSkeleton';

interface SpawnedBody {
  half: THREE.Vector3;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}
interface SpawnedJoint {
  b1: number;
  b2: number;
  a1: THREE.Vector3;
  a2: THREE.Vector3;
}

/**
 * Records everything Ragdoll spawns and replays each body's transform back
 * verbatim from getRagdollBodyState — i.e. "physics frozen", so update() should
 * reconstruct the original pose exactly.
 */
function makeMockRuntime() {
  const bodies = new Map<number, SpawnedBody>();
  const joints: SpawnedJoint[] = [];
  const runtime: Partial<GameRuntimeClient> = {
    spawnRagdollBody(id, hx, hy, hz, px, py, pz, qx, qy, qz, qw) {
      bodies.set(id, {
        half: new THREE.Vector3(hx, hy, hz),
        pos: new THREE.Vector3(px, py, pz),
        quat: new THREE.Quaternion(qx, qy, qz, qw),
      });
    },
    getRagdollBodyState(id) {
      const b = bodies.get(id);
      if (!b) return null;
      return new Float64Array([b.pos.x, b.pos.y, b.pos.z, b.quat.x, b.quat.y, b.quat.z, b.quat.w]);
    },
    setRagdollBodyVelocity() {},
    createRagdollSphericalJoint(_jid, b1, b2, a1x, a1y, a1z, a2x, a2y, a2z) {
      joints.push({
        b1,
        b2,
        a1: new THREE.Vector3(a1x, a1y, a1z),
        a2: new THREE.Vector3(a2x, a2y, a2z),
      });
    },
    createRagdollRevoluteJoint(_jid, b1, b2, a1x, a1y, a1z, a2x, a2y, a2z) {
      joints.push({
        b1,
        b2,
        a1: new THREE.Vector3(a1x, a1y, a1z),
        a2: new THREE.Vector3(a2x, a2y, a2z),
      });
    },
    removeRagdollBody() {},
    removeRagdollJoint() {},
  };
  return { runtime: runtime as GameRuntimeClient, bodies, joints };
}

/** World position of a body-local anchor given the body's recorded transform. */
function anchorWorld(body: SpawnedBody, localAnchor: THREE.Vector3): THREE.Vector3 {
  return localAnchor.clone().applyQuaternion(body.quat).add(body.pos);
}

describe('Ragdoll animated → physics conversion', () => {
  it('reconstructs the exact death pose when physics has not moved (scaled, posed rig)', () => {
    // 0.8 scale + non-trivial per-bone rotations — exactly the conditions that
    // broke the old setFromRotationMatrix-based calibration.
    const { root } = buildSyntheticSkeleton({ scale: 0.8, pose: true, rootY: 0 });
    const model = { root } as unknown as CharacterModel;

    // Capture the expected world transform of every driven bone BEFORE activation.
    const expected = new Map<string, { pos: THREE.Vector3; quat: THREE.Quaternion }>();
    for (const part of RAGDOLL_PARTS) {
      const bone = root.getObjectByName(PART_CONFIG[part].bone)!;
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      bone.matrixWorld.decompose(pos, quat, scl);
      expected.set(part, { pos, quat });
    }

    const { runtime } = makeMockRuntime();
    const ragdoll = new Ragdoll(model, 1, runtime);
    ragdoll.activate(new THREE.Vector3());
    ragdoll.update();
    root.updateMatrixWorld(true);

    for (const part of RAGDOLL_PARTS) {
      const bone = root.getObjectByName(PART_CONFIG[part].bone)!;
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      bone.matrixWorld.decompose(pos, quat, scl);

      const exp = expected.get(part)!;
      const posErr = pos.distanceTo(exp.pos);
      const angErr = quat.angleTo(exp.quat); // handles q vs -q
      expect(posErr, `position drift for ${part}`).toBeLessThan(1e-4);
      expect(angErr, `rotation drift for ${part}`).toBeLessThan(1e-3);
    }
  });

  it('wires every joint so its two anchors coincide in world space', () => {
    const { root } = buildSyntheticSkeleton({ scale: 1, pose: false });
    const model = { root } as unknown as CharacterModel;

    const { runtime, bodies, joints } = makeMockRuntime();
    const ragdoll = new Ragdoll(model, 1, runtime);
    ragdoll.activate(new THREE.Vector3());

    expect(joints.length).toBe(JOINT_DEFS.length);

    // Correctly-wired joints connect adjacent body *ends*, so the two anchors land
    // within a couple of cm (the joint clearance). A flipped arm anchor attaches the
    // wrong end and the two anchors end up a whole limb-segment apart (>0.3 m).
    for (const j of joints) {
      const b1 = bodies.get(j.b1)!;
      const b2 = bodies.get(j.b2)!;
      const gap = anchorWorld(b1, j.a1).distanceTo(anchorWorld(b2, j.a2));
      expect(gap, `joint anchor gap between bodies ${j.b1} and ${j.b2}`).toBeLessThan(0.15);
    }
  });

  it('uses the same proximal/distal anchor convention for arms as for legs', () => {
    // Anatomical invariant: the body whose *proximal* end meets the joint anchors at
    // -Y; the *distal* end at +Y. Arms must mirror legs — the bug had them inverted.
    const find = (b1: string, b2: string) =>
      JOINT_DEFS.find((d) => d.b1 === b1 && d.b2 === b2)!;

    // Hips/shoulders: limb's proximal end (-Y) attaches to the central body.
    expect(find('thighL', 'pelvis').a1[1]).toBeLessThan(0);
    expect(find('upperArmL', 'torso').a1[1]).toBeLessThan(0);
    expect(find('upperArmR', 'torso').a1[1]).toBeLessThan(0);

    // Knees/elbows: distal limb proximal end (-Y) ↔ proximal limb distal end (+Y).
    const knee = find('shinL', 'thighL');
    expect(knee.a1[1]).toBeLessThan(0);
    expect(knee.a2[1]).toBeGreaterThan(0);
    for (const elbow of [find('lowerArmL', 'upperArmL'), find('lowerArmR', 'upperArmR')]) {
      expect(elbow.a1[1]).toBeLessThan(0);
      expect(elbow.a2[1]).toBeGreaterThan(0);
    }
  });

  it('seeds every body with the player velocity for a cohesive hand-off', () => {
    const { root } = buildSyntheticSkeleton({ scale: 1, pose: false });
    const model = { root } as unknown as CharacterModel;

    const seeded: number[][] = [];
    const runtime: Partial<GameRuntimeClient> = {
      spawnRagdollBody(_id, _hx, _hy, _hz, _px, _py, _pz, _qx, _qy, _qz, _qw, vx, vy, vz) {
        seeded.push([vx, vy, vz]);
      },
      getRagdollBodyState: () => null,
      setRagdollBodyVelocity() {},
      createRagdollSphericalJoint() {},
      createRagdollRevoluteJoint() {},
      removeRagdollBody() {},
      removeRagdollJoint() {},
    };

    const ragdoll = new Ragdoll(model, 1, runtime as GameRuntimeClient);
    ragdoll.activate(new THREE.Vector3(3, -1, 2));

    expect(seeded.length).toBe(RAGDOLL_PARTS.length);
    for (const [vx, vy, vz] of seeded) {
      expect(vx).toBeCloseTo(3, 5);
      expect(vy).toBeCloseTo(-1, 5);
      expect(vz).toBeCloseTo(2, 5);
    }
    // sanity: PART_INDEX covers every part (used for body id allocation)
    expect(Object.keys(PART_INDEX).length).toBe(RAGDOLL_PARTS.length);
  });
});
