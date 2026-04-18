// Module-level GLB cache so every remote player shares one fetch.
// On `load()`, the GLTF scene is cloned via SkeletonUtils so each
// instance gets its own bones (skeleton sharing breaks animation).

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<GLTF>>();

export function preload(url: string): Promise<GLTF> {
  let promise = cache.get(url);
  if (!promise) {
    promise = loader.loadAsync(url);
    cache.set(url, promise);
  }
  return promise;
}

/** Returns a per-instance cloned scene plus the cached, shared AnimationClips. */
export async function load(url: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  const gltf = await preload(url);
  return {
    scene: skeletonClone(gltf.scene) as THREE.Group,
    animations: gltf.animations,
  };
}
