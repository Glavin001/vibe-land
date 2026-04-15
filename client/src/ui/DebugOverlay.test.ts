import { describe, expect, it } from 'vitest';
import { debugStatsToMarkdown, DEFAULT_STATS } from './DebugOverlay';
import { buildVehicleDeepCaptureMarkdown, type VehicleDeepCaptureSample } from './useDebugStats';

describe('debugStatsToMarkdown', () => {
  it('includes local vehicle mesh jitter diagnostics', () => {
    const markdown = debugStatsToMarkdown({
      ...DEFAULT_STATS,
      vehicleMeshDeltaM: 0.123,
      vehicleMeshRotDeltaRad: 0.045,
      vehicleMeshDeltaRms5sM: 0.111,
      vehicleMeshDeltaPeak5sM: 0.333,
      vehicleMeshFrameDeltaRms5sM: 0.101,
      vehicleMeshFrameDeltaPeak5sM: 0.222,
      vehicleRestJitterRms5sM: 0.02,
      vehicleStraightJitterRms5sM: 0.05,
      vehicleRawHeaveDeltaRms5sM: 0.011,
      vehicleRawPlanarDeltaRms5sM: 0.021,
      vehicleRawYawDeltaRms5sRad: 0.031,
      vehicleRawPitchDeltaRms5sRad: 0.012,
      vehicleLatestAuthDeltaM: 1.234,
      vehicleSampledAuthDeltaM: 0.222,
      vehicleCurrentAuthDeltaM: 0.111,
      vehicleMeshCurrentAuthDeltaM: 0.099,
      vehicleExpectedLeadM: 0.088,
      vehicleCurrentAuthUnexplainedDeltaM: 0.044,
      vehicleAckBacklogMs: 50,
    });

    expect(markdown).toContain('vehicle_mesh_delta_m: 0.123');
    expect(markdown).toContain('vehicle_mesh_rot_delta_rad: 0.045');
    expect(markdown).toContain('vehicle_mesh_frame_delta_rms_5s_m: 0.101');
    expect(markdown).toContain('vehicle_rest_jitter_rms_5s_m: 0.020');
    expect(markdown).toContain('vehicle_straight_jitter_rms_5s_m: 0.050');
    expect(markdown).toContain('vehicle_raw_heave_delta_rms_5s_m: 0.011');
    expect(markdown).toContain('vehicle_raw_planar_delta_rms_5s_m: 0.021');
    expect(markdown).toContain('vehicle_raw_yaw_delta_rms_5s_rad: 0.031');
    expect(markdown).toContain('vehicle_raw_pitch_delta_rms_5s_rad: 0.012');
    expect(markdown).toContain('vehicle_latest_auth_delta_m: 1.234');
    expect(markdown).toContain('vehicle_sampled_auth_delta_m: 0.222');
    expect(markdown).toContain('vehicle_current_auth_delta_m: 0.111');
    expect(markdown).toContain('vehicle_mesh_current_auth_delta_m: 0.099');
    expect(markdown).toContain('vehicle_expected_lead_m: 0.088');
    expect(markdown).toContain('vehicle_current_auth_unexplained_delta_m: 0.044');
    expect(markdown).toContain('vehicle_ack_backlog_ms: 50.00');
  });

  it('appends deep capture diagnostics when provided', () => {
    const samples: VehicleDeepCaptureSample[] = [
      {
        atMs: 1000,
        frameTimeMs: 16.7,
        speedMs: 10,
        groundedWheels: 4,
        wheelContactBits: 0b1111,
        wheelContactBitChanges: 0,
        wheelContactNormalDeltaRad: 0.01,
        wheelGroundObjectSwitches: 0,
        ackBacklogMs: 33.3,
        resendWindow: 4,
        replayErrorM: 0.01,
        correctionM: 0.02,
        predictedFrameDeltaM: 0.05,
        predictedPlanarDeltaM: 0.04,
        predictedHeaveDeltaM: 0.01,
        predictedYawDeltaRad: 0.02,
        predictedPitchDeltaRad: 0.01,
        predictedRollDeltaRad: 0.01,
        predictedResidualDeltaM: 0.01,
        predictedResidualPlanarDeltaM: 0.01,
        predictedResidualHeaveDeltaM: 0.005,
        predictedResidualYawDeltaRad: 0.004,
        predictedResidualPitchDeltaRad: 0.003,
        predictedResidualRollDeltaRad: 0.002,
        meshFrameDeltaM: 0.03,
        meshFrameRotDeltaRad: 0.01,
        meshOffsetToPredictedM: 0.02,
        meshOffsetToCurrentAuthM: 0.03,
        cameraFrameDeltaM: 0.02,
        cameraFrameRotDeltaRad: 0.01,
        suspensionLengthSpreadM: 0.02,
        suspensionForceSpreadN: 50,
        suspensionLengthDeltaM: 0.01,
        suspensionForceDeltaN: 20,
        currentAuthDeltaM: 0.10,
        currentAuthPlanarDeltaM: 0.09,
        currentAuthVerticalDeltaM: 0.01,
        currentAuthUnexplainedDeltaM: 0.03,
        expectedLeadM: 0.07,
        groundedTransitionThisFrame: false,
      },
      {
        atMs: 1100,
        frameTimeMs: 16.7,
        speedMs: 11,
        groundedWheels: 3,
        wheelContactBits: 0b0111,
        wheelContactBitChanges: 1,
        wheelContactNormalDeltaRad: 0.02,
        wheelGroundObjectSwitches: 1,
        ackBacklogMs: 50,
        resendWindow: 4,
        replayErrorM: 0.02,
        correctionM: 0.01,
        predictedFrameDeltaM: 0.06,
        predictedPlanarDeltaM: 0.05,
        predictedHeaveDeltaM: 0.01,
        predictedYawDeltaRad: 0.03,
        predictedPitchDeltaRad: 0.01,
        predictedRollDeltaRad: 0.02,
        predictedResidualDeltaM: 0.02,
        predictedResidualPlanarDeltaM: 0.015,
        predictedResidualHeaveDeltaM: 0.01,
        predictedResidualYawDeltaRad: 0.006,
        predictedResidualPitchDeltaRad: 0.004,
        predictedResidualRollDeltaRad: 0.003,
        meshFrameDeltaM: 0.04,
        meshFrameRotDeltaRad: 0.01,
        meshOffsetToPredictedM: 0.03,
        meshOffsetToCurrentAuthM: 0.04,
        cameraFrameDeltaM: 0.03,
        cameraFrameRotDeltaRad: 0.01,
        suspensionLengthSpreadM: 0.03,
        suspensionForceSpreadN: 60,
        suspensionLengthDeltaM: 0.015,
        suspensionForceDeltaN: 30,
        currentAuthDeltaM: 0.12,
        currentAuthPlanarDeltaM: 0.11,
        currentAuthVerticalDeltaM: 0.01,
        currentAuthUnexplainedDeltaM: 0.04,
        expectedLeadM: 0.08,
        groundedTransitionThisFrame: true,
      },
    ];
    const markdown = debugStatsToMarkdown(DEFAULT_STATS, {
      deepCaptureEnabled: true,
      deepCaptureReport: buildVehicleDeepCaptureMarkdown(samples),
    });

    expect(markdown).toContain('## Deep Capture');
    expect(markdown).toContain('- enabled: yes');
    expect(markdown).toContain('## Vehicle Deep Capture');
    expect(markdown).toContain('grounded_transitions_10s: 1');
    expect(markdown).toContain('wheel_contact_bit_changes_10s: 1');
    expect(markdown).toContain('wheel_contact_normal_delta_rms_10s_rad');
    expect(markdown).toContain('wheel_ground_object_switches_10s: 1');
    expect(markdown).toContain('t_ms speed gw bits ack_ms exp_lead unexpl_auth');
  });
});
