import { afterEach, describe, expect, it } from 'vitest';

import { FLAG_DEAD, FLAG_IN_VEHICLE, type DynamicBodyStateMeters, type VehicleStateMeters } from '../net/protocol';
import type { RemotePlayer } from '../net/netcodeClient';
import type { PlayerSample, VehicleSample } from '../net/interpolation';
import { clearMeteorFlights, registerMeteorFlight } from '../vfx/meteorFlights';
import {
  DRIVER_ROOT_LIFT_M,
  remoteVehicleDrawPose,
  resolveDynamicBodyDraws,
  resolveRemotePlayerDraw,
} from './netEntityPoses';

const player = (over: Partial<RemotePlayer> = {}): RemotePlayer =>
  ({ id: 3, position: [1, 2, 3], yaw: 0.5, pitch: 0, hp: 100, ...over }) as unknown as RemotePlayer;
const sample = (over: Partial<PlayerSample> = {}): PlayerSample =>
  ({ position: [4, 5, 6], yaw: 1.25, pitch: 0.1, flags: 0, velocity: [0, 0, 0], ...over }) as unknown as PlayerSample;
const vehicle = (over: Partial<VehicleStateMeters> = {}): VehicleStateMeters =>
  ({ id: 9, driverId: 3, position: [10, 0.5, 10], quaternion: [0, 0, 0, 1], vehicleType: 0, ...over }) as unknown as VehicleStateMeters;
const body = (id: number, position: [number, number, number]): DynamicBodyStateMeters =>
  ({ id, shapeType: 1, position, quaternion: [0, 0, 0, 1], halfExtents: [0.5, 0.5, 0.5], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] }) as DynamicBodyStateMeters;

afterEach(() => clearMeteorFlights());

describe('netEntityPoses', () => {
  it('draws a remote player at its sample, else its latest state', () => {
    const drawn = resolveRemotePlayerDraw(3, player(), sample(), new Map(), () => null, 0);
    expect(drawn).toMatchObject({ position: [4, 5, 6], yaw: 1.25, sampled: true, visible: true, inVehicle: false });
    const latest = resolveRemotePlayerDraw(3, player(), null, new Map(), () => null, 0);
    expect(latest).toMatchObject({ position: [1, 2, 3], yaw: 0.5, sampled: false, visible: true });
    const dead = resolveRemotePlayerDraw(3, player({ hp: 0 }), null, new Map(), () => null, 0);
    expect(dead.dead).toBe(true);
    expect(dead.flags & FLAG_DEAD).toBe(FLAG_DEAD);
  });

  it('lifts a driver onto its vehicle (sampled at the same render time) and does not draw it', () => {
    const vehicles = new Map([[9, vehicle()]]);
    const at: number[] = [];
    const sampled: VehicleSample = { position: [20, 1, 20], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2] } as VehicleSample;
    const drawn = resolveRemotePlayerDraw(3, player(), sample({ flags: FLAG_IN_VEHICLE }), vehicles, (_id, t) => {
      at.push(t);
      return sampled;
    }, 1234);
    expect(at).toEqual([1234]);
    expect(drawn.position).toEqual([20, 1 + DRIVER_ROOT_LIFT_M, 20]);
    expect(drawn.vehicleQuaternion).toEqual(sampled.quaternion);
    expect(drawn.visible).toBe(false);
    const hidden = resolveRemotePlayerDraw(3, player(), sample(), new Map(), () => null, 0, new Set([3]));
    expect(hidden.visible).toBe(false);
  });

  it('draws every streamed body but a meteor, at the rendered state or else the latest', () => {
    const bodies = new Map([[1, body(1, [0, 1, 0])], [2, body(2, [0, 2, 0])], [3, body(3, [0, 3, 0])]]);
    registerMeteorFlight({
      bodyId: 3, shooterPlayerId: 1, serverLaunchTimeUs: 0, start: [0, 50, 0], velocity: [0, -10, 0],
      target: [0, 0, 0], radiusM: 1, gravityMs2: 9.81, flightTimeS: 3,
    } as never, () => 0);
    const rendered = (id: number) => (id === 1 ? body(1, [9, 9, 9]) : null);
    const draws = resolveDynamicBodyDraws(bodies, rendered);
    expect(draws.map((d) => d.id)).toEqual([1, 2]);
    expect(draws[0].body.position).toEqual([9, 9, 9]);
    expect(draws[1].body.position).toEqual([0, 2, 0]);
  });

  it('draws a remote vehicle at its sample, else its latest state', () => {
    const s = { position: [1, 2, 3], quaternion: [0, 0, 1, 0] } as VehicleSample;
    expect(remoteVehicleDrawPose(vehicle(), s)).toEqual({ position: [1, 2, 3], quaternion: [0, 0, 1, 0], sampled: true });
    expect(remoteVehicleDrawPose(vehicle(), null)).toEqual({ position: [10, 0.5, 10], quaternion: [0, 0, 0, 1], sampled: false });
  });
});
