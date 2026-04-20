/**
 * Per-bot glue object for behavior + crowd + steering.
 */

import type { BotCrowd, BotHandle } from '../crowd/BotCrowd';
import { agentStateToIntent, createSteeringState, type SteeringOptions, type SteeringState } from './steering';
import type { Behavior, BotBehaviorContext } from './behaviors';
import { BotPerception, DEFAULT_PERCEPTION_CONFIG, type PerceptionConfig, type RaycastFn } from './perception';
import type { BotIntent, BotSelfState, ObservedPlayer, Vec3Tuple } from '../types';

export interface BotBrainOptions extends SteeringOptions {
  anchor?: Vec3Tuple;
  retargetDistanceSqM?: number;
  maxTicksBetweenReplans?: number;
  /**
   * Optional raycast callback used for line-of-sight checks in perception.
   * If null/undefined, perception falls back to FOV-only filtering.
   */
  raycast?: RaycastFn | null;
  /** Optional perception tuning — falls back to {@link DEFAULT_PERCEPTION_CONFIG}. */
  perception?: Partial<PerceptionConfig>;
}

export class BotBrain {
  readonly handle: BotHandle;
  readonly crowd: BotCrowd;
  readonly perception: BotPerception;
  private behavior: Behavior;
  private readonly steer: SteeringState;
  private readonly options: BotBrainOptions;
  private readonly perceptionConfig: PerceptionConfig;
  private readonly raycast: RaycastFn | null;
  private anchor: Vec3Tuple;
  private tick = 0;
  private lastTarget: Vec3Tuple | null = null;
  private ticksSinceReplan = 0;
  private lastDecisionTarget: Vec3Tuple | null = null;
  private lastMoveAccepted: boolean | null = null;
  private lastLookYaw: number | null = null;

  constructor(
    crowd: BotCrowd,
    handle: BotHandle,
    behavior: Behavior,
    options: BotBrainOptions = {},
  ) {
    this.crowd = crowd;
    this.handle = handle;
    this.behavior = behavior;
    this.options = options;
    this.steer = createSteeringState();
    this.perception = new BotPerception();
    this.perceptionConfig = { ...DEFAULT_PERCEPTION_CONFIG, ...(options.perception ?? {}) };
    this.raycast = options.raycast ?? null;
    const agent = crowd.getAgent(handle.id);
    this.anchor = options.anchor ?? (agent
      ? [agent.position[0], agent.position[1], agent.position[2]] as Vec3Tuple
      : [0, 0, 0]);
  }

  setBehavior(behavior: Behavior): void {
    this.behavior = behavior;
    this.lastTarget = null;
  }

  setAnchor(anchor: Vec3Tuple): void {
    this.anchor = [anchor[0], anchor[1], anchor[2]];
    this.lastTarget = null;
  }

  getAnchor(): Vec3Tuple {
    return [this.anchor[0], this.anchor[1], this.anchor[2]];
  }

  think(self: BotSelfState, remotePlayers: readonly ObservedPlayer[]): BotIntent {
    this.tick += 1;
    this.crowd.syncBotPosition(this.handle, self.position);

    // Filter raw observations through perception (FOV + LOS). Behaviors
    // treat the filtered list as their "currently visible" input.
    const visible = this.perception.observe(
      self,
      remotePlayers,
      this.raycast,
      this.tick,
      this.perceptionConfig,
    );
    const ctx: BotBehaviorContext = {
      self,
      remotePlayers: visible,
      anchor: this.anchor,
      tick: this.tick,
      perception: this.perception,
      isCurious: this.perception.isCurious(this.tick),
    };
    const decision = this.behavior(ctx);
    this.lastDecisionTarget = decision.target ? [...decision.target] : null;
    this.lastLookYaw = decision.lookYaw ?? null;
    const targetDistanceM = decision.target
      ? Math.hypot(
          decision.target[0] - self.position[0],
          decision.target[2] - self.position[2],
        )
      : null;

    if (decision.target) {
      const shouldReplan = this.shouldReplan(decision.target);
      if (shouldReplan) {
        const accepted = this.crowd.requestMoveTo(this.handle, decision.target);
        this.lastMoveAccepted = accepted;
        if (accepted) {
          this.lastTarget = [...decision.target];
          this.ticksSinceReplan = 0;
        } else {
          this.crowd.stop(this.handle);
          this.lastTarget = null;
        }
      } else {
        this.ticksSinceReplan += 1;
      }
    } else if (this.lastTarget !== null) {
      this.crowd.stop(this.handle);
      this.lastTarget = null;
      this.ticksSinceReplan = 0;
      this.lastMoveAccepted = null;
    }

    const agent = this.crowd.getAgent(this.handle.id);
    return agentStateToIntent(
      agent,
      self,
      this.steer,
      decision.mode,
      decision.targetPlayerId,
      targetDistanceM,
      decision.fireAim,
      decision.meleeAim,
      this.options,
      decision.fireAimVelocity ?? null,
      decision.lookYaw ?? null,
    );
  }

  /**
   * Forward the bot's current HP and target-acquisition state into the
   * perception layer so it can detect damage and enter curious mode.
   * Called once per tick by the runtime after it knows whether the bot has
   * a visible target (derived from the previously emitted intent).
   */
  notePerceptionTick(
    currentHp: number,
    hasTarget: boolean,
    yaw: number,
  ): void {
    this.perception.noteHp(currentHp, this.tick, hasTarget, yaw, this.perceptionConfig);
  }

  getDebugState(): {
    rawTarget: Vec3Tuple | null;
    lastMoveAccepted: boolean | null;
    ticksSinceReplan: number;
    memorySize: number;
    curious: boolean;
    lookYaw: number | null;
  } {
    const p = this.perception.getDebugState(this.tick);
    return {
      rawTarget: this.lastDecisionTarget ? [...this.lastDecisionTarget] : null,
      lastMoveAccepted: this.lastMoveAccepted,
      ticksSinceReplan: this.ticksSinceReplan,
      memorySize: p.memorySize,
      curious: p.curious,
      lookYaw: this.lastLookYaw,
    };
  }

  private shouldReplan(target: Vec3Tuple): boolean {
    if (this.lastTarget === null) return true;
    const maxTicks = this.options.maxTicksBetweenReplans ?? 30;
    if (this.ticksSinceReplan >= maxTicks) return true;
    const dx = target[0] - this.lastTarget[0];
    const dy = target[1] - this.lastTarget[1];
    const dz = target[2] - this.lastTarget[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    const threshold = this.options.retargetDistanceSqM ?? 0.25;
    return distSq >= threshold;
  }
}
