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
  meleeDistanceM?: number;
  meleeAgainstVehicleDistanceM?: number;
  targetMemoryTicks?: number;
}

export function harassNearest(options: HarassNearestOptions = {}): Behavior {
  const acquire = options.acquireDistanceM ?? 40;
  const release = options.releaseDistanceM ?? acquire * 1.5;
  const fireRange = options.fireDistanceM ?? 18;
  const meleeRange = options.meleeDistanceM ?? 2.0;
  const meleeVehicleRange = options.meleeAgainstVehicleDistanceM ?? 3.0;
  const targetMemoryTicks = options.targetMemoryTicks ?? 45;
  const state = {
    lockedPlayerId: null as number | null,
    lastKnownTarget: null as Vec3Tuple | null,
    lastSeenTick: -Infinity,
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
      const fireAim = !inMelee && nearest.distance <= fireRange ? nearest.player.position : null;
      const meleeAim = inMelee ? nearest.player.position : null;
      state.lockedPlayerId = nearest.player.id;
      state.lastKnownTarget = [
        nearest.player.position[0],
        nearest.player.position[1],
        nearest.player.position[2],
      ];
      state.lastSeenTick = ctx.tick;
      return {
        target: [
          nearest.player.position[0],
          nearest.player.position[1],
          nearest.player.position[2],
        ],
        fireAim,
        meleeAim,
        targetPlayerId: nearest.player.id,
        mode: 'follow_target',
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
