/**
 * Unified bot personality / configuration.
 *
 * Both the local practice bots and the WebTransport load-test bots share
 * the same brain code. This module defines the single shape for everything
 * that tunes that brain: locomotion thresholds, target acquisition,
 * fire/melee ranges, and vehicle support. Practice and load-test should
 * differ only in transport and population — not in decision-making.
 */
import { DEFAULT_VEHICLE_PROFILE } from '../practice/practiceVehicleDefaults';
import type { VehicleProfile } from '../types';

export type BotBehaviorKind = 'harass' | 'wander' | 'hold';

export type BotFireMode =
  | 'off'
  | 'nearest_target'
  | 'center'
  | 'nearest_target_or_center';

export interface BotPersonality {
  /** Top-level behavior selection. The runtime picks a `Behavior` from this. */
  behaviorKind: BotBehaviorKind;

  // ---------- Locomotion ----------
  /** Max desired speed (m/s). */
  maxSpeed: number;
  /** Distance to target at which the bot stops pressing forward. */
  stopDistanceM: number;
  /** Distance at which the bot strafes around the target instead of charging. */
  orbitDistanceM: number;
  /** Distance beyond which the bot wants to sprint (informational; bots no longer emit BTN_SPRINT). */
  sprintDistanceM: number;

  // ---------- Target acquisition ----------
  /** Range at which the bot first locks onto a target. */
  targetAcquireDistanceM: number;
  /** Range at which the bot drops a previously locked target. Defaults to 1.5× acquire. */
  targetReleaseDistanceM: number;
  /** Ticks of "out of sight" memory before the bot gives up on a locked target. */
  targetMemoryTicks: number;
  /** Distance from the arena center beyond which the bot retreats home. */
  recoveryDistanceM: number;

  // ---------- Combat ----------
  fireMode: BotFireMode;
  fireDistanceM: number;
  /** Planar distance below which the bot refuses to fire (prevents point-blank clip shots). */
  minFireDistanceM: number;
  fireCooldownTicks: number;
  /** Ticks the bot holds still after entering fire range before it visibly resumes moving. */
  standAndShootTicks: number;
  /** Ticks of consecutive valid fireAim before firePrimary is asserted (reaction-time sim). */
  firePrepTicks: number;
  /** Radians of random yaw/pitch jitter added to the fire aim per tick. */
  aimJitterRad: number;
  /** Seconds of target velocity to project aim forward for aim-lead. */
  aimLeadSec: number;
  meleeDistanceM: number;
  meleeAgainstVehicleDistanceM: number;

  // ---------- Reflexes ----------
  stuckTickThreshold: number;
  jumpCooldownTicks: number;
  /** Minimum desired planar speed before the steering layer presses forward. */
  minMoveSpeedM: number;

  // ---------- Perception ----------
  /** Max planar distance at which the bot can perceive another player (beyond this, invisible). */
  perceptionRangeM: number;
  /** Half-angle of the forward FOV cone in radians. PI/2 => 180° cone. */
  fovHalfAngleRad: number;
  /** Ticks a per-player last-known position is retained after losing sight. */
  memoryDurationTicks: number;
  /** Ticks the bot stays in "curious" (scan behind/around) state after taking damage with no target. */
  curiousDurationTicks: number;
  /**
   * How often (in ticks) the LOS raycast runs per visible candidate. 1 = every
   * tick; raise to 2-3 to amortize cost under heavy bot counts.
   */
  perceptionRaycastCadenceTicks: number;

  // ---------- Vehicles ----------
  useVehicles: boolean;
  vehicleProfile: VehicleProfile;
}

/**
 * Defaults matching the practice bot's canonical tuning — the "smart bot"
 * baseline. Load-test scenarios that want quieter bots opt in via
 * {@link LoadTestScenario.behavior} / {@link LoadTestScenario.personality}
 * (e.g. `fireMode: 'off'`, narrower `targetAcquireDistanceM`).
 *
 *  - Target acquisition / fire ranges (80 / 120 / 28 m) mirror the practice
 *    floors that previously lived inline in `PracticeBotRuntime`.
 *  - Aim jitter / lead / fire prep are the practice values that make shots
 *    land plausibly without feeling like an aimbot.
 *  - Vehicles default off — practice still opts in via the panel toggle and
 *    the load-test runtime will honour `useVehicles` once its FSM ships.
 */
export const DEFAULT_BOT_PERSONALITY: BotPersonality = Object.freeze({
  behaviorKind: 'harass',

  maxSpeed: 3.0,
  stopDistanceM: 1.6,
  orbitDistanceM: 4.5,
  sprintDistanceM: 8,

  targetAcquireDistanceM: 80,
  targetReleaseDistanceM: 120,
  targetMemoryTicks: 45,
  recoveryDistanceM: 32,

  fireMode: 'nearest_target',
  fireDistanceM: 28,
  minFireDistanceM: 2,
  fireCooldownTicks: 8,
  standAndShootTicks: 18,
  firePrepTicks: 12,
  aimJitterRad: 0.02,
  aimLeadSec: 0.08,
  meleeDistanceM: 2.0,
  meleeAgainstVehicleDistanceM: 3.0,

  stuckTickThreshold: 18,
  jumpCooldownTicks: 30,
  minMoveSpeedM: 0.4,

  perceptionRangeM: 60,
  fovHalfAngleRad: Math.PI / 2,
  memoryDurationTicks: 300,
  curiousDurationTicks: 120,
  perceptionRaycastCadenceTicks: 1,

  useVehicles: false,
  vehicleProfile: DEFAULT_VEHICLE_PROFILE,
}) as BotPersonality;

/**
 * Merge a partial personality into the defaults, preserving the `vehicleProfile`
 * sub-object via a shallow copy.
 */
export function resolvePersonality(
  patch?: Partial<BotPersonality>,
): BotPersonality {
  if (!patch) return { ...DEFAULT_BOT_PERSONALITY };
  return {
    ...DEFAULT_BOT_PERSONALITY,
    ...patch,
    vehicleProfile: patch.vehicleProfile ?? DEFAULT_BOT_PERSONALITY.vehicleProfile,
  };
}
