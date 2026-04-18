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
    battery_count: 0,
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
      player_query_ctx_ms: { avg: 0.2, p95: 0.3, max: 0.4 },
      player_kcc_ms: { avg: 4, p95: 5, max: 6 },
      player_kcc_horizontal_ms: { avg: 2, p95: 2.5, max: 3 },
      player_kcc_support_ms: { avg: 1.5, p95: 2, max: 2.5 },
      player_kcc_merged_ms: { avg: 0, p95: 0, max: 0 },
      player_support_probe_ms: { avg: 0.1, p95: 0.2, max: 0.3 },
      player_collider_sync_ms: { avg: 0, p95: 0.01, max: 0.02 },
      player_dynamic_contact_query_ms: { avg: 0.05, p95: 0.1, max: 0.2 },
      player_dynamic_interaction_ms: { avg: 0.1, p95: 0.2, max: 0.3 },
      player_dynamic_impulse_apply_ms: { avg: 0.02, p95: 0.03, max: 0.05 },
      player_history_record_ms: { avg: 0.05, p95: 0.08, max: 0.1 },
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
      strict_snapshot_drops: 0,
      strict_snapshot_drop_oversize: 0,
      strict_snapshot_drop_connection_closed: 0,
      strict_snapshot_drop_unsupported_peer: 0,
      strict_snapshot_drop_other: 0,
      dropped_outbound_packets: 0,
      dropped_outbound_snapshots: 0,
      snapshot_bytes_per_client: { avg: 500, p95: 700, max: 900 },
      snapshot_bytes_per_tick: { avg: 2000, p95: 2500, max: 2800 },
      snapshot_players_per_client: { avg: 4, p95: 4, max: 4 },
      snapshot_dynamic_bodies_per_client: { avg: 8, p95: 10, max: 12 },
      snapshot_vehicles_per_client: { avg: 1, p95: 1, max: 1 },
      visible_batteries_per_client: { avg: 0, p95: 0, max: 0 },
      local_player_energy_packets_sent: 0,
      local_player_energy_bytes_sent: 0,
      battery_sync_packets_sent: 0,
      battery_sync_bytes_sent: 0,
      dynamic_bodies_considered_per_tick: { avg: 0, p95: 0, max: 0 },
      dynamic_contacts_raw_per_tick: { avg: 0, p95: 0, max: 0 },
      dynamic_contacts_kept_per_tick: { avg: 0, p95: 0, max: 0 },
      dynamic_bodies_pushed_per_tick: { avg: 0, p95: 0, max: 0 },
      dynamic_impulses_applied_per_tick: { avg: 0, p95: 0, max: 0 },
      contacted_dynamic_mass_per_tick: { avg: 0, p95: 0, max: 0 },
      player_kcc_horizontal_calls_per_tick: { avg: 4, p95: 4, max: 4 },
      player_kcc_support_calls_per_tick: { avg: 4, p95: 4, max: 4 },
      player_support_probe_count_per_tick: { avg: 1, p95: 1, max: 1 },
      player_support_probe_hit_count_per_tick: { avg: 1, p95: 1, max: 1 },
      awake_dynamic_bodies_total: { avg: 2, p95: 3, max: 3 },
      awake_dynamic_bodies_near_players: { avg: 1, p95: 1, max: 2 },
      players_in_vehicles: { avg: 0, p95: 0, max: 0 },
      dead_players_skipped: { avg: 0, p95: 0, max: 0 },
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
        datagramFallbacks: { comparator: 'upper', warn: 0, fail: 1 },
        strictSnapshotDrops: { comparator: 'upper', warn: 0, fail: 1 },
        maxPendingInputs: { comparator: 'upper', warn: 16, fail: 24 },
        connectedRatio: { comparator: 'lower', warn: 0.95, fail: 0.8 },
        deadPlayersSkippedP95: { comparator: 'upper', warn: 1, fail: 2 },
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

  it('uses measurement-window deltas for cumulative counters', () => {
    const base = makeMatch({
      network: {
        ...makeMatch().network,
        datagram_fallbacks: 7,
        strict_snapshot_drops: 11,
      },
      load: {
        ...makeMatch().load,
        void_kills: 2,
      },
    });
    const later = makeMatch({
      network: {
        ...base.network,
        datagram_fallbacks: 9,
        strict_snapshot_drops: 14,
      },
      load: {
        ...base.load,
        void_kills: 3,
      },
    });

    const measured = buildMeasuredWindow(
      'test',
      [
        { at: new Date().toISOString(), match: base },
        { at: new Date(Date.now() + 1000).toISOString(), match: later },
      ],
      60,
    );

    expect(measured.peakMetrics.datagramFallbacks).toBe(2);
    expect(measured.peakMetrics.strictSnapshotDrops).toBe(3);
    expect(measured.peakMetrics.voidKills).toBe(1);
  });

  it('fails when too many dead players are skipped in the measured window', () => {
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
        datagramFallbacks: { comparator: 'upper', warn: 0, fail: 1 },
        strictSnapshotDrops: { comparator: 'upper', warn: 0, fail: 1 },
        maxPendingInputs: { comparator: 'upper', warn: 16, fail: 24 },
        connectedRatio: { comparator: 'lower', warn: 0.95, fail: 0.8 },
        deadPlayersSkippedP95: { comparator: 'upper', warn: 1, fail: 2 },
        voidKills: { comparator: 'upper', warn: 0, fail: 1 },
      },
      scenario: {
        botCount: 4,
        transportMix: { websocket: 0, webtransport: 4 },
      },
    });
    const measured = buildMeasuredWindow('test', [{
      at: new Date().toISOString(),
      match: makeMatch({
        network: {
          ...makeMatch().network,
          dead_players_skipped: { avg: 2, p95: 3, max: 4 },
        },
      }),
    }], 60);
    const evaluation = evaluateScenario(spec, measured, 1, [], [], []);
    expect(evaluation.verdict).toBe('fail');
    expect(evaluation.thresholdOutcomes.find((outcome) => outcome.metric === 'dead_players_skipped_p95')?.verdict).toBe('fail');
  });

  it('fails invalid benchmark anomalies even when numeric thresholds pass', () => {
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
        datagramFallbacks: { comparator: 'upper', warn: 0, fail: 1 },
        strictSnapshotDrops: { comparator: 'upper', warn: 0, fail: 1 },
        maxPendingInputs: { comparator: 'upper', warn: 16, fail: 24 },
        connectedRatio: { comparator: 'lower', warn: 0.95, fail: 0.8 },
        deadPlayersSkippedP95: { comparator: 'upper', warn: 1, fail: 2 },
        voidKills: { comparator: 'upper', warn: 0, fail: 1 },
      },
      scenario: {
        botCount: 4,
        transportMix: { websocket: 0, webtransport: 4 },
      },
    });
    const measured = buildMeasuredWindow('test', [{ at: new Date().toISOString(), match: makeMatch() }], 60);
    const evaluation = evaluateScenario(
      spec,
      measured,
      1,
      ['Invalid benchmark: missing play worker result payloads.'],
      [],
      [],
    );
    expect(evaluation.verdict).toBe('fail');
  });
});
