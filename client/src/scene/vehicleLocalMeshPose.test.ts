import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  resetLocalVehicleMeshPose,
  updateLocalVehicleMeshPose,
  type LocalVehicleVisualPoseState,
} from './vehicleLocalMeshPose';

function makeState(): LocalVehicleVisualPoseState {
  return {
    vehicleId: null,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    euler: new THREE.Euler(0, 0, 0, 'YXZ'),
  };
}

describe('vehicleLocalMeshPose', () => {
  it('keeps normal multiplayer planar translation exact while damping heave, yaw, and tilt', () => {
    const state = makeState();
    updateLocalVehicleMeshPose(
      state,
      1,
      { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      8,
      4,
      'multiplayer',
    );

    const targetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08, 0.1, -0.05, 'YXZ'));

    const result = updateLocalVehicleMeshPose(
      state,
      1,
      {
        position: [0.08, 0.06, 0.09],
        quaternion: [targetQuat.x, targetQuat.y, targetQuat.z, targetQuat.w],
      },
      1 / 60,
      8,
      4,
      'multiplayer',
    );

    const resultEuler = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(
        result.pose.quaternion[0],
        result.pose.quaternion[1],
        result.pose.quaternion[2],
        result.pose.quaternion[3],
      ),
      'YXZ',
    );

    expect(result.pose.position[0]).toBeCloseTo(0.08);
    expect(result.pose.position[2]).toBeCloseTo(0.09);
    expect(result.pose.position[1]).toBeGreaterThan(0);
    expect(result.pose.position[1]).toBeLessThan(0.06);
    expect(resultEuler.y).toBeGreaterThan(0);
    expect(resultEuler.y).toBeLessThan(0.1);
    expect(resultEuler.x).toBeGreaterThan(0);
    expect(resultEuler.x).toBeLessThan(0.08);
    expect(result.metrics.positionDeltaM).toBeGreaterThan(0);
  });

  it('caps multiplayer single-frame planar outliers without snapping the chassis', () => {
    const state = makeState();
    updateLocalVehicleMeshPose(
      state,
      1,
      { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      12,
      4,
      'multiplayer',
    );

    const result = updateLocalVehicleMeshPose(
      state,
      1,
      { position: [1.2, 0, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      12,
      4,
      'multiplayer',
    );

    expect(result.pose.position[0]).toBeGreaterThan(0.3);
    expect(result.pose.position[0]).toBeLessThan(1.2);
    expect(result.metrics.positionDeltaM).toBeGreaterThan(0);
  });

  it('continues smoothing planar motion in practice mode', () => {
    const state = makeState();
    updateLocalVehicleMeshPose(
      state,
      1,
      { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      8,
      4,
      'practice',
    );

    const result = updateLocalVehicleMeshPose(
      state,
      1,
      { position: [0.08, 0, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      8,
      4,
      'practice',
    );

    expect(result.pose.position[0]).toBeGreaterThan(0);
    expect(result.pose.position[0]).toBeLessThan(0.08);
  });

  it('snaps multiplayer mesh pose on large discontinuities', () => {
    const state = makeState();
    updateLocalVehicleMeshPose(
      state,
      1,
      { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      12,
      4,
      'multiplayer',
    );

    const result = updateLocalVehicleMeshPose(
      state,
      1,
      { position: [4.0, 0, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      12,
      4,
      'multiplayer',
    );

    expect(result.pose.position[0]).toBeCloseTo(4.0);
    expect(result.metrics.positionDeltaM).toBeCloseTo(0);
  });

  it('does not snap multiplayer mesh pose only because wheel contact briefly drops', () => {
    const state = makeState();
    updateLocalVehicleMeshPose(
      state,
      1,
      { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      12,
      4,
      'multiplayer',
    );

    const result = updateLocalVehicleMeshPose(
      state,
      1,
      { position: [0.1, 0.02, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      12,
      1,
      'multiplayer',
    );

    expect(result.pose.position[0]).toBeCloseTo(0.1);
    expect(result.pose.position[1]).toBeGreaterThan(0);
    expect(result.pose.position[1]).toBeLessThan(0.02);
  });

  it('resets cleanly across vehicle changes', () => {
    const state = makeState();
    updateLocalVehicleMeshPose(
      state,
      1,
      { position: [0.3, 0, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      4,
      4,
      'multiplayer',
    );
    resetLocalVehicleMeshPose(state);

    const result = updateLocalVehicleMeshPose(
      state,
      2,
      { position: [2, 0, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      4,
      4,
      'multiplayer',
    );

    expect(result.pose.position[0]).toBeCloseTo(2);
    expect(result.metrics.positionDeltaM).toBeCloseTo(0);
  });
});
