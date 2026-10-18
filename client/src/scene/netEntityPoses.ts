// Where the networked entities are drawn: the pose step of each entity
// renderer (netEntityRenderers.ts), after the netcode has sampled them and
// before anything touches a mesh.
//
// Pure and three.js-free, so the renderers and Netlab v2's headless client
// stage (client/netlab/v2/clientStage.mts) run the same decisions: which
// entities are drawn at all, and at which pose. The renderers keep only mesh
// bookkeeping around these.

import type { PlayerSample, VehicleSample } from '../net/interpolation';
import type { RemotePlayer } from '../net/netcodeClient';
import {
  FLAG_DEAD,
  FLAG_IN_VEHICLE,
  type DynamicBodyStateMeters,
  type VehicleStateMeters,
} from '../net/protocol';
import { isMeteorBody } from '../vfx/meteorFlights';

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

/** Height of a driver's (hidden) root above the vehicle's origin. */
export const DRIVER_ROOT_LIFT_M = 0.8;

export interface RemotePlayerDraw {
  /** The character root's position. */
  position: V3;
  /** Heading, radians (the root's rotation about +y). */
  yaw: number;
  /** The driven vehicle's orientation while driving (the root takes its yaw); else null. */
  vehicleQuaternion: Q4 | null;
  flags: number;
  /** An interpolated sample was available (else the latest state). */
  sampled: boolean;
  inVehicle: boolean;
  dead: boolean;
  /** The character is drawn: not in a vehicle and not hidden. */
  visible: boolean;
}

/**
 * A remote player's drawn root: its interpolated sample at the player render
 * time, else its latest state; while it drives, lifted onto its vehicle (and
 * not drawn: the vehicle is).
 */
export function resolveRemotePlayerDraw(
  id: number,
  rp: RemotePlayer,
  sample: PlayerSample | null,
  vehicles: Map<number, VehicleStateMeters>,
  sampleVehicle: (id: number, renderTimeUs: number) => VehicleSample | null,
  renderTimeUs: number,
  hidden?: ReadonlySet<number>,
): RemotePlayerDraw {
  const flags = sample?.flags ?? (rp.hp <= 0 ? FLAG_DEAD : 0);
  let position: V3 = [...(sample?.position ?? rp.position)] as V3;
  const yaw = sample?.yaw ?? rp.yaw;
  const inVehicle = (flags & FLAG_IN_VEHICLE) !== 0;
  let vehicleQuaternion: Q4 | null = null;
  if (inVehicle) {
    for (const [vehicleId, vehicleState] of vehicles) {
      if (vehicleState.driverId !== id) continue;
      const vehicleSample = sampleVehicle(vehicleId, renderTimeUs);
      const vehiclePosition = vehicleSample?.position ?? vehicleState.position;
      vehicleQuaternion = [...(vehicleSample?.quaternion ?? vehicleState.quaternion)] as Q4;
      position = [vehiclePosition[0], vehiclePosition[1] + DRIVER_ROOT_LIFT_M, vehiclePosition[2]];
      break;
    }
  }
  const isHidden = hidden?.has(id) ?? false;
  return {
    position,
    yaw,
    vehicleQuaternion,
    flags,
    sampled: sample !== null,
    inVehicle,
    dead: (flags & FLAG_DEAD) !== 0,
    visible: !inVehicle && !isHidden,
  };
}

export interface DynamicBodyDraw {
  id: number;
  /** The state drawn: the runtime's rendered state, else the latest streamed one. */
  body: DynamicBodyStateMeters;
}

/**
 * The plain dynamic bodies drawn this frame (spheres and boxes), each at the
 * runtime's rendered state (interpolated, or the local proxy while the player
 * interacts with it) or else its latest streamed state. A meteor's body is
 * skipped: the meteor layer draws it as a burning rock.
 */
export function resolveDynamicBodyDraws(
  bodies: Map<number, DynamicBodyStateMeters>,
  rendered: (id: number) => DynamicBodyStateMeters | null,
): DynamicBodyDraw[] {
  const out: DynamicBodyDraw[] = [];
  for (const [id, body] of bodies) {
    if (isMeteorBody(id)) continue;
    out.push({ id, body: rendered(id) ?? body });
  }
  return out;
}

export interface VehicleDrawPose {
  position: V3;
  quaternion: Q4;
  /** An interpolated sample was available (else the latest state). */
  sampled: boolean;
}

/**
 * A vehicle nobody on this client drives: its interpolated sample at the
 * player render time, else its latest state. (The driven vehicle is drawn at
 * the local prediction's pose instead: GameWorld.)
 */
export function remoteVehicleDrawPose(state: VehicleStateMeters, sample: VehicleSample | null): VehicleDrawPose {
  return {
    position: [...(sample?.position ?? state.position)] as V3,
    quaternion: [...(sample?.quaternion ?? state.quaternion)] as Q4,
    sampled: sample !== null,
  };
}
