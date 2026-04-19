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
import { Ragdoll } from './Ragdoll';
import { PLAYER_PROFILE } from './profile';
import { STATE, type AnimationProfile, type StateId } from './types';
import type { GameRuntimeClient } from '../../runtime/gameRuntime';

/** "dead" is a synthetic state that triggers the physics ragdoll on transition. */
export type RemoteRenderState = StateId | 'dead';

export interface RemotePlayerHandle {
  /** Top-level group attached to the scene (always present). */
  readonly root: THREE.Group;
  /**
   * Per-frame entry. `state` is the desired ground-level state ('idle' | 'move' | 'dead').
   * The handle layers a jump/air/land sub-FSM on top, driven by `onGround`: when the
   * player leaves the ground we play Jump_Start → Jump_Loop, and on landing we
   * play Jump_Land before falling back to the requested state.
   */
  update(
    dt: number,
    state: RemoteRenderState,
    speedHorizontal: number,
    onGround: boolean,
  ): void;
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
  /**
   * Toggle ragdoll physics mode.
   * Call with active=true when isDead transitions false→true.
   * Call with active=false on respawn.
   */
  setRagdoll(active: boolean, seedVelocity?: THREE.Vector3): void;
  /** Returns true once the GLB has finished loading and the rig is animated. */
  isReady(): boolean;
  dispose(): void;
}

export interface CreateRemotePlayerOptions {
  profile?: AnimationProfile;
  tint?: THREE.Color | number;
  playerId?: number;
  runtime?: GameRuntimeClient;
}

export function createRemotePlayer(
  parent: THREE.Object3D,
  options: CreateRemotePlayerOptions = {},
): RemotePlayerHandle {
  const profile = options.profile ?? PLAYER_PROFILE;
  const playerId = options.playerId ?? 0;
  const runtime = options.runtime ?? null;

  const root = new THREE.Group();
  root.name = `RemotePlayer:${profile.id}`;
  parent.add(root);

  let model: CharacterModel | null = null;
  let controller: AnimationController | null = null;
  let ragdoll: Ragdoll | null = null;
  let ragdollActive = false;
  let lastDeathPlayed = false;
  let pendingSeedVelocity: THREE.Vector3 | null = null;
  let pendingTint: THREE.Color | number | null = options.tint ?? null;
  let pendingVisible = true;
  let disposed = false;

  // Sub-FSM layered on top of the caller's idle/move request:
  //   grounded → (left ground) → jumping → (Jump_Start finished) → airborne
  //                            → (touched ground) → landing → (Jump_Land finished) → grounded
  // Death always wins and resets the phase on respawn.
  type JumpPhase = 'grounded' | 'jumping' | 'airborne' | 'landing';
  let jumpPhase: JumpPhase = 'grounded';

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

      // If ragdoll was requested before the model finished loading, activate now.
      // IMPORTANT: do NOT call mixer.stopAllAction() — that triggers Three's
      // PropertyBinding.restoreOriginalState() which snaps every bone back to
      // the bind pose (T-pose). We just skip calling controller.update(dt)
      // while ragdollActive; the mixer freezes at the last animated pose and
      // our Ragdoll.update() writes over the bones each frame.
      if (ragdollActive && runtime) {
        m.root.updateMatrixWorld(true);
        ragdoll = new Ragdoll(m, playerId, runtime);
        ragdoll.activate(pendingSeedVelocity ?? new THREE.Vector3());
        pendingSeedVelocity = null;
      }
    })
    .catch((err) => {
      console.warn('[characterAnim] Failed to load player rig — falling back to empty group.', err);
    });

  return {
    root,
    update(dt, state, speedHorizontal, onGround) {
      // While ragdoll is active, drive bones from physics and skip mixer entirely.
      if (ragdollActive) {
        ragdoll?.update();
        return;
      }

      if (!controller) return;

      if (state === 'dead') {
        // When cosmetic ragdolls are disabled, fall back to the authored death
        // clip and only trigger it once for the current death.
        if (profile.deathClip && !lastDeathPlayed) {
          controller.playOneShot(profile.deathClip);
          lastDeathPlayed = true;
        }
        controller.update(dt);
        return;
      }

      // Leaving dead state — ragdoll cleanup is handled in setRagdoll(false).
      if (lastDeathPlayed) {
        controller.resetOneShot();
        lastDeathPlayed = false;
        jumpPhase = 'grounded';
      }
      switch (jumpPhase) {
        case 'grounded':
          if (!onGround) {
            controller.setState(STATE.jump);
            jumpPhase = 'jumping';
          }
          break;
        case 'jumping':
          if (onGround) {
            controller.setState(STATE.land);
            jumpPhase = 'landing';
          } else if (controller.isClipFinished()) {
            controller.setState(STATE.air);
            jumpPhase = 'airborne';
          }
          break;
        case 'airborne':
          if (onGround) {
            controller.setState(STATE.land);
            jumpPhase = 'landing';
          }
          break;
        case 'landing':
          if (!onGround) {
            controller.setState(STATE.jump);
            jumpPhase = 'jumping';
          } else if (controller.isClipFinished()) {
            jumpPhase = 'grounded';
          }
          break;
      }

      if (jumpPhase === 'grounded') {
        controller.setState(state);
        if (state === STATE.move) controller.setSpeed(speedHorizontal);
      }

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
    setRagdoll(active, seedVelocity) {
      if (active === ragdollActive) return;
      ragdollActive = active;

      if (active) {
        jumpPhase = 'grounded';
        if (model && controller && runtime) {
          // IMPORTANT: do NOT call mixer.stopAllAction() — that triggers
          // Three's PropertyBinding.restoreOriginalState() which resets every
          // bone to the bind pose (T-pose). We just stop calling
          // controller.update(dt) while ragdollActive; the mixer freezes with
          // bones at their last animated pose, and our Ragdoll.update() writes
          // over them each frame.
          //
          // Force a fresh matrixWorld so the calibration snapshot reads the
          // exact bone transforms the mixer last produced.
          model.root.updateMatrixWorld(true);
          ragdoll = new Ragdoll(model, playerId, runtime);
          ragdoll.activate(seedVelocity ?? new THREE.Vector3());
          pendingSeedVelocity = null;
        } else {
          // Model not loaded yet — store velocity; activate in onLoad above.
          pendingSeedVelocity = seedVelocity ?? new THREE.Vector3();
        }
      } else {
        ragdoll?.dispose();
        ragdoll = null;
        lastDeathPlayed = false;
        jumpPhase = 'grounded';
        // Force the FSM to fade back into an animation next frame.
        controller?.resumeFromRagdoll();
      }
    },
    isReady() {
      return controller != null;
    },
    dispose() {
      disposed = true;
      ragdoll?.dispose();
      ragdoll = null;
      controller?.dispose();
      model?.dispose();
      controller = null;
      model = null;
      const p = root.parent;
      if (p) p.remove(root);
    },
  };
}
