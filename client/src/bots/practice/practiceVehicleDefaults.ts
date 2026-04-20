import type { VehicleProfile } from '../types';

/**
 * Stock {@link VehicleProfile} for the default practice/load-test vehicle
 * (the small Rapier raycast car).
 *
 * - `turningRadius`: at `VEHICLE_MAX_STEER_RAD = 0.5 rad` and a 1.8 m
 *   wheelbase, the kinematic lower bound is ≈ 1.8 / tan(0.5) ≈ 3.3 m. We
 *   bump to 5 m to account for the raycast-vehicle's drift and the fact
 *   that A* costs use centroids, not wheelbase geometry.
 * - `cruiseSpeed`: empirical — the chassis reaches ~14 m/s on a straight
 *   with the default engine force. 12 m/s leaves margin for the car
 *   actually *exiting* a corner.
 *
 * Lives in its own module so config-only consumers (like `botPersonality.ts`)
 * don't have to pull the full bot runtime / navcat dependency graph.
 */
export const DEFAULT_VEHICLE_PROFILE: VehicleProfile = Object.freeze({
  turningRadius: 5,
  agentRadius: 1.3,
  agentHeight: 1.5,
  cruiseSpeed: 12,
  enterDistance: 2.5,
  enterExitOverheadSec: 1.5,
});
