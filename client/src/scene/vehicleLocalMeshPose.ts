import * as THREE from 'three';

export type LocalVehicleVisualPoseState = {
  vehicleId: number | null;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  euler: THREE.Euler;
};

export type VehiclePose = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
};

export type VehicleMeshPoseMode = 'practice' | 'multiplayer';

export type VehicleMeshPoseMetrics = {
  positionDeltaM: number;
  rotationDeltaRad: number;
};

const PRACTICE_PLANAR_RATE = 40.0;
const PRACTICE_VERTICAL_RATE = 12.0;
const PRACTICE_YAW_RATE = 24.0;
const PRACTICE_TILT_RATE = 10.0;

const MULTIPLAYER_PLANAR_STEP_MIN_M = 0.18;
const MULTIPLAYER_PLANAR_STEP_EXTRA_M = 0.12;
const MULTIPLAYER_PLANAR_STEP_SPEED_SCALE = 1.6;
const MULTIPLAYER_YAW_RATE = 28.0;
const MULTIPLAYER_HEAVE_RATE = 10.0;
const MULTIPLAYER_TILT_RATE = 10.0;

const MULTIPLAYER_SNAP_DISTANCE_M = 3.5;
const MULTIPLAYER_SNAP_VERTICAL_M = 0.75;
const MULTIPLAYER_SNAP_ROT_RAD = 0.75;
const PRACTICE_SNAP_DISTANCE_M = 1.5;
const PRACTICE_SNAP_VERTICAL_M = 0.35;
const PRACTICE_SNAP_ROT_RAD = 0.35;

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  const delta = THREE.MathUtils.euclideanModulo(target - current + Math.PI, Math.PI * 2) - Math.PI;
  const alpha = 1 - Math.exp(-lambda * dt);
  return current + delta * alpha;
}

function quaternionAngle(a: THREE.Quaternion, b: THREE.Quaternion): number {
  const dot = Math.min(1, Math.abs(a.dot(b)));
  return 2 * Math.acos(dot);
}

function stepPlanarToward(
  position: THREE.Vector3,
  targetX: number,
  targetZ: number,
  maxStepM: number,
): void {
  const dx = targetX - position.x;
  const dz = targetZ - position.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= maxStepM || distance <= 1e-6) {
    position.x = targetX;
    position.z = targetZ;
    return;
  }
  const scale = maxStepM / distance;
  position.x += dx * scale;
  position.z += dz * scale;
}

function shouldSnapVehicleMeshPose(
  positionDeltaM: number,
  verticalDeltaM: number,
  rotationDeltaRad: number,
  _groundedWheels: number,
  mode: VehicleMeshPoseMode,
): boolean {
  const snapDistance = mode === 'practice' ? PRACTICE_SNAP_DISTANCE_M : MULTIPLAYER_SNAP_DISTANCE_M;
  const snapVertical = mode === 'practice' ? PRACTICE_SNAP_VERTICAL_M : MULTIPLAYER_SNAP_VERTICAL_M;
  const snapRotation = mode === 'practice' ? PRACTICE_SNAP_ROT_RAD : MULTIPLAYER_SNAP_ROT_RAD;
  return positionDeltaM >= snapDistance
    || Math.abs(verticalDeltaM) >= snapVertical
    || rotationDeltaRad >= snapRotation;
}

export function updateLocalVehicleMeshPose(
  state: LocalVehicleVisualPoseState,
  vehicleId: number,
  targetPose: VehiclePose,
  frameDeltaSec: number,
  speedMs: number,
  groundedWheels: number,
  mode: VehicleMeshPoseMode,
): {
  pose: VehiclePose;
  metrics: VehicleMeshPoseMetrics;
} {
  const targetQuat = new THREE.Quaternion(
    targetPose.quaternion[0],
    targetPose.quaternion[1],
    targetPose.quaternion[2],
    targetPose.quaternion[3],
  );
  const targetEuler = new THREE.Euler().setFromQuaternion(targetQuat, 'YXZ');

  if (state.vehicleId !== vehicleId) {
    state.vehicleId = vehicleId;
    state.position.set(targetPose.position[0], targetPose.position[1], targetPose.position[2]);
    state.quaternion.copy(targetQuat);
    state.euler.copy(targetEuler);
  } else {
    const dx = targetPose.position[0] - state.position.x;
    const dy = targetPose.position[1] - state.position.y;
    const dz = targetPose.position[2] - state.position.z;
    const positionDeltaM = Math.hypot(dx, dy, dz);
    const rotationDeltaRad = quaternionAngle(state.quaternion, targetQuat);
    const shouldSnap = shouldSnapVehicleMeshPose(
      positionDeltaM,
      dy,
      rotationDeltaRad,
      groundedWheels,
      mode,
    );

    if (shouldSnap) {
      state.position.set(targetPose.position[0], targetPose.position[1], targetPose.position[2]);
      state.quaternion.copy(targetQuat);
      state.euler.copy(targetEuler);
    } else {
      if (mode === 'practice') {
        const verticalRate = PRACTICE_VERTICAL_RATE + Math.min(speedMs * 0.2, 8.0);
        const yawRate = PRACTICE_YAW_RATE + Math.min(speedMs * 0.12, 6.0);
        const tiltRate = PRACTICE_TILT_RATE + Math.min(speedMs * 0.08, 4.0);
        state.position.x = THREE.MathUtils.damp(state.position.x, targetPose.position[0], PRACTICE_PLANAR_RATE, frameDeltaSec);
        state.position.y = THREE.MathUtils.damp(state.position.y, targetPose.position[1], verticalRate, frameDeltaSec);
        state.position.z = THREE.MathUtils.damp(state.position.z, targetPose.position[2], PRACTICE_PLANAR_RATE, frameDeltaSec);
        state.euler.x = dampAngle(state.euler.x, targetEuler.x, tiltRate, frameDeltaSec);
        state.euler.y = dampAngle(state.euler.y, targetEuler.y, yawRate, frameDeltaSec);
        state.euler.z = dampAngle(state.euler.z, targetEuler.z, tiltRate, frameDeltaSec);
      } else {
        const maxPlanarStepM = Math.max(
          MULTIPLAYER_PLANAR_STEP_MIN_M,
          speedMs * frameDeltaSec * MULTIPLAYER_PLANAR_STEP_SPEED_SCALE + MULTIPLAYER_PLANAR_STEP_EXTRA_M,
        );
        const heaveRate = MULTIPLAYER_HEAVE_RATE + Math.min(speedMs * 0.2, 8.0);
        const yawRate = MULTIPLAYER_YAW_RATE + Math.min(speedMs * 0.08, 6.0);
        const tiltRate = MULTIPLAYER_TILT_RATE + Math.min(speedMs * 0.08, 4.0);
        // Keep normal local motion exact, but cap single-frame visual outliers
        // caused by prediction/contact discontinuities so they do not render as
        // chassis teleports.
        stepPlanarToward(state.position, targetPose.position[0], targetPose.position[2], maxPlanarStepM);
        state.position.y = THREE.MathUtils.damp(state.position.y, targetPose.position[1], heaveRate, frameDeltaSec);
        state.euler.x = dampAngle(state.euler.x, targetEuler.x, tiltRate, frameDeltaSec);
        state.euler.y = dampAngle(state.euler.y, targetEuler.y, yawRate, frameDeltaSec);
        state.euler.z = dampAngle(state.euler.z, targetEuler.z, tiltRate, frameDeltaSec);
      }
      state.quaternion.setFromEuler(state.euler);
    }
  }

  const pose: VehiclePose = {
    position: [state.position.x, state.position.y, state.position.z],
    quaternion: [state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w],
  };
  return {
    pose,
    metrics: {
      positionDeltaM: Math.hypot(
        pose.position[0] - targetPose.position[0],
        pose.position[1] - targetPose.position[1],
        pose.position[2] - targetPose.position[2],
      ),
      rotationDeltaRad: quaternionAngle(state.quaternion, targetQuat),
    },
  };
}

export function resetLocalVehicleMeshPose(state: LocalVehicleVisualPoseState): void {
  state.vehicleId = null;
}
