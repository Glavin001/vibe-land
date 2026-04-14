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
  it('smooths tiny multiplayer chassis noise for the local mesh', () => {
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

    const result = updateLocalVehicleMeshPose(
      state,
      1,
      { position: [0.08, 0, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      8,
      4,
      'multiplayer',
    );

    expect(result.pose.position[0]).toBeGreaterThan(0);
    expect(result.pose.position[0]).toBeLessThan(0.08);
    expect(result.metrics.positionDeltaM).toBeGreaterThan(0);
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
      { position: [1.2, 0, 0], quaternion: [0, 0, 0, 1] },
      1 / 60,
      12,
      4,
      'multiplayer',
    );

    expect(result.pose.position[0]).toBeCloseTo(1.2);
    expect(result.metrics.positionDeltaM).toBeCloseTo(0);
  });

  it('snaps multiplayer mesh pose when airborne', () => {
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
    expect(result.pose.position[1]).toBeCloseTo(0.02);
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
