export interface SummaryStatsSnapshot {
  avg: number;
  p95: number;
  max: number;
}

export interface MatchTimingSnapshot {
  total_ms: SummaryStatsSnapshot;
  player_sim_ms: SummaryStatsSnapshot;
  vehicle_ms: SummaryStatsSnapshot;
  dynamics_ms: SummaryStatsSnapshot;
  hitscan_ms: SummaryStatsSnapshot;
  snapshot_ms: SummaryStatsSnapshot;
}

export interface MatchNetworkSnapshot {
  inbound_bps: number;
  outbound_bps: number;
  inbound_packets_per_sec: number;
  outbound_packets_per_sec: number;
  total_inbound_bytes: number;
  total_outbound_bytes: number;
  total_inbound_packets: number;
  total_outbound_packets: number;
  reliable_packets_sent: number;
  datagram_packets_sent: number;
  datagram_fallbacks: number;
  malformed_packets: number;
  snapshot_bytes_per_client: SummaryStatsSnapshot;
  snapshot_bytes_per_tick: SummaryStatsSnapshot;
}

export interface MatchLoadSnapshot {
  nearby_radius_m: number;
  avg_nearby_players: number;
  max_nearby_players: number;
  websocket_players: number;
  webtransport_players: number;
  void_kills: number;
}

export interface PlayerStatsSnapshot {
  id: number;
  identity: string;
  transport: string;
  one_way_ms: number;
  pending_inputs: number;
  hp: number;
  pos_m: [number, number, number];
  vel_ms: [number, number, number];
  on_ground: boolean;
  in_vehicle: boolean;
  dead: boolean;
  input_jitter_ms: number;
  avg_bundle_size: number;
  correction_m: number;
  physics_ms: number;
}

export interface MatchStatsSnapshot {
  id: string;
  scenario_tag: string;
  server_tick: number;
  player_count: number;
  dynamic_body_count: number;
  vehicle_count: number;
  chunk_count: number;
  load: MatchLoadSnapshot;
  timings: MatchTimingSnapshot;
  network: MatchNetworkSnapshot;
  players: PlayerStatsSnapshot[];
}

export interface GlobalStatsSnapshot {
  sim_hz: number;
  snapshot_hz: number;
  matches: MatchStatsSnapshot[];
}

export function totalPhysicsP95(match: MatchStatsSnapshot): number {
  return match.timings.player_sim_ms.p95 + match.timings.vehicle_ms.p95 + match.timings.dynamics_ms.p95;
}

export function describeBottleneck(match: MatchStatsSnapshot): string {
  const timingCandidates = [
    ['player movement', match.timings.player_sim_ms.p95],
    ['dynamic bodies', match.timings.dynamics_ms.p95],
    ['vehicles', match.timings.vehicle_ms.p95],
    ['hitscan', match.timings.hitscan_ms.p95],
    ['snapshot encode', match.timings.snapshot_ms.p95],
  ] as const;
  const [timingName, timingMs] = timingCandidates.reduce((best, current) =>
    current[1] > best[1] ? current : best,
  );

  const snapshotBytes = match.network.snapshot_bytes_per_client.p95;
  if (snapshotBytes > 1_000 || match.network.datagram_fallbacks > 0) {
    const mode = match.network.datagram_fallbacks > 0 ? 'WT datagram overflow' : 'network-heavy snapshots';
    return `${mode}: ${timingName} ${timingMs.toFixed(1)}ms, snapshot p95 ${(snapshotBytes / 1024).toFixed(1)} KiB/client`;
  }
  return `${timingName} p95 ${timingMs.toFixed(1)}ms`;
}
