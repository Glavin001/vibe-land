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
 */
export interface BotIntent {
  buttons: number;
  yaw: number;
  pitch: number;
  firePrimary: boolean;
  mode: BotMode;
  targetPlayerId: number | null;
}

export type BotMode =
  | 'acquire_target'
  | 'follow_target'
  | 'recover_center'
  | 'hold_anchor'
  | 'dead';
