import * as THREE from 'three';
import { MAX_LOCAL_PLAYERS } from '../app/localPlayers';

/**
 * Three.js layer conventions for local split-screen.
 *
 * - Layer 0 — default world layer; everything that's visible to every local
 *   player (terrain, vehicles, bots, pickups, remote networked players).
 * - Layer `1 + slotId` — mesh of a specific local-human slot. That slot's
 *   own camera leaves this bit **disabled** so the player's body doesn't
 *   obstruct their own viewport; every other local camera enables it.
 *
 * Unused slot layers (e.g. slot 3 when only 2 players are configured)
 * simply carry no geometry, so enabling them on other cameras is free.
 */
export const DEFAULT_WORLD_LAYER = 0;
export const LOCAL_HUMAN_LAYER_BASE = 1;

export function layerForLocalSlot(slotId: number): number {
  return LOCAL_HUMAN_LAYER_BASE + slotId;
}

/**
 * Recursively stamp a single layer onto `root` and all descendants.
 * Needed because `CharacterModel.load` attaches skinned-mesh children
 * asynchronously, so one-time stamping at creation misses them.
 */
export function setObjectLayerRecursive(root: THREE.Object3D, layer: number): void {
  root.traverse((obj) => {
    obj.layers.set(layer);
  });
}

/**
 * Configure a camera to render layer 0 (world) + every local-human mesh
 * layer except `ownSlotId`'s. Stateless — no active-slot list required,
 * because unused layers have no geometry.
 */
export function configureCameraLayersForLocalSlot(camera: THREE.Camera, ownSlotId: number): void {
  camera.layers.set(DEFAULT_WORLD_LAYER);
  for (let slotId = 0; slotId < MAX_LOCAL_PLAYERS; slotId += 1) {
    if (slotId === ownSlotId) continue;
    camera.layers.enable(layerForLocalSlot(slotId));
  }
}
