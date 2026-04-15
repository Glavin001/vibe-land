/**
 * Shared types for the bot framework.
 *
 * These types are intentionally decoupled from the network/protocol layer so
 * that the bot framework can be reused from Node load-test runners (no THREE,
 * no React) and from the browser LoadTest page alike.
 */

export type Vec3Tuple = [number, number, number];

/**
 * Observed state of a remote player from the bot's perspective.
 *
 * Mirrors the shape `stepBotBrain` uses today in `loadtest/brain.ts`, so
 * existing loadtest runners don't have to reshape their snapshot data to feed
 * it into the framework.
 */
export interface ObservedPlayer {
  id: number;
  position: Vec3Tuple;
  isDead: boolean;
}

/**
 * Snapshot of the bot's own state at the top of a brain tick.
 */
export interface BotSelfState {
  position: Vec3Tuple;
  velocity: Vec3Tuple;
  yaw: number;
  pitch: number;
  onGround: boolean;
  dead: boolean;
}

/**
 * The only output a bot produces: aim + held buttons + fire intent.
 *
 * All consumers (simulate.ts, wsWorker.ts, LoadTest.tsx) translate this to
 * their transport-specific `InputFrame` via `buildInputFromButtons` — see
 * `client/src/scene/inputBuilder.ts`.
 */
export interface BotIntent {
  buttons: number;
  yaw: number;
  pitch: number;
  firePrimary: boolean;
  /** For debug/telemetry. Matches existing BotBrainMode values. */
  mode: BotMode;
  /** Currently targeted remote player, or null. */
  targetPlayerId: number | null;
  /**
   * Side-channel request to enter or exit a vehicle this tick. Consumed by
   * `PracticeBotRuntime`, which translates it to a `PKT_VEHICLE_ENTER` /
   * `PKT_VEHICLE_EXIT` through the local-preview transport. Null means
   * "no vehicle action this tick" (the common case).
   */
  vehicleAction?: 'enter' | 'exit' | null;
  /** Vehicle id the action targets (only meaningful when vehicleAction != null). */
  vehicleId?: number | null;
}

export type BotMode =
  | 'acquire_target'
  | 'follow_target'
  | 'recover_center'
  | 'hold_anchor'
  | 'dead'
  | 'walking_to_vehicle'
  | 'entering_vehicle'
  | 'driving'
  | 'exiting_vehicle';

/**
 * Static physical parameters for a driven vehicle, used by the bot planner
 * to:
 *  - size the vehicle navmesh / crowd agent,
 *  - bias `getCost` against turns sharper than the chassis can execute,
 *  - estimate travel time for the "walk vs drive" planner in the brain.
 *
 * Units are meters / seconds everywhere. Defaults for the stock practice
 * vehicle live in `PracticeBotRuntime`.
 */
export interface VehicleProfile {
  /** Minimum turning radius (m). Turns tighter than this are heavily penalized by the vehicle `QueryFilter.getCost`. */
  turningRadius: number;
  /** Agent radius used when adding a vehicle-bot agent to the vehicle crowd (m). */
  agentRadius: number;
  /** Agent height used when adding a vehicle-bot agent to the vehicle crowd (m). */
  agentHeight: number;
  /** Cruise speed used when estimating drive-leg travel time (m/s). */
  cruiseSpeed: number;
  /** Max walk distance (m) at which a bot will consider a vehicle "reachable". */
  enterDistance: number;
  /** Fixed seconds added to the drive-leg estimate to account for enter + exit animations. */
  enterExitOverheadSec: number;
}
