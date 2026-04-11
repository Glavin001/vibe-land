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
import type { LoadTestScenario } from './scenario';
import { anchorForBot } from './scenario';

export type ObservedPlayer = {
  id: number;
  state: PlayerStateMeters;
};

export type BotBrainMode = 'acquire_target' | 'follow_target' | 'recover_center' | 'hold_anchor' | 'dead';

export interface BotBrainState {
  mode: BotBrainMode;
  anchor: [number, number];
  orbitDirection: -1 | 1;
  jumpCooldownTicks: number;
  stuckTicks: number;
  airborneTicks: number;
  lastPosition: [number, number, number] | null;
  targetPlayerId: number | null;
}

export interface BotIntent {
  buttons: number;
  yaw: number;
  mode: BotBrainMode;
  targetPlayerId: number | null;
}

export function createBotBrainState(botIndex: number, scenario: LoadTestScenario): BotBrainState {
  return {
    mode: 'acquire_target',
    anchor: anchorForBot(botIndex, scenario),
    orbitDirection: botIndex % 2 === 0 ? 1 : -1,
    jumpCooldownTicks: 0,
    stuckTicks: 0,
    airborneTicks: 0,
    lastPosition: null,
    targetPlayerId: null,
  };
}

export function stepBotBrain(
  state: BotBrainState,
  scenario: LoadTestScenario,
  localState: PlayerStateMeters | null,
  remotePlayers: ObservedPlayer[],
): BotIntent {
  if (!localState || (localState.flags & FLAG_DEAD) !== 0) {
    state.mode = 'dead';
    state.targetPlayerId = null;
    state.lastPosition = localState?.position ?? null;
    return { buttons: 0, yaw: 0, mode: state.mode, targetPlayerId: null };
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
  const yaw = distance > 0.001 ? Math.atan2(dx, dz) : 0;

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

  return { buttons, yaw, mode: state.mode, targetPlayerId };
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
