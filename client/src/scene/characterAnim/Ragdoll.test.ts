// Verification of the animated → ragdoll conversion, driven by the REAL shipped
// rig (public/models/UAL1_Standard.glb) loaded through the production
// CharacterModel.build() pipeline — so these tests actually prove what /play and
// /practice do on death, not a hand-built approximation.
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Ragdoll } from './Ragdoll';
import { RAGDOLL_PARTS, PART_CONFIG, JOINT_DEFS } from './ragdollBones';
import type { CharacterModel } from './CharacterModel';
import type { GameRuntimeClient } from '../../runtime/gameRuntime';
import { loadRealCharacterModel, poseWithClip } from './ragdollTestModel';

interface SpawnedBody {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}
interface SpawnedJoint {
  b1: number;
  b2: number;
  a1: THREE.Vector3;
  a2: THREE.Vector3;
}

/** Records spawns/joints and replays each body's transform verbatim from
 * getRagdollBodyState — i.e. "physics frozen", so update() must reconstruct the
 * exact death pose. */
function makeMockRuntime() {
  const bodies = new Map<number, SpawnedBody>();
  const joints: SpawnedJoint[] = [];
  const runtime: Partial<GameRuntimeClient> = {
    spawnRagdollBody(id, _hx, _hy, _hz, px, py, pz, qx, qy, qz, qw) {
      bodies.set(id, {
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
      joints.push({ b1, b2, a1: new THREE.Vector3(a1x, a1y, a1z), a2: new THREE.Vector3(a2x, a2y, a2z) });
    },
    createRagdollRevoluteJoint(_jid, b1, b2, a1x, a1y, a1z, a2x, a2y, a2z) {
      joints.push({ b1, b2, a1: new THREE.Vector3(a1x, a1y, a1z), a2: new THREE.Vector3(a2x, a2y, a2z) });
    },
    removeRagdollBody() {},
    removeRagdollJoint() {},
  };
  return { runtime: runtime as GameRuntimeClient, bodies, joints };
}

function anchorWorld(b: SpawnedBody, local: THREE.Vector3): THREE.Vector3 {
  return local.clone().applyQuaternion(b.quat).add(b.pos);
}

// Each test gets its own rig instance (activate + the mixer mutate the bones).
// The 8 MB GLB parse is cached in the loader, so a fresh build is cheap.
const freshModel = () => loadRealCharacterModel(new THREE.Group());

describe('Ragdoll conversion on the real UAL rig', () => {
  beforeAll(async () => {
    // Warm the parse cache once so per-test builds are fast.
    await loadRealCharacterModel(new THREE.Group());
  });

  it('finds every driven bone and creates all joints on the shipped rig', async () => {
    const { runtime, bodies, joints } = makeMockRuntime();
    new Ragdoll(await freshModel(), 1, runtime).activate(new THREE.Vector3());
    expect(bodies.size, 'one physics body per ragdoll part').toBe(RAGDOLL_PARTS.length);
    expect(joints.length, 'all joints created').toBe(JOINT_DEFS.length);
  });

  it('reconstructs the exact death pose when physics has not moved', async () => {
    const m = await freshModel();
    poseWithClip(m, 'Death01', 0.6); // a real clip, so it is not a bind/T-pose

    const expected = new Map<string, { pos: THREE.Vector3; quat: THREE.Quaternion }>();
    for (const part of RAGDOLL_PARTS) {
      const bone = m.root.getObjectByName(PART_CONFIG[part].bone)!;
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      bone.matrixWorld.decompose(pos, quat, new THREE.Vector3());
      expected.set(part, { pos, quat });
    }

    const { runtime } = makeMockRuntime();
    const ragdoll = new Ragdoll(m, 1, runtime);
    ragdoll.activate(new THREE.Vector3());
    ragdoll.update();
    m.root.updateMatrixWorld(true);

    for (const part of RAGDOLL_PARTS) {
      const bone = m.root.getObjectByName(PART_CONFIG[part].bone)!;
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      bone.matrixWorld.decompose(pos, quat, new THREE.Vector3());
      const exp = expected.get(part)!;
      expect(pos.distanceTo(exp.pos), `position drift for ${part}`).toBeLessThan(1e-3);
      expect(quat.angleTo(exp.quat), `rotation drift for ${part}`).toBeLessThan(5e-3);
    }
  });

  it('connects every joint at coincident anchors on the real rig', async () => {
    const { runtime, bodies, joints } = makeMockRuntime();
    new Ragdoll(await freshModel(), 1, runtime).activate(new THREE.Vector3());

    const gap = (j: SpawnedJoint) =>
      anchorWorld(bodies.get(j.b1)!, j.a1).distanceTo(anchorWorld(bodies.get(j.b2)!, j.a2));

    // Anchors are derived from the real bone joint position and expressed in each
    // body's frame, so the two anchors land on the same world point (to float
    // precision) for every joint — no on-death tug, on whatever rig is loaded.
    for (const j of joints) {
      const g = gap(j);
      expect(Number.isFinite(g)).toBe(true);
      expect(g, `joint anchor gap ${j.b1}->${j.b2}`).toBeLessThan(1e-4);
    }
  });

  it('seeds every body with the player velocity for a cohesive hand-off', async () => {
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
    new Ragdoll(await freshModel(), 1, runtime as GameRuntimeClient).activate(
      new THREE.Vector3(3, -1, 2),
    );

    expect(seeded.length).toBe(RAGDOLL_PARTS.length);
    for (const [vx, vy, vz] of seeded) {
      expect(vx).toBeCloseTo(3, 5);
      expect(vy).toBeCloseTo(-1, 5);
      expect(vz).toBeCloseTo(2, 5);
    }
  });
});
