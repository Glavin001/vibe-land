/**
 * Loadtest-facing bot brain.
 *
 * Historically this file owned a complete FSM (target acquisition, recover,
 * hold anchor, fire, stuck detection). That logic now lives inside the
 * reusable `@/bots` framework. This file is the thin shim between the
 * loadtest runners (`simulate.ts`, `wsWorker.ts`, `LoadTest.tsx`) and the
 * framework.
 *
 * Behavior matrix:
 *   - If a {@link BotCrowd} is supplied to {@link createBotBrainState}, the
 *     brain routes through a {@link BotBrain} with the `harassNearest`
 *     behavior — bots plan paths through the navmesh and avoid each other.
 *   - If no crowd is supplied (legacy + unit-test path) the brain falls back
 *     to the original direct-steering FSM so existing tests keep passing.
 */

import {
  BTN_FORWARD,
  BTN_JUMP,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_SPRINT,
  FLAG_DEAD,
  FLAG_ON_GROUND,
  type PlayerStateMeters,
} from '../net/protocol';
import {
  BotBrain,
  behaviors,
  type BotCrowd,
  type BotHandle,
  type BotSelfState,
  type ObservedPlayer as FrameworkObservedPlayer,
  type Vec3Tuple,
} from '../bots';
import type { LoadTestScenario } from './scenario';
import { anchorForBot } from './scenario';

export type ObservedPlayer = {
  id: number;
  state: PlayerStateMeters;
};

export type BotBrainMode =
  | 'acquire_target'
  | 'follow_target'
  | 'recover_center'
  | 'hold_anchor'
  | 'dead';

export interface BotBrainState {
  mode: BotBrainMode;
  anchor: [number, number];
  orbitDirection: -1 | 1;
  jumpCooldownTicks: number;
  fireCooldownTicks: number;
  stuckTicks: number;
  airborneTicks: number;
  lastPosition: [number, number, number] | null;
  targetPlayerId: number | null;
  /**
   * Optional navmesh-aware brain. When present, stepBotBrain delegates all
   * movement decisions to it and only keeps {@link fireCooldownTicks} /
   * target-id bookkeeping locally.
   */
  navBrain: BotBrain | null;
  /** Handle into the shared crowd (for cleanup). */
  navHandle: BotHandle | null;
}

export interface BotIntent {
  buttons: number;
  yaw: number;
  pitch: number;
  mode: BotBrainMode;
  targetPlayerId: number | null;
  firePrimary: boolean;
}

export interface CreateBotBrainOptions {
  /** Shared navcat crowd. When set, the brain uses navmesh pathfinding. */
  crowd?: BotCrowd;
  /** Optional initial spawn point override (meters). */
  spawnPosition?: [number, number, number];
}

export function createBotBrainState(
  botIndex: number,
  scenario: LoadTestScenario,
  options: CreateBotBrainOptions = {},
): BotBrainState {
  const anchor = anchorForBot(botIndex, scenario);
  const state: BotBrainState = {
    mode: 'acquire_target',
    anchor,
    orbitDirection: botIndex % 2 === 0 ? 1 : -1,
    jumpCooldownTicks: 0,
    fireCooldownTicks: 0,
    stuckTicks: 0,
    airborneTicks: 0,
    lastPosition: null,
    targetPlayerId: null,
    navBrain: null,
    navHandle: null,
  };

  if (options.crowd) {
    const spawn: Vec3Tuple = options.spawnPosition ?? [anchor[0], 2.5, anchor[1]];
    const handle = options.crowd.addBot(spawn);
    const behavior = behaviors.harassNearest({
      acquireDistanceM: scenario.behavior.targetAcquireDistanceM,
      recoveryDistanceM: scenario.behavior.recoveryDistanceM,
      fireDistanceM: scenario.behavior.fireDistanceM,
    });
    state.navBrain = new BotBrain(options.crowd, handle, behavior, {
      anchor: [anchor[0], spawn[1], anchor[1]],
      stuckTicksBeforeJump: scenario.behavior.stuckTickThreshold,
      jumpCooldownTicks: scenario.behavior.jumpCooldownTicks,
    });
    state.navHandle = handle;
  }

  return state;
}

/** Removes the underlying crowd agent, if any. Call on disconnect. */
export function disposeBotBrainState(state: BotBrainState, crowd?: BotCrowd): void {
  if (state.navHandle && crowd) {
    crowd.removeBot(state.navHandle);
  }
  state.navBrain = null;
  state.navHandle = null;
}

export function stepBotBrain(
  state: BotBrainState,
  scenario: LoadTestScenario,
  localState: PlayerStateMeters | null,
  remotePlayers: ObservedPlayer[],
): BotIntent {
  if (state.navBrain) {
    return stepWithNavBrain(state, scenario, localState, remotePlayers);
  }
  return stepLegacy(state, scenario, localState, remotePlayers);
}

function stepWithNavBrain(
  state: BotBrainState,
  scenario: LoadTestScenario,
  localState: PlayerStateMeters | null,
  remotePlayers: ObservedPlayer[],
): BotIntent {
  if (!localState) {
    return { buttons: 0, yaw: 0, pitch: 0, mode: state.mode, targetPlayerId: null, firePrimary: false };
  }
  if ((localState.flags & FLAG_DEAD) !== 0) {
    state.mode = 'dead';
    state.targetPlayerId = null;
    return { buttons: 0, yaw: 0, pitch: 0, mode: 'dead', targetPlayerId: null, firePrimary: false };
  }

  const self: BotSelfState = {
    position: [...localState.position],
    velocity: [...localState.velocity],
    yaw: localState.yaw,
    pitch: localState.pitch,
    onGround: (localState.flags & FLAG_ON_GROUND) !== 0,
    dead: false,
  };

  const observed: FrameworkObservedPlayer[] = remotePlayers.map((p) => ({
    id: p.id,
    position: [...p.state.position],
    isDead: (p.state.flags & FLAG_DEAD) !== 0,
  }));

  state.fireCooldownTicks = Math.max(0, state.fireCooldownTicks - 1);
  const intent = state.navBrain!.think(self, observed);

  // Fire gating: the framework always requests fire when the behavior asks;
  // loadtest adds a fireMode + cooldown on top.
  let firePrimary = intent.firePrimary;
  if (firePrimary) {
    if (scenario.behavior.fireMode === 'off' || state.fireCooldownTicks > 0) {
      firePrimary = false;
    } else {
      state.fireCooldownTicks = scenario.behavior.fireCooldownTicks;
    }
  }

  state.mode = intent.mode;
  state.targetPlayerId = intent.targetPlayerId;

  return {
    buttons: intent.buttons,
    yaw: intent.yaw,
    pitch: intent.pitch,
    mode: intent.mode,
    targetPlayerId: intent.targetPlayerId,
    firePrimary,
  };
}

// ---------------------------------------------------------------------------
// Legacy direct-steering FSM (used when no crowd/navmesh is available, and
// by the existing unit tests).
// ---------------------------------------------------------------------------

function stepLegacy(
  state: BotBrainState,
  scenario: LoadTestScenario,
  localState: PlayerStateMeters | null,
  remotePlayers: ObservedPlayer[],
): BotIntent {
  if (!localState || (localState.flags & FLAG_DEAD) !== 0) {
    state.mode = 'dead';
    state.targetPlayerId = null;
    state.lastPosition = localState?.position ?? null;
    return { buttons: 0, yaw: 0, pitch: 0, mode: state.mode, targetPlayerId: null, firePrimary: false };
  }

  const onGround = (localState.flags & FLAG_ON_GROUND) !== 0;
  const horizontalMotion = state.lastPosition
    ? Math.hypot(
      localState.position[0] - state.lastPosition[0],
      localState.position[2] - state.lastPosition[2],
    )
    : 0;

  if (!onGround) {
    state.airborneTicks += 1;
  } else {
    state.airborneTicks = 0;
  }

  if (horizontalMotion < 0.04) {
    state.stuckTicks += 1;
  } else {
    state.stuckTicks = 0;
  }
  state.lastPosition = [...localState.position];
  state.jumpCooldownTicks = Math.max(0, state.jumpCooldownTicks - 1);
  state.fireCooldownTicks = Math.max(0, state.fireCooldownTicks - 1);

  const centerDistance = Math.hypot(localState.position[0], localState.position[2]);
  const nearest = findNearestTarget(localState.position, remotePlayers);
  const wantsRecovery =
    localState.position[1] < 0.5
    || centerDistance > scenario.behavior.recoveryDistanceM
    || state.airborneTicks > 40;

  let desired: [number, number, number];
  let targetPlayerId: number | null = null;

  if (wantsRecovery) {
    state.mode = 'recover_center';
    desired = [0, localState.position[1], 0];
  } else if (nearest && nearest.distance <= scenario.behavior.targetAcquireDistanceM) {
    state.mode = 'follow_target';
    desired = nearest.player.state.position;
    targetPlayerId = nearest.player.id;
  } else if (scenario.spawnPattern === 'clustered') {
    state.mode = 'recover_center';
    desired = [0, localState.position[1], 0];
  } else {
    state.mode = 'hold_anchor';
    desired = [state.anchor[0], localState.position[1], state.anchor[1]];
  }

  state.targetPlayerId = targetPlayerId;

  const dx = desired[0] - localState.position[0];
  const dz = desired[2] - localState.position[2];
  const distance = Math.hypot(dx, dz);
  let yaw = distance > 0.001 ? Math.atan2(dx, dz) : 0;
  let pitch = 0;
  let firePrimary = false;

  let buttons = 0;
  if (distance > scenario.behavior.stopDistanceM) {
    buttons |= BTN_FORWARD;
  } else if (state.mode === 'follow_target' && distance <= scenario.behavior.orbitDistanceM) {
    buttons |= state.orbitDirection > 0 ? BTN_RIGHT : BTN_LEFT;
  }

  if (distance > scenario.behavior.sprintDistanceM) {
    buttons |= BTN_SPRINT;
  }

  if (onGround && state.jumpCooldownTicks === 0 && state.stuckTicks >= scenario.behavior.stuckTickThreshold) {
    buttons |= BTN_JUMP;
    state.jumpCooldownTicks = scenario.behavior.jumpCooldownTicks;
    state.stuckTicks = 0;
  }

  const nearestDistance = nearest?.distance ?? Number.POSITIVE_INFINITY;
  const canShoot = state.fireCooldownTicks === 0;
  if (canShoot) {
    let fireTarget: [number, number, number] | null = null;
    switch (scenario.behavior.fireMode) {
      case 'nearest_target':
        if (nearest && nearestDistance <= scenario.behavior.fireDistanceM) {
          fireTarget = nearest.player.state.position;
        }
        break;
      case 'center':
        if (centerDistance <= scenario.behavior.fireDistanceM) {
          fireTarget = [0, 1.0, 0];
        }
        break;
      case 'nearest_target_or_center':
        if (nearest && nearestDistance <= scenario.behavior.fireDistanceM) {
          fireTarget = nearest.player.state.position;
        } else if (centerDistance <= scenario.behavior.fireDistanceM) {
          fireTarget = [0, 1.0, 0];
        }
        break;
      case 'off':
      default:
        break;
    }

    if (fireTarget) {
      const fx = fireTarget[0] - localState.position[0];
      const fy = fireTarget[1] - localState.position[1];
      const fz = fireTarget[2] - localState.position[2];
      const planar = Math.hypot(fx, fz);
      yaw = planar > 0.001 ? Math.atan2(fx, fz) : yaw;
      pitch = planar > 0.001 || Math.abs(fy) > 0.001 ? Math.atan2(-fy, planar) : 0;
      firePrimary = true;
      state.fireCooldownTicks = scenario.behavior.fireCooldownTicks;
    }
  }

  return { buttons, yaw, pitch, mode: state.mode, targetPlayerId, firePrimary };
}

function findNearestTarget(
  localPosition: [number, number, number],
  remotePlayers: ObservedPlayer[],
): { player: ObservedPlayer; distance: number } | null {
  let best: { player: ObservedPlayer; distance: number } | null = null;
  for (const player of remotePlayers) {
    if ((player.state.flags & FLAG_DEAD) !== 0) {
      continue;
    }
    const distance = Math.hypot(
      player.state.position[0] - localPosition[0],
      player.state.position[2] - localPosition[2],
    );
    if (!best || distance < best.distance) {
      best = { player, distance };
    }
  }
  return best;
}
