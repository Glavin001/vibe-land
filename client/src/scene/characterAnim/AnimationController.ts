// Ported nearly verbatim from Kinema's AnimationController
// (https://github.com/2600th/Kinema, MIT 2026 Pranshul Chandhok).
// Only changes: imports our local STATE/StateId instead of @core/types.
// Crouch/carry/grab branches are kept so any future netcode bit can flip
// them on without re-wiring; today only idle/move/dead are exercised.

import * as THREE from 'three';
import { AnimationUtils } from 'three';
import type { CharacterModel } from './CharacterModel';
import { STATE, type AnimationProfile, type StateId } from './types';

const FADE_LOCOMOTION = 0.15;
const FADE_ACTION = 0.1;
const FADE_LAND = 0.08;

const WALK_AUTHORED_SPEED = 1.5;
const JOG_AUTHORED_SPEED = 3.5;
const SPRINT_AUTHORED_SPEED = 6.5;

const WEIGHT_LAMBDA = 8;
const SPEED_SWITCH_THRESHOLD = 0.1;

type MixerFinishedListener = THREE.EventListener<
  THREE.AnimationMixerEventMap['finished'],
  'finished',
  THREE.AnimationMixer
>;
type MixerLoopListener = THREE.EventListener<THREE.AnimationMixerEventMap['loop'], 'loop', THREE.AnimationMixer>;

export interface AnimationEventListener {
  onFootstep?: () => void;
  onActionEvent?: (clipName: string, event: string) => void;
}

export class AnimationController {
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private currentState: StateId | null = null;
  private currentAction: THREE.AnimationAction | null = null;
  private speed = 0;

  private locoWalk: THREE.AnimationAction | null = null;
  private locoJog: THREE.AnimationAction | null = null;
  private locoSprint: THREE.AnimationAction | null = null;
  private locoWeights = { walk: 0, jog: 0, sprint: 0 };
  private locoTargetWeights = { walk: 0, jog: 0, sprint: 0 };
  private locoActive = false;
  private oneShotActive = false;
  private oneShotActions = new Map<string, THREE.AnimationAction>();
  private clipFinished = false;
  private additiveClipNames: Set<string>;
  private forwardAlignment = 1;
  private eventListener: AnimationEventListener | null = null;
  private firedEvents = new Set<string>();
  private currentOneShotClipName: string | null = null;
  private additiveAction: THREE.AnimationAction | null = null;

  private crouchIdleAction: THREE.AnimationAction | null = null;
  private crouchMoveAction: THREE.AnimationAction | null = null;
  private carryIdleAction: THREE.AnimationAction | null = null;
  private carryMoveAction: THREE.AnimationAction | null = null;

  private crouchIdleWeight = 1;
  private crouchMoveWeight = 0;
  private carryIdleWeight = 1;
  private carryMoveWeight = 0;

  private onMixerFinished: MixerFinishedListener = (e) => {
    if (e.action === this.additiveAction) {
      this.additiveAction.fadeOut(FADE_ACTION);
      this.additiveAction = null;
      this.currentOneShotClipName = null;
    }
    if (e.action === this.currentAction) {
      this.clipFinished = true;
      if (this.oneShotActive) this.oneShotActive = false;
    }
  };

  private onMixerLoop: MixerLoopListener = (e) => {
    const a = e.action;
    if (this.locoActive && (a === this.locoWalk || a === this.locoJog || a === this.locoSprint)) {
      const w = a.getEffectiveWeight();
      const maxW = Math.max(
        this.locoWalk?.getEffectiveWeight() ?? 0,
        this.locoJog?.getEffectiveWeight() ?? 0,
        this.locoSprint?.getEffectiveWeight() ?? 0,
      );
      if (w >= maxW - 0.01) this.eventListener?.onFootstep?.();
      return;
    }
    if (a === this.crouchMoveAction || a === this.carryMoveAction) {
      if (a.getEffectiveWeight() > 0.3) this.eventListener?.onFootstep?.();
    }
  };

  constructor(
    private model: CharacterModel,
    private profile: AnimationProfile,
  ) {
    this.additiveClipNames = new Set(profile.additiveOneShots ?? []);
    this.mixer = new THREE.AnimationMixer(model.root);
    this.mixer.addEventListener('finished', this.onMixerFinished);
    this.mixer.addEventListener('loop', this.onMixerLoop);
    this.buildActions();
    this.buildAdditiveOneShots();
    this.playImmediate(STATE.idle);
  }

  setEventListener(listener: AnimationEventListener): void {
    this.eventListener = listener;
  }

  private buildActions(): void {
    const { stateMap, locomotion, crouchLocomotion, carryLocomotion } = this.profile;
    const clips = this.model.clips;

    for (const [stateId, clipDef] of Object.entries(stateMap)) {
      if (!clipDef) continue;
      const clip = clips.get(clipDef.clip);
      if (!clip) {
        console.warn(`[AnimationController] Clip "${clipDef.clip}" not found for state "${stateId}"`);
        continue;
      }
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      action.loop = clipDef.loop ? THREE.LoopRepeat : THREE.LoopOnce;
      action.clampWhenFinished = !clipDef.loop;
      if (clipDef.timeScale != null) action.timeScale = clipDef.timeScale;
      this.actions.set(stateId, action);
    }

    if (locomotion) {
      this.locoWalk = this.createLocoAction(locomotion.walk);
      this.locoJog = this.createLocoAction(locomotion.jog);
      this.locoSprint = this.createLocoAction(locomotion.sprint);
    }
    if (crouchLocomotion) {
      this.crouchIdleAction = this.createLocoAction(crouchLocomotion.idle);
      this.crouchMoveAction = this.createLocoAction(crouchLocomotion.moving);
    }
    if (carryLocomotion) {
      this.carryIdleAction = this.createLocoAction(carryLocomotion.idle);
      this.carryMoveAction = this.createLocoAction(carryLocomotion.moving);
    }
  }

  private buildAdditiveOneShots(): void {
    for (const clipName of this.additiveClipNames) {
      const originalClip = this.model.clips.get(clipName);
      if (!originalClip) continue;
      const clip = originalClip.clone();
      AnimationUtils.makeClipAdditive(clip);
      clip.blendMode = THREE.AdditiveAnimationBlendMode;
      const action = this.mixer.clipAction(clip);
      action.loop = THREE.LoopOnce;
      action.clampWhenFinished = true;
      this.oneShotActions.set(clipName, action);
    }
  }

  private createLocoAction(clipName: string): THREE.AnimationAction | null {
    const originalClip = this.model.clips.get(clipName);
    if (!originalClip) {
      console.warn(`[AnimationController] Locomotion clip "${clipName}" not found`);
      return null;
    }
    const clip = originalClip.clone();
    const action = this.mixer.clipAction(clip);
    action.enabled = true;
    action.loop = THREE.LoopRepeat;
    return action;
  }

  private playImmediate(state: StateId): void {
    const action = this.resolveAction(state);
    if (!action) return;
    this.currentState = state;
    action.reset().setEffectiveWeight(1).play();
    this.currentAction = action;
  }

  setState(state: StateId): void {
    if (this.oneShotActive) return;
    if (state === this.currentState) return;
    this.clipFinished = false;

    const prevState = this.currentState;
    this.currentState = state;

    const fadeDuration =
      state === STATE.land ? FADE_LAND : state === STATE.move || state === STATE.idle ? FADE_LOCOMOTION : FADE_ACTION;

    if (prevState === STATE.move && state !== STATE.move) {
      this.deactivateLocomotion(fadeDuration);
    }
    if (prevState === STATE.crouch && state !== STATE.crouch) {
      this.deactivateSpeedSwitch(this.crouchIdleAction, this.crouchMoveAction, fadeDuration);
    }
    if (prevState === STATE.carry && state !== STATE.carry) {
      this.deactivateSpeedSwitch(this.carryIdleAction, this.carryMoveAction, fadeDuration);
    }

    if (state === STATE.move && this.profile.locomotion) {
      this.activateLocomotion();
      if (this.currentAction) {
        this.currentAction.fadeOut(fadeDuration);
        this.currentAction = null;
      }
      return;
    }
    if (state === STATE.crouch && this.profile.crouchLocomotion) {
      this.activateSpeedSwitch(this.crouchIdleAction, this.crouchMoveAction);
      if (this.currentAction) {
        this.currentAction.fadeOut(fadeDuration);
        this.currentAction = null;
      }
      return;
    }
    if (state === STATE.carry && this.profile.carryLocomotion) {
      this.activateSpeedSwitch(this.carryIdleAction, this.carryMoveAction);
      if (this.currentAction) {
        this.currentAction.fadeOut(fadeDuration);
        this.currentAction = null;
      }
      return;
    }

    const nextAction = this.resolveAction(state);
    if (!nextAction) return;
    if (this.currentAction && this.currentAction !== nextAction) {
      this.currentAction.fadeOut(fadeDuration);
    }
    nextAction.reset().fadeIn(fadeDuration).play();
    this.currentAction = nextAction;
  }

  setSpeed(horizontalSpeed: number): void {
    this.speed = horizontalSpeed;

    if (this.locoActive && this.profile.locomotion) {
      const [t0, t1] = this.profile.locomotion.thresholds;
      const mid = (t0 + t1) * 0.5;
      if (horizontalSpeed <= t0) {
        this.locoTargetWeights.walk = 1;
        this.locoTargetWeights.jog = 0;
        this.locoTargetWeights.sprint = 0;
      } else if (horizontalSpeed <= mid) {
        const t = (horizontalSpeed - t0) / (mid - t0);
        this.locoTargetWeights.walk = 1 - t;
        this.locoTargetWeights.jog = t;
        this.locoTargetWeights.sprint = 0;
      } else if (horizontalSpeed <= t1) {
        const t = (horizontalSpeed - mid) / (t1 - mid);
        this.locoTargetWeights.walk = 0;
        this.locoTargetWeights.jog = 1 - t;
        this.locoTargetWeights.sprint = t;
      } else {
        this.locoTargetWeights.walk = 0;
        this.locoTargetWeights.jog = 0;
        this.locoTargetWeights.sprint = 1;
      }

      const a = this.forwardAlignment;
      if (this.locoWalk) this.locoWalk.timeScale = Math.max(0.1, (a * horizontalSpeed) / WALK_AUTHORED_SPEED);
      if (this.locoJog) this.locoJog.timeScale = Math.max(0.1, (a * horizontalSpeed) / JOG_AUTHORED_SPEED);
      if (this.locoSprint) this.locoSprint.timeScale = Math.max(0.1, (a * horizontalSpeed) / SPRINT_AUTHORED_SPEED);
    }

    if (this.currentState === STATE.crouch && this.crouchIdleAction && this.crouchMoveAction) {
      this.updateSpeedSwitch(this.crouchMoveAction, horizontalSpeed, 'crouchIdleWeight', 'crouchMoveWeight');
    }
    if (this.currentState === STATE.carry && this.carryIdleAction && this.carryMoveAction) {
      this.updateSpeedSwitch(this.carryMoveAction, horizontalSpeed, 'carryIdleWeight', 'carryMoveWeight');
    }
  }

  isClipFinished(): boolean {
    return this.clipFinished;
  }

  setForwardAlignment(alignment: number): void {
    this.forwardAlignment = Math.max(0.3, alignment);
  }

  /** Play any clip in the GLB by name. Additive clips overlay locomotion; others override. */
  playOneShot(clipName: string, fadeDuration = 0.2): void {
    const originalClip = this.model.clips.get(clipName);
    if (!originalClip) {
      console.warn(`[AnimationController] OneShot clip "${clipName}" not found`);
      return;
    }
    const isAdditive = this.additiveClipNames.has(clipName);

    if (!isAdditive) {
      if (this.currentAction) this.currentAction.fadeOut(fadeDuration);
      if (this.locoActive) this.deactivateLocomotion(fadeDuration);
      this.deactivateSpeedSwitch(this.crouchIdleAction, this.crouchMoveAction, fadeDuration);
      this.deactivateSpeedSwitch(this.carryIdleAction, this.carryMoveAction, fadeDuration);
    }

    let action = this.oneShotActions.get(clipName);
    if (!action) {
      action = this.mixer.clipAction(originalClip.clone());
      this.oneShotActions.set(clipName, action);
    }
    action.reset();
    action.loop = THREE.LoopOnce;
    action.clampWhenFinished = true;
    action.fadeIn(fadeDuration).play();
    this.currentOneShotClipName = clipName;
    this.firedEvents.clear();

    if (isAdditive) {
      this.additiveAction = action;
    } else {
      this.currentAction = action;
      // Clear currentState so the next setState() always re-fades into the
      // returning state (e.g. dead → idle on respawn) instead of treating
      // it as a no-op when the FSM was already in that state pre-override.
      this.currentState = null;
      this.oneShotActive = true;
      this.clipFinished = false;
    }
  }

  resetOneShot(): void {
    this.oneShotActive = false;
  }

  /** Freeze the mixer for ragdoll mode. The last animated pose is preserved in bone transforms. */
  stopAll(): void {
    this.mixer.stopAllAction();
    this.currentAction = null;
    this.additiveAction = null;
    this.oneShotActive = false;
    this.locoActive = false;
    this.currentState = null;
  }

  /** Resume animation from idle after ragdoll deactivation. */
  restoreState(): void {
    this.playImmediate(STATE.idle);
  }

  update(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;

    if (this.locoActive) {
      const factor = 1 - Math.exp(-WEIGHT_LAMBDA * dt);
      this.locoWeights.walk += (this.locoTargetWeights.walk - this.locoWeights.walk) * factor;
      this.locoWeights.jog += (this.locoTargetWeights.jog - this.locoWeights.jog) * factor;
      this.locoWeights.sprint += (this.locoTargetWeights.sprint - this.locoWeights.sprint) * factor;
      if (this.locoWalk) this.locoWalk.setEffectiveWeight(this.locoWeights.walk);
      if (this.locoJog) this.locoJog.setEffectiveWeight(this.locoWeights.jog);
      if (this.locoSprint) this.locoSprint.setEffectiveWeight(this.locoWeights.sprint);
    }

    if (this.currentState === STATE.crouch && this.crouchIdleAction && this.crouchMoveAction) {
      const f = 1 - Math.exp(-WEIGHT_LAMBDA * dt);
      const curIdle = this.crouchIdleAction.getEffectiveWeight();
      const curMove = this.crouchMoveAction.getEffectiveWeight();
      this.crouchIdleAction.setEffectiveWeight(curIdle + (this.crouchIdleWeight - curIdle) * f);
      this.crouchMoveAction.setEffectiveWeight(curMove + (this.crouchMoveWeight - curMove) * f);
    }
    if (this.currentState === STATE.carry && this.carryIdleAction && this.carryMoveAction) {
      const f = 1 - Math.exp(-WEIGHT_LAMBDA * dt);
      const curIdle = this.carryIdleAction.getEffectiveWeight();
      const curMove = this.carryMoveAction.getEffectiveWeight();
      this.carryIdleAction.setEffectiveWeight(curIdle + (this.carryIdleWeight - curIdle) * f);
      this.carryMoveAction.setEffectiveWeight(curMove + (this.carryMoveWeight - curMove) * f);
    }

    this.mixer.update(dt);

    const oneShotAction = this.additiveAction ?? (this.oneShotActive ? this.currentAction : null);
    if (this.currentOneShotClipName && oneShotAction && this.profile.animationEvents) {
      const markers = this.profile.animationEvents[this.currentOneShotClipName];
      if (markers) {
        const time = oneShotAction.time;
        for (const marker of markers) {
          const key = `${this.currentOneShotClipName}:${marker.event}`;
          if (time >= marker.time && !this.firedEvents.has(key)) {
            this.firedEvents.add(key);
            this.eventListener?.onActionEvent?.(this.currentOneShotClipName, marker.event);
          }
        }
      }
    }
  }

  dispose(): void {
    this.mixer.removeEventListener('finished', this.onMixerFinished);
    this.mixer.removeEventListener('loop', this.onMixerLoop);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model.root);
    this.actions.clear();
    this.oneShotActions.clear();
    this.currentAction = null;
    this.additiveAction = null;
    this.locoWalk = null;
    this.locoJog = null;
    this.locoSprint = null;
  }

  private resolveAction(state: StateId): THREE.AnimationAction | null {
    const direct = this.actions.get(state);
    if (direct) return direct;
    const fallback = this.profile.fallbacks?.[state];
    if (fallback) {
      const fallbackAction = this.actions.get(fallback);
      if (fallbackAction) return fallbackAction;
    }
    return this.actions.get(STATE.idle) ?? null;
  }

  private activateLocomotion(): void {
    this.locoActive = true;
    this.setSpeed(this.speed);
    this.locoWeights.walk = 0;
    this.locoWeights.jog = 0;
    this.locoWeights.sprint = 0;
    if (this.locoWalk) {
      this.locoWalk.reset().play();
      this.locoWalk.setEffectiveWeight(0);
    }
    if (this.locoJog) {
      this.locoJog.reset().play();
      this.locoJog.setEffectiveWeight(0);
    }
    if (this.locoSprint) {
      this.locoSprint.reset().play();
      this.locoSprint.setEffectiveWeight(0);
    }
  }

  private deactivateLocomotion(fadeDuration: number): void {
    this.locoActive = false;
    if (this.locoWalk) this.locoWalk.fadeOut(fadeDuration);
    if (this.locoJog) this.locoJog.fadeOut(fadeDuration);
    if (this.locoSprint) this.locoSprint.fadeOut(fadeDuration);
  }

  private activateSpeedSwitch(
    idleAction: THREE.AnimationAction | null,
    moveAction: THREE.AnimationAction | null,
  ): void {
    const moving = this.speed > SPEED_SWITCH_THRESHOLD;
    if (idleAction) {
      idleAction.reset().play();
      idleAction.setEffectiveWeight(moving ? 0 : 1);
    }
    if (moveAction) {
      moveAction.reset().play();
      moveAction.setEffectiveWeight(moving ? 1 : 0);
    }
  }

  private deactivateSpeedSwitch(
    idleAction: THREE.AnimationAction | null,
    moveAction: THREE.AnimationAction | null,
    fadeDuration: number,
  ): void {
    if (idleAction) idleAction.fadeOut(fadeDuration);
    if (moveAction) moveAction.fadeOut(fadeDuration);
  }

  private updateSpeedSwitch(
    moveAction: THREE.AnimationAction,
    speed: number,
    idleWeightKey: 'crouchIdleWeight' | 'carryIdleWeight',
    moveWeightKey: 'crouchMoveWeight' | 'carryMoveWeight',
  ): void {
    this[idleWeightKey] = speed > SPEED_SWITCH_THRESHOLD ? 0 : 1;
    this[moveWeightKey] = speed > SPEED_SWITCH_THRESHOLD ? 1 : 0;
    moveAction.timeScale = speed > SPEED_SWITCH_THRESHOLD ? Math.max(0.1, speed / WALK_AUTHORED_SPEED) : 1.0;
  }
}
