import { describe, expect, it } from 'vitest';
import {
  describeBottleneck,
  describeTransport,
  tickHeadroomMs,
  type MatchStatsSnapshot,
} from './serverStats';

function makeMatch(overrides: Partial<MatchStatsSnapshot> = {}): MatchStatsSnapshot {
  return {
    id: 'default',
    scenario_tag: 'default',
    server_tick: 1,
    player_count: 4,
    dynamic_body_count: 51,
    vehicle_count: 1,
    chunk_count: 16,
    load: {
      nearby_radius_m: 12,
      avg_nearby_players: 1.5,
      max_nearby_players: 2,
      websocket_players: 0,
      webtransport_players: 4,
      void_kills: 0,
      ...overrides.load,
    },
    timings: {
      total_ms: { avg: 8, p95: 10, max: 12 },
      player_sim_ms: { avg: 3, p95: 4, max: 5 },
      player_move_math_ms: { avg: 0.5, p95: 0.7, max: 0.9 },
      player_query_ctx_ms: { avg: 0.2, p95: 0.3, max: 0.4 },
      player_kcc_ms: { avg: 2.0, p95: 2.5, max: 3.0 },
      player_kcc_horizontal_ms: { avg: 1.3, p95: 1.5, max: 1.8 },
      player_kcc_support_ms: { avg: 0.6, p95: 0.8, max: 1.0 },
      player_kcc_merged_ms: { avg: 0, p95: 0, max: 0 },
      player_support_probe_ms: { avg: 0.05, p95: 0.1, max: 0.15 },
      player_collider_sync_ms: { avg: 0.1, p95: 0.2, max: 0.3 },
      player_dynamic_contact_query_ms: { avg: 0.05, p95: 0.08, max: 0.1 },
      player_dynamic_interaction_ms: { avg: 0.4, p95: 0.6, max: 0.8 },
      player_dynamic_impulse_apply_ms: { avg: 0.02, p95: 0.05, max: 0.08 },
      player_history_record_ms: { avg: 0.03, p95: 0.06, max: 0.08 },
      vehicle_ms: { avg: 0.1, p95: 0.2, max: 0.3 },
      dynamics_ms: { avg: 4, p95: 5, max: 6 },
      hitscan_ms: { avg: 0, p95: 0, max: 0 },
      snapshot_ms: { avg: 0.1, p95: 0.2, max: 0.4 },
      ...overrides.timings,
    },
    network: {
      inbound_bps: 1000,
      outbound_bps: 10000,
      inbound_packets_per_sec: 50,
      outbound_packets_per_sec: 100,
      total_inbound_bytes: 10000,
      total_outbound_bytes: 100000,
      total_inbound_packets: 1000,
      total_outbound_packets: 2000,
      reliable_packets_sent: 0,
      datagram_packets_sent: 0,
      datagram_fallbacks: 0,
      malformed_packets: 0,
      snapshot_reliable_sent: 0,
      snapshot_datagram_sent: 0,
      websocket_snapshot_reliable_sent: 0,
      webtransport_snapshot_reliable_sent: 20,
      webtransport_snapshot_datagram_sent: 980,
      strict_snapshot_drops: 0,
      strict_snapshot_drop_oversize: 0,
      strict_snapshot_drop_connection_closed: 0,
      strict_snapshot_drop_unsupported_peer: 0,
      strict_snapshot_drop_other: 0,
      dropped_outbound_packets: 0,
      dropped_outbound_snapshots: 0,
      snapshot_bytes_per_client: { avg: 700, p95: 800, max: 900 },
      snapshot_bytes_per_tick: { avg: 4096, p95: 5000, max: 5500 },
      snapshot_players_per_client: { avg: 4, p95: 4, max: 4 },
      snapshot_dynamic_bodies_per_client: { avg: 12, p95: 16, max: 20 },
      snapshot_vehicles_per_client: { avg: 1, p95: 1, max: 1 },
      dynamic_bodies_considered_per_tick: { avg: 1, p95: 2, max: 3 },
      dynamic_contacts_raw_per_tick: { avg: 2, p95: 3, max: 4 },
      dynamic_contacts_kept_per_tick: { avg: 1, p95: 2, max: 3 },
      dynamic_bodies_pushed_per_tick: { avg: 1, p95: 1, max: 2 },
      dynamic_impulses_applied_per_tick: { avg: 1, p95: 1, max: 2 },
      contacted_dynamic_mass_per_tick: { avg: 0.5, p95: 0.8, max: 1.0 },
      player_kcc_horizontal_calls_per_tick: { avg: 4, p95: 4, max: 4 },
      player_kcc_support_calls_per_tick: { avg: 4, p95: 4, max: 4 },
      player_support_probe_count_per_tick: { avg: 1, p95: 1, max: 1 },
      player_support_probe_hit_count_per_tick: { avg: 1, p95: 1, max: 1 },
      awake_dynamic_bodies_total: { avg: 3, p95: 4, max: 5 },
      awake_dynamic_bodies_near_players: { avg: 2, p95: 3, max: 4 },
      players_in_vehicles: { avg: 0, p95: 0, max: 0 },
      dead_players_skipped: { avg: 0, p95: 0, max: 0 },
      ...overrides.network,
    },
    players: [
      {
        id: 1,
        identity: 'p1',
        transport: 'webtransport',
        one_way_ms: 12,
        pending_inputs: 0,
        hp: 100,
        pos_m: [0, 0, 0],
        vel_ms: [0, 0, 0],
        on_ground: true,
        in_vehicle: false,
        dead: false,
        input_jitter_ms: 2,
        avg_bundle_size: 1,
        correction_m: 0,
        physics_ms: 0,
        has_debug_stats: true,
      },
    ],
    ...overrides,
  };
}

describe('serverStats heuristics', () => {
  it('reports healthy matches when tick headroom is good', () => {
    const match = makeMatch();
    expect(describeBottleneck(match, 60)).toContain('Healthy');
    expect(tickHeadroomMs(match, 60)).toBeGreaterThan(0);
  });

  it('reports occasional WT fallback when fallback ratio is small', () => {
    const match = makeMatch({
      network: {
        ...makeMatch().network,
        webtransport_snapshot_reliable_sent: 80,
        webtransport_snapshot_datagram_sent: 920,
      },
    });
    expect(describeBottleneck(match, 60)).toContain('WT occasional fallback');
    expect(describeTransport(match)).toContain('WT mixed delivery');
  });

  it('reports near tick budget when headroom is small but still positive', () => {
    const match = makeMatch({
      timings: {
        ...makeMatch().timings,
        total_ms: { avg: 14, p95: 15.8, max: 18 },
        dynamics_ms: { avg: 9, p95: 11, max: 12 },
      },
    });
    expect(describeBottleneck(match, 60)).toContain('Near tick budget');
  });

  it('reports CPU-limited when tick p95 exceeds budget', () => {
    const match = makeMatch({
      timings: {
        ...makeMatch().timings,
        total_ms: { avg: 15, p95: 16.8, max: 18.5 },
        dynamics_ms: { avg: 9, p95: 11, max: 12 },
      },
    });
    expect(describeBottleneck(match, 60)).toContain('CPU-limited');
  });

  it('does not claim WT overflow on websocket-only matches', () => {
    const match = makeMatch({
      load: {
        nearby_radius_m: 12,
        avg_nearby_players: 1,
        max_nearby_players: 2,
        websocket_players: 6,
        webtransport_players: 0,
        void_kills: 0,
      },
      network: {
        ...makeMatch().network,
        websocket_snapshot_reliable_sent: 1000,
        webtransport_snapshot_reliable_sent: 0,
        webtransport_snapshot_datagram_sent: 0,
      },
    });
    expect(describeBottleneck(match, 60)).not.toContain('WT');
    expect(describeTransport(match)).toBe('websocket-only');
  });
});
