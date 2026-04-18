// Ported from Kinema's CharacterModel
// (https://github.com/2600th/Kinema, MIT 2026 Pranshul Chandhok).
// Trimmed: removed AssetLoader dependency (we use sharedAssets directly),
// removed Kinema-specific PlayerCapsule hide, removed iridescent
// applyHeroFinish() since vibe-land has no hero player. Kept: material
// cloning, capsule-aligned scaling, root-motion stripping, neutralize(),
// tint(), setDamagePulse(), hand bone, dispose().

import * as THREE from 'three';
import { load as loadGlb } from './sharedAssets';
import type { AnimationProfile } from './types';

const CAPSULE_HEIGHT = 1.3; // 2 * (capsuleRadius + capsuleHalfHeight) in Kinema
const CAPSULE_BOTTOM = -0.6; // -(capsuleRadius + floatHeight)

interface BaseMaterialState {
  color: THREE.Color;
  emissive: THREE.Color;
  emissiveIntensity: number;
  opacity: number;
  transparent: boolean;
}

export class CharacterModel {
  readonly root: THREE.Object3D;
  readonly clips: Map<string, THREE.AnimationClip>;
  readonly handBone: THREE.Object3D | null;
  private readonly baseRootY: number;
  private readonly baseMaterialState = new Map<THREE.MeshStandardMaterial, BaseMaterialState>();
  private readonly damageTint = new THREE.Color(0xff6ea8);
  private readonly flashTmp = new THREE.Color();

  private constructor(
    root: THREE.Object3D,
    clips: Map<string, THREE.AnimationClip>,
    handBone: THREE.Object3D | null,
    baseRootY: number,
  ) {
    this.root = root;
    this.clips = clips;
    this.handBone = handBone;
    this.baseRootY = baseRootY;
  }

  static async load(profile: AnimationProfile, parent: THREE.Object3D): Promise<CharacterModel> {
    const main = await loadGlb(profile.modelUrl);
    const root = main.scene;
    root.name = 'CharacterModel';

    root.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        if (Array.isArray(node.material)) {
          node.material = node.material.map((m: THREE.Material) => m.clone());
        } else {
          node.material = node.material.clone();
        }
      }
    });

    const box = new THREE.Box3().setFromObject(root);
    const modelHeight = box.max.y - box.min.y;
    if (modelHeight > 0) {
      root.scale.setScalar(CAPSULE_HEIGHT / modelHeight);
    }

    const scaledBox = new THREE.Box3().setFromObject(root);
    root.position.y = CAPSULE_BOTTOM - scaledBox.min.y;

    parent.add(root);

    const clips = new Map<string, THREE.AnimationClip>();
    for (const clip of main.animations) {
      if (!clips.has(clip.name)) clips.set(clip.name, clip.clone());
    }
    for (const url of profile.animationUrls) {
      if (url === profile.modelUrl) continue;
      try {
        const extra = await loadGlb(url);
        for (const clip of extra.animations) {
          if (!clips.has(clip.name)) clips.set(clip.name, clip.clone());
        }
      } catch (err) {
        console.warn(`[CharacterModel] Failed to load animation GLB: ${url}`, err);
      }
    }

    const rootBoneName = CharacterModel.findRootBoneName(root);
    for (const clip of clips.values()) {
      CharacterModel.stripRootMotion(clip, rootBoneName);
    }

    let handBone: THREE.Object3D | null = null;
    root.traverse((n) => {
      if (!handBone && (n as THREE.Bone).isBone && n.name === 'hand_r') {
        handBone = n;
      }
    });

    return new CharacterModel(root, clips, handBone, root.position.y);
  }

  /** Find the head bone for label attachment. Quaternius rigs use 'head' (lower). */
  findHeadBone(): THREE.Object3D | null {
    let bone: THREE.Object3D | null = null;
    this.root.traverse((n) => {
      if (bone) return;
      if (!(n as THREE.Bone).isBone) return;
      const name = n.name.toLowerCase();
      if (name === 'head' || name === 'head_01' || name.endsWith('_head')) bone = n;
    });
    return bone;
  }

  /** Reset all materials to a neutral mannequin color (removes purple joints). */
  neutralize(): void {
    const neutral = new THREE.Color(0xccbbaa);
    this.root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) {
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.color.copy(neutral);
          mat.emissive.setScalar(0);
          mat.emissiveIntensity = 0;
        }
      }
    });
  }

  /** Tint all materials to the given color (per-player identification). */
  tint(color: THREE.Color | number): void {
    const c = color instanceof THREE.Color ? color : new THREE.Color(color);
    this.root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) {
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.color.copy(c);
          mat.emissive.copy(c);
          mat.emissiveIntensity = 0.15;
        }
      }
    });
    this.captureBaseMaterialState();
  }

  /**
   * Lerp materials toward `color` by `amount` (0..1). Used by the existing
   * vibe-land "got hit" yellow flash. amount=0 restores base.
   */
  flash(color: THREE.Color | number, amount: number): void {
    const target = color instanceof THREE.Color ? color : this.flashTmp.set(color);
    const a = Math.max(0, Math.min(1, amount));
    for (const [mat, base] of this.baseMaterialState) {
      mat.color.copy(base.color).lerp(target, a);
      mat.emissive.copy(base.emissive).lerp(target, a * 0.85);
      mat.emissiveIntensity = base.emissiveIntensity + a * 0.9;
    }
  }

  /** Apply opacity uniformly. Used for dead-player translucency. */
  setOpacity(opacity: number): void {
    const transparent = opacity < 0.999;
    for (const mat of this.baseMaterialState.keys()) {
      mat.transparent = transparent;
      mat.opacity = opacity;
      mat.depthWrite = !transparent;
    }
  }

  setDamagePulse(weight: number): void {
    const a = Math.max(0, Math.min(1, weight));
    for (const [mat, base] of this.baseMaterialState) {
      mat.color.copy(base.color).lerp(this.damageTint, a * 0.16);
      mat.emissive.copy(base.emissive).lerp(this.damageTint, a * 0.82);
      mat.emissiveIntensity = base.emissiveIntensity + a * 0.95;
    }
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /** Raise/lower the rendered character without moving the parent. */
  setVisualLift(offsetY: number): void {
    this.root.position.y = this.baseRootY + offsetY;
  }

  dispose(): void {
    const parent = this.root.parent;
    if (parent) parent.remove(this.root);
    this.root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.geometry.dispose();
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) {
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.map?.dispose();
          mat.normalMap?.dispose();
          mat.roughnessMap?.dispose();
          mat.metalnessMap?.dispose();
          mat.aoMap?.dispose();
          mat.emissiveMap?.dispose();
          mat.alphaMap?.dispose();
          mat.envMap?.dispose();
        }
        mat.dispose();
      }
    });
    this.baseMaterialState.clear();
  }

  private captureBaseMaterialState(): void {
    this.baseMaterialState.clear();
    this.root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) {
        if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
        this.baseMaterialState.set(mat, {
          color: mat.color.clone(),
          emissive: mat.emissive.clone(),
          emissiveIntensity: mat.emissiveIntensity,
          opacity: mat.opacity,
          transparent: mat.transparent,
        });
      }
    });
  }

  private static findRootBoneName(root: THREE.Object3D): string {
    let boneName = '';
    root.traverse((node) => {
      if (!boneName && (node as THREE.Bone).isBone) boneName = node.name;
    });
    return boneName || 'root';
  }

  private static stripRootMotion(clip: THREE.AnimationClip, rootBoneName: string): void {
    for (const track of clip.tracks) {
      if (track.name === `${rootBoneName}.position`) {
        const values = track.values;
        for (let i = 0; i < values.length; i += 3) {
          values[i] = 0;
          values[i + 1] = 0;
          values[i + 2] = 0;
        }
      }
    }
  }
}
