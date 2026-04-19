/**
 * Composable behavior primitives for bots.
 */

import type { BotSelfState, ObservedPlayer, Vec3Tuple } from '../types';

export interface BotBehaviorContext {
  self: BotSelfState;
  remotePlayers: readonly ObservedPlayer[];
  anchor: Vec3Tuple;
  tick: number;
}

export interface BehaviorDecision {
  target: Vec3Tuple | null;
  fireAim: Vec3Tuple | null;
  /** Velocity of the target being aimed at (for aim-lead). Optional. */
  fireAimVelocity?: Vec3Tuple | null;
  meleeAim: Vec3Tuple | null;
  targetPlayerId: number | null;
  mode: 'acquire_target' | 'follow_target' | 'recover_center' | 'hold_anchor' | 'dead';
}

export type Behavior = (ctx: BotBehaviorContext) => BehaviorDecision;

const DEAD_DECISION: BehaviorDecision = {
  target: null,
  fireAim: null,
  meleeAim: null,
  targetPlayerId: null,
  mode: 'dead',
};

export function moveTo(point: Vec3Tuple): Behavior {
  return ({ self }) => {
    if (self.dead) return DEAD_DECISION;
    return {
      target: [point[0], point[1], point[2]],
      fireAim: null,
      meleeAim: null,
      targetPlayerId: null,
      mode: 'follow_target',
    };
  };
}

export function holdAnchor(anchor?: Vec3Tuple): Behavior {
  return ({ self, anchor: ctxAnchor }) => {
    if (self.dead) return DEAD_DECISION;
    const a = anchor ?? ctxAnchor;
    return {
      target: [a[0], self.position[1], a[2]],
      fireAim: null,
      meleeAim: null,
      targetPlayerId: null,
      mode: 'hold_anchor',
    };
  };
}

export interface HarassNearestOptions {
  acquireDistanceM?: number;
  releaseDistanceM?: number;
  fireDistanceM?: number;
  /**
   * Minimum planar distance below which a bot will not try to fire. Prevents
   * point-blank shots while the bot is physically clipping the target.
   */
  minFireDistanceM?: number;
  meleeDistanceM?: number;
  meleeAgainstVehicleDistanceM?: number;
  targetMemoryTicks?: number;
  /**
   * Once a bot enters its fire window it stops moving for this many ticks so
   * it visibly pauses to shoot rather than running through the target.
   */
  standAndShootTicks?: number;
}

export function harassNearest(options: HarassNearestOptions = {}): Behavior {
  const acquire = options.acquireDistanceM ?? 40;
  const release = options.releaseDistanceM ?? acquire * 1.5;
  const fireRange = options.fireDistanceM ?? 18;
  const minFireRange = options.minFireDistanceM ?? 1.5;
  const meleeRange = options.meleeDistanceM ?? 2.0;
  const meleeVehicleRange = options.meleeAgainstVehicleDistanceM ?? 3.0;
  const targetMemoryTicks = options.targetMemoryTicks ?? 45;
  const standAndShootTicks = options.standAndShootTicks ?? 18;
  const state = {
    lockedPlayerId: null as number | null,
    lastKnownTarget: null as Vec3Tuple | null,
    lastSeenTick: -Infinity,
    standUntilTick: -Infinity,
  };

  return (ctx) => {
    const { self, remotePlayers, anchor } = ctx;
    if (self.dead) return DEAD_DECISION;

    const locked = state.lockedPlayerId != null
      ? findById(self.position, remotePlayers, state.lockedPlayerId)
      : null;
    const nearest = locked ?? findNearest(self.position, remotePlayers);
    const shouldFollowObserved = nearest
      && (
        nearest.distance <= acquire
        || (
          state.lockedPlayerId === nearest.player.id
          && nearest.distance <= release
        )
      );

    if (shouldFollowObserved) {
      const meleeThreshold = nearest.player.isInVehicle ? meleeVehicleRange : meleeRange;
      const inMelee = nearest.distance <= meleeThreshold;
      const inFireWindow = !inMelee
        && nearest.distance <= fireRange
        && nearest.distance >= minFireRange;
      const fireAim = inFireWindow ? nearest.player.position : null;
      const fireAimVelocity = inFireWindow && nearest.player.velocity
        ? ([
            nearest.player.velocity[0],
            nearest.player.velocity[1],
            nearest.player.velocity[2],
          ] as Vec3Tuple)
        : null;
      const meleeAim = inMelee ? nearest.player.position : null;
      state.lockedPlayerId = nearest.player.id;
      state.lastKnownTarget = [
        nearest.player.position[0],
        nearest.player.position[1],
        nearest.player.position[2],
      ];
      state.lastSeenTick = ctx.tick;
      if (inFireWindow) {
        state.standUntilTick = ctx.tick + standAndShootTicks;
      }
      const standing = ctx.tick <= state.standUntilTick;
      return {
        target: standing
          ? null
          : [
              nearest.player.position[0],
              nearest.player.position[1],
              nearest.player.position[2],
            ],
        fireAim,
        fireAimVelocity,
        meleeAim,
        targetPlayerId: nearest.player.id,
        mode: standing ? 'acquire_target' : 'follow_target',
      };
    }

    if (
      state.lockedPlayerId !== null
      && state.lastKnownTarget
      && ctx.tick - state.lastSeenTick <= targetMemoryTicks
    ) {
      return {
        target: [
          state.lastKnownTarget[0],
          state.lastKnownTarget[1],
          state.lastKnownTarget[2],
        ],
        fireAim: null,
        meleeAim: null,
        targetPlayerId: state.lockedPlayerId,
        mode: 'follow_target',
      };
    }

    state.lockedPlayerId = null;
    state.lastKnownTarget = null;

    return {
      target: [anchor[0], self.position[1], anchor[2]],
      fireAim: null,
      meleeAim: null,
      targetPlayerId: null,
      mode: 'hold_anchor',
    };
  };
}

export interface ArenaHarassOptions extends HarassNearestOptions {
  /** Distance from arena origin (XZ plane) above which the bot retreats to center. */
  recoveryDistanceM?: number;
  /** Y-coordinate below which the bot is considered "off the arena" and recovers. */
  recoveryFloorY?: number;
  /** When true, the bot retreats to center if it has no acquired target (instead of holding anchor). */
  preferCenterWhenIdle?: boolean;
  /** Optional secondary fire intent: enables aiming at the arena center when no player is in fireRange. */
  fireAtCenter?: boolean;
}

/**
 * Like {@link harassNearest}, but adds the load-test arena semantics:
 *
 *  - If the bot has fallen off the arena (`y < recoveryFloorY`) or wandered
 *    too far from origin, it retreats to `(0, y, 0)` and emits no fire/melee.
 *  - When idle and `preferCenterWhenIdle` is set (clustered spawn pattern),
 *    the bot returns to center instead of holding anchor.
 *  - When `fireAtCenter` is set, the bot's fire intent falls back to the
 *    arena center if no player is in fire range.
 *
 * This is the canonical behavior for both load-test bots and any practice
 * bot scenario that needs arena-style chase + recovery.
 */
export function arenaHarass(options: ArenaHarassOptions = {}): Behavior {
  const recoveryDistance = options.recoveryDistanceM ?? 32;
  const recoveryFloorY = options.recoveryFloorY ?? 0.5;
  const preferCenterWhenIdle = options.preferCenterWhenIdle ?? false;
  const fireAtCenter = options.fireAtCenter ?? false;
  const fireRange = options.fireDistanceM ?? 18;
  const inner = harassNearest(options);
  const CENTER_AIM: Vec3Tuple = [0, 1.0, 0];

  return (ctx) => {
    const { self } = ctx;
    if (self.dead) return DEAD_DECISION;

    const centerDistance = Math.hypot(self.position[0], self.position[2]);
    if (self.position[1] < recoveryFloorY || centerDistance > recoveryDistance) {
      return {
        target: [0, self.position[1], 0],
        fireAim: null,
        meleeAim: null,
        targetPlayerId: null,
        mode: 'recover_center',
      };
    }

    const decision = inner(ctx);

    if (decision.mode === 'hold_anchor' && preferCenterWhenIdle) {
      return {
        ...decision,
        target: [0, self.position[1], 0],
        mode: 'recover_center',
      };
    }

    if (
      fireAtCenter
      && decision.fireAim === null
      && decision.meleeAim === null
      && centerDistance <= fireRange
    ) {
      return { ...decision, fireAim: CENTER_AIM };
    }

    return decision;
  };
}

export interface WanderOptions {
  radiusM?: number;
  retargetEveryTicks?: number;
}

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
      meleeAim: null,
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

function findById(
  self: Vec3Tuple,
  players: readonly ObservedPlayer[],
  playerId: number,
): { player: ObservedPlayer; distance: number } | null {
  for (const player of players) {
    if (player.id !== playerId || player.isDead) continue;
    return {
      player,
      distance: Math.hypot(
        player.position[0] - self[0],
        player.position[2] - self[2],
      ),
    };
  }
  return null;
}
