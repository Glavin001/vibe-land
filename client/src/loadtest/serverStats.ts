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
  snapshot_reliable_sent: number;
  snapshot_datagram_sent: number;
  websocket_snapshot_reliable_sent: number;
  webtransport_snapshot_reliable_sent: number;
  webtransport_snapshot_datagram_sent: number;
  snapshot_bytes_per_client: SummaryStatsSnapshot;
  snapshot_bytes_per_tick: SummaryStatsSnapshot;
  snapshot_players_per_client: SummaryStatsSnapshot;
  snapshot_dynamic_bodies_per_client: SummaryStatsSnapshot;
  snapshot_vehicles_per_client: SummaryStatsSnapshot;
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
  has_debug_stats: boolean;
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

export function tickBudgetMs(simHz: number): number {
  return simHz > 0 ? 1000 / simHz : 0;
}

export function totalPhysicsP95(match: MatchStatsSnapshot): number {
  return match.timings.player_sim_ms.p95 + match.timings.vehicle_ms.p95 + match.timings.dynamics_ms.p95;
}

export function tickHeadroomMs(match: MatchStatsSnapshot, simHz: number): number {
  return tickBudgetMs(simHz) - match.timings.total_ms.p95;
}

export function maxPendingInputs(match: MatchStatsSnapshot): number {
  return match.players.reduce((max, player) => Math.max(max, player.pending_inputs), 0);
}

export function avgPendingInputs(match: MatchStatsSnapshot): number {
  if (match.players.length === 0) return 0;
  return match.players.reduce((sum, player) => sum + player.pending_inputs, 0) / match.players.length;
}

export function webTransportSnapshotFallbackRatio(match: MatchStatsSnapshot): number {
  const total =
    match.network.webtransport_snapshot_datagram_sent + match.network.webtransport_snapshot_reliable_sent;
  if (total <= 0) return 0;
  return match.network.webtransport_snapshot_reliable_sent / total;
}

export function webTransportSnapshotDatagramRatio(match: MatchStatsSnapshot): number {
  const total =
    match.network.webtransport_snapshot_datagram_sent + match.network.webtransport_snapshot_reliable_sent;
  if (total <= 0) return 0;
  return match.network.webtransport_snapshot_datagram_sent / total;
}

export function describeTransport(match: MatchStatsSnapshot): string {
  if (match.load.webtransport_players === 0) {
    if (match.load.websocket_players === 0) return 'no clients';
    return 'websocket-only';
  }
  const total =
    match.network.webtransport_snapshot_datagram_sent + match.network.webtransport_snapshot_reliable_sent;
  if (total <= 0) return 'WT awaiting snapshot samples';
  const datagramRatio = webTransportSnapshotDatagramRatio(match);
  if (datagramRatio >= 0.95) return `WT mostly datagrams (${(datagramRatio * 100).toFixed(1)}%)`;
  if (datagramRatio >= 0.8) return `WT mixed delivery (${(datagramRatio * 100).toFixed(1)}% datagram)`;
  return `WT fallback-heavy (${(datagramRatio * 100).toFixed(1)}% datagram)`;
}

export function describeBottleneck(match: MatchStatsSnapshot, simHz = 60): string {
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

  const budgetMs = tickBudgetMs(simHz);
  const headroomMs = tickHeadroomMs(match, simHz);
  const snapshotBytes = match.network.snapshot_bytes_per_client.p95;
  const wtFallbackRatio = webTransportSnapshotFallbackRatio(match);
  const pendingMax = maxPendingInputs(match);

  if (budgetMs > 0 && headroomMs <= 0) {
    return `CPU-limited: ${timingName} ${timingMs.toFixed(1)}ms, tick p95 ${match.timings.total_ms.p95.toFixed(1)}ms / ${budgetMs.toFixed(1)}ms budget`;
  }
  if (budgetMs > 0 && headroomMs <= 4.0) {
    return `Near tick budget: ${timingName} ${timingMs.toFixed(1)}ms, headroom ${headroomMs.toFixed(1)}ms`;
  }
  if (match.load.webtransport_players > 0 && wtFallbackRatio >= 0.25) {
    return `WT datagram overflow: ${(wtFallbackRatio * 100).toFixed(1)}% reliable fallback, snapshot p95 ${(snapshotBytes / 1024).toFixed(1)} KiB/client`;
  }
  if (match.load.webtransport_players > 0 && wtFallbackRatio >= 0.05) {
    return `WT occasional fallback: ${(wtFallbackRatio * 100).toFixed(1)}% reliable fallback, snapshot p95 ${(snapshotBytes / 1024).toFixed(1)} KiB/client`;
  }
  if (snapshotBytes > 1_000) {
    const mode = match.load.webtransport_players > 0 ? 'large WT snapshots' : 'large snapshots';
    return `${mode}: ${timingName} ${timingMs.toFixed(1)}ms, snapshot p95 ${(snapshotBytes / 1024).toFixed(1)} KiB/client`;
  }
  if (pendingMax >= 20) {
    return `Input backlog: max in-buf ${pendingMax}, ${timingName} ${timingMs.toFixed(1)}ms, headroom ${headroomMs.toFixed(1)}ms`;
  }
  return `Healthy: ${timingName} ${timingMs.toFixed(1)}ms, headroom ${headroomMs.toFixed(1)}ms`;
}
