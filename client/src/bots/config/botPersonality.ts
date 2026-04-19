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
  fireCooldownTicks: number;
  meleeDistanceM: number;
  meleeAgainstVehicleDistanceM: number;

  // ---------- Reflexes ----------
  stuckTickThreshold: number;
  jumpCooldownTicks: number;
  /** Minimum desired planar speed before the steering layer presses forward. */
  minMoveSpeedM: number;

  // ---------- Vehicles ----------
  useVehicles: boolean;
  vehicleProfile: VehicleProfile;
}

/**
 * Defaults that preserve historical behavior:
 *  - Locomotion / target / fire numbers come from `loadtest/scenario.ts` (the
 *    place where these were already named and tuned).
 *  - Steering reflexes (jump cooldown, stuck threshold) come from the
 *    practice steering defaults in `agent/steering.ts`.
 *  - Melee / target memory come from `harassNearest`'s defaults.
 *  - Vehicles default off — practice opts in via the panel toggle.
 */
export const DEFAULT_BOT_PERSONALITY: BotPersonality = Object.freeze({
  behaviorKind: 'harass',

  maxSpeed: 3.0,
  stopDistanceM: 1.6,
  orbitDistanceM: 4.5,
  sprintDistanceM: 8,

  targetAcquireDistanceM: 40,
  targetReleaseDistanceM: 60,
  targetMemoryTicks: 45,
  recoveryDistanceM: 32,

  fireMode: 'off',
  fireDistanceM: 18,
  fireCooldownTicks: 8,
  meleeDistanceM: 2.0,
  meleeAgainstVehicleDistanceM: 3.0,

  stuckTickThreshold: 18,
  jumpCooldownTicks: 30,
  minMoveSpeedM: 0.4,

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
