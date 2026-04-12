import { describe, expect, it } from 'vitest';
import { buildMeasuredWindow, evaluateScenario } from './evaluate';
import { createScenarioSpec } from './spec';
import type { MatchStatsSnapshot } from '../loadtest/serverStats';

function makeMatch(overrides: Partial<MatchStatsSnapshot> = {}): MatchStatsSnapshot {
  return {
    id: 'test',
    scenario_tag: 'test',
    server_tick: 100,
    player_count: 4,
    dynamic_body_count: 10,
    vehicle_count: 1,
    chunk_count: 0,
    load: {
      nearby_radius_m: 16,
      avg_nearby_players: 2,
      max_nearby_players: 3,
      websocket_players: 0,
      webtransport_players: 4,
      void_kills: 0,
    },
    timings: {
      total_ms: { avg: 10, p95: 12, max: 14 },
      player_sim_ms: { avg: 5, p95: 6, max: 8 },
      player_move_math_ms: { avg: 0.1, p95: 0.2, max: 0.3 },
      player_kcc_ms: { avg: 4, p95: 5, max: 6 },
      player_collider_sync_ms: { avg: 0, p95: 0.01, max: 0.02 },
      player_dynamic_interaction_ms: { avg: 0.1, p95: 0.2, max: 0.3 },
      vehicle_ms: { avg: 0.1, p95: 0.2, max: 0.3 },
      dynamics_ms: { avg: 2, p95: 3, max: 4 },
      hitscan_ms: { avg: 0.1, p95: 0.2, max: 0.3 },
      snapshot_ms: { avg: 0.1, p95: 0.2, max: 0.3 },
    },
    network: {
      inbound_bps: 1000,
      outbound_bps: 2000,
      inbound_packets_per_sec: 10,
      outbound_packets_per_sec: 20,
      total_inbound_bytes: 10000,
      total_outbound_bytes: 20000,
      total_inbound_packets: 100,
      total_outbound_packets: 200,
      reliable_packets_sent: 0,
      datagram_packets_sent: 0,
      datagram_fallbacks: 0,
      malformed_packets: 0,
      snapshot_reliable_sent: 0,
      snapshot_datagram_sent: 0,
      websocket_snapshot_reliable_sent: 0,
      webtransport_snapshot_reliable_sent: 5,
      webtransport_snapshot_datagram_sent: 95,
      snapshot_bytes_per_client: { avg: 500, p95: 700, max: 900 },
      snapshot_bytes_per_tick: { avg: 2000, p95: 2500, max: 2800 },
      snapshot_players_per_client: { avg: 4, p95: 4, max: 4 },
      snapshot_dynamic_bodies_per_client: { avg: 8, p95: 10, max: 12 },
      snapshot_vehicles_per_client: { avg: 1, p95: 1, max: 1 },
      dynamic_bodies_considered_per_tick: { avg: 0, p95: 0, max: 0 },
      dynamic_bodies_pushed_per_tick: { avg: 0, p95: 0, max: 0 },
      contacted_dynamic_mass_per_tick: { avg: 0, p95: 0, max: 0 },
    },
    players: [
      {
        id: 1,
        identity: 'p1',
        transport: 'WT',
        one_way_ms: 10,
        pending_inputs: 2,
        hp: 100,
        pos_m: [0, 0, 0],
        vel_ms: [0, 0, 0],
        on_ground: true,
        in_vehicle: false,
        dead: false,
        input_jitter_ms: 2,
        avg_bundle_size: 1,
        correction_m: 0,
        physics_ms: 0.1,
        has_debug_stats: true,
      },
    ],
    ...overrides,
  };
}

describe('benchmark evaluation', () => {
  it('warns when connected ratio dips below threshold', () => {
    const spec = createScenarioSpec({
      name: 'test',
      environment: 'local',
      warmupS: 2,
      measureS: 2,
      thresholds: {
        tickP95Ms: { comparator: 'upper', warn: 14, fail: 16 },
        playerKccP95Ms: { comparator: 'upper', warn: 8, fail: 10 },
        dynamicsP95Ms: { comparator: 'upper', warn: 6, fail: 8 },
        snapshotBytesPerClientP95: { comparator: 'upper', warn: 900, fail: 1200 },
        wtReliableRatio: { comparator: 'upper', warn: 0.1, fail: 0.2 },
        maxPendingInputs: { comparator: 'upper', warn: 16, fail: 24 },
        connectedRatio: { comparator: 'lower', warn: 0.95, fail: 0.8 },
        voidKills: { comparator: 'upper', warn: 0, fail: 1 },
      },
      scenario: {
        botCount: 4,
        transportMix: { websocket: 0, webtransport: 4 },
      },
    });
    const measured = buildMeasuredWindow('test', [{ at: new Date().toISOString(), match: makeMatch() }], 60);
    const evaluation = evaluateScenario(spec, measured, 0.9, [], [], []);
    expect(evaluation.verdict).toBe('warn');
    expect(evaluation.thresholdOutcomes.find((outcome) => outcome.metric === 'connected_ratio')?.verdict).toBe('warn');
  });
});
