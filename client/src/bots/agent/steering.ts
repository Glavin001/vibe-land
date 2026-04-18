/**
 * Translates a navcat crowd agent's planned motion into concrete game
 * commands: aim yaw, held buttons, and fire intent.
 */

import { crowd } from 'navcat/blocks';
import { BTN_FORWARD, BTN_JUMP } from '../../net/protocol';
import type { BotIntent, BotMode, BotSelfState, Vec3Tuple } from '../types';

type Agent = crowd.Agent;

export interface SteeringOptions {
  minMoveSpeed?: number;
  /**
   * @deprecated Bots no longer emit BTN_SPRINT. Speed is controlled by the
   * practice-session speed override.
   */
  sprintSpeed?: number;
  stuckSpeed?: number;
  stuckTicksBeforeJump?: number;
  jumpCooldownTicks?: number;
}

export interface SteeringState {
  stuckTicks: number;
  jumpCooldownTicks: number;
  lastYaw: number;
}

export function createSteeringState(): SteeringState {
  return { stuckTicks: 0, jumpCooldownTicks: 0, lastYaw: 0 };
}

const DEFAULT_OPTIONS = Object.freeze<Required<SteeringOptions>>({
  minMoveSpeed: 0.4,
  sprintSpeed: 4.0,
  stuckSpeed: 0.15,
  stuckTicksBeforeJump: 18,
  jumpCooldownTicks: 30,
});

export function agentStateToIntent(
  agent: Agent | undefined,
  self: BotSelfState,
  state: SteeringState,
  mode: BotMode,
  targetPlayerId: number | null,
  fireAim: Vec3Tuple | null,
  options: SteeringOptions = {},
): BotIntent {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (self.dead || mode === 'dead') {
    state.stuckTicks = 0;
    state.jumpCooldownTicks = Math.max(0, state.jumpCooldownTicks - 1);
    return { buttons: 0, yaw: self.yaw, pitch: 0, firePrimary: false, mode: 'dead', targetPlayerId: null };
  }

  let buttons = 0;
  let yaw = state.lastYaw || self.yaw || 0;
  let pitch = 0;

  const desiredVel: Vec3Tuple = agent
    ? [agent.desiredVelocity[0], agent.desiredVelocity[1], agent.desiredVelocity[2]]
    : [0, 0, 0];
  const desiredSpeedPlanar = Math.hypot(desiredVel[0], desiredVel[2]);

  if (desiredSpeedPlanar > 0.01) {
    yaw = Math.atan2(desiredVel[0], desiredVel[2]);
  }

  if (desiredSpeedPlanar > opts.minMoveSpeed) {
    buttons |= BTN_FORWARD;
  }

  const actualSpeed = Math.hypot(self.velocity[0], self.velocity[2]);
  if (desiredSpeedPlanar > opts.minMoveSpeed && actualSpeed < opts.stuckSpeed) {
    state.stuckTicks += 1;
  } else {
    state.stuckTicks = 0;
  }

  state.jumpCooldownTicks = Math.max(0, state.jumpCooldownTicks - 1);
  if (
    self.onGround
    && state.jumpCooldownTicks === 0
    && state.stuckTicks >= opts.stuckTicksBeforeJump
  ) {
    buttons |= BTN_JUMP;
    state.jumpCooldownTicks = opts.jumpCooldownTicks;
    state.stuckTicks = 0;
  }

  let firePrimary = false;
  if (fireAim) {
    const fx = fireAim[0] - self.position[0];
    const fy = fireAim[1] - self.position[1];
    const fz = fireAim[2] - self.position[2];
    const planar = Math.hypot(fx, fz);
    if (planar > 0.001 || Math.abs(fy) > 0.001) {
      yaw = planar > 0.001 ? Math.atan2(fx, fz) : yaw;
      pitch = Math.atan2(-fy, Math.max(planar, 0.0001));
      firePrimary = true;
    }
  }

  state.lastYaw = yaw;
  return { buttons, yaw, pitch, firePrimary, mode, targetPlayerId };
}
