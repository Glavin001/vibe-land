/**
 * Per-bot glue object. Owns:
 *  - a {@link BotHandle} into a shared {@link BotCrowd}
 *  - a {@link Behavior} that picks high-level move targets
 *  - a {@link SteeringState} that translates agent velocity into buttons
 *
 * Call {@link BotBrain.think} once per bot each tick _after_ the host has
 * called {@link BotCrowd.step}. `think` syncs the authoritative server
 * position into the crowd, runs the behavior, optionally re-requests a move
 * target, and returns a ready-to-send {@link BotIntent}.
 */

import type { BotCrowd, BotHandle } from '../crowd/BotCrowd';
import { agentStateToIntent, createSteeringState, type SteeringOptions, type SteeringState } from './steering';
import type { Behavior, BotBehaviorContext } from './behaviors';
import type { BotIntent, BotSelfState, ObservedPlayer, Vec3Tuple } from '../types';

export interface BotBrainOptions extends SteeringOptions {
  /** World-space anchor passed to behaviors; defaults to initial position. */
  anchor?: Vec3Tuple;
  /**
   * Minimum squared distance (meters²) a new target must differ from the
   * last-requested one before we call `requestMoveTo` again. Cheap way to
   * avoid spamming pathfinder with microscopic target churn.
   * @default 0.25 (0.5 m)
   */
  retargetDistanceSqM?: number;
  /**
   * Hard ceiling on ticks between replans, even if target hasn't moved.
   * Handles cases where a moving player drifts slowly away.
   * @default 30
   */
  maxTicksBetweenReplans?: number;
}

export class BotBrain {
  readonly handle: BotHandle;
  readonly crowd: BotCrowd;
  private behavior: Behavior;
  private readonly steer: SteeringState;
  private readonly options: BotBrainOptions;
  private readonly anchor: Vec3Tuple;
  private tick = 0;
  private lastTarget: Vec3Tuple | null = null;
  private ticksSinceReplan = 0;

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
    const agent = crowd.getAgent(handle.id);
    this.anchor = options.anchor ?? (agent
      ? [agent.position[0], agent.position[1], agent.position[2]] as Vec3Tuple
      : [0, 0, 0]);
  }

  /** Hot-swap the behavior without resetting steering state. */
  setBehavior(behavior: Behavior): void {
    this.behavior = behavior;
    this.lastTarget = null;
  }

  /**
   * Produces a {@link BotIntent} for this tick.
   *
   * @param self           The latest server-authoritative self state.
   * @param remotePlayers  Latest observed remote players.
   */
  think(self: BotSelfState, remotePlayers: readonly ObservedPlayer[]): BotIntent {
    this.tick += 1;

    // Sync the crowd with server truth before running the behavior, so the
    // decision is based on where we actually are.
    this.crowd.syncBotPosition(this.handle, self.position);

    const ctx: BotBehaviorContext = {
      self,
      remotePlayers,
      anchor: this.anchor,
      tick: this.tick,
    };
    const decision = this.behavior(ctx);

    if (decision.target) {
      const shouldReplan = this.shouldReplan(decision.target);
      if (shouldReplan) {
        this.crowd.requestMoveTo(this.handle, decision.target);
        this.lastTarget = [...decision.target];
        this.ticksSinceReplan = 0;
      } else {
        this.ticksSinceReplan += 1;
      }
    } else if (this.lastTarget !== null) {
      this.crowd.stop(this.handle);
      this.lastTarget = null;
      this.ticksSinceReplan = 0;
    }

    const agent = this.crowd.getAgent(this.handle.id);
    return agentStateToIntent(
      agent,
      self,
      this.steer,
      decision.mode,
      decision.targetPlayerId,
      decision.fireAim,
      this.options,
    );
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
