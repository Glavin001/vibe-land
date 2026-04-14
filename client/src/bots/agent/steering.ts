/**
 * Translates a navcat crowd agent's planned motion into concrete game
 * commands: aim yaw, held buttons, and (optionally) fire intent.
 *
 * This is the glue between navcat (which thinks in continuous velocities) and
 * the game protocol (which thinks in discrete button bitmasks).
 */

import { crowd } from 'navcat/blocks';
import {
  BTN_FORWARD,
  BTN_JUMP,
  BTN_SPRINT,
} from '../../net/protocol';

type Agent = crowd.Agent;
import type { BotIntent, BotMode, BotSelfState, Vec3Tuple } from '../types';

export interface SteeringOptions {
  /** Minimum desired speed before we hold BTN_FORWARD (m/s). */
  minMoveSpeed?: number;
  /** Desired speed above which BTN_SPRINT is held (m/s). */
  sprintSpeed?: number;
  /** If desiredVelocity magnitude is below this and we're not at target, count as stuck. */
  stuckSpeed?: number;
  /** Consecutive stuck ticks before emitting a jump. */
  stuckTicksBeforeJump?: number;
  /** Ticks to wait between jumps. */
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

/**
 * Produces a {@link BotIntent} for the current tick.
 *
 * @param agent           The navcat agent (latest `crowd.update` state).
 * @param self            Server-reported self state (position, onGround, etc.).
 * @param state           Per-bot steering state (persists across calls).
 * @param mode            High-level behavior label (passed through to intent).
 * @param targetPlayerId  Currently targeted remote player, if any.
 * @param fireAim         World-space point the bot should fire at, or null.
 * @param options         Tunables; defaults are sensible.
 */
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

  // Dead: idle, no buttons.
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
  if (desiredSpeedPlanar > opts.sprintSpeed) {
    buttons |= BTN_SPRINT;
  }

  // Stuck detection: agent wants to move but isn't (stuck on a ledge / step).
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
