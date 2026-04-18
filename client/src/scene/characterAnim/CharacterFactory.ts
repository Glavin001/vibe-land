// Factory that builds an animated remote-player rig from PLAYER_PROFILE.
// Returns a synchronously usable handle: `root` is added to the parent
// immediately so callers can position it from frame 1, while the GLB loads
// in the background. When the rig is ready, `controller` becomes non-null.
//
// On load failure, `controller` stays null and `root` keeps its placeholder
// (caller-supplied or empty) so the game never soft-locks.

import * as THREE from 'three';
import { AnimationController } from './AnimationController';
import { CharacterModel } from './CharacterModel';
import { PLAYER_PROFILE } from './profile';
import { STATE, type AnimationProfile, type StateId } from './types';

/** "dead" is a synthetic state that triggers `profile.deathClip` as a full-override one-shot. */
export type RemoteRenderState = StateId | 'dead';

export interface RemotePlayerHandle {
  /** Top-level group attached to the scene (always present). */
  readonly root: THREE.Group;
  /** Per-frame entry: dt in seconds, current state, current horizontal speed (m/s). */
  update(dt: number, state: RemoteRenderState, speedHorizontal: number): void;
  /** Re-tint the rig (per-player color). Safe to call before the GLB loads. */
  setTint(color: THREE.Color | number): void;
  /** Yellow hit-flash overlay (0..1). */
  setFlash(color: THREE.Color | number, amount: number): void;
  /** Translucency for dead players (1 = solid). */
  setOpacity(opacity: number): void;
  /** Hide entire rig (e.g. while the player is in a vehicle). */
  setVisible(visible: boolean): void;
  /** Play any clip by name (e.g. "OverhandThrow", "Death01"). */
  playOneShot(clipName: string): void;
  /** Returns true once the GLB has finished loading and the rig is animated. */
  isReady(): boolean;
  dispose(): void;
}

export interface CreateRemotePlayerOptions {
  profile?: AnimationProfile;
  tint?: THREE.Color | number;
}

export function createRemotePlayer(
  parent: THREE.Object3D,
  options: CreateRemotePlayerOptions = {},
): RemotePlayerHandle {
  const profile = options.profile ?? PLAYER_PROFILE;
  const root = new THREE.Group();
  root.name = `RemotePlayer:${profile.id}`;
  parent.add(root);

  let model: CharacterModel | null = null;
  let controller: AnimationController | null = null;
  let lastDeathPlayed = false;
  let pendingTint: THREE.Color | number | null = options.tint ?? null;
  let pendingVisible = true;
  let disposed = false;

  CharacterModel.load(profile, root)
    .then((m) => {
      if (disposed) {
        m.dispose();
        return;
      }
      model = m;
      m.neutralize();
      if (pendingTint != null) m.tint(pendingTint);
      m.setVisible(pendingVisible);
      controller = new AnimationController(m, profile);
    })
    .catch((err) => {
      console.warn('[characterAnim] Failed to load player rig — falling back to empty group.', err);
    });

  return {
    root,
    update(dt, state, speedHorizontal) {
      if (!controller) return;
      if (state === 'dead' && profile.deathClip) {
        if (!lastDeathPlayed) {
          controller.playOneShot(profile.deathClip);
          lastDeathPlayed = true;
        }
      } else if (state !== 'dead') {
        if (lastDeathPlayed) {
          controller.resetOneShot();
          lastDeathPlayed = false;
        }
        controller.setState(state);
      }
      if (state === STATE.move) controller.setSpeed(speedHorizontal);
      controller.update(dt);
    },
    setTint(color) {
      pendingTint = color;
      if (model) model.tint(color);
    },
    setFlash(color, amount) {
      if (model) model.flash(color, amount);
    },
    setOpacity(opacity) {
      if (model) model.setOpacity(opacity);
    },
    setVisible(visible) {
      pendingVisible = visible;
      if (model) model.setVisible(visible);
    },
    playOneShot(clipName) {
      controller?.playOneShot(clipName);
    },
    isReady() {
      return controller != null;
    },
    dispose() {
      disposed = true;
      controller?.dispose();
      model?.dispose();
      controller = null;
      model = null;
      const p = root.parent;
      if (p) p.remove(root);
    },
  };
}
