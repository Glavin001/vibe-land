// Test-only helper: load the REAL production rig (public/models/UAL*_Standard.glb)
// from disk and run it through the actual CharacterModel.build() pipeline, so the
// ragdoll tests exercise the exact same model + scale + clips that /play and
// /practice use — not a hand-authored stand-in that can silently diverge from the
// shipped asset.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CharacterModel, type LoadedGlb } from './CharacterModel';
import { PLAYER_PROFILE } from './profile';

const MODELS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/models');

// Parsing the 8 MB GLB is the slow part — cache the parsed result and clone the
// skeleton per build (exactly as sharedAssets.load does in production).
const parseCache = new Map<string, { scene: THREE.Group; animations: THREE.AnimationClip[] }>();

function parseGlb(file: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  const cached = parseCache.get(file);
  if (cached) return Promise.resolve(cached);
  const buf = readFileSync(resolve(MODELS_DIR, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) =>
    new GLTFLoader().parse(
      ab,
      '',
      (gltf) => {
        const parsed = { scene: gltf.scene as THREE.Group, animations: gltf.animations };
        parseCache.set(file, parsed);
        res(parsed);
      },
      rej,
    ),
  );
}

function toLoaded(parsed: { scene: THREE.Group; animations: THREE.AnimationClip[] }): LoadedGlb {
  return { scene: skeletonClone(parsed.scene) as THREE.Group, animations: parsed.animations };
}

const fileOf = (url: string) => url.split('/').pop()!;

/** Build the production player CharacterModel from the real GLBs, added to `parent`. */
export async function loadRealCharacterModel(parent: THREE.Object3D): Promise<CharacterModel> {
  const modelFile = fileOf(PLAYER_PROFILE.modelUrl);
  const main = toLoaded(await parseGlb(modelFile));
  const extras: LoadedGlb[] = [];
  for (const url of PLAYER_PROFILE.animationUrls) {
    const file = fileOf(url);
    if (file === modelFile) continue;
    extras.push(toLoaded(await parseGlb(file)));
  }
  return CharacterModel.build(main, extras, parent);
}

/** Drive a real animation clip onto the rig so the snapshot isn't a bind/T-pose. */
export function poseWithClip(model: CharacterModel, clipName: string, t = 0.5): void {
  const clip = model.clips.get(clipName) ?? model.clips.values().next().value;
  if (!clip) return;
  const mixer = new THREE.AnimationMixer(model.root);
  mixer.clipAction(clip).play();
  mixer.update(t);
  model.root.updateMatrixWorld(true);
}
