import { describe, expect, it } from 'vitest';
import type { DebugStats } from '../ui/DebugOverlay';
import {
  createVehicleBenchmarkAccumulator,
  sampleVehicleBenchmarkAccumulator,
  VEHICLE_BENCHMARK_SETTLE_MS,
} from './vehicleAccumulator';

function vehicleStats(overrides: Partial<DebugStats> = {}): DebugStats {
  return {
    inVehicle: true,
    vehicleDebugId: 1,
    vehicleDriverConfirmed: true,
    vehicleLocalSpeedMs: 12,
    vehicleServerSpeedMs: 12.5,
    vehiclePendingInputs: 2,
    vehicleAckBacklogMs: 33.33,
    vehicleCurrentAuthDeltaM: 0.04,
    vehicleMeshCurrentAuthDeltaM: 0.03,
    vehicleCurrentAuthUnexplainedDeltaM: 0.01,
    vehicleRestJitterRms5sM: 0,
    vehicleStraightJitterRms5sM: 0.02,
    vehicleRawHeaveDeltaRms5sM: 0.01,
    vehicleRawPlanarDeltaRms5sM: 0.08,
    vehicleRawYawDeltaRms5sRad: 0.01,
    vehicleRawPitchDeltaRms5sRad: 0.01,
    vehicleRawRollDeltaRms5sRad: 0.01,
    vehicleResidualPlanarDeltaRms5sM: 0.04,
    vehicleResidualHeaveDeltaRms5sM: 0.01,
    vehicleResidualYawDeltaRms5sRad: 0.01,
    vehicleWheelContactBitChanges5s: 2,
    vehicleGroundedTransitions5s: 2,
    vehicleSuspensionLengthDeltaRms5sM: 0.01,
    vehicleSuspensionForceDeltaRms5sN: 250,
    vehicleSuspensionLengthSpreadPeak5sM: 0.02,
    vehicleSuspensionForceSpreadPeak5sN: 1200,
    vehicleWheelContactNormalDeltaRms5sRad: 0.01,
    vehicleWheelGroundObjectSwitches5s: 0,
    vehicleMeshFrameDeltaRms5sM: 0.08,
    vehicleCameraFrameDeltaRms5sM: 0.05,
    vehiclePredictedAuthDeltaRms5sM: 0.08,
    vehiclePredictedAuthDeltaPeak5sM: 0.15,
    ...overrides,
  } as DebugStats;
}

describe('vehicle benchmark accumulator', () => {
  it('ignores driver startup settling before recording steady-state metrics', () => {
    const accumulator = createVehicleBenchmarkAccumulator();

    sampleVehicleBenchmarkAccumulator(
      accumulator,
      vehicleStats({
        vehiclePendingInputs: 100,
        vehicleAckBacklogMs: 2000,
        vehicleRawHeaveDeltaRms5sM: 1.2,
      }),
      1000,
    );
    sampleVehicleBenchmarkAccumulator(
      accumulator,
      vehicleStats({
        vehiclePendingInputs: 80,
        vehicleAckBacklogMs: 1200,
        vehicleRawHeaveDeltaRms5sM: 0.8,
      }),
      1000 + VEHICLE_BENCHMARK_SETTLE_MS - 1,
    );

    expect(accumulator.samples).toBe(0);
    expect(accumulator.skippedStartupSamples).toBe(2);
    expect(accumulator.vehiclePendingInputs).toBe(0);

    sampleVehicleBenchmarkAccumulator(
      accumulator,
      vehicleStats({
        vehiclePendingInputs: 3,
        vehicleAckBacklogMs: 50,
        vehicleRawHeaveDeltaRms5sM: 0.02,
      }),
      1000 + VEHICLE_BENCHMARK_SETTLE_MS,
    );

    expect(accumulator.samples).toBe(1);
    expect(accumulator.vehiclePendingInputs).toBe(3);
    expect(accumulator.vehicleAckBacklogMs).toBe(50);
    expect(accumulator.vehicleRawHeaveDeltaRms5sM).toBe(0.02);
  });

  it('restarts the settle window when the local driver leaves the vehicle', () => {
    const accumulator = createVehicleBenchmarkAccumulator();

    sampleVehicleBenchmarkAccumulator(accumulator, vehicleStats(), 1000);
    sampleVehicleBenchmarkAccumulator(accumulator, vehicleStats(), 1000 + VEHICLE_BENCHMARK_SETTLE_MS);
    expect(accumulator.samples).toBe(1);

    sampleVehicleBenchmarkAccumulator(accumulator, vehicleStats({ inVehicle: false }), 7000);
    sampleVehicleBenchmarkAccumulator(accumulator, vehicleStats({ vehiclePendingInputs: 99 }), 7100);

    expect(accumulator.samples).toBe(1);
    expect(accumulator.skippedStartupSamples).toBe(2);
    expect(accumulator.vehiclePendingInputs).toBe(2);
  });
});
