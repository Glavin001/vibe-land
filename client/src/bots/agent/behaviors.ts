/**
 * Composable behavior primitives for bots.
 *
 * A {@link Behavior} is a plain function that is invoked each tick with the
 * current {@link BotBehaviorContext} and returns a {@link BehaviorDecision}
 * describing the next high-level goal: a world-space move target, optional
 * fire target, optional manual stop.
 *
 * Behaviors are designed to be composable — higher-level behaviors like
 * `harassNearest` are just predicates that delegate to `followNearest` or
 * `holdAnchor`.
 *
 * Consumers (loadtest, custom bot scripts) read the decision and call
 * `BotCrowd.requestMoveTo` + `agentStateToIntent` themselves.
 */

import type { BotSelfState, ObservedPlayer, Vec3Tuple } from '../types';

export interface BotBehaviorContext {
  /** Self state from the latest server snapshot. */
  self: BotSelfState;
  /** Remote players the bot can see. */
  remotePlayers: readonly ObservedPlayer[];
  /** Anchor position (x, z), for patrols and fallbacks. */
  anchor: Vec3Tuple;
  /** Monotonically increasing tick counter. */
  tick: number;
}

export interface BehaviorDecision {
  /** World-space destination the bot should move toward. */
  target: Vec3Tuple | null;
  /** World-space point the bot should try to shoot at, or null. */
  fireAim: Vec3Tuple | null;
  /** Currently targeted remote player (if any) for telemetry. */
  targetPlayerId: number | null;
  /** High-level mode label for telemetry. */
  mode: 'acquire_target' | 'follow_target' | 'recover_center' | 'hold_anchor' | 'dead';
}

export type Behavior = (ctx: BotBehaviorContext) => BehaviorDecision;

const DEAD_DECISION: BehaviorDecision = {
  target: null,
  fireAim: null,
  targetPlayerId: null,
  mode: 'dead',
};

/**
 * Always move toward the given static point. Useful for scripted test bots.
 */
export function moveTo(point: Vec3Tuple): Behavior {
  return ({ self }) => {
    if (self.dead) return DEAD_DECISION;
    return {
      target: [point[0], point[1], point[2]],
      fireAim: null,
      targetPlayerId: null,
      mode: 'follow_target',
    };
  };
}

/** Holds a fixed anchor position. */
export function holdAnchor(anchor?: Vec3Tuple): Behavior {
  return ({ self, anchor: ctxAnchor }) => {
    if (self.dead) return DEAD_DECISION;
    const a = anchor ?? ctxAnchor;
    return {
      target: [a[0], self.position[1], a[2]],
      fireAim: null,
      targetPlayerId: null,
      mode: 'hold_anchor',
    };
  };
}

export interface HarassNearestOptions {
  /** Only acquire targets within this planar distance (meters). */
  acquireDistanceM?: number;
  /** If the bot wanders outside this planar radius from origin, recover. */
  recoveryDistanceM?: number;
  /** Within this distance, start firing at the target. */
  fireDistanceM?: number;
}

/**
 * Chase the nearest living remote player. If no one is in range, recover to
 * the origin (when outside `recoveryDistanceM`) or hold the anchor.
 *
 * Mirrors the FSM that lived inside `loadtest/brain.ts` before the framework
 * refactor, but with navmesh-aware steering handled upstream.
 */
export function harassNearest(options: HarassNearestOptions = {}): Behavior {
  const acquire = options.acquireDistanceM ?? 40;
  const recovery = options.recoveryDistanceM ?? 32;
  const fireRange = options.fireDistanceM ?? 18;

  return (ctx) => {
    const { self, remotePlayers, anchor } = ctx;
    if (self.dead) return DEAD_DECISION;

    const centerDistance = Math.hypot(self.position[0], self.position[2]);
    const fallingOff = self.position[1] < 0.5 || centerDistance > recovery;

    if (fallingOff) {
      return {
        target: [0, self.position[1], 0],
        fireAim: null,
        targetPlayerId: null,
        mode: 'recover_center',
      };
    }

    const nearest = findNearest(self.position, remotePlayers);
    if (nearest && nearest.distance <= acquire) {
      const fireAim = nearest.distance <= fireRange ? nearest.player.position : null;
      return {
        target: [
          nearest.player.position[0],
          nearest.player.position[1],
          nearest.player.position[2],
        ],
        fireAim,
        targetPlayerId: nearest.player.id,
        mode: 'follow_target',
      };
    }

    return {
      target: [anchor[0], self.position[1], anchor[2]],
      fireAim: null,
      targetPlayerId: null,
      mode: 'hold_anchor',
    };
  };
}

export interface WanderOptions {
  /** Planar radius (meters) the wander target is chosen within. */
  radiusM?: number;
  /** Ticks between picking new wander targets. */
  retargetEveryTicks?: number;
}

/**
 * Picks a random walkable-looking point every N ticks and strolls toward it.
 */
export function wander(options: WanderOptions = {}): Behavior {
  const radius = options.radiusM ?? 25;
  const retarget = options.retargetEveryTicks ?? 120;
  const state = { target: null as Vec3Tuple | null, lastTick: -Infinity };
  return (ctx) => {
    if (ctx.self.dead) return DEAD_DECISION;
    if (state.target === null || ctx.tick - state.lastTick >= retarget) {
      const a = (ctx.tick * 0.73 + ctx.self.position[0] * 0.11) % (Math.PI * 2);
      const r = radius * (0.3 + 0.7 * (((ctx.tick * 2654435761) >>> 0) % 1000) / 1000);
      state.target = [
        ctx.anchor[0] + Math.cos(a) * r,
        ctx.self.position[1],
        ctx.anchor[2] + Math.sin(a) * r,
      ];
      state.lastTick = ctx.tick;
    }
    return {
      target: state.target,
      fireAim: null,
      targetPlayerId: null,
      mode: 'hold_anchor',
    };
  };
}

function findNearest(
  self: Vec3Tuple,
  players: readonly ObservedPlayer[],
): { player: ObservedPlayer; distance: number } | null {
  let best: { player: ObservedPlayer; distance: number } | null = null;
  for (const player of players) {
    if (player.isDead) continue;
    const distance = Math.hypot(
      player.position[0] - self[0],
      player.position[2] - self[2],
    );
    if (!best || distance < best.distance) {
      best = { player, distance };
    }
  }
  return best;
}
