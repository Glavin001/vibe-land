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
  targetPlayerId: number | null;
  mode: 'acquire_target' | 'follow_target' | 'recover_center' | 'hold_anchor' | 'dead';
}

export type Behavior = (ctx: BotBehaviorContext) => BehaviorDecision;

const DEAD_DECISION: BehaviorDecision = {
  target: null,
  fireAim: null,
  targetPlayerId: null,
  mode: 'dead',
};

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
  acquireDistanceM?: number;
  recoveryDistanceM?: number;
  fireDistanceM?: number;
}

export function harassNearest(options: HarassNearestOptions = {}): Behavior {
  const acquire = options.acquireDistanceM ?? 40;
  const fireRange = options.fireDistanceM ?? 18;

  return (ctx) => {
    const { self, remotePlayers, anchor } = ctx;
    if (self.dead) return DEAD_DECISION;

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
