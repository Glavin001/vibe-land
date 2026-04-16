import type { DebugStats } from '../ui/DebugOverlay';

export const VEHICLE_BENCHMARK_SETTLE_MS = 5000;

export type VehicleBenchmarkAccumulator = {
  samples: number;
  firstDriverConfirmedAtMs: number | null;
  skippedStartupSamples: number;
  maxSpeedMs: number;
  vehiclePendingInputs: number;
  vehicleAckBacklogMs: number;
  vehicleCurrentAuthDeltaM: number;
  vehicleMeshCurrentAuthDeltaM: number;
  vehicleCurrentAuthUnexplainedDeltaM: number;
  vehicleRestJitterRms5sM: number;
  vehicleStraightJitterRms5sM: number;
  vehicleRawHeaveDeltaRms5sM: number;
  vehicleRawPlanarDeltaRms5sM: number;
  vehicleRawYawDeltaRms5sRad: number;
  vehicleRawPitchDeltaRms5sRad: number;
  vehicleRawRollDeltaRms5sRad: number;
  vehicleResidualPlanarDeltaRms5sM: number;
  vehicleResidualHeaveDeltaRms5sM: number;
  vehicleResidualYawDeltaRms5sRad: number;
  vehicleWheelContactBitChanges5s: number;
  vehicleGroundedTransitions5s: number;
  vehicleSuspensionLengthDeltaRms5sM: number;
  vehicleSuspensionForceDeltaRms5sN: number;
  vehicleSuspensionLengthSpreadPeak5sM: number;
  vehicleSuspensionForceSpreadPeak5sN: number;
  vehicleWheelContactNormalDeltaRms5sRad: number;
  vehicleWheelGroundObjectSwitches5s: number;
  vehicleMeshFrameDeltaRms5sM: number;
  vehicleCameraFrameDeltaRms5sM: number;
  vehiclePredictedAuthDeltaRms5sM: number;
  vehiclePredictedAuthDeltaPeak5sM: number;
};

export function createVehicleBenchmarkAccumulator(): VehicleBenchmarkAccumulator {
  return {
    samples: 0,
    firstDriverConfirmedAtMs: null,
    skippedStartupSamples: 0,
    maxSpeedMs: 0,
    vehiclePendingInputs: 0,
    vehicleAckBacklogMs: 0,
    vehicleCurrentAuthDeltaM: 0,
    vehicleMeshCurrentAuthDeltaM: 0,
    vehicleCurrentAuthUnexplainedDeltaM: 0,
    vehicleRestJitterRms5sM: 0,
    vehicleStraightJitterRms5sM: 0,
    vehicleRawHeaveDeltaRms5sM: 0,
    vehicleRawPlanarDeltaRms5sM: 0,
    vehicleRawYawDeltaRms5sRad: 0,
    vehicleRawPitchDeltaRms5sRad: 0,
    vehicleRawRollDeltaRms5sRad: 0,
    vehicleResidualPlanarDeltaRms5sM: 0,
    vehicleResidualHeaveDeltaRms5sM: 0,
    vehicleResidualYawDeltaRms5sRad: 0,
    vehicleWheelContactBitChanges5s: 0,
    vehicleGroundedTransitions5s: 0,
    vehicleSuspensionLengthDeltaRms5sM: 0,
    vehicleSuspensionForceDeltaRms5sN: 0,
    vehicleSuspensionLengthSpreadPeak5sM: 0,
    vehicleSuspensionForceSpreadPeak5sN: 0,
    vehicleWheelContactNormalDeltaRms5sRad: 0,
    vehicleWheelGroundObjectSwitches5s: 0,
    vehicleMeshFrameDeltaRms5sM: 0,
    vehicleCameraFrameDeltaRms5sM: 0,
    vehiclePredictedAuthDeltaRms5sM: 0,
    vehiclePredictedAuthDeltaPeak5sM: 0,
  };
}

function maxFinite(current: number, value: number): number {
  return Number.isFinite(value) ? Math.max(current, value) : current;
}

export function sampleVehicleBenchmarkAccumulator(
  accumulator: VehicleBenchmarkAccumulator,
  stats: DebugStats,
  nowMs: number,
): void {
  if (!stats.inVehicle || stats.vehicleDebugId === 0 || !stats.vehicleDriverConfirmed) {
    accumulator.firstDriverConfirmedAtMs = null;
    return;
  }
  if (accumulator.firstDriverConfirmedAtMs == null) {
    accumulator.firstDriverConfirmedAtMs = nowMs;
  }
  if (nowMs - accumulator.firstDriverConfirmedAtMs < VEHICLE_BENCHMARK_SETTLE_MS) {
    accumulator.skippedStartupSamples += 1;
    return;
  }

  accumulator.samples += 1;
  accumulator.maxSpeedMs = maxFinite(
    accumulator.maxSpeedMs,
    Math.max(stats.vehicleLocalSpeedMs, stats.vehicleServerSpeedMs),
  );
  accumulator.vehiclePendingInputs = maxFinite(accumulator.vehiclePendingInputs, stats.vehiclePendingInputs);
  accumulator.vehicleAckBacklogMs = maxFinite(accumulator.vehicleAckBacklogMs, stats.vehicleAckBacklogMs);
  accumulator.vehicleCurrentAuthDeltaM = maxFinite(accumulator.vehicleCurrentAuthDeltaM, stats.vehicleCurrentAuthDeltaM);
  accumulator.vehicleMeshCurrentAuthDeltaM = maxFinite(accumulator.vehicleMeshCurrentAuthDeltaM, stats.vehicleMeshCurrentAuthDeltaM);
  accumulator.vehicleCurrentAuthUnexplainedDeltaM = maxFinite(accumulator.vehicleCurrentAuthUnexplainedDeltaM, stats.vehicleCurrentAuthUnexplainedDeltaM);
  accumulator.vehicleRestJitterRms5sM = maxFinite(accumulator.vehicleRestJitterRms5sM, stats.vehicleRestJitterRms5sM);
  accumulator.vehicleStraightJitterRms5sM = maxFinite(accumulator.vehicleStraightJitterRms5sM, stats.vehicleStraightJitterRms5sM);
  accumulator.vehicleRawHeaveDeltaRms5sM = maxFinite(accumulator.vehicleRawHeaveDeltaRms5sM, stats.vehicleRawHeaveDeltaRms5sM);
  accumulator.vehicleRawPlanarDeltaRms5sM = maxFinite(accumulator.vehicleRawPlanarDeltaRms5sM, stats.vehicleRawPlanarDeltaRms5sM);
  accumulator.vehicleRawYawDeltaRms5sRad = maxFinite(accumulator.vehicleRawYawDeltaRms5sRad, stats.vehicleRawYawDeltaRms5sRad);
  accumulator.vehicleRawPitchDeltaRms5sRad = maxFinite(accumulator.vehicleRawPitchDeltaRms5sRad, stats.vehicleRawPitchDeltaRms5sRad);
  accumulator.vehicleRawRollDeltaRms5sRad = maxFinite(accumulator.vehicleRawRollDeltaRms5sRad, stats.vehicleRawRollDeltaRms5sRad);
  accumulator.vehicleResidualPlanarDeltaRms5sM = maxFinite(accumulator.vehicleResidualPlanarDeltaRms5sM, stats.vehicleResidualPlanarDeltaRms5sM);
  accumulator.vehicleResidualHeaveDeltaRms5sM = maxFinite(accumulator.vehicleResidualHeaveDeltaRms5sM, stats.vehicleResidualHeaveDeltaRms5sM);
  accumulator.vehicleResidualYawDeltaRms5sRad = maxFinite(accumulator.vehicleResidualYawDeltaRms5sRad, stats.vehicleResidualYawDeltaRms5sRad);
  accumulator.vehicleWheelContactBitChanges5s = maxFinite(accumulator.vehicleWheelContactBitChanges5s, stats.vehicleWheelContactBitChanges5s);
  accumulator.vehicleGroundedTransitions5s = maxFinite(accumulator.vehicleGroundedTransitions5s, stats.vehicleGroundedTransitions5s);
  accumulator.vehicleSuspensionLengthDeltaRms5sM = maxFinite(accumulator.vehicleSuspensionLengthDeltaRms5sM, stats.vehicleSuspensionLengthDeltaRms5sM);
  accumulator.vehicleSuspensionForceDeltaRms5sN = maxFinite(accumulator.vehicleSuspensionForceDeltaRms5sN, stats.vehicleSuspensionForceDeltaRms5sN);
  accumulator.vehicleSuspensionLengthSpreadPeak5sM = maxFinite(accumulator.vehicleSuspensionLengthSpreadPeak5sM, stats.vehicleSuspensionLengthSpreadPeak5sM);
  accumulator.vehicleSuspensionForceSpreadPeak5sN = maxFinite(accumulator.vehicleSuspensionForceSpreadPeak5sN, stats.vehicleSuspensionForceSpreadPeak5sN);
  accumulator.vehicleWheelContactNormalDeltaRms5sRad = maxFinite(accumulator.vehicleWheelContactNormalDeltaRms5sRad, stats.vehicleWheelContactNormalDeltaRms5sRad);
  accumulator.vehicleWheelGroundObjectSwitches5s = maxFinite(accumulator.vehicleWheelGroundObjectSwitches5s, stats.vehicleWheelGroundObjectSwitches5s);
  accumulator.vehicleMeshFrameDeltaRms5sM = maxFinite(accumulator.vehicleMeshFrameDeltaRms5sM, stats.vehicleMeshFrameDeltaRms5sM);
  accumulator.vehicleCameraFrameDeltaRms5sM = maxFinite(accumulator.vehicleCameraFrameDeltaRms5sM, stats.vehicleCameraFrameDeltaRms5sM);
  accumulator.vehiclePredictedAuthDeltaRms5sM = maxFinite(accumulator.vehiclePredictedAuthDeltaRms5sM, stats.vehiclePredictedAuthDeltaRms5sM);
  accumulator.vehiclePredictedAuthDeltaPeak5sM = maxFinite(accumulator.vehiclePredictedAuthDeltaPeak5sM, stats.vehiclePredictedAuthDeltaPeak5sM);
}
