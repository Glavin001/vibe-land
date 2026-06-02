import * as THREE from 'three';
import type { CharacterModel } from './CharacterModel';
import type { GameRuntimeClient } from '../../runtime/gameRuntime';
import {
  RAGDOLL_PARTS,
  PART_CONFIG,
  PART_INDEX,
  JOINT_DEFS,
  type RagdollPart,
} from './ragdollBones';

// ── ID allocation ────────────────────────────────────────────────────────────
// Body IDs: 0xC000_0000 | (playerId << 4) | partIndex
// Joint IDs: 0xD000_0000 | (playerId << 4) | jointIndex
function bodyId(playerId: number, partIndex: number): number {
  return (0xc000_0000 | ((playerId & 0xff) << 4) | (partIndex & 0xf)) >>> 0;
}
function jointId(playerId: number, jointIndex: number): number {
  return (0xd000_0000 | ((playerId & 0xff) << 4) | (jointIndex & 0xf)) >>> 0;
}

// ── Calibration snapshot per body part ───────────────────────────────────────
interface Calibration {
  bone: THREE.Bone;
  /** Body world position expressed as offset from bone world position, in bone-local frame. */
  posOffsetInBone: THREE.Vector3;
  /** Rotation from bone world orientation to body world orientation: bodyQ = boneQ * rotOffset */
  rotOffset: THREE.Quaternion;
  bId: number;
}

// Scratch objects reused every frame to avoid GC pressure.
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();
const _m1 = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);

/** Build a quaternion that rotates +Y to point along `dir`. */
function quatFromYDir(dir: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _v0.set(0, 1, 0);
  if (Math.abs(dir.dot(_v0)) > 0.9999) {
    // Near-parallel: fall back to a 180° rotation around Z if pointing down, or identity if up.
    if (dir.y < 0) {
      out.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
    } else {
      out.identity();
    }
  } else {
    out.setFromUnitVectors(_v0, dir);
  }
  return out;
}

export class Ragdoll {
  private calibrations = new Map<RagdollPart, Calibration>();
  private jointIds: number[] = [];
  private scale = 1;
  private active = false;

  constructor(
    private readonly model: CharacterModel,
    private readonly playerId: number,
    private readonly runtime: GameRuntimeClient,
  ) {}

  /**
   * Snapshot current bone world transforms, spawn physics bodies co-located
   * with each driven bone, create joints, seed velocity.
   */
  activate(seedVelocity: THREE.Vector3): void {
    if (this.active) return;
    this.active = true;

    // Measure character scale from head-foot distance.
    const modelRoot = this.model.root;
    modelRoot.updateMatrixWorld(true);
    const headBone = this._findBone('Head') ?? this._findBone('head');
    const footBone = this._findBone('foot_l') ?? this._findBone('foot_r');
    if (headBone && footBone) {
      headBone.getWorldPosition(_v0);
      footBone.getWorldPosition(_v1);
      const span = _v0.y - _v1.y;
      if (span > 0.1) this.scale = span / 1.67;
    }
    const s = this.scale;

    // World transform of each spawned body, used below to derive joint anchors
    // from the real bone positions.
    const bodyXf = new Map<RagdollPart, { pos: THREE.Vector3; quat: THREE.Quaternion }>();

    // Spawn one body per part.
    for (const part of RAGDOLL_PARTS) {
      const cfg = PART_CONFIG[part];
      const bone = this._findBone(cfg.bone);
      if (!bone) {
        console.warn(`[Ragdoll] bone not found: ${cfg.bone}`);
        continue;
      }
      bone.updateWorldMatrix(true, false);

      // Bone world position + quaternion. Decompose (rather than
      // setFromRotationMatrix) so the rig's uniform scale is stripped out and we
      // get a true *unit* quaternion — setFromRotationMatrix on a scaled matrix
      // yields a non-unit quaternion, which then corrupts the offset/rotOffset
      // calibration below (THREE's invert/applyQuaternion assume unit length).
      bone.matrixWorld.decompose(_v0, _q0, _v1);
      const boneWorldPos = _v0.clone();
      const boneWorldQuat = _q0.clone();

      // Tip position: defines body +Y axis direction.
      let tipWorldPos: THREE.Vector3;
      if (cfg.tipBone === 'up') {
        tipWorldPos = boneWorldPos.clone().add(new THREE.Vector3(0, cfg.hy * 2 * s, 0));
      } else {
        const tipBone = this._findBone(cfg.tipBone);
        if (tipBone) {
          tipBone.updateWorldMatrix(true, false);
          tipBone.getWorldPosition(_v1);
          tipWorldPos = _v1.clone();
        } else {
          tipWorldPos = boneWorldPos.clone().add(new THREE.Vector3(0, cfg.hy * 2 * s, 0));
        }
      }

      // Body orientation: +Y points from bone toward tip.
      const dir = tipWorldPos.clone().sub(boneWorldPos);
      const dirLen = dir.length();
      if (dirLen > 0.001) dir.divideScalar(dirLen);
      else dir.set(0, 1, 0);

      const bodyOrientQuat = quatFromYDir(dir, _q1.clone());

      // Body position at midpoint along bone→tip.
      const bodyWorldPos = boneWorldPos.clone().add(
        tipWorldPos.clone().sub(boneWorldPos).multiplyScalar(0.5),
      );

      // Calibration offsets.
      const invBoneQuat = boneWorldQuat.clone().invert();
      const posOffsetInBone = bodyWorldPos.clone().sub(boneWorldPos).applyQuaternion(invBoneQuat);
      const rotOffset = invBoneQuat.clone().multiply(bodyOrientQuat);

      const bId = bodyId(this.playerId, PART_INDEX[part]);

      // Every part inherits the player's last-frame linear velocity so the
      // ragdoll hands off as one cohesive body (no "limbs left behind" jolt),
      // then collapses under gravity + joint constraints. A small random spin
      // adds natural tumble; the core (pelvis/torso) gets a slightly larger kick.
      const spin = part === 'pelvis' || part === 'torso' ? 1.2 : 0.6;
      this.runtime.spawnRagdollBody(
        bId,
        cfg.hx * s, cfg.hy * s, cfg.hz * s,
        bodyWorldPos.x, bodyWorldPos.y, bodyWorldPos.z,
        bodyOrientQuat.x, bodyOrientQuat.y, bodyOrientQuat.z, bodyOrientQuat.w,
        seedVelocity.x, seedVelocity.y, seedVelocity.z,
        (Math.random() - 0.5) * 2 * spin,
        (Math.random() - 0.5) * 2 * spin,
        (Math.random() - 0.5) * 2 * spin,
      );

      bodyXf.set(part, { pos: bodyWorldPos, quat: bodyOrientQuat });
      this.calibrations.set(part, { bone: bone as THREE.Bone, posOffsetInBone, rotOffset, bId });
    }

    // Create joints. The pivot is the b1 bone's world origin (the anatomical
    // joint); expressing it in each body's local frame makes the two anchors
    // coincide exactly on whatever rig is loaded — no hand-tuned offsets.
    const _aShared = new THREE.Vector3();
    const _a1 = new THREE.Vector3();
    const _a2 = new THREE.Vector3();
    for (let i = 0; i < JOINT_DEFS.length; i++) {
      const def = JOINT_DEFS[i];
      const t1 = bodyXf.get(def.b1);
      const t2 = bodyXf.get(def.b2);
      const pivotBone = this._findBone(PART_CONFIG[def.b1].bone);
      if (!t1 || !t2 || !pivotBone) continue;

      pivotBone.getWorldPosition(_aShared);
      _a1.copy(_aShared).sub(t1.pos).applyQuaternion(_q0.copy(t1.quat).invert());
      _a2.copy(_aShared).sub(t2.pos).applyQuaternion(_q0.copy(t2.quat).invert());

      const jId = jointId(this.playerId, i);
      const b1Id = bodyId(this.playerId, PART_INDEX[def.b1]);
      const b2Id = bodyId(this.playerId, PART_INDEX[def.b2]);

      if (def.type === 'spherical') {
        this.runtime.createRagdollSphericalJoint(
          jId, b1Id, b2Id,
          _a1.x, _a1.y, _a1.z,
          _a2.x, _a2.y, _a2.z,
          def.swing, def.twist,
        );
      } else {
        this.runtime.createRagdollRevoluteJoint(
          jId, b1Id, b2Id,
          _a1.x, _a1.y, _a1.z,
          _a2.x, _a2.y, _a2.z,
          def.axis[0], def.axis[1], def.axis[2],
          def.limits[0], def.limits[1],
        );
      }
      this.jointIds.push(jId);
    }
  }

  /**
   * Read physics body transforms and write them back to bone local transforms.
   * Call once per frame while the character is dead.
   */
  update(): void {
    if (!this.active) return;

    // Process in RAGDOLL_PARTS order (parent-first) so each bone's parent
    // matrixWorld is already updated before we decompose the child.
    for (const part of RAGDOLL_PARTS) {
      const cal = this.calibrations.get(part);
      if (!cal) continue;

      const state = this.runtime.getRagdollBodyState(cal.bId);
      if (!state || state.length < 7) continue;

      const bodyWorldPos = _v0.set(state[0], state[1], state[2]);
      const bodyWorldQuat = _q0.set(state[3], state[4], state[5], state[6]);

      // Derive bone world orientation/position from body + stored calibration.
      const invRotOffset = _q1.copy(cal.rotOffset).invert();
      const boneWorldQuat = _q0.clone().multiply(invRotOffset);
      const boneWorldPos = bodyWorldPos.clone().sub(
        cal.posOffsetInBone.clone().applyQuaternion(boneWorldQuat),
      );

      // Build bone world matrix and convert to parent-local.
      _m0.compose(boneWorldPos, boneWorldQuat, _s);
      const parent = cal.bone.parent;
      if (!parent) continue;
      parent.updateWorldMatrix(true, false);
      _m1.copy(parent.matrixWorld).invert();
      _m0.premultiply(_m1);

      // Decompose and write — skip scale to preserve CharacterModel's loaded scale.
      const localPos = new THREE.Vector3();
      const localQuat = new THREE.Quaternion();
      const localScale = new THREE.Vector3();
      _m0.decompose(localPos, localQuat, localScale);
      cal.bone.position.copy(localPos);
      cal.bone.quaternion.copy(localQuat);
    }
  }

  /** Remove all bodies and joints from the physics world. */
  dispose(): void {
    if (!this.active) return;
    this.active = false;

    for (const jId of this.jointIds) {
      this.runtime.removeRagdollJoint(jId);
    }
    this.jointIds = [];

    for (const cal of this.calibrations.values()) {
      this.runtime.removeRagdollBody(cal.bId);
    }
    this.calibrations.clear();
  }

  private _findBone(name: string): THREE.Object3D | null {
    let found: THREE.Object3D | null = null;
    this.model.root.traverse((node) => {
      if (!found && (node as THREE.Bone).isBone && node.name === name) {
        found = node;
      }
    });
    return found;
  }
}
