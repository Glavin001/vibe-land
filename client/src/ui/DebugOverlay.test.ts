import { describe, expect, it } from 'vitest';
import { debugStatsToMarkdown, DEFAULT_STATS } from './DebugOverlay';

describe('debugStatsToMarkdown', () => {
  it('includes local vehicle mesh jitter diagnostics', () => {
    const markdown = debugStatsToMarkdown({
      ...DEFAULT_STATS,
      vehicleMeshDeltaM: 0.123,
      vehicleMeshRotDeltaRad: 0.045,
      vehicleMeshDeltaRms5sM: 0.111,
      vehicleMeshDeltaPeak5sM: 0.333,
      vehicleRestJitterRms5sM: 0.02,
      vehicleStraightJitterRms5sM: 0.05,
      vehicleLatestAuthDeltaM: 1.234,
      vehicleSampledAuthDeltaM: 0.222,
      vehicleCurrentAuthDeltaM: 0.111,
      vehicleMeshCurrentAuthDeltaM: 0.099,
      vehicleAckBacklogMs: 50,
    });

    expect(markdown).toContain('vehicle_mesh_delta_m: 0.123');
    expect(markdown).toContain('vehicle_mesh_rot_delta_rad: 0.045');
    expect(markdown).toContain('vehicle_rest_jitter_rms_5s_m: 0.020');
    expect(markdown).toContain('vehicle_straight_jitter_rms_5s_m: 0.050');
    expect(markdown).toContain('vehicle_latest_auth_delta_m: 1.234');
    expect(markdown).toContain('vehicle_sampled_auth_delta_m: 0.222');
    expect(markdown).toContain('vehicle_current_auth_delta_m: 0.111');
    expect(markdown).toContain('vehicle_mesh_current_auth_delta_m: 0.099');
    expect(markdown).toContain('vehicle_ack_backlog_ms: 50.00');
  });
});
