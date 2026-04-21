/**
 * Translates a vehicle-mode crowd agent's planned motion into concrete
 * driving commands: throttle / reverse / steer bits on a {@link BotIntent}.
 *
 * The navcat crowd plans in world-space velocities; the server's
 * `input_to_vehicle_cmd` in `shared/src/movement.rs:31` interprets
 * `move_y`/`move_x` (or the equivalent button bits) in the vehicle's local
 * frame:
 *   - `move_y > 0` → throttle → chassis drives along its local **+Z** axis
 *     (`index_forward_axis = 2` in `create_vehicle_physics`).
 *   - `move_x > 0` → steer right in the vehicle's forward direction.
 *
 * So to go from "desired world velocity" → "buttons", we rotate the
 * world-space desired velocity into chassis-local coordinates via the
 * **inverse** of the chassis quaternion and look at the resulting (x, z):
 *
 *   localForward =  localZ  // "ahead" direction in chassis frame
 *   localRight   =  localX  // "right" direction in chassis frame
 *   heading      = atan2(localRight, localForward)   // 0 = ahead, +π/2 = right
 *
 * - Small |heading|: press BTN_FORWARD, maybe nudge LEFT / RIGHT to stay on
 *   the crowd's desired bearing.
 * - Target in the frontal arc but off-axis: forward + hard steer.
 * - Target behind: reverse (BTN_BACK) and counter-steer, which pivots the
 *   nose around. Good enough to unstick the bot on a bad approach; proper
 *   3-point turns are out of scope.
 *
 * This is a pure function — no side effects, no globals — so it's
 * trivially unit-testable and can be reused from a Node load test or a
 * browser preview alike.
 */

import type { crowd as navcatCrowd } from 'navcat/blocks';

import {
  BTN_BACK,
  BTN_FORWARD,
  BTN_LEFT,
  BTN_RIGHT,
} from '../../net/sharedConstants';
import type { BotIntent, BotMode, Vec3Tuple } from '../types';

type Agent = navcatCrowd.Agent;

/** Chassis orientation quaternion in `[x, y, z, w]` order (match `VehicleStateMeters`). */
export type Quaternion = readonly [number, number, number, number];

export interface VehicleSteeringOptions {
  /**
   * Minimum desired planar speed (m/s) before we start pressing any
   * drive button. Below this the bot just coasts — avoids jittering
   * throttle on a waypoint we've essentially already hit.
   */
  minDesiredSpeed?: number;
  /**
   * Half-width (radians) of the "dead ahead" zone where we won't emit
   * left/right steer bits at all. Outside the deadband we commit to a
   * discrete LEFT or RIGHT.
   */
  steerDeadband?: number;
  /**
   * Half-angle (radians, from +local forward) of the frontal arc where
   * we throttle forward. Outside this arc the target is "behind" and we
   * reverse. Default 100° → forward arc is ±100° (forward-biased — we
   * only reverse when the target is clearly to the rear).
   */
  forwardArc?: number;
}

const DEFAULTS = Object.freeze<Required<VehicleSteeringOptions>>({
  minDesiredSpeed: 0.5,
  steerDeadband: 0.08, // ~4.6°
  forwardArc: (100 * Math.PI) / 180,
});

/** Rotates `v` by the **inverse** of unit quaternion `q` (i.e. into `q`'s local frame). */
export function rotateVectorByQuaternionInverse(v: Vec3Tuple, q: Quaternion): Vec3Tuple {
  const [qx, qy, qz, qw] = q;
  // Conjugate (inverse for a unit quaternion):
  const ix = -qx;
  const iy = -qy;
  const iz = -qz;
  // v' = q* v q (pure-quaternion multiplication, expanded).
  // Using the Rodrigues-style form:
  //   t = 2 * (q.xyz × v)
  //   v' = v + q.w * t + q.xyz × t
  const tx = 2 * (iy * v[2] - iz * v[1]);
  const ty = 2 * (iz * v[0] - ix * v[2]);
  const tz = 2 * (ix * v[1] - iy * v[0]);
  return [
    v[0] + qw * tx + (iy * tz - iz * ty),
    v[1] + qw * ty + (iz * tx - ix * tz),
    v[2] + qw * tz + (ix * ty - iy * tx),
  ];
}

/**
 * Pure conversion: given the crowd's desired velocity and the chassis
 * orientation, emit a {@link BotIntent} with the right drive buttons set.
 *
 * `yaw` and `pitch` in the returned intent are passed through unchanged
 * from the caller — `input_to_vehicle_cmd` in `shared/src/movement.rs`
 * ignores them, but snapshot code still echoes them back to observers, so
 * we keep the bot's head aimed wherever the caller wants.
 */
export function vehicleAgentStateToIntent(
  desiredVelocity: Vec3Tuple,
  chassisQuaternion: Quaternion,
  passthrough: {
    yaw: number;
    pitch: number;
    mode: BotMode;
    targetPlayerId: number | null;
    vehicleId: number;
    firePrimary?: boolean;
    vehicleAction?: 'enter' | 'exit' | null;
  },
  options: VehicleSteeringOptions = {},
): BotIntent {
  const opts = { ...DEFAULTS, ...options };

  const planarSpeed = Math.hypot(desiredVelocity[0], desiredVelocity[2]);
  let buttons = 0;

  if (planarSpeed >= opts.minDesiredSpeed) {
    const local = rotateVectorByQuaternionInverse(desiredVelocity, chassisQuaternion);
    // Chassis forward is +Z (see `index_forward_axis = 2` in
    // `create_vehicle_physics`). +X is right.
    const forward = local[2];
    const right = local[0];
    // 0 = straight ahead, +π/2 = full right, ±π = directly behind.
    const heading = Math.atan2(right, forward);
    const absHeading = Math.abs(heading);

    if (absHeading <= opts.forwardArc) {
      // Target is in the frontal arc: drive forward, steer toward it.
      buttons |= BTN_FORWARD;
      if (heading > opts.steerDeadband) {
        buttons |= BTN_RIGHT;
      } else if (heading < -opts.steerDeadband) {
        buttons |= BTN_LEFT;
      }
    } else {
      // Target is behind: reverse, and steer the **opposite** way so the
      // nose swings around toward the target. (When reversing, pressing
      // RIGHT steers the front wheels right, which in turn pivots the
      // rear-end right and the nose left — so we invert here.)
      buttons |= BTN_BACK;
      if (heading > opts.steerDeadband) {
        buttons |= BTN_LEFT;
      } else if (heading < -opts.steerDeadband) {
        buttons |= BTN_RIGHT;
      }
    }
  }

  return {
    buttons,
    yaw: passthrough.yaw,
    pitch: passthrough.pitch,
    firePrimary: passthrough.firePrimary ?? false,
    meleePrimary: false,
    mode: passthrough.mode,
    targetPlayerId: passthrough.targetPlayerId,
    vehicleAction: passthrough.vehicleAction ?? null,
    vehicleId: passthrough.vehicleId,
  };
}

/**
 * Convenience wrapper that pulls `desiredVelocity` off a navcat agent.
 * Returns `undefined` if the agent is missing (caller should synthesize
 * an idle intent in that case).
 */
export function vehicleAgentToIntent(
  agent: Agent | undefined,
  chassisQuaternion: Quaternion,
  passthrough: Parameters<typeof vehicleAgentStateToIntent>[2],
  options: VehicleSteeringOptions = {},
): BotIntent | undefined {
  if (!agent) return undefined;
  const desired: Vec3Tuple = [
    agent.desiredVelocity[0],
    agent.desiredVelocity[1],
    agent.desiredVelocity[2],
  ];
  return vehicleAgentStateToIntent(desired, chassisQuaternion, passthrough, options);
}
