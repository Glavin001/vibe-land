/**
 * Composable behavior primitives for bots.
 */

import type { BotPersonality } from '../config/botPersonality';
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
  stopDistanceM?: number;
  orbitDistanceM?: number;
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
  const stopDistance = options.stopDistanceM ?? 1.6;
  const orbitDistance = Math.max(stopDistance, options.orbitDistanceM ?? 4.5);
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
    wasInFireWindow: false,
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
      const moveTarget = inMelee
        ? null
        : computeHarassMoveTarget(
            self.position,
            nearest.player.position,
            stopDistance,
            orbitDistance,
          );
      state.lockedPlayerId = nearest.player.id;
      state.lastKnownTarget = [
        nearest.player.position[0],
        nearest.player.position[1],
        nearest.player.position[2],
      ];
      state.lastSeenTick = ctx.tick;
      if (inFireWindow && !state.wasInFireWindow) {
        state.standUntilTick = ctx.tick + standAndShootTicks;
      }
      state.wasInFireWindow = inFireWindow;
      const standing = inFireWindow && ctx.tick <= state.standUntilTick;
      return {
        target: standing ? null : moveTarget,
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
      state.wasInFireWindow = false;
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
    state.wasInFireWindow = false;

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
  /** Whether the planar distance leash is active at all. */
  enableDistanceRecovery?: boolean;
  /** Y-coordinate below which the bot is considered "off the arena" and recovers. */
  recoveryFloorY?: number;
  /**
   * Which reference frame to use for the vertical recovery check.
   * `absolute` preserves arena semantics; `anchor` treats "fell off" as
   * dropping well below the bot's spawn/home plane.
   */
  recoveryFloorReference?: 'absolute' | 'anchor';
  /**
   * When `recoveryFloorReference === 'anchor'`, trigger vertical recovery
   * once the bot has dropped this far below its anchor Y.
   */
  recoveryDropBelowAnchorM?: number;
  /**
   * Which XZ reference point the recovery-distance check is measured from.
   * `origin` preserves the arena-loadtest semantics; `anchor` is better for
   * freeform practice worlds where combat may not happen around (0, 0).
   */
  recoveryReference?: 'origin' | 'anchor';
  /**
   * Where the bot retreats once recovery triggers.
   * `center` means arena center `[0, anchorY, 0]`; `anchor` means home spawn.
   */
  recoveryTarget?: 'center' | 'anchor';
  /** When true, the bot retreats to center if it has no acquired target (instead of holding anchor). */
  preferCenterWhenIdle?: boolean;
  /** Optional secondary fire intent: enables aiming at the arena center when no player is in fireRange. */
  fireAtCenter?: boolean;
}

/**
 * Like {@link harassNearest}, but adds the load-test arena semantics:
 *
 *  - If the bot has fallen off the arena (`y < recoveryFloorY`) or wandered
 *    too far from origin, it retreats to the arena center on its anchor plane
 *    and emits no fire/melee.
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
  const enableDistanceRecovery = options.enableDistanceRecovery ?? true;
  const recoveryFloorY = options.recoveryFloorY ?? 0.5;
  const recoveryFloorReference = options.recoveryFloorReference ?? 'absolute';
  const recoveryDropBelowAnchorM = options.recoveryDropBelowAnchorM ?? 2.0;
  const recoveryReference = options.recoveryReference ?? 'origin';
  const recoveryTarget = options.recoveryTarget ?? 'center';
  const preferCenterWhenIdle = options.preferCenterWhenIdle ?? false;
  const fireAtCenter = options.fireAtCenter ?? false;
  const fireRange = options.fireDistanceM ?? 18;
  const inner = harassNearest(options);
  const CENTER_AIM: Vec3Tuple = [0, 1.0, 0];

  return (ctx) => {
    const { self, anchor } = ctx;
    if (self.dead) return DEAD_DECISION;

    const recoveryDx = self.position[0] - (recoveryReference === 'anchor' ? anchor[0] : 0);
    const recoveryDz = self.position[2] - (recoveryReference === 'anchor' ? anchor[2] : 0);
    const centerDistance = Math.hypot(self.position[0], self.position[2]);
    const recoveryDistanceFromReference = Math.hypot(recoveryDx, recoveryDz);
    const recoveryPoint: Vec3Tuple = recoveryTarget === 'anchor'
      ? [anchor[0], anchor[1], anchor[2]]
      : [0, anchor[1], 0];
    const fellBelowRecoveryFloor = recoveryFloorReference === 'anchor'
      ? self.position[1] < anchor[1] - recoveryDropBelowAnchorM
      : self.position[1] < recoveryFloorY;
    if (
      fellBelowRecoveryFloor
      || (enableDistanceRecovery && recoveryDistanceFromReference > recoveryDistance)
    ) {
      return {
        target: recoveryPoint,
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
        target: recoveryPoint,
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

/**
 * Construct the `Behavior` driven by a unified {@link BotPersonality}. Both
 * {@link PracticeBotRuntime} and {@link LoadTestBotRuntime} call this so
 * that a personality JSON produces the exact same in-game behavior whether
 * the bot is running locally or over WebTransport.
 */
export function makeBehaviorFromPersonality(
  personality: BotPersonality,
  options: {
    fireAtCenter?: boolean;
    preferCenterWhenIdle?: boolean;
    enableDistanceRecovery?: boolean;
    recoveryFloorReference?: 'absolute' | 'anchor';
    recoveryDropBelowAnchorM?: number;
    recoveryReference?: 'origin' | 'anchor';
    recoveryTarget?: 'center' | 'anchor';
  } = {},
): Behavior {
  switch (personality.behaviorKind) {
    case 'wander':
      return wander({ radiusM: 18 });
    case 'hold':
      return holdAnchor();
    case 'harass':
    default:
      return arenaHarass({
        acquireDistanceM: personality.targetAcquireDistanceM,
        releaseDistanceM: personality.targetReleaseDistanceM,
        stopDistanceM: personality.stopDistanceM,
        orbitDistanceM: personality.orbitDistanceM,
        targetMemoryTicks: personality.targetMemoryTicks,
        recoveryDistanceM: personality.recoveryDistanceM,
        enableDistanceRecovery: options.enableDistanceRecovery ?? true,
        recoveryFloorReference: options.recoveryFloorReference ?? 'absolute',
        recoveryDropBelowAnchorM: options.recoveryDropBelowAnchorM ?? 2.0,
        recoveryReference: options.recoveryReference ?? 'origin',
        recoveryTarget: options.recoveryTarget ?? 'center',
        fireDistanceM: personality.fireMode === 'off' ? 0 : personality.fireDistanceM,
        minFireDistanceM: personality.minFireDistanceM,
        standAndShootTicks: personality.standAndShootTicks,
        meleeDistanceM: personality.meleeDistanceM,
        meleeAgainstVehicleDistanceM: personality.meleeAgainstVehicleDistanceM,
        preferCenterWhenIdle: options.preferCenterWhenIdle ?? false,
        fireAtCenter:
          options.fireAtCenter
          ?? (personality.fireMode === 'center'
            || personality.fireMode === 'nearest_target_or_center'),
      });
  }
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

function computeHarassMoveTarget(
  self: Vec3Tuple,
  target: Vec3Tuple,
  stopDistanceM: number,
  orbitDistanceM: number,
): Vec3Tuple | null {
  const dx = target[0] - self[0];
  const dz = target[2] - self[2];
  const planarDistance = Math.hypot(dx, dz);
  if (planarDistance <= stopDistanceM) {
    return null;
  }

  const targetY = target[1];
  if (planarDistance > orbitDistanceM) {
    const scale = orbitDistanceM / Math.max(planarDistance, 0.0001);
    return [
      target[0] - dx * scale,
      targetY,
      target[2] - dz * scale,
    ];
  }

  const orbitAdvance = Math.min(Math.max(orbitDistanceM * 0.35, 0.75), 2.0);
  const invDistance = 1 / Math.max(planarDistance, 0.0001);
  const radialX = -dx * invDistance;
  const radialZ = -dz * invDistance;
  const tangentX = -radialZ;
  const tangentZ = radialX;
  const orbitDirX = radialX * orbitDistanceM + tangentX * orbitAdvance;
  const orbitDirZ = radialZ * orbitDistanceM + tangentZ * orbitAdvance;
  const orbitDirLength = Math.hypot(orbitDirX, orbitDirZ);
  const scale = orbitDistanceM / Math.max(orbitDirLength, 0.0001);
  return [
    target[0] + orbitDirX * scale,
    targetY,
    target[2] + orbitDirZ * scale,
  ];
}
