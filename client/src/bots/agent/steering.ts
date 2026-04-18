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
  /**
   * Yaw/pitch random offset (radians) added to the fire aim each tick, so
   * bots don't land pixel-perfect headshots. Deterministic per (bot, tick).
   */
  aimJitterRad?: number;
  /**
   * Seconds of velocity to project the aim point forward by when the target
   * has a known velocity. 0 disables lead.
   */
  aimLeadSec?: number;
  /**
   * Number of consecutive ticks the bot must keep a valid fireAim before
   * firePrimary is asserted. Simulates reaction time.
   */
  firePrepTicks?: number;
  /**
   * Stable per-bot seed used by the deterministic aim jitter. Fresh
   * steering states default to 0; callers (e.g. PracticeBotRuntime) can
   * set a per-bot seed so two bots don't share a jitter pattern.
   */
  seed?: number;
}

export interface SteeringState {
  stuckTicks: number;
  jumpCooldownTicks: number;
  lastYaw: number;
  fireAimTicks: number;
  jitterCounter: number;
}

export function createSteeringState(): SteeringState {
  return {
    stuckTicks: 0,
    jumpCooldownTicks: 0,
    lastYaw: 0,
    fireAimTicks: 0,
    jitterCounter: 0,
  };
}

const DEFAULT_OPTIONS = Object.freeze<Required<SteeringOptions>>({
  minMoveSpeed: 0.4,
  sprintSpeed: 4.0,
  stuckSpeed: 0.15,
  stuckTicksBeforeJump: 18,
  jumpCooldownTicks: 30,
  aimJitterRad: 0,
  aimLeadSec: 0,
  firePrepTicks: 0,
  seed: 0,
});

export function agentStateToIntent(
  agent: Agent | undefined,
  self: BotSelfState,
  state: SteeringState,
  mode: BotMode,
  targetPlayerId: number | null,
  fireAim: Vec3Tuple | null,
  options: SteeringOptions = {},
  fireAimVelocity: Vec3Tuple | null = null,
): BotIntent {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (self.dead || mode === 'dead') {
    state.stuckTicks = 0;
    state.jumpCooldownTicks = Math.max(0, state.jumpCooldownTicks - 1);
    state.fireAimTicks = 0;
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
    let aimX = fireAim[0];
    let aimY = fireAim[1];
    let aimZ = fireAim[2];
    if (fireAimVelocity && opts.aimLeadSec > 0) {
      aimX += fireAimVelocity[0] * opts.aimLeadSec;
      aimY += fireAimVelocity[1] * opts.aimLeadSec;
      aimZ += fireAimVelocity[2] * opts.aimLeadSec;
    }
    const fx = aimX - self.position[0];
    const fy = aimY - self.position[1];
    const fz = aimZ - self.position[2];
    const planar = Math.hypot(fx, fz);
    if (planar > 0.001 || Math.abs(fy) > 0.001) {
      let targetYaw = planar > 0.001 ? Math.atan2(fx, fz) : yaw;
      let targetPitch = Math.atan2(-fy, Math.max(planar, 0.0001));
      if (opts.aimJitterRad > 0) {
        const [jitterYaw, jitterPitch] = deterministicJitter(
          opts.seed,
          state.jitterCounter,
          opts.aimJitterRad,
        );
        targetYaw += jitterYaw;
        targetPitch += jitterPitch;
      }
      yaw = targetYaw;
      pitch = targetPitch;
      state.fireAimTicks += 1;
      firePrimary = state.fireAimTicks > opts.firePrepTicks;
    } else {
      state.fireAimTicks = 0;
    }
  } else {
    state.fireAimTicks = 0;
  }

  state.jitterCounter = (state.jitterCounter + 1) >>> 0;
  state.lastYaw = yaw;
  return { buttons, yaw, pitch, firePrimary, mode, targetPlayerId };
}

/**
 * Tiny deterministic sine-based jitter in [-amp, amp] for both yaw and
 * pitch. Avoids a PRNG dependency while still varying across bots (via
 * `seed`) and across ticks (via `counter`).
 */
function deterministicJitter(
  seed: number,
  counter: number,
  amp: number,
): [number, number] {
  const a = Math.sin((seed + 1) * 12.9898 + counter * 0.31337) * 43758.5453;
  const b = Math.sin((seed + 1) * 78.2331 + counter * 0.27183) * 12345.6789;
  const jy = (a - Math.floor(a)) * 2 - 1;
  const jp = (b - Math.floor(b)) * 2 - 1;
  return [jy * amp, jp * amp];
}
