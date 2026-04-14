import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { resolveMultiplayerBackend } from '../app/runtimeConfig';
import {
  avgPendingInputs,
  describeBottleneck,
  describeTransport,
  maxPendingInputs,
  tickBudgetMs,
  tickHeadroomMs,
  totalPhysicsP95,
  webTransportSnapshotDatagramRatio,
  webTransportSnapshotFallbackRatio,
  type GlobalStatsSnapshot,
  type MatchStatsSnapshot,
  type PlayerStatsSnapshot,
} from '../loadtest/serverStats';

type ConnState = 'connecting' | 'connected' | 'disconnected';

type MatchHistoryPoint = {
  atMs: number;
  serverTick: number;
  tickP95Ms: number;
  totalPhysicsP95Ms: number;
  snapshotBytesPerClientP95: number;
  snapshotBytesPerTickP95: number;
  outboundBps: number;
  inboundBps: number;
  outboundPacketsPerSec: number;
  inboundPacketsPerSec: number;
  headroomMs: number;
  maxPendingInputs: number;
  playerCount: number;
  wtDatagramRatio: number;
  wtReliableRatio: number;
};

type MatchHistoryMap = Record<string, MatchHistoryPoint[]>;

type ChartSeries = {
  label: string;
  color: string;
  values: number[];
  dashed?: boolean;
};

type BreakdownSegment = {
  label: string;
  value: number;
  color: string;
};

type DistributionRow = {
  label: string;
  avg: number;
  p95: number;
  max: number;
};

type ConstraintRow = {
  label: string;
  value: number;
  display: string;
  note?: string;
};

type ConstraintAlert = {
  tone: SeverityTone;
  text: string;
};

type SeverityTone = 'celebrate' | 'good' | 'watch' | 'danger' | 'neutral';

const HISTORY_LIMIT = 90;
const WT_STRICT_DATAGRAM_TARGET_BYTES = 1100;
const SERVER_PENDING_INPUT_CAP = 120;
const NEAR_LIMIT_RATIO = 0.9;

const BG = '#07111d';
const PANEL = '#0e1a2b';
const PANEL_ALT = '#122239';
const PANEL_SOFT = '#162844';
const BORDER = '#274463';
const FG = '#e7f0ff';
const MUTED = '#8aa3c2';
const DIM = '#5f7797';
const GREEN = '#63e6be';
const GREEN_SOFT = '#1f8f6a';
const YELLOW = '#ffd166';
const ORANGE = '#ff9f5a';
const RED = '#ff6b6b';
const BLUE = '#6ea8fe';
const CYAN = '#6ef2ff';
const PURPLE = '#b692ff';
const PINK = '#ff89c2';
const TEAL = '#57d9c1';
const GRAY = '#8593a6';

function severityVisual(tone: SeverityTone): {
  color: string;
  background: string;
  border: string;
  label: string;
} {
  switch (tone) {
    case 'celebrate':
      return {
        color: GREEN,
        background: 'rgba(99, 230, 190, 0.12)',
        border: 'rgba(99, 230, 190, 0.30)',
        label: 'Great',
      };
    case 'good':
      return {
        color: CYAN,
        background: 'rgba(110, 242, 255, 0.10)',
        border: 'rgba(110, 242, 255, 0.28)',
        label: 'Good',
      };
    case 'watch':
      return {
        color: YELLOW,
        background: 'rgba(255, 209, 102, 0.12)',
        border: 'rgba(255, 209, 102, 0.30)',
        label: 'Watch',
      };
    case 'danger':
      return {
        color: RED,
        background: 'rgba(255, 107, 107, 0.12)',
        border: 'rgba(255, 107, 107, 0.32)',
        label: 'Danger',
      };
    case 'neutral':
    default:
      return {
        color: MUTED,
        background: 'rgba(138, 163, 194, 0.08)',
        border: 'rgba(138, 163, 194, 0.22)',
        label: 'Neutral',
      };
  }
}

function severityRank(tone: SeverityTone): number {
  switch (tone) {
    case 'danger':
      return 4;
    case 'watch':
      return 3;
    case 'good':
      return 2;
    case 'celebrate':
      return 1;
    case 'neutral':
    default:
      return 0;
  }
}

function worstSeverity(tones: SeverityTone[]): SeverityTone {
  return tones.reduce<SeverityTone>((worst, tone) => (
    severityRank(tone) > severityRank(worst) ? tone : worst
  ), 'neutral');
}

function useServerStats() {
  const [stats, setStats] = useState<GlobalStatsSnapshot | null>(null);
  const [connState, setConnState] = useState<ConnState>('connecting');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsWebSocketUrl = resolveMultiplayerBackend().statsWebSocketUrl;

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) {
        return;
      }
      const ws = new WebSocket(statsWebSocketUrl);
      wsRef.current = ws;
      setConnState('connecting');

      ws.onopen = () => {
        if (!cancelled) {
          setConnState('connected');
        }
      };

      ws.onmessage = (event) => {
        if (cancelled) {
          return;
        }
        try {
          const nextStats = JSON.parse(event.data as string) as GlobalStatsSnapshot;
          setStats(nextStats);
          setLastUpdate(new Date());
        } catch {
          // Ignore malformed websocket payloads.
        }
      };

      ws.onclose = () => {
        if (cancelled) {
          return;
        }
        setConnState('disconnected');
        retryTimer.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
      }
      wsRef.current?.close();
    };
  }, [statsWebSocketUrl]);

  return { stats, connState, lastUpdate };
}

function clampPositive(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function fmt(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function fmtInt(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toString() : '—';
}

function fmtMsDetailed(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  if (value === 0) {
    return '0.00';
  }
  if (value < 0.01) {
    return '<0.01';
  }
  return value < 1 ? value.toFixed(2) : value.toFixed(1);
}

function fmtRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond)) {
    return '—';
  }
  if (bytesPerSecond >= 1024 * 1024) {
    return `${fmt(bytesPerSecond / 1024 / 1024, 2)} MiB/s`;
  }
  if (bytesPerSecond >= 1024) {
    return `${fmt(bytesPerSecond / 1024, 1)} KiB/s`;
  }
  return `${fmt(bytesPerSecond, 0)} B/s`;
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return '—';
  }
  if (bytes >= 1024 * 1024) {
    return `${fmt(bytes / 1024 / 1024, 2)} MiB`;
  }
  if (bytes >= 1024) {
    return `${fmt(bytes / 1024, 2)} KiB`;
  }
  return `${fmt(bytes, 0)} B`;
}

function fmtKiB(bytes: number): string {
  return Number.isFinite(bytes) ? `${fmt(bytes / 1024, 2)} KiB` : '—';
}

function fmtPercent(ratio: number, digits = 1): string {
  return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(digits)}%` : '—';
}

function fractionOfLimit(value: number, limit: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(limit) || limit <= 0) {
    return value > 0 ? 1 : 0;
  }
  return value / limit;
}

function limitStateLabel(value: number, limit: number, nearRatio = NEAR_LIMIT_RATIO): string {
  const tone = limitSeverity(value, limit, nearRatio);
  if (tone === 'danger') {
    return limit <= 0 ? 'NONZERO' : 'EXCEEDED';
  }
  if (tone === 'watch') {
    return 'NEAR LIMIT';
  }
  if (tone === 'celebrate') {
    return limit <= 0 ? 'CLEAR' : 'LOTS OF HEADROOM';
  }
  return limit <= 0 ? 'CLEAR' : 'OK';
}

function limitUtilizationLabel(value: number, limit: number): string {
  if (limit <= 0) {
    return value > 0 ? `${fmtInt(value)} issues` : '0 issues';
  }
  const ratio = fractionOfLimit(value, limit);
  if (ratio > 1) {
    return `${fmtPercent(ratio, 0)} of limit`;
  }
  return `${fmtPercent(ratio, 0)} of limit`;
}

function limitSeverity(value: number, limit: number, nearRatio = NEAR_LIMIT_RATIO): SeverityTone {
  if (limit <= 0) {
    return value > 0 ? 'danger' : 'celebrate';
  }
  const ratio = fractionOfLimit(value, limit);
  if (ratio > 1) {
    return 'danger';
  }
  if (ratio >= nearRatio) {
    return 'watch';
  }
  if (ratio <= 0.55) {
    return 'celebrate';
  }
  return 'good';
}

function lowerIsBetterSeverity(
  value: number,
  celebrateMax: number,
  goodMax: number,
  watchMax: number,
): SeverityTone {
  if (!Number.isFinite(value)) {
    return 'neutral';
  }
  if (value <= celebrateMax) {
    return 'celebrate';
  }
  if (value <= goodMax) {
    return 'good';
  }
  if (value <= watchMax) {
    return 'watch';
  }
  return 'danger';
}

function higherIsBetterSeverity(
  value: number,
  celebrateMin: number,
  goodMin: number,
  watchMin: number,
): SeverityTone {
  if (!Number.isFinite(value)) {
    return 'neutral';
  }
  if (value >= celebrateMin) {
    return 'celebrate';
  }
  if (value >= goodMin) {
    return 'good';
  }
  if (value >= watchMin) {
    return 'watch';
  }
  return 'danger';
}

function headroomSeverity(headroomMs: number, budgetMs: number): SeverityTone {
  return higherIsBetterSeverity(headroomMs, budgetMs * 0.45, budgetMs * 0.2, 0.01);
}

function playerPressureSeverity(player: PlayerStatsSnapshot): SeverityTone {
  const correction = player.has_debug_stats ? player.correction_m : 0;
  const worst = worstSeverity([
    lowerIsBetterSeverity(player.pending_inputs, 2, 8, 20),
    lowerIsBetterSeverity(player.one_way_ms, 25, 60, 100),
    lowerIsBetterSeverity(player.input_jitter_ms, 4, 10, 20),
    player.has_debug_stats ? lowerIsBetterSeverity(correction, 0.03, 0.1, 0.5) : 'neutral',
  ]);
  if (worst !== 'neutral') {
    return worst;
  }
  if (player.dead) {
    return 'neutral';
  }
  return 'good';
}

function transportRatioSeverity(match: MatchStatsSnapshot): SeverityTone {
  return higherIsBetterSeverity(webTransportSnapshotDatagramRatio(match), 0.98, 0.85, 0.65);
}

function SeverityIcon({
  tone,
  size = 14,
}: {
  tone: SeverityTone;
  size?: number;
}) {
  const visual = severityVisual(tone);
  const common = {
    fill: 'none',
    stroke: visual.color,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      {tone === 'celebrate' ? (
        <>
          <path {...common} d="M12 3 13.8 8.2 19 10 13.8 11.8 12 17 10.2 11.8 5 10 10.2 8.2 12 3Z" />
          <path {...common} d="M18.5 3.5v3" />
          <path {...common} d="M17 5h3" />
        </>
      ) : null}
      {tone === 'good' ? (
        <>
          <circle {...common} cx="12" cy="12" r="9" />
          <path {...common} d="m8.5 12.5 2.3 2.3 4.7-5.3" />
        </>
      ) : null}
      {tone === 'watch' ? (
        <>
          <path {...common} d="M12 4 20 19H4L12 4Z" />
          <path {...common} d="M12 9v4.5" />
          <path {...common} d="M12 17h.01" />
        </>
      ) : null}
      {tone === 'danger' ? (
        <>
          <circle {...common} cx="12" cy="12" r="9" />
          <path {...common} d="m9 9 6 6" />
          <path {...common} d="m15 9-6 6" />
        </>
      ) : null}
      {tone === 'neutral' ? (
        <>
          <circle {...common} cx="12" cy="12" r="9" />
          <path {...common} d="M8 12h8" />
        </>
      ) : null}
    </svg>
  );
}

function SeverityBadge({
  tone,
  label,
}: {
  tone: SeverityTone;
  label?: string;
}) {
  const visual = severityVisual(tone);
  return (
    <span
      style={{
        ...styles.severityBadge,
        color: visual.color,
        background: visual.background,
        borderColor: visual.border,
      }}
    >
      <SeverityIcon tone={tone} size={12} />
      <span>{label ?? visual.label}</span>
    </span>
  );
}

function fmtPos(pos: [number, number, number]): string {
  return pos.every((value) => Number.isFinite(value))
    ? `${fmt(pos[0], 1)}, ${fmt(pos[1], 1)}, ${fmt(pos[2], 1)}`
    : '—';
}

function fmtSpeed(vel: [number, number, number]): string {
  if (!vel.every((value) => Number.isFinite(value))) {
    return '—';
  }
  return `${fmt(Math.hypot(vel[0], vel[1], vel[2]), 1)} m/s`;
}

function statusStr(player: PlayerStatsSnapshot): string {
  if (player.dead) {
    return 'DEAD';
  }
  if (player.in_vehicle) {
    return 'VEHICLE';
  }
  if (player.on_ground) {
    return 'GROUND';
  }
  return 'AIR';
}

function statusTone(player: PlayerStatsSnapshot): string {
  if (player.dead) {
    return RED;
  }
  if (player.in_vehicle) {
    return CYAN;
  }
  if (player.on_ground) {
    return GREEN;
  }
  return YELLOW;
}

function tickSeverity(match: MatchStatsSnapshot, simHz: number): SeverityTone {
  return limitSeverity(match.timings.total_ms.p95, tickBudgetMs(simHz));
}

function snapshotPayloadSeverity(match: MatchStatsSnapshot): SeverityTone {
  return limitSeverity(match.network.snapshot_bytes_per_client.p95, WT_STRICT_DATAGRAM_TARGET_BYTES);
}

function backlogSeverity(match: MatchStatsSnapshot): SeverityTone {
  return limitSeverity(maxPendingInputs(match), SERVER_PENDING_INPUT_CAP);
}

function zeroToleranceSeverity(match: MatchStatsSnapshot): SeverityTone {
  return worstSeverity([
    match.network.strict_snapshot_drops > 0 ? 'danger' : 'celebrate',
    match.network.dropped_outbound_snapshots > 0 ? 'danger' : 'celebrate',
    match.network.malformed_packets > 0 ? 'danger' : 'celebrate',
  ]);
}

function relevantTransportSeverity(match: MatchStatsSnapshot): SeverityTone {
  return match.load.webtransport_players > 0 ? transportRatioSeverity(match) : 'neutral';
}

function overallMatchSeverity(match: MatchStatsSnapshot, simHz: number): SeverityTone {
  return worstSeverity([
    tickSeverity(match, simHz),
    snapshotPayloadSeverity(match),
    backlogSeverity(match),
    zeroToleranceSeverity(match),
    relevantTransportSeverity(match),
  ]);
}

function topEntries(entries: Array<{ label: string; value: number }>, count: number): Array<{ label: string; value: number }> {
  return entries
    .filter((entry) => entry.value > 0.01)
    .sort((left, right) => right.value - left.value)
    .slice(0, count);
}

function dominantTickDrivers(match: MatchStatsSnapshot): string {
  const entries = topEntries([
    { label: 'player sim', value: match.timings.player_sim_ms.p95 },
    { label: 'snapshot', value: match.timings.snapshot_ms.p95 },
    { label: 'dynamics', value: match.timings.dynamics_ms.p95 },
    { label: 'vehicles', value: match.timings.vehicle_ms.p95 },
    { label: 'hitscan', value: match.timings.hitscan_ms.p95 },
  ], 2);
  return entries.length > 0
    ? entries.map((entry) => `${entry.label} ${fmtMsDetailed(entry.value)}ms`).join(', ')
    : 'no dominant driver captured';
}

function dominantPlayerDrivers(match: MatchStatsSnapshot): string {
  const entries = topEntries([
    { label: 'move math', value: match.timings.player_move_math_ms.p95 },
    { label: 'query ctx', value: match.timings.player_query_ctx_ms.p95 },
    { label: 'KCC horizontal', value: match.timings.player_kcc_horizontal_ms.p95 },
    { label: 'KCC support', value: match.timings.player_kcc_support_ms.p95 },
    { label: 'KCC merged', value: match.timings.player_kcc_merged_ms.p95 },
    { label: 'support probe', value: match.timings.player_support_probe_ms.p95 },
    { label: 'collider sync', value: match.timings.player_collider_sync_ms.p95 },
    { label: 'dynamic contact query', value: match.timings.player_dynamic_contact_query_ms.p95 },
    { label: 'dynamic interaction', value: match.timings.player_dynamic_interaction_ms.p95 },
    { label: 'impulse apply', value: match.timings.player_dynamic_impulse_apply_ms.p95 },
  ], 3);
  return entries.length > 0
    ? entries.map((entry) => `${entry.label} ${fmtMsDetailed(entry.value)}ms`).join(', ')
    : 'no player sub-step hotspot captured';
}

function snapshotPressureDrivers(match: MatchStatsSnapshot): string {
  const drivers = [
    `${fmt(match.network.snapshot_players_per_client.p95, 1)} players/client p95`,
    `${fmt(match.network.snapshot_dynamic_bodies_per_client.p95, 1)} bodies/client p95`,
    `${fmt(match.network.snapshot_vehicles_per_client.p95, 1)} vehicles/client p95`,
    `${fmt(match.network.dynamic_bodies_pushed_per_tick.p95, 1)} bodies pushed/tick p95`,
  ];
  return drivers.join(', ');
}

function topPlayerPressureSummary(match: MatchStatsSnapshot): string {
  const topPlayers = sortPlayers(match.players).slice(0, 3);
  return topPlayers.length > 0
    ? topPlayers.map((player) => `P${player.id} (${player.pending_inputs} in-buf, ${player.one_way_ms}ms, ±${fmt(player.input_jitter_ms)}ms)`).join('; ')
    : 'none';
}

function buildMatchFocusAreas(match: MatchStatsSnapshot, simHz: number): string[] {
  const focus: string[] = [];
  const tickTone = tickSeverity(match, simHz);
  const payloadTone = snapshotPayloadSeverity(match);
  const queueTone = backlogSeverity(match);
  const transportTone = relevantTransportSeverity(match);

  if (severityRank(tickTone) >= severityRank('watch')) {
    focus.push(
      `Tick budget pressure: p95 ${fmtMsDetailed(match.timings.total_ms.p95)}ms and max ${fmtMsDetailed(match.timings.total_ms.max)}ms against ${fmtMsDetailed(tickBudgetMs(simHz))}ms. Dominant cost drivers: ${dominantTickDrivers(match)}.`,
    );
    if (match.timings.player_sim_ms.p95 >= Math.max(match.timings.snapshot_ms.p95, match.timings.dynamics_ms.p95, match.timings.vehicle_ms.p95)) {
      focus.push(`Player simulation is the largest contributor. Inspect ${dominantPlayerDrivers(match)}.`);
    }
  }

  if (severityRank(payloadTone) >= severityRank('watch')) {
    focus.push(
      `WT payload pressure: snapshot/client p95 ${fmtBytes(match.network.snapshot_bytes_per_client.p95)} and max ${fmtBytes(match.network.snapshot_bytes_per_client.max)} against the ${fmtBytes(WT_STRICT_DATAGRAM_TARGET_BYTES)} strict target. Replication shape: ${snapshotPressureDrivers(match)}.`,
    );
  }

  if (severityRank(queueTone) >= severityRank('watch')) {
    focus.push(
      `Input backlog pressure: max ${fmtInt(maxPendingInputs(match))} and avg ${fmt(avgPendingInputs(match), 1)} against cap ${SERVER_PENDING_INPUT_CAP}. Highest-pressure players: ${topPlayerPressureSummary(match)}.`,
    );
  }

  if (severityRank(transportTone) >= severityRank('watch')) {
    focus.push(
      `WT delivery is leaning reliable: datagram ${fmtPercent(webTransportSnapshotDatagramRatio(match))}, reliable fallback ${fmtPercent(webTransportSnapshotFallbackRatio(match))}. This usually points to oversized snapshots or unstable datagram fit.`,
    );
  }

  if (match.network.strict_snapshot_drops > 0 || match.network.dropped_outbound_snapshots > 0 || match.network.malformed_packets > 0) {
    focus.push(
      `Zero-tolerance counters fired: strict drops ${match.network.strict_snapshot_drops}, dropped outbound snapshots ${match.network.dropped_outbound_snapshots}, malformed packets ${match.network.malformed_packets}.`,
    );
  }

  if (focus.length === 0) {
    focus.push(`No immediate hot path stands out. ${describeBottleneck(match, simHz)} with healthy queue and transport margins.`);
  }

  return focus;
}

function buildMatchOpportunities(match: MatchStatsSnapshot, simHz: number): string[] {
  const opportunities: string[] = [];
  const majorDriver = topEntries([
    { label: 'player sim', value: match.timings.player_sim_ms.p95 },
    { label: 'snapshot', value: match.timings.snapshot_ms.p95 },
    { label: 'dynamics', value: match.timings.dynamics_ms.p95 },
    { label: 'vehicles', value: match.timings.vehicle_ms.p95 },
    { label: 'hitscan', value: match.timings.hitscan_ms.p95 },
  ], 1)[0];

  if (tickSeverity(match, simHz) === 'danger' || tickSeverity(match, simHz) === 'watch') {
    if (majorDriver?.label === 'player sim') {
      opportunities.push(`Reduce player-sim cost first. The biggest sub-steps are ${dominantPlayerDrivers(match)}.`);
    } else if (majorDriver?.label === 'snapshot') {
      opportunities.push(`Trim snapshot build cost first. Tighten AOI and reduce bodies/client replication before chasing lower-level transport tweaks.`);
    } else if (majorDriver?.label === 'dynamics') {
      opportunities.push(`Reduce dynamics/contact pressure. Raw/kept contacts p95 are ${fmt(match.network.dynamic_contacts_raw_per_tick.p95, 1)} / ${fmt(match.network.dynamic_contacts_kept_per_tick.p95, 1)}.`);
    } else if (majorDriver?.label === 'vehicles') {
      opportunities.push(`Vehicle simulation is a meaningful tick contributor. Isolate expensive vehicle scenes and profile per-vehicle cost.`);
    }
  }

  if (snapshotPayloadSeverity(match) === 'danger' || snapshotPayloadSeverity(match) === 'watch') {
    opportunities.push(`Get snapshot/client p95 under ${fmtBytes(WT_STRICT_DATAGRAM_TARGET_BYTES)} so WT can stay mostly datagram-first.`);
  }

  if (relevantTransportSeverity(match) === 'danger' || relevantTransportSeverity(match) === 'watch') {
    opportunities.push(`Improve datagram fit. Reliable fallback is ${fmtPercent(webTransportSnapshotFallbackRatio(match))}; trim payload or split content earlier.`);
  }

  if (backlogSeverity(match) === 'danger' || backlogSeverity(match) === 'watch') {
    opportunities.push(`Reduce queue spikes on the worst players: ${topPlayerPressureSummary(match)}.`);
  }

  if (match.network.strict_snapshot_drops > 0 || match.network.dropped_outbound_snapshots > 0 || match.network.malformed_packets > 0) {
    opportunities.push('Zero-tolerance counters should be driven to zero before trusting higher-scale benchmark runs.');
  }

  if (opportunities.length === 0) {
    opportunities.push('Current scenario looks clean. Increase player count or harsher network presets to find the next real bottleneck.');
  }

  return opportunities.slice(0, 4);
}

function buildMatchWins(match: MatchStatsSnapshot, simHz: number): string[] {
  const wins: string[] = [];

  if (severityRank(tickSeverity(match, simHz)) <= severityRank('good')) {
    wins.push(`Tick cost is controlled: p95 ${fmtMsDetailed(match.timings.total_ms.p95)}ms with ${fmtMsDetailed(tickHeadroomMs(match, simHz))}ms headroom.`);
  }
  if (severityRank(snapshotPayloadSeverity(match)) <= severityRank('good')) {
    wins.push(`Snapshot/client p95 ${fmtBytes(match.network.snapshot_bytes_per_client.p95)} is comfortably below the ${fmtBytes(WT_STRICT_DATAGRAM_TARGET_BYTES)} WT strict target.`);
  }
  if (severityRank(relevantTransportSeverity(match)) <= severityRank('good') && match.load.webtransport_players > 0) {
    wins.push(`WT delivery is healthy: ${fmtPercent(webTransportSnapshotDatagramRatio(match))} datagrams and ${fmtPercent(webTransportSnapshotFallbackRatio(match))} reliable fallback.`);
  }
  if (severityRank(backlogSeverity(match)) <= severityRank('good')) {
    wins.push(`Input queue is stable: max ${fmtInt(maxPendingInputs(match))}, avg ${fmt(avgPendingInputs(match), 1)}.`);
  }
  if (match.network.strict_snapshot_drops === 0 && match.network.dropped_outbound_snapshots === 0 && match.network.malformed_packets === 0) {
    wins.push('Zero-tolerance counters are clean: no strict drops, dropped outbound snapshots, or malformed packets.');
  }

  if (wins.length === 0) {
    wins.push(`No standout positives yet; this run is currently defined by ${describeBottleneck(match, simHz)}.`);
  }

  return wins;
}

function buildGlobalFocusAreas(stats: GlobalStatsSnapshot): string[] {
  const tickAlerts = stats.matches
    .filter((match) => severityRank(tickSeverity(match, stats.sim_hz)) >= severityRank('watch'))
    .sort((left, right) => right.timings.total_ms.p95 - left.timings.total_ms.p95);
  const payloadAlerts = stats.matches
    .filter((match) => severityRank(snapshotPayloadSeverity(match)) >= severityRank('watch'))
    .sort((left, right) => right.network.snapshot_bytes_per_client.p95 - left.network.snapshot_bytes_per_client.p95);
  const queueAlerts = stats.matches
    .filter((match) => severityRank(backlogSeverity(match)) >= severityRank('watch'))
    .sort((left, right) => maxPendingInputs(right) - maxPendingInputs(left));
  const transportAlerts = stats.matches
    .filter((match) => severityRank(zeroToleranceSeverity(match)) >= severityRank('danger'));

  const focus: string[] = [];
  if (tickAlerts.length > 0) {
    const worst = tickAlerts[0];
    focus.push(`Tick pressure on ${tickAlerts.length}/${stats.matches.length} matches. Worst is ${worst.id} at ${fmtMsDetailed(worst.timings.total_ms.p95)}ms p95 vs ${fmtMsDetailed(tickBudgetMs(stats.sim_hz))}ms.`);
  }
  if (payloadAlerts.length > 0) {
    const worst = payloadAlerts[0];
    focus.push(`WT payload pressure on ${payloadAlerts.length}/${stats.matches.length} matches. Worst is ${worst.id} at ${fmtBytes(worst.network.snapshot_bytes_per_client.p95)} p95.`);
  }
  if (queueAlerts.length > 0) {
    const worst = queueAlerts[0];
    focus.push(`Input backlog pressure on ${queueAlerts.length}/${stats.matches.length} matches. Worst is ${worst.id} with ${fmtInt(maxPendingInputs(worst))} pending inputs.`);
  }
  if (transportAlerts.length > 0) {
    focus.push(`Zero-tolerance transport counters fired on ${transportAlerts.length} matches. Fix strict drops/dropped snapshots/malformed packets before trusting capacity ceilings.`);
  }
  if (focus.length === 0) {
    focus.push('No global alarm is active. Current matches are staying inside the main hard guardrails.');
  }
  return focus;
}

function buildGlobalWins(stats: GlobalStatsSnapshot): string[] {
  const wins: string[] = [];
  const allZeroToleranceClean = stats.matches.every((match) => (
    match.network.strict_snapshot_drops === 0
    && match.network.dropped_outbound_snapshots === 0
    && match.network.malformed_packets === 0
  ));
  const allTicksHealthy = stats.matches.every((match) => severityRank(tickSeverity(match, stats.sim_hz)) <= severityRank('good'));
  const allPayloadsHealthy = stats.matches.every((match) => severityRank(snapshotPayloadSeverity(match)) <= severityRank('good'));
  const bestWtMatch = stats.matches
    .filter((match) => match.load.webtransport_players > 0)
    .sort((left, right) => webTransportSnapshotDatagramRatio(right) - webTransportSnapshotDatagramRatio(left))[0];

  if (allTicksHealthy && stats.matches.length > 0) {
    wins.push(`All active matches are inside the tick budget with usable headroom at ${stats.sim_hz} Hz.`);
  }
  if (allPayloadsHealthy && stats.matches.length > 0) {
    wins.push(`All active matches are staying below the ${fmtBytes(WT_STRICT_DATAGRAM_TARGET_BYTES)} WT strict payload target at p95.`);
  }
  if (allZeroToleranceClean && stats.matches.length > 0) {
    wins.push('All active matches are clean on strict drops, dropped outbound snapshots, and malformed packets.');
  }
  if (bestWtMatch) {
    wins.push(`Best WT delivery is ${bestWtMatch.id}: ${fmtPercent(webTransportSnapshotDatagramRatio(bestWtMatch))} datagrams, ${fmtPercent(webTransportSnapshotFallbackRatio(bestWtMatch))} reliable fallback.`);
  }
  if (wins.length === 0) {
    wins.push('No global win is stable across matches yet. Use per-match sections below to isolate what is still holding the system back.');
  }
  return wins;
}

function buildGlobalOpportunities(stats: GlobalStatsSnapshot): string[] {
  const opportunities: string[] = [];
  const worstTick = stats.matches
    .filter((match) => severityRank(tickSeverity(match, stats.sim_hz)) >= severityRank('watch'))
    .sort((left, right) => right.timings.total_ms.p95 - left.timings.total_ms.p95)[0];
  const worstPayload = stats.matches
    .filter((match) => severityRank(snapshotPayloadSeverity(match)) >= severityRank('watch'))
    .sort((left, right) => right.network.snapshot_bytes_per_client.p95 - left.network.snapshot_bytes_per_client.p95)[0];
  const worstQueue = stats.matches
    .filter((match) => severityRank(backlogSeverity(match)) >= severityRank('watch'))
    .sort((left, right) => maxPendingInputs(right) - maxPendingInputs(left))[0];
  const badTransport = stats.matches.find((match) => zeroToleranceSeverity(match) === 'danger');

  if (worstTick) {
    opportunities.push(`Prioritize ${worstTick.id} for tick-time reduction. Current p95 is ${fmtMsDetailed(worstTick.timings.total_ms.p95)}ms, driven by ${dominantTickDrivers(worstTick)}.`);
  }
  if (worstPayload) {
    opportunities.push(`Shrink snapshot/client size on ${worstPayload.id}. P95 is ${fmtBytes(worstPayload.network.snapshot_bytes_per_client.p95)} with replication shaped by ${snapshotPressureDrivers(worstPayload)}.`);
  }
  if (worstQueue) {
    opportunities.push(`Reduce queue pressure on ${worstQueue.id}. Worst players are ${topPlayerPressureSummary(worstQueue)}.`);
  }
  if (badTransport) {
    opportunities.push(`Drive strict drops, dropped outbound snapshots, and malformed packets back to zero on ${badTransport.id} before using the run as a capacity reference.`);
  }
  if (opportunities.length === 0) {
    opportunities.push('The current active set is inside the main guardrails. Scale player count or worsen the network preset to expose the next bottleneck.');
  }

  return opportunities;
}

function markdownBullets(title: string, items: string[]): string[] {
  return [
    `### ${title}`,
    ...items.map((item) => `- ${item}`),
    '',
  ];
}

function escapeMdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function playerRowMarkdown(player: PlayerStatsSnapshot): string {
  const phys = player.has_debug_stats ? `${fmtMsDetailed(player.physics_ms)}ms` : 'n/a';
  const correction = player.has_debug_stats ? `${fmt(player.correction_m, 3)}m` : 'n/a';
  return `| ${player.id} | ${severityVisual(playerPressureSeverity(player)).label} | ${player.transport === 'webtransport' ? 'WT' : 'WS'} | ${player.one_way_ms}ms | ${player.pending_inputs} | ${player.dead ? '—' : `${player.hp}`} | ${escapeMdCell(fmtPos(player.pos_m))} | ${escapeMdCell(fmtSpeed(player.vel_ms))} | ${statusStr(player)} | ±${fmt(player.input_jitter_ms)}ms | ${fmt(player.avg_bundle_size, 1)} | ${correction} | ${phys} |`;
}

function matchMarkdown(match: MatchStatsSnapshot, simHz: number): string {
  const matchTone = overallMatchSeverity(match, simHz);
  const tickTone = tickSeverity(match, simHz);
  const payloadTone = snapshotPayloadSeverity(match);
  const queueTone = backlogSeverity(match);
  const transportTone = relevantTransportSeverity(match);
  const zeroTone = zeroToleranceSeverity(match);
  const wtFallbackRatio = webTransportSnapshotFallbackRatio(match);
  const lines = [
    `## Match: ${match.id}`,
    '',
    `overall: ${severityVisual(matchTone).label} | scenario: ${match.scenario_tag} | bottleneck: ${describeBottleneck(match, simHz)}`,
    `tick: ${match.server_tick} | players: ${match.player_count} | bodies: ${match.dynamic_body_count} | vehicles: ${match.vehicle_count} | chunks: ${match.chunk_count}`,
    '',
    '### Constraint Watch',
    '| Signal | Current | Limit / Target | Status | Diagnostic note |',
    '| --- | --- | --- | --- | --- |',
    `| Tick cost | avg ${fmtMsDetailed(match.timings.total_ms.avg)}ms / p95 ${fmtMsDetailed(match.timings.total_ms.p95)}ms / max ${fmtMsDetailed(match.timings.total_ms.max)}ms | ${fmtMsDetailed(tickBudgetMs(simHz))}ms | ${severityVisual(tickTone).label} | headroom ${fmtMsDetailed(tickHeadroomMs(match, simHz))}ms; drivers: ${escapeMdCell(dominantTickDrivers(match))} |`,
    `| WT payload / client | avg ${fmtBytes(match.network.snapshot_bytes_per_client.avg)} / p95 ${fmtBytes(match.network.snapshot_bytes_per_client.p95)} / max ${fmtBytes(match.network.snapshot_bytes_per_client.max)} | ${fmtBytes(WT_STRICT_DATAGRAM_TARGET_BYTES)} | ${severityVisual(payloadTone).label} | ${escapeMdCell(snapshotPressureDrivers(match))} |`,
    `| Pending inputs | avg ${fmt(avgPendingInputs(match), 1)} / max ${fmtInt(maxPendingInputs(match))} | ${SERVER_PENDING_INPUT_CAP} | ${severityVisual(queueTone).label} | worst players: ${escapeMdCell(topPlayerPressureSummary(match))} |`,
    `| WT delivery | datagram ${fmtPercent(webTransportSnapshotDatagramRatio(match))} / reliable ${fmtPercent(wtFallbackRatio)} | keep datagram dominant | ${severityVisual(transportTone).label} | WS players ${match.load.websocket_players}; WT players ${match.load.webtransport_players} |`,
    `| Zero-tolerance errors | strict ${match.network.strict_snapshot_drops} / dropped ${match.network.dropped_outbound_snapshots} / malformed ${match.network.malformed_packets} | 0 | ${severityVisual(zeroTone).label} | any non-zero here invalidates a clean run |`,
    '',
    ...markdownBullets('What To Focus On', buildMatchFocusAreas(match, simHz)),
    ...markdownBullets('Improvement Opportunities', buildMatchOpportunities(match, simHz)),
    ...markdownBullets('What Is Working Well', buildMatchWins(match, simHz)),
    '### Load Shape',
    `- ws ${match.load.websocket_players} | wt ${match.load.webtransport_players}`,
    `- nearby avg ${fmt(match.load.avg_nearby_players, 1)} | max ${match.load.max_nearby_players}`,
    `- void kills ${match.load.void_kills}`,
    '',
    '### Network',
    `- in ${fmtRate(match.network.inbound_bps)} | out ${fmtRate(match.network.outbound_bps)}`,
    `- packets ${match.network.inbound_packets_per_sec}/${match.network.outbound_packets_per_sec} per sec`,
    `- ${describeTransport(match)}`,
    `- ws reliable ${match.network.websocket_snapshot_reliable_sent} | wt datagram ${match.network.webtransport_snapshot_datagram_sent} | wt reliable ${match.network.webtransport_snapshot_reliable_sent}`,
    `- fallbacks ${match.network.datagram_fallbacks} | strict drops ${match.network.strict_snapshot_drops} | malformed ${match.network.malformed_packets}`,
    '',
    '### Snapshot Shape',
    `- players/client p95 ${fmt(match.network.snapshot_players_per_client.p95, 1)}`,
    `- bodies/client p95 ${fmt(match.network.snapshot_dynamic_bodies_per_client.p95, 1)}`,
    `- vehicles/client p95 ${fmt(match.network.snapshot_vehicles_per_client.p95, 1)}`,
    `- bodies considered/tick p95 ${fmt(match.network.dynamic_bodies_considered_per_tick.p95, 1)}`,
    `- contacts raw/kept p95 ${fmt(match.network.dynamic_contacts_raw_per_tick.p95, 1)} / ${fmt(match.network.dynamic_contacts_kept_per_tick.p95, 1)}`,
    `- bodies pushed/tick p95 ${fmt(match.network.dynamic_bodies_pushed_per_tick.p95, 1)}`,
    `- impulses/support probes p95 ${fmt(match.network.dynamic_impulses_applied_per_tick.p95, 1)} / ${fmt(match.network.player_support_probe_count_per_tick.p95, 1)}`,
    `- awake bodies total/near p95 ${fmt(match.network.awake_dynamic_bodies_total.p95, 1)} / ${fmt(match.network.awake_dynamic_bodies_near_players.p95, 1)}`,
    `- contacted mass/tick p95 ${fmt(match.network.contacted_dynamic_mass_per_tick.p95, 2)}`,
    `- wt reliable ${fmtPercent(wtFallbackRatio)}`,
    `- bytes/tick p95 ${fmtKiB(match.network.snapshot_bytes_per_tick.p95)}`,
    '',
    '### Tick Breakdown',
    `- player movement ${fmt(match.timings.player_sim_ms.p95, 2)}ms`,
    `- movement math ${fmt(match.timings.player_move_math_ms.p95, 2)}ms`,
    `- query ctx ${fmt(match.timings.player_query_ctx_ms.p95, 2)}ms`,
    `- player KCC total ${fmt(match.timings.player_kcc_ms.p95, 2)}ms`,
    `- kcc horizontal/support ${fmt(match.timings.player_kcc_horizontal_ms.p95, 2)} / ${fmt(match.timings.player_kcc_support_ms.p95, 2)}ms`,
    `- support probe/contact query ${fmt(match.timings.player_support_probe_ms.p95, 2)} / ${fmt(match.timings.player_dynamic_contact_query_ms.p95, 2)}ms`,
    `- collider sync ${fmt(match.timings.player_collider_sync_ms.p95, 2)}ms`,
    `- dynamic interaction/apply ${fmt(match.timings.player_dynamic_interaction_ms.p95, 2)} / ${fmt(match.timings.player_dynamic_impulse_apply_ms.p95, 2)}ms`,
    `- history record ${fmt(match.timings.player_history_record_ms.p95, 2)}ms`,
    `- vehicles ${fmt(match.timings.vehicle_ms.p95, 2)}ms`,
    `- dynamic bodies ${fmt(match.timings.dynamics_ms.p95, 2)}ms`,
    `- snapshot ${fmt(match.timings.snapshot_ms.p95, 2)}ms`,
    '',
    '### Players',
    '| ID | Health | Transport | Latency | In-buf | HP | Position (m) | Speed | Status | Net-jitter | Bundle | Correction | Phys-ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...(match.players.length > 0 ? match.players.map(playerRowMarkdown) : ['| — | — | — | — | — | — | — | — | — | — | — | — | — |']),
  ];
  return lines.join('\n');
}

function statsMarkdown(stats: GlobalStatsSnapshot, lastUpdate: Date | null, connState: ConnState): string {
  const lines = [
    '# vibe-land / server-stats',
    '',
    `build: ${stats.server_build_profile} | sim: ${stats.sim_hz} Hz | snapshots: ${stats.snapshot_hz} Hz | matches: ${stats.matches.length}`,
    `connection: ${connState}`,
    `updated: ${lastUpdate ? lastUpdate.toISOString() : 'unknown'}`,
    '',
    '## Fixed Constraints',
    `- tick budget: ${fmtMsDetailed(tickBudgetMs(stats.sim_hz))}ms at ${stats.sim_hz} Hz`,
    `- WT strict snapshot target: ${fmtBytes(WT_STRICT_DATAGRAM_TARGET_BYTES)} per client snapshot`,
    `- pending input cap: ${SERVER_PENDING_INPUT_CAP} per player`,
    '',
    ...markdownBullets('Executive Summary', buildGlobalFocusAreas(stats)),
    ...markdownBullets('Improvement Opportunities', buildGlobalOpportunities(stats)),
    ...markdownBullets('What Is Working Well', buildGlobalWins(stats)),
  ];
  if (stats.server_build_profile !== 'release') {
    lines.push('warning: debug server build; authoritative performance numbers are not representative.', '');
  }
  for (const match of stats.matches) {
    lines.push(matchMarkdown(match, stats.sim_hz), '');
  }
  return lines.join('\n').trim();
}

function makeHistoryPoint(match: MatchStatsSnapshot, simHz: number): MatchHistoryPoint {
  return {
    atMs: Date.now(),
    serverTick: match.server_tick,
    tickP95Ms: match.timings.total_ms.p95,
    totalPhysicsP95Ms: totalPhysicsP95(match),
    snapshotBytesPerClientP95: match.network.snapshot_bytes_per_client.p95,
    snapshotBytesPerTickP95: match.network.snapshot_bytes_per_tick.p95,
    outboundBps: match.network.outbound_bps,
    inboundBps: match.network.inbound_bps,
    outboundPacketsPerSec: match.network.outbound_packets_per_sec,
    inboundPacketsPerSec: match.network.inbound_packets_per_sec,
    headroomMs: tickHeadroomMs(match, simHz),
    maxPendingInputs: maxPendingInputs(match),
    playerCount: match.player_count,
    wtDatagramRatio: webTransportSnapshotDatagramRatio(match),
    wtReliableRatio: webTransportSnapshotFallbackRatio(match),
  };
}

function appendHistory(
  previous: MatchHistoryMap,
  stats: GlobalStatsSnapshot,
): MatchHistoryMap {
  const next: MatchHistoryMap = {};

  for (const match of stats.matches) {
    const current = previous[match.id] ? [...previous[match.id]] : [];
    const point = makeHistoryPoint(match, stats.sim_hz);
    const last = current[current.length - 1];
    if (last && last.serverTick === point.serverTick) {
      current[current.length - 1] = point;
    } else {
      current.push(point);
    }
    next[match.id] = current.slice(-HISTORY_LIMIT);
  }

  return next;
}

function latestValue(values: number[]): number {
  return values.length > 0 ? values[values.length - 1] : 0;
}

function computeTickSegments(match: MatchStatsSnapshot, simHz: number): BreakdownSegment[] {
  const budget = tickBudgetMs(simHz);
  const tickTotal = clampPositive(match.timings.total_ms.p95);
  const used = [
    { label: 'Player sim', value: clampPositive(match.timings.player_sim_ms.p95), color: BLUE },
    { label: 'Vehicles', value: clampPositive(match.timings.vehicle_ms.p95), color: TEAL },
    { label: 'Dynamics', value: clampPositive(match.timings.dynamics_ms.p95), color: PURPLE },
    { label: 'Hitscan', value: clampPositive(match.timings.hitscan_ms.p95), color: ORANGE },
    { label: 'Snapshot', value: clampPositive(match.timings.snapshot_ms.p95), color: YELLOW },
  ];
  const other = Math.max(0, tickTotal - used.reduce((sum, segment) => sum + segment.value, 0));
  const segments = [...used];
  if (other > 0.01) {
    segments.push({ label: 'Other', value: other, color: GRAY });
  }
  const headroom = Math.max(0, budget - tickTotal);
  if (headroom > 0.01) {
    segments.push({ label: 'Headroom', value: headroom, color: GREEN_SOFT });
  }
  const overflow = Math.max(0, tickTotal - budget);
  if (overflow > 0.01) {
    segments.push({ label: 'Overflow', value: overflow, color: RED });
  }
  return segments;
}

function computePlayerSegments(match: MatchStatsSnapshot): BreakdownSegment[] {
  const playerTotal = clampPositive(match.timings.player_sim_ms.p95);
  const base = [
    { label: 'Move math', value: clampPositive(match.timings.player_move_math_ms.p95), color: BLUE },
    { label: 'Query ctx', value: clampPositive(match.timings.player_query_ctx_ms.p95), color: CYAN },
    { label: 'KCC horizontal', value: clampPositive(match.timings.player_kcc_horizontal_ms.p95), color: PURPLE },
    { label: 'KCC support', value: clampPositive(match.timings.player_kcc_support_ms.p95), color: PINK },
    { label: 'KCC merged', value: clampPositive(match.timings.player_kcc_merged_ms.p95), color: '#d59eff' },
    { label: 'Support probe', value: clampPositive(match.timings.player_support_probe_ms.p95), color: YELLOW },
    { label: 'Collider sync', value: clampPositive(match.timings.player_collider_sync_ms.p95), color: '#f7c75f' },
    { label: 'Dyn contact query', value: clampPositive(match.timings.player_dynamic_contact_query_ms.p95), color: ORANGE },
    { label: 'Dyn interaction', value: clampPositive(match.timings.player_dynamic_interaction_ms.p95), color: '#ffb37a' },
    { label: 'Impulse apply', value: clampPositive(match.timings.player_dynamic_impulse_apply_ms.p95), color: '#ffcb93' },
    { label: 'History', value: clampPositive(match.timings.player_history_record_ms.p95), color: GRAY },
  ];
  const residual = Math.max(0, playerTotal - base.reduce((sum, segment) => sum + segment.value, 0));
  return residual > 0.01
    ? [...base, { label: 'Residual', value: residual, color: '#6e8097' }]
    : base;
}

function computeTransportSegments(match: MatchStatsSnapshot): BreakdownSegment[] {
  const segments = [
    { label: 'WS reliable', value: match.network.websocket_snapshot_reliable_sent, color: BLUE },
    { label: 'WT datagram', value: match.network.webtransport_snapshot_datagram_sent, color: GREEN },
    { label: 'WT reliable', value: match.network.webtransport_snapshot_reliable_sent, color: YELLOW },
    { label: 'Strict drops', value: match.network.strict_snapshot_drops, color: RED },
  ];
  return segments.filter((segment) => segment.value > 0);
}

function buildConstraintAlerts(match: MatchStatsSnapshot, simHz: number): ConstraintAlert[] {
  const budget = tickBudgetMs(simHz);
  const alerts: ConstraintAlert[] = [];

  if (match.timings.total_ms.max > budget) {
    alerts.push({
      tone: 'danger',
      text: `Tick max ${fmtMsDetailed(match.timings.total_ms.max)}ms > ${fmtMsDetailed(budget)}ms budget`,
    });
  } else if (match.timings.total_ms.p95 >= budget * NEAR_LIMIT_RATIO) {
    alerts.push({
      tone: 'watch',
      text: `Tick p95 ${fmtMsDetailed(match.timings.total_ms.p95)}ms at ${fmtPercent(match.timings.total_ms.p95 / budget, 0)}`,
    });
  } else {
    alerts.push({
      tone: limitSeverity(match.timings.total_ms.p95, budget),
      text: `Tick p95 ${fmtMsDetailed(match.timings.total_ms.p95)}ms with ${fmtMsDetailed(tickHeadroomMs(match, simHz))}ms headroom`,
    });
  }

  if (match.network.snapshot_bytes_per_client.max > WT_STRICT_DATAGRAM_TARGET_BYTES) {
    alerts.push({
      tone: 'danger',
      text: `Snapshot max ${fmtBytes(match.network.snapshot_bytes_per_client.max)} > ${fmtBytes(WT_STRICT_DATAGRAM_TARGET_BYTES)} WT strict target`,
    });
  } else if (match.network.snapshot_bytes_per_client.p95 >= WT_STRICT_DATAGRAM_TARGET_BYTES * NEAR_LIMIT_RATIO) {
    alerts.push({
      tone: 'watch',
      text: `Snapshot p95 ${fmtBytes(match.network.snapshot_bytes_per_client.p95)} at ${fmtPercent(match.network.snapshot_bytes_per_client.p95 / WT_STRICT_DATAGRAM_TARGET_BYTES, 0)}`,
    });
  } else {
    alerts.push({
      tone: limitSeverity(match.network.snapshot_bytes_per_client.p95, WT_STRICT_DATAGRAM_TARGET_BYTES),
      text: `Snapshot p95 ${fmtBytes(match.network.snapshot_bytes_per_client.p95)} below strict WT target`,
    });
  }

  const backlogMax = maxPendingInputs(match);
  if (backlogMax > SERVER_PENDING_INPUT_CAP) {
    alerts.push({
      tone: 'danger',
      text: `Pending inputs ${backlogMax} > ${SERVER_PENDING_INPUT_CAP} cap`,
    });
  } else if (backlogMax >= SERVER_PENDING_INPUT_CAP * NEAR_LIMIT_RATIO) {
    alerts.push({
      tone: 'watch',
      text: `Pending inputs ${backlogMax} at ${fmtPercent(backlogMax / SERVER_PENDING_INPUT_CAP, 0)}`,
    });
  } else {
    alerts.push({
      tone: limitSeverity(backlogMax, SERVER_PENDING_INPUT_CAP),
      text: `Pending inputs stable: max ${backlogMax}, avg ${fmt(avgPendingInputs(match), 1)}`,
    });
  }

  if (match.network.strict_snapshot_drops > 0) {
    alerts.push({
      tone: 'danger',
      text: `Strict WT drops ${match.network.strict_snapshot_drops} (target 0)`,
    });
  }

  if (match.network.dropped_outbound_snapshots > 0) {
    alerts.push({
      tone: 'danger',
      text: `Dropped outbound snapshots ${match.network.dropped_outbound_snapshots} (target 0)`,
    });
  }

  if (match.network.malformed_packets > 0) {
    alerts.push({
      tone: 'danger',
      text: `Malformed packets ${match.network.malformed_packets} (target 0)`,
    });
  }

  return alerts;
}

function sortPlayers(players: PlayerStatsSnapshot[]): PlayerStatsSnapshot[] {
  return [...players].sort((left, right) =>
    right.pending_inputs - left.pending_inputs
    || right.one_way_ms - left.one_way_ms
    || right.input_jitter_ms - left.input_jitter_ms
    || right.correction_m - left.correction_m
    || left.id - right.id,
  );
}

function riskLabel(player: PlayerStatsSnapshot): string {
  if (player.pending_inputs >= 20) {
    return 'input backlog';
  }
  if (player.one_way_ms >= 100) {
    return 'high latency';
  }
  if (player.input_jitter_ms >= 20) {
    return 'high jitter';
  }
  if (player.has_debug_stats && player.correction_m >= 0.5) {
    return 'large correction';
  }
  if (player.dead) {
    return 'dead';
  }
  return playerPressureSeverity(player) === 'celebrate' ? 'clean link' : 'stable';
}

function OverviewStat({
  label,
  value,
  subtitle,
  severity,
}: {
  label: string;
  value: string;
  subtitle?: string;
  severity?: SeverityTone;
}) {
  const visual = severity ? severityVisual(severity) : null;
  return (
    <div
      style={{
        ...styles.overviewCard,
        borderColor: visual?.border ?? BORDER,
        background: visual
          ? `linear-gradient(180deg, ${visual.background}, rgba(14,26,43,0.96))`
          : styles.overviewCard.background,
      }}
    >
      <div style={styles.overviewHeader}>
        <div style={styles.overviewLabel}>{label}</div>
        {severity ? <SeverityBadge tone={severity} /> : null}
      </div>
      <div style={{ ...styles.overviewValue, color: visual?.color ?? FG }}>{value}</div>
      {subtitle ? <div style={styles.overviewSubtitle}>{subtitle}</div> : null}
    </div>
  );
}

function DashboardCard({
  title,
  subtitle,
  children,
  severity,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  severity?: SeverityTone;
}) {
  const visual = severity ? severityVisual(severity) : null;
  return (
    <section
      style={{
        ...styles.card,
        borderColor: visual?.border ?? BORDER,
        boxShadow: visual ? `inset 0 0 0 1px ${visual.background}` : undefined,
      }}
    >
      <div style={styles.cardHeader}>
        <div style={styles.cardHeaderRow}>
          <div style={styles.cardTitle}>{title}</div>
          {severity ? <SeverityBadge tone={severity} /> : null}
        </div>
        {subtitle ? <div style={styles.cardSubtitle}>{subtitle}</div> : null}
      </div>
      {children}
    </section>
  );
}

function SeverityLegend() {
  const items: Array<{ tone: SeverityTone; text: string }> = [
    { tone: 'celebrate', text: 'Large safety margin' },
    { tone: 'good', text: 'Healthy operating range' },
    { tone: 'watch', text: 'Near a meaningful limit' },
    { tone: 'danger', text: 'Exceeded or needs attention' },
  ];

  return (
    <div style={styles.severityLegend}>
      {items.map((item) => (
        <div key={item.tone} style={styles.severityLegendItem}>
          <SeverityBadge tone={item.tone} />
          <span style={styles.severityLegendText}>{item.text}</span>
        </div>
      ))}
    </div>
  );
}

function AlertStrip({ alerts }: { alerts: ConstraintAlert[] }) {
  return (
    <div style={styles.alertStrip}>
      {alerts.map((alert, index) => {
        const visual = severityVisual(alert.tone);
        return (
          <div
            key={`${alert.text}-${index}`}
            style={{
              ...styles.alertChip,
              color: visual.color,
              borderColor: visual.border,
              background: visual.background,
            }}
          >
            <SeverityIcon tone={alert.tone} size={13} />
            {alert.text}
          </div>
        );
      })}
    </div>
  );
}

function LimitWatchCard({
  title,
  subtitle,
  limit,
  limitLabel,
  rows,
  formatLimit,
}: {
  title: string;
  subtitle: string;
  limit: number;
  limitLabel: string;
  rows: ConstraintRow[];
  formatLimit: (value: number) => string;
}) {
  const worstValue = rows.reduce((max, row) => Math.max(max, row.value), 0);
  const worstTone = limitSeverity(worstValue, limit);

  return (
    <DashboardCard
      title={title}
      subtitle={`${subtitle} · ${limitLabel} ${formatLimit(limit)}`}
      severity={worstTone}
    >
      <div style={styles.limitSummaryRow}>
        <div style={styles.limitSummaryLabel}>Worst state</div>
        <SeverityBadge tone={worstTone} label={limitStateLabel(worstValue, limit)} />
      </div>

      <div style={styles.limitList}>
        {rows.map((row) => {
          const rowTone = limitSeverity(row.value, limit);
          const visual = severityVisual(rowTone);
          const ratio = fractionOfLimit(row.value, limit);
          const width = limit > 0 ? `${Math.min(100, Math.max(0, ratio) * 100)}%` : row.value > 0 ? '100%' : '0%';
          return (
            <div
              key={row.label}
              style={{
                ...styles.limitRow,
                borderColor: visual.border,
                background: visual.background,
              }}
            >
              <div style={styles.limitRowHeader}>
                <span style={styles.limitRowLabelWrap}>
                  <SeverityIcon tone={rowTone} size={12} />
                  <span style={styles.limitRowLabel}>{row.label}</span>
                </span>
                <span style={{ ...styles.limitRowValue, color: visual.color }}>{row.display}</span>
              </div>
              <div style={styles.limitTrack}>
                <div style={{ ...styles.limitFill, width, background: visual.color }} />
              </div>
              <div style={styles.limitMeta}>
                <span style={{ color: visual.color }}>{limitStateLabel(row.value, limit)}</span>
                <span>{limitUtilizationLabel(row.value, limit)}</span>
              </div>
              {row.note ? <div style={styles.limitNote}>{row.note}</div> : null}
            </div>
          );
        })}
      </div>
    </DashboardCard>
  );
}

function ConnBadge({ state }: { state: ConnState }) {
  const label = state === 'connected' ? 'LIVE' : state === 'connecting' ? 'CONNECTING' : 'DISCONNECTED';
  const tone = state === 'connected' ? GREEN : state === 'connecting' ? YELLOW : RED;
  const bg = state === 'connected' ? 'rgba(99, 230, 190, 0.12)' : state === 'connecting' ? 'rgba(255, 209, 102, 0.12)' : 'rgba(255, 107, 107, 0.12)';
  return <span style={{ ...styles.badge, color: tone, background: bg, borderColor: tone }}>{label}</span>;
}

function LineChart({
  series,
  referenceLines = [],
  zeroBaseline = true,
  formatValue = fmt,
}: {
  series: ChartSeries[];
  referenceLines?: Array<{ label: string; color: string; value: number }>;
  zeroBaseline?: boolean;
  formatValue?: (value: number) => string;
}) {
  const values = [
    ...series.flatMap((item) => item.values),
    ...referenceLines.map((line) => line.value),
  ].filter((value) => Number.isFinite(value));

  if (series.every((item) => item.values.length === 0) && referenceLines.length === 0) {
    return <div style={styles.emptyState}>Waiting for chart samples…</div>;
  }

  const width = 420;
  const height = 180;
  const left = 42;
  const top = 14;
  const right = 12;
  const bottom = 20;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  let min = values.length > 0 ? Math.min(...values) : 0;
  let max = values.length > 0 ? Math.max(...values) : 1;
  if (zeroBaseline) {
    min = Math.min(0, min);
  }
  if (max - min < 0.001) {
    max = min + 1;
  }

  const yFor = (value: number) => top + innerHeight - ((value - min) / (max - min)) * innerHeight;
  const xFor = (index: number, count: number) =>
    left + (count <= 1 ? innerWidth / 2 : (index / (count - 1)) * innerWidth);

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={styles.chartSvg}>
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
          const value = max - (max - min) * tick;
          const y = top + innerHeight * tick;
          return (
            <g key={tick}>
              <line x1={left} x2={width - right} y1={y} y2={y} stroke="rgba(138, 163, 194, 0.14)" strokeWidth="1" />
              <text x={left - 8} y={y + 4} fill={DIM} fontSize="10" textAnchor="end">
                {formatValue(value)}
              </text>
            </g>
          );
        })}

        {referenceLines.map((line) => {
          const y = yFor(line.value);
          return (
            <g key={line.label}>
              <line
                x1={left}
                x2={width - right}
                y1={y}
                y2={y}
                stroke={line.color}
                strokeDasharray="5 4"
                strokeOpacity="0.8"
                strokeWidth="1.5"
              />
            </g>
          );
        })}

        {series.map((item) => {
          if (item.values.length === 0) {
            return null;
          }
          const points = item.values
            .map((value, index) => `${xFor(index, item.values.length)},${yFor(value)}`)
            .join(' ');
          const latest = latestValue(item.values);
          return (
            <g key={item.label}>
              {item.values.length > 1 ? (
                <polyline
                  fill="none"
                  points={points}
                  stroke={item.color}
                  strokeWidth={item.dashed ? 1.5 : 2.5}
                  strokeDasharray={item.dashed ? '5 4' : undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : null}
              <circle
                cx={xFor(item.values.length - 1, item.values.length)}
                cy={yFor(latest)}
                r="3.5"
                fill={item.color}
              />
            </g>
          );
        })}
      </svg>

      <div style={styles.legend}>
        {series.map((item) => (
          <div key={item.label} style={styles.legendItem}>
            <span style={{ ...styles.legendSwatch, background: item.color }} />
            <span style={styles.legendLabel}>{item.label}</span>
            <span style={styles.legendValue}>{formatValue(latestValue(item.values))}</span>
          </div>
        ))}
        {referenceLines.map((line) => (
          <div key={line.label} style={styles.legendItem}>
            <span style={{ ...styles.legendSwatch, background: line.color, opacity: 0.6 }} />
            <span style={styles.legendLabel}>{line.label}</span>
            <span style={styles.legendValue}>{formatValue(line.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BreakdownChart({
  segments,
  totalLabel,
  totalValue,
  formatValue,
}: {
  segments: BreakdownSegment[];
  totalLabel: string;
  totalValue: number;
  formatValue: (value: number) => string;
}) {
  const total = Math.max(totalValue, segments.reduce((sum, segment) => sum + segment.value, 0), 0.001);

  return (
    <div>
      <div style={styles.breakdownTrack}>
        {segments.map((segment) => (
          <div
            key={segment.label}
            style={{
              width: `${(segment.value / total) * 100}%`,
              background: segment.color,
              minWidth: segment.value > 0 ? 6 : 0,
            }}
          />
        ))}
      </div>
      <div style={styles.breakdownTotal}>
        <span>{totalLabel}</span>
        <span>{formatValue(totalValue)}</span>
      </div>
      <div style={styles.breakdownLegend}>
        {segments.map((segment) => (
          <div key={segment.label} style={styles.breakdownRow}>
            <div style={styles.breakdownLabelWrap}>
              <span style={{ ...styles.legendSwatch, background: segment.color }} />
              <span>{segment.label}</span>
            </div>
            <span style={styles.breakdownValue}>
              {formatValue(segment.value)} · {fmtPercent(segment.value / total, 1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DistributionChart({
  rows,
  formatValue,
}: {
  rows: DistributionRow[];
  formatValue: (value: number) => string;
}) {
  const scale = Math.max(
    1,
    ...rows.flatMap((row) => [row.avg, row.p95, row.max]),
  );

  return (
    <div style={styles.distributionList}>
      {rows.map((row) => (
        <div key={row.label} style={styles.distributionRow}>
          <div style={styles.distributionLabel}>{row.label}</div>
          <div style={styles.distributionBars}>
            {[
              { key: 'avg', label: 'avg', value: row.avg, color: BLUE },
              { key: 'p95', label: 'p95', value: row.p95, color: YELLOW },
              { key: 'max', label: 'max', value: row.max, color: RED },
            ].map((entry) => (
              <div key={entry.key} style={styles.distributionBarRow}>
                <div style={styles.distributionBarLabel}>{entry.label}</div>
                <div style={styles.distributionTrack}>
                  <div
                    style={{
                      ...styles.distributionFill,
                      width: `${(entry.value / scale) * 100}%`,
                      background: entry.color,
                    }}
                  />
                </div>
                <div style={styles.distributionValue}>{formatValue(entry.value)}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function HotspotList({ players }: { players: PlayerStatsSnapshot[] }) {
  const hotPlayers = sortPlayers(players).slice(0, 5);
  if (hotPlayers.length === 0) {
    return <div style={styles.emptyState}>No connected players.</div>;
  }

  return (
    <div style={styles.hotspotList}>
      {hotPlayers.map((player) => {
        const tone = playerPressureSeverity(player);
        const visual = severityVisual(tone);
        return (
        <div
          key={player.id}
          style={{
            ...styles.hotspotRow,
            borderColor: visual.border,
            background: visual.background,
          }}
        >
          <div>
            <div style={styles.hotspotTitleRow}>
              <SeverityBadge tone={tone} />
              <div style={{ ...styles.hotspotTitle, color: visual.color }}>{`P${player.id} · ${riskLabel(player)}`}</div>
            </div>
            <div style={styles.hotspotMeta}>
              {`${player.transport === 'webtransport' ? 'WT' : 'WS'} · ${statusStr(player)} · ${fmtPos(player.pos_m)}`}
            </div>
          </div>
          <div style={styles.hotspotStats}>
            <span>{`${player.pending_inputs} in-buf`}</span>
            <span>{`${player.one_way_ms}ms one-way`}</span>
            <span>{`±${fmt(player.input_jitter_ms)}ms jitter`}</span>
          </div>
        </div>
        );
      })}
    </div>
  );
}

function MetricCell({
  value,
  max,
  text,
  severity,
}: {
  value: number;
  max: number;
  text: string;
  severity: SeverityTone;
}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const visual = severityVisual(severity);
  return (
    <div style={{ ...styles.metricCell, borderColor: visual.border, background: visual.background }}>
      <div style={{ ...styles.metricCellFill, background: visual.color, width: `${ratio * 100}%` }} />
      <span style={styles.metricCellText}>
        <SeverityIcon tone={severity} size={12} />
        <span>{text}</span>
      </span>
    </div>
  );
}

function PlayersTable({ players }: { players: PlayerStatsSnapshot[] }) {
  const sorted = sortPlayers(players);
  if (sorted.length === 0) {
    return <div style={styles.emptyState}>No connected players.</div>;
  }

  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            {['ID', 'Transport', 'Latency', 'In-buf', 'HP', 'Position', 'Speed', 'Status', 'Jitter', 'Bundle', 'Correction', 'Phys'].map((header) => (
              <th key={header} style={styles.th}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((player) => {
            const rowSeverity = playerPressureSeverity(player);
            const latencySeverity = lowerIsBetterSeverity(player.one_way_ms, 25, 60, 100);
            const pendingSeverity = lowerIsBetterSeverity(player.pending_inputs, 2, 8, 20);
            const jitterSeverity = lowerIsBetterSeverity(player.input_jitter_ms, 4, 10, 20);
            const correctionSeverity = player.has_debug_stats ? lowerIsBetterSeverity(player.correction_m, 0.03, 0.1, 0.5) : 'neutral';
            const physicsSeverity = player.has_debug_stats ? lowerIsBetterSeverity(player.physics_ms, 2, 4, 8) : 'neutral';
            const visual = severityVisual(rowSeverity);
            return (
            <tr
              key={player.id}
              style={{
                ...styles.row,
                background: visual.background,
                boxShadow: `inset 3px 0 0 ${visual.color}`,
              }}
            >
              <td style={styles.td}>
                <div style={styles.tableIdCell}>
                  <SeverityIcon tone={rowSeverity} size={13} />
                  <span>{player.id}</span>
                </div>
              </td>
              <td style={styles.td}>
                <span style={{ ...styles.transportPill, color: player.transport === 'webtransport' ? CYAN : FG }}>
                  {player.transport === 'webtransport' ? 'WT' : 'WS'}
                </span>
              </td>
              <td style={styles.td}>
                <MetricCell
                  value={player.one_way_ms}
                  max={150}
                  severity={latencySeverity}
                  text={`${player.one_way_ms}ms`}
                />
              </td>
              <td style={styles.td}>
                <MetricCell
                  value={player.pending_inputs}
                  max={30}
                  severity={pendingSeverity}
                  text={fmtInt(player.pending_inputs)}
                />
              </td>
              <td style={styles.td}>
                <span style={{ color: player.dead ? RED : player.hp < 30 ? YELLOW : FG }}>
                  {player.dead ? '—' : player.hp}
                </span>
              </td>
              <td style={{ ...styles.td, color: MUTED }}>{fmtPos(player.pos_m)}</td>
              <td style={styles.td}>{fmtSpeed(player.vel_ms)}</td>
              <td style={styles.td}>
                <span style={{ ...styles.statusPill, color: statusTone(player), borderColor: statusTone(player) }}>
                  {statusStr(player)}
                </span>
              </td>
              <td style={styles.td}>
                <MetricCell
                  value={player.input_jitter_ms}
                  max={30}
                  severity={jitterSeverity}
                  text={`±${fmt(player.input_jitter_ms)}ms`}
                />
              </td>
              <td style={styles.td}>{fmt(player.avg_bundle_size, 1)}</td>
              <td style={styles.td}>
                {player.has_debug_stats ? (
                  <MetricCell
                    value={player.correction_m}
                    max={0.6}
                    severity={correctionSeverity}
                    text={`${fmt(player.correction_m, 3)}m`}
                  />
                ) : (
                  <span style={{ color: DIM }}>n/a</span>
                )}
              </td>
              <td style={styles.td}>
                {player.has_debug_stats ? (
                  <MetricCell
                    value={player.physics_ms}
                    max={10}
                    severity={physicsSeverity}
                    text={`${fmtMsDetailed(player.physics_ms)}ms`}
                  />
                ) : (
                  <span style={{ color: DIM }}>n/a</span>
                )}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MatchPanel({
  match,
  simHz,
  history,
}: {
  match: MatchStatsSnapshot;
  simHz: number;
  history: MatchHistoryPoint[];
}) {
  const tickBudget = tickBudgetMs(simHz);
  const matchTone = overallMatchSeverity(match, simHz);
  const tickTone = tickSeverity(match, simHz);
  const payloadTone = snapshotPayloadSeverity(match);
  const backlogTone = backlogSeverity(match);
  const transportTone = relevantTransportSeverity(match);
  const playersTone = worstSeverity(match.players.map(playerPressureSeverity));
  const tickSegments = computeTickSegments(match, simHz);
  const playerSegments = computePlayerSegments(match);
  const transportSegments = computeTransportSegments(match);
  const transportTotal = transportSegments.reduce((sum, segment) => sum + segment.value, 0);
  const constraintAlerts = buildConstraintAlerts(match, simHz);
  const tickLimitRows: ConstraintRow[] = [
    {
      label: 'avg',
      value: match.timings.total_ms.avg,
      display: `${fmtMsDetailed(match.timings.total_ms.avg)}ms`,
    },
    {
      label: 'p95',
      value: match.timings.total_ms.p95,
      display: `${fmtMsDetailed(match.timings.total_ms.p95)}ms`,
    },
    {
      label: 'max',
      value: match.timings.total_ms.max,
      display: `${fmtMsDetailed(match.timings.total_ms.max)}ms`,
      note: `headroom ${fmtMsDetailed(Math.max(0, tickBudget - match.timings.total_ms.max))}ms`,
    },
  ];
  const snapshotLimitRows: ConstraintRow[] = [
    {
      label: 'avg',
      value: match.network.snapshot_bytes_per_client.avg,
      display: fmtBytes(match.network.snapshot_bytes_per_client.avg),
    },
    {
      label: 'p95',
      value: match.network.snapshot_bytes_per_client.p95,
      display: fmtBytes(match.network.snapshot_bytes_per_client.p95),
    },
    {
      label: 'max',
      value: match.network.snapshot_bytes_per_client.max,
      display: fmtBytes(match.network.snapshot_bytes_per_client.max),
      note: `per tick p95 ${fmtBytes(match.network.snapshot_bytes_per_tick.p95)}`,
    },
  ];
  const pendingLimitRows: ConstraintRow[] = [
    {
      label: 'avg',
      value: avgPendingInputs(match),
      display: fmt(avgPendingInputs(match), 1),
    },
    {
      label: 'max player',
      value: maxPendingInputs(match),
      display: fmtInt(maxPendingInputs(match)),
    },
  ];
  const zeroIssueRows: ConstraintRow[] = [
    {
      label: 'strict drops',
      value: match.network.strict_snapshot_drops,
      display: fmtInt(match.network.strict_snapshot_drops),
    },
    {
      label: 'dropped snapshots',
      value: match.network.dropped_outbound_snapshots,
      display: fmtInt(match.network.dropped_outbound_snapshots),
    },
    {
      label: 'malformed packets',
      value: match.network.malformed_packets,
      display: fmtInt(match.network.malformed_packets),
    },
  ];

  const tickSeries: ChartSeries[] = [
    {
      label: 'Tick p95',
      color: BLUE,
      values: history.map((point) => point.tickP95Ms),
    },
    {
      label: 'Physics p95',
      color: PURPLE,
      values: history.map((point) => point.totalPhysicsP95Ms),
    },
  ];

  const snapshotSeries: ChartSeries[] = [
    {
      label: 'Per client p95',
      color: YELLOW,
      values: history.map((point) => point.snapshotBytesPerClientP95 / 1024),
    },
    {
      label: 'Per tick p95',
      color: ORANGE,
      values: history.map((point) => point.snapshotBytesPerTickP95 / 1024),
    },
  ];

  const bandwidthSeries: ChartSeries[] = [
    {
      label: 'Outbound',
      color: GREEN,
      values: history.map((point) => point.outboundBps / 1024),
    },
    {
      label: 'Inbound',
      color: CYAN,
      values: history.map((point) => point.inboundBps / 1024),
    },
  ];

  const pressureSeries: ChartSeries[] = [
    {
      label: 'Max in-buf',
      color: RED,
      values: history.map((point) => point.maxPendingInputs),
    },
    {
      label: 'Players',
      color: BLUE,
      values: history.map((point) => point.playerCount),
    },
  ];

  const snapshotSizeRows: DistributionRow[] = [
    {
      label: 'Bytes / client',
      avg: match.network.snapshot_bytes_per_client.avg,
      p95: match.network.snapshot_bytes_per_client.p95,
      max: match.network.snapshot_bytes_per_client.max,
    },
    {
      label: 'Bytes / tick',
      avg: match.network.snapshot_bytes_per_tick.avg,
      p95: match.network.snapshot_bytes_per_tick.p95,
      max: match.network.snapshot_bytes_per_tick.max,
    },
  ];

  const snapshotContentRows: DistributionRow[] = [
    {
      label: 'Players / client',
      avg: match.network.snapshot_players_per_client.avg,
      p95: match.network.snapshot_players_per_client.p95,
      max: match.network.snapshot_players_per_client.max,
    },
    {
      label: 'Bodies / client',
      avg: match.network.snapshot_dynamic_bodies_per_client.avg,
      p95: match.network.snapshot_dynamic_bodies_per_client.p95,
      max: match.network.snapshot_dynamic_bodies_per_client.max,
    },
    {
      label: 'Vehicles / client',
      avg: match.network.snapshot_vehicles_per_client.avg,
      p95: match.network.snapshot_vehicles_per_client.p95,
      max: match.network.snapshot_vehicles_per_client.max,
    },
  ];

  return (
    <section style={styles.matchPanel}>
      <div style={styles.matchHeader}>
        <div>
          <div style={styles.matchTitleRow}>
            <h2 style={styles.matchTitle}>{match.id}</h2>
            <span style={styles.matchScenario}>{match.scenario_tag}</span>
          </div>
          <div style={styles.matchMeta}>
            {`tick ${match.server_tick} · ${match.player_count} players · ${match.dynamic_body_count} bodies · ${match.vehicle_count} vehicles · ${match.chunk_count} chunks`}
          </div>
          <div style={styles.bottleneckLine}>{describeBottleneck(match, simHz)}</div>
        </div>
        <div style={styles.matchBadgeRow}>
          <SeverityBadge tone={matchTone} label={`Health ${severityVisual(matchTone).label}`} />
          <span style={styles.metaBadge}>{`Headroom ${fmtMsDetailed(tickHeadroomMs(match, simHz))}ms`}</span>
          <span style={styles.metaBadge}>{describeTransport(match)}</span>
        </div>
      </div>

      <AlertStrip alerts={constraintAlerts} />

      <div style={styles.overviewGrid}>
        <OverviewStat
          label="Tick P95"
          value={`${fmtMsDetailed(match.timings.total_ms.p95)}ms`}
          severity={tickTone}
          subtitle={`budget ${fmtMsDetailed(tickBudget)}ms`}
        />
        <OverviewStat
          label="Physics P95"
          value={`${fmtMsDetailed(totalPhysicsP95(match))}ms`}
          severity={limitSeverity(totalPhysicsP95(match), tickBudget)}
          subtitle="player sim + vehicles + dynamics"
        />
        <OverviewStat
          label="Snapshot / Client P95"
          value={fmtKiB(match.network.snapshot_bytes_per_client.p95)}
          severity={payloadTone}
          subtitle={`tick ${fmtKiB(match.network.snapshot_bytes_per_tick.p95)}`}
        />
        <OverviewStat
          label="Bandwidth"
          value={fmtRate(match.network.outbound_bps)}
          subtitle={`in ${fmtRate(match.network.inbound_bps)}`}
        />
        <OverviewStat
          label="Input Backlog"
          value={fmtInt(maxPendingInputs(match))}
          severity={backlogTone}
          subtitle={`avg ${fmt(avgPendingInputs(match), 1)}`}
        />
        <OverviewStat
          label="WT Datagram"
          value={fmtPercent(webTransportSnapshotDatagramRatio(match))}
          severity={transportTone}
          subtitle={`reliable ${fmtPercent(webTransportSnapshotFallbackRatio(match))}`}
        />
      </div>

      <div style={styles.chartGrid}>
        <LimitWatchCard
          title="Tick Budget Watch"
          subtitle="Authoritative server tick cost against the 60 Hz simulation budget"
          limit={tickBudget}
          limitLabel="budget"
          rows={tickLimitRows}
          formatLimit={(value) => `${fmtMsDetailed(value)}ms`}
        />

        <LimitWatchCard
          title="WT Payload Watch"
          subtitle="Snapshot bytes per client against the strict WebTransport datagram target"
          limit={WT_STRICT_DATAGRAM_TARGET_BYTES}
          limitLabel="target"
          rows={snapshotLimitRows}
          formatLimit={fmtBytes}
        />

        <LimitWatchCard
          title="Input Backlog Watch"
          subtitle="Queued authoritative inputs per player against the server cap"
          limit={SERVER_PENDING_INPUT_CAP}
          limitLabel="cap"
          rows={[
            pendingLimitRows[0],
            pendingLimitRows[1],
          ]}
          formatLimit={(value) => fmtInt(value)}
        />

        <LimitWatchCard
          title="Zero-Tolerance Watch"
          subtitle="These counters should remain at zero under healthy operation"
          limit={0}
          limitLabel="target"
          rows={zeroIssueRows}
          formatLimit={(value) => fmtInt(value)}
        />

        <DashboardCard title="Tick Trend" subtitle="Rolling stats feed, p95 timing versus 60 Hz budget" severity={tickTone}>
          <LineChart
            series={tickSeries}
            referenceLines={[{ label: 'Budget', color: DIM, value: tickBudget }]}
            formatValue={(value) => `${fmt(value, value < 10 ? 2 : 1)}ms`}
          />
        </DashboardCard>

        <DashboardCard title="Bandwidth Trend" subtitle="Ingress and egress throughput over recent stat pushes">
          <LineChart
            series={bandwidthSeries}
            formatValue={(value) => `${fmt(value, value < 100 ? 1 : 0)} KiB/s`}
          />
        </DashboardCard>

        <DashboardCard title="Snapshot Trend" subtitle="Payload size pressure over time" severity={payloadTone}>
          <LineChart
            series={snapshotSeries}
            referenceLines={[{ label: 'WT target', color: DIM, value: WT_STRICT_DATAGRAM_TARGET_BYTES / 1024 }]}
            formatValue={(value) => `${fmt(value, value < 10 ? 2 : 1)} KiB`}
          />
        </DashboardCard>

        <DashboardCard title="Pressure Trend" subtitle="Queue pressure and active player count" severity={backlogTone}>
          <LineChart
            series={pressureSeries}
            referenceLines={[{ label: 'Input cap', color: DIM, value: SERVER_PENDING_INPUT_CAP }]}
            formatValue={(value) => fmt(value, value < 10 ? 1 : 0)}
          />
        </DashboardCard>

        <DashboardCard title="Tick Budget Allocation" subtitle="How p95 compute time consumes the per-tick budget" severity={tickTone}>
          <BreakdownChart
            segments={tickSegments}
            totalLabel="Tick budget"
            totalValue={Math.max(tickBudget, match.timings.total_ms.p95)}
            formatValue={(value) => `${fmtMsDetailed(value)}ms`}
          />
        </DashboardCard>

        <DashboardCard title="Player Sim Breakdown" subtitle={`Player sim p95 ${fmtMsDetailed(match.timings.player_sim_ms.p95)}ms`} severity={limitSeverity(match.timings.player_sim_ms.p95, tickBudget)}>
          <BreakdownChart
            segments={playerSegments}
            totalLabel="Player sim"
            totalValue={match.timings.player_sim_ms.p95}
            formatValue={(value) => `${fmtMsDetailed(value)}ms`}
          />
        </DashboardCard>

        <DashboardCard title="Snapshot Size Distribution" subtitle="avg / p95 / max packet size metrics" severity={payloadTone}>
          <DistributionChart rows={snapshotSizeRows} formatValue={fmtBytes} />
        </DashboardCard>

        <DashboardCard title="Snapshot Content Distribution" subtitle="Replication fanout per client snapshot">
          <DistributionChart rows={snapshotContentRows} formatValue={(value) => fmt(value, value < 10 ? 1 : 0)} />
        </DashboardCard>

        <DashboardCard title="Transport Delivery Mix" subtitle={`Cumulative snapshot delivery counts: ${transportTotal.toLocaleString()}`} severity={transportTone}>
          {transportSegments.length > 0 ? (
            <BreakdownChart
              segments={transportSegments}
              totalLabel="Snapshot deliveries"
              totalValue={transportTotal}
              formatValue={(value) => fmtInt(value)}
            />
          ) : (
            <div style={styles.emptyState}>Waiting for transport samples…</div>
          )}
        </DashboardCard>

        <DashboardCard title="Top Pressure Players" subtitle="Sorted by backlog, latency, jitter, and correction pressure" severity={playersTone}>
          <HotspotList players={match.players} />
        </DashboardCard>
      </div>

      <DashboardCard title="Players" subtitle="Scrollable table, sorted by highest pressure first" severity={playersTone}>
        <PlayersTable players={match.players} />
      </DashboardCard>
    </section>
  );
}

function computeGlobalSummary(stats: GlobalStatsSnapshot) {
  const totalPlayers = stats.matches.reduce((sum, match) => sum + match.player_count, 0);
  const totalBodies = stats.matches.reduce((sum, match) => sum + match.dynamic_body_count, 0);
  const totalVehicles = stats.matches.reduce((sum, match) => sum + match.vehicle_count, 0);
  const worstTick = stats.matches.reduce<MatchStatsSnapshot | null>(
    (worst, match) => (!worst || match.timings.total_ms.p95 > worst.timings.total_ms.p95 ? match : worst),
    null,
  );
  const lowestHeadroom = stats.matches.reduce<MatchStatsSnapshot | null>(
    (worst, match) => (!worst || tickHeadroomMs(match, stats.sim_hz) < tickHeadroomMs(worst, stats.sim_hz) ? match : worst),
    null,
  );
  const highestOutbound = stats.matches.reduce<MatchStatsSnapshot | null>(
    (worst, match) => (!worst || match.network.outbound_bps > worst.network.outbound_bps ? match : worst),
    null,
  );
  const largestSnapshot = stats.matches.reduce<MatchStatsSnapshot | null>(
    (worst, match) => (!worst || match.network.snapshot_bytes_per_client.p95 > worst.network.snapshot_bytes_per_client.p95 ? match : worst),
    null,
  );

  return {
    totalPlayers,
    totalBodies,
    totalVehicles,
    worstTick,
    lowestHeadroom,
    highestOutbound,
    largestSnapshot,
  };
}

export function ServerStats() {
  const { stats, connState, lastUpdate } = useServerStats();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [historyByMatch, setHistoryByMatch] = useState<MatchHistoryMap>({});

  useEffect(() => {
    if (!stats) {
      return;
    }
    setHistoryByMatch((current) => appendHistory(current, stats));
  }, [stats]);

  const summary = useMemo(() => (stats ? computeGlobalSummary(stats) : null), [stats]);

  async function copyMarkdown(): Promise<void> {
    if (!stats) {
      return;
    }
    try {
      await navigator.clipboard.writeText(statsMarkdown(stats, lastUpdate, connState));
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('failed');
      window.setTimeout(() => setCopyState('idle'), 2000);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.pageInner}>
        <header style={styles.header}>
          <div>
            <div style={styles.kicker}>Operations</div>
            <h1 style={styles.pageTitle}>vibe-land / server-stats</h1>
            {stats ? (
              <div style={styles.headerMeta}>
                {`build ${stats.server_build_profile} · sim ${stats.sim_hz} Hz · snapshots ${stats.snapshot_hz} Hz · matches ${stats.matches.length}`}
              </div>
            ) : (
              <div style={styles.headerMeta}>Waiting for live stats feed…</div>
            )}
            {stats && stats.server_build_profile !== 'release' ? (
              <div style={styles.warningBanner}>
                Debug server build detected. Performance numbers are useful for relative comparison, not authoritative capacity.
              </div>
            ) : null}
          </div>

          <div style={styles.headerActions}>
            <button style={styles.button} onClick={() => void copyMarkdown()} disabled={!stats}>
              {copyState === 'copied' ? 'Copied Markdown' : copyState === 'failed' ? 'Copy Failed' : 'Copy Markdown'}
            </button>
            <ConnBadge state={connState} />
            <div style={styles.updateText}>
              {lastUpdate ? `updated ${lastUpdate.toLocaleTimeString()}` : 'waiting for first update'}
            </div>
          </div>
        </header>

        <SeverityLegend />

        {!stats ? (
          <div style={styles.emptyPanel}>
            {connState === 'connecting' ? 'Connecting to /ws/stats…' : 'Disconnected. Retrying in 2 seconds…'}
          </div>
        ) : (
          <>
            <div style={styles.overviewGrid}>
              <OverviewStat label="Matches" value={stats.matches.length.toString()} subtitle={`players ${summary?.totalPlayers ?? 0}`} />
              <OverviewStat label="Bodies" value={(summary?.totalBodies ?? 0).toString()} subtitle={`vehicles ${summary?.totalVehicles ?? 0}`} />
              <OverviewStat
                label="Worst Tick"
                value={summary?.worstTick ? `${fmtMsDetailed(summary.worstTick.timings.total_ms.p95)}ms` : '—'}
                subtitle={summary?.worstTick?.id ?? 'n/a'}
                severity={summary?.worstTick ? tickSeverity(summary.worstTick, stats.sim_hz) : undefined}
              />
              <OverviewStat
                label="Lowest Headroom"
                value={summary?.lowestHeadroom ? `${fmtMsDetailed(tickHeadroomMs(summary.lowestHeadroom, stats.sim_hz))}ms` : '—'}
                subtitle={summary?.lowestHeadroom?.id ?? 'n/a'}
                severity={summary?.lowestHeadroom ? headroomSeverity(tickHeadroomMs(summary.lowestHeadroom, stats.sim_hz), tickBudgetMs(stats.sim_hz)) : undefined}
              />
              <OverviewStat
                label="Largest Snapshot"
                value={summary?.largestSnapshot ? fmtKiB(summary.largestSnapshot.network.snapshot_bytes_per_client.p95) : '—'}
                subtitle={summary?.largestSnapshot?.id ?? 'n/a'}
                severity={summary?.largestSnapshot ? snapshotPayloadSeverity(summary.largestSnapshot) : undefined}
              />
              <OverviewStat
                label="Highest Outbound"
                value={summary?.highestOutbound ? fmtRate(summary.highestOutbound.network.outbound_bps) : '—'}
                subtitle={summary?.highestOutbound?.id ?? 'n/a'}
              />
            </div>

            {stats.matches.length === 0 ? (
              <div style={styles.emptyPanel}>No active matches.</div>
            ) : (
              stats.matches.map((match) => (
                <MatchPanel
                  key={match.id}
                  match={match}
                  simHz={stats.sim_hz}
                  history={historyByMatch[match.id] ?? []}
                />
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    height: '100vh',
    overflowY: 'auto',
    overflowX: 'hidden',
    background:
      'radial-gradient(circle at top left, rgba(87,217,193,0.08), transparent 28%), radial-gradient(circle at top right, rgba(110,168,254,0.10), transparent 26%), linear-gradient(180deg, #07111d 0%, #09131f 100%)',
    color: FG,
  },
  pageInner: {
    maxWidth: 1600,
    margin: '0 auto',
    padding: '24px 20px 40px',
    boxSizing: 'border-box',
  },
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 20,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
    padding: '18px 0 20px',
    marginBottom: 20,
    background: 'linear-gradient(180deg, rgba(7,17,29,0.96) 0%, rgba(7,17,29,0.85) 80%, rgba(7,17,29,0) 100%)',
    backdropFilter: 'blur(10px)',
  },
  kicker: {
    color: CYAN,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  pageTitle: {
    margin: 0,
    fontSize: 30,
    lineHeight: 1.1,
    letterSpacing: '-0.02em',
  },
  headerMeta: {
    marginTop: 8,
    color: MUTED,
    fontSize: 13,
  },
  warningBanner: {
    marginTop: 10,
    color: RED,
    background: 'rgba(255, 107, 107, 0.08)',
    border: `1px solid rgba(255, 107, 107, 0.28)`,
    borderRadius: 12,
    padding: '10px 12px',
    maxWidth: 760,
    fontSize: 13,
  },
  headerActions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 8,
    minWidth: 180,
  },
  button: {
    border: `1px solid ${BORDER}`,
    borderRadius: 999,
    background: PANEL_ALT,
    color: FG,
    padding: '10px 14px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  badge: {
    border: '1px solid transparent',
    borderRadius: 999,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
  updateText: {
    color: DIM,
    fontSize: 12,
  },
  severityLegend: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 18,
  },
  severityLegendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    borderRadius: 14,
    background: 'rgba(18, 34, 57, 0.52)',
    border: `1px solid rgba(39, 68, 99, 0.55)`,
  },
  severityLegendText: {
    color: MUTED,
    fontSize: 12,
  },
  severityBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: '1px solid transparent',
    borderRadius: 999,
    padding: '5px 9px',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  },
  overviewGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: 14,
    marginBottom: 18,
  },
  overviewCard: {
    background: 'linear-gradient(180deg, rgba(18,34,57,0.92), rgba(14,26,43,0.96))',
    border: `1px solid ${BORDER}`,
    borderRadius: 18,
    padding: '14px 16px',
    boxShadow: '0 18px 42px rgba(0, 0, 0, 0.18)',
  },
  overviewHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 8,
  },
  overviewLabel: {
    color: MUTED,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  overviewValue: {
    fontSize: 24,
    fontWeight: 700,
    lineHeight: 1.1,
  },
  overviewSubtitle: {
    marginTop: 8,
    color: DIM,
    fontSize: 12,
  },
  emptyPanel: {
    border: `1px dashed ${BORDER}`,
    borderRadius: 18,
    padding: '22px 18px',
    color: MUTED,
    background: 'rgba(14, 26, 43, 0.72)',
  },
  matchPanel: {
    marginBottom: 24,
    padding: 18,
    borderRadius: 24,
    border: `1px solid ${BORDER}`,
    background: 'linear-gradient(180deg, rgba(14,26,43,0.96), rgba(10,20,34,0.98))',
    boxShadow: '0 24px 60px rgba(0, 0, 0, 0.22)',
  },
  matchHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
    marginBottom: 18,
    flexWrap: 'wrap',
  },
  matchTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    marginBottom: 6,
  },
  matchTitle: {
    margin: 0,
    fontSize: 24,
    lineHeight: 1.1,
  },
  matchScenario: {
    color: CYAN,
    fontSize: 12,
    fontWeight: 700,
    border: `1px solid rgba(110, 242, 255, 0.28)`,
    background: 'rgba(110, 242, 255, 0.08)',
    borderRadius: 999,
    padding: '5px 10px',
  },
  matchMeta: {
    color: MUTED,
    fontSize: 13,
    marginBottom: 6,
  },
  bottleneckLine: {
    color: FG,
    fontSize: 14,
  },
  matchBadgeRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  metaBadge: {
    color: FG,
    fontSize: 12,
    borderRadius: 999,
    padding: '6px 10px',
    border: `1px solid ${BORDER}`,
    background: PANEL_SOFT,
  },
  chartGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: 14,
    marginBottom: 16,
  },
  card: {
    borderRadius: 18,
    border: `1px solid ${BORDER}`,
    background: 'linear-gradient(180deg, rgba(18,34,57,0.84), rgba(13,24,40,0.94))',
    padding: 14,
    minHeight: 120,
  },
  cardHeader: {
    marginBottom: 10,
  },
  cardHeaderRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 4,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: 700,
  },
  cardSubtitle: {
    color: DIM,
    fontSize: 12,
    lineHeight: 1.4,
  },
  alertStrip: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  alertChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    border: '1px solid transparent',
    borderRadius: 999,
    padding: '7px 11px',
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1.25,
  },
  limitSummaryRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    gap: 12,
  },
  limitSummaryLabel: {
    color: MUTED,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  limitSummaryValue: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.04em',
  },
  limitList: {
    display: 'grid',
    gap: 10,
  },
  limitRow: {
    display: 'grid',
    gap: 5,
    border: '1px solid transparent',
    borderRadius: 12,
    padding: '9px 10px',
  },
  limitRowHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  limitRowLabelWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  limitRowLabel: {
    color: FG,
    fontSize: 12,
    fontWeight: 600,
  },
  limitRowValue: {
    fontSize: 12,
    fontWeight: 700,
  },
  limitTrack: {
    height: 10,
    borderRadius: 999,
    overflow: 'hidden',
    background: 'rgba(138, 163, 194, 0.12)',
  },
  limitFill: {
    height: '100%',
    borderRadius: 999,
  },
  limitMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    color: MUTED,
    fontSize: 11,
  },
  limitNote: {
    color: DIM,
    fontSize: 11,
  },
  chartSvg: {
    width: '100%',
    height: 180,
    display: 'block',
  },
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 8,
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: MUTED,
  },
  legendSwatch: {
    width: 10,
    height: 10,
    borderRadius: 999,
    display: 'inline-block',
    flexShrink: 0,
  },
  legendLabel: {
    color: MUTED,
  },
  legendValue: {
    color: FG,
    fontWeight: 600,
  },
  breakdownTrack: {
    display: 'flex',
    width: '100%',
    height: 18,
    borderRadius: 999,
    overflow: 'hidden',
    background: 'rgba(138, 163, 194, 0.12)',
    marginBottom: 10,
  },
  breakdownTotal: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    color: MUTED,
    fontSize: 12,
    marginBottom: 10,
  },
  breakdownLegend: {
    display: 'grid',
    gap: 8,
  },
  breakdownRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
    fontSize: 12,
  },
  breakdownLabelWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: FG,
  },
  breakdownValue: {
    color: MUTED,
  },
  distributionList: {
    display: 'grid',
    gap: 14,
  },
  distributionRow: {
    display: 'grid',
    gridTemplateColumns: '110px 1fr',
    gap: 12,
    alignItems: 'start',
  },
  distributionLabel: {
    color: FG,
    fontSize: 12,
    fontWeight: 600,
    paddingTop: 4,
  },
  distributionBars: {
    display: 'grid',
    gap: 6,
  },
  distributionBarRow: {
    display: 'grid',
    gridTemplateColumns: '34px 1fr 82px',
    gap: 8,
    alignItems: 'center',
  },
  distributionBarLabel: {
    color: MUTED,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  distributionTrack: {
    height: 10,
    borderRadius: 999,
    background: 'rgba(138, 163, 194, 0.10)',
    overflow: 'hidden',
  },
  distributionFill: {
    height: '100%',
    borderRadius: 999,
  },
  distributionValue: {
    fontSize: 12,
    color: FG,
    textAlign: 'right',
    whiteSpace: 'nowrap',
  },
  hotspotList: {
    display: 'grid',
    gap: 10,
  },
  hotspotRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 14,
    alignItems: 'center',
    borderRadius: 14,
    border: `1px solid rgba(39, 68, 99, 0.8)`,
    background: 'rgba(18, 34, 57, 0.55)',
    padding: '10px 12px',
    flexWrap: 'wrap',
  },
  hotspotTitle: {
    fontSize: 13,
    fontWeight: 700,
    marginBottom: 4,
  },
  hotspotTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 4,
  },
  hotspotMeta: {
    color: MUTED,
    fontSize: 12,
  },
  hotspotStats: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap',
    color: FG,
    fontSize: 12,
  },
  tableWrap: {
    overflowX: 'auto',
    overflowY: 'auto',
    maxHeight: 460,
    borderRadius: 16,
    border: `1px solid rgba(39, 68, 99, 0.75)`,
  },
  table: {
    width: '100%',
    borderCollapse: 'separate',
    borderSpacing: 0,
    minWidth: 1120,
    fontSize: 12,
  },
  th: {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    background: '#14253c',
    color: MUTED,
    textAlign: 'left',
    padding: '10px 12px',
    borderBottom: `1px solid ${BORDER}`,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontSize: 11,
  },
  row: {
    background: 'rgba(14, 26, 43, 0.72)',
  },
  td: {
    padding: '10px 12px',
    borderBottom: '1px solid rgba(39, 68, 99, 0.35)',
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
  },
  tableIdCell: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontWeight: 700,
  },
  transportPill: {
    display: 'inline-block',
    borderRadius: 999,
    border: `1px solid rgba(110, 242, 255, 0.18)`,
    background: 'rgba(255, 255, 255, 0.02)',
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.04em',
  },
  statusPill: {
    display: 'inline-block',
    borderRadius: 999,
    border: '1px solid currentColor',
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.04em',
  },
  metricCell: {
    position: 'relative',
    minWidth: 84,
    height: 24,
    borderRadius: 999,
    overflow: 'hidden',
    background: 'rgba(138, 163, 194, 0.10)',
    border: '1px solid rgba(138, 163, 194, 0.12)',
  },
  metricCellFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    opacity: 0.28,
  },
  metricCellText: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    height: '100%',
    padding: '0 9px',
    color: FG,
    fontSize: 12,
    fontWeight: 600,
  },
  emptyState: {
    color: DIM,
    fontSize: 12,
    padding: '10px 0',
  },
} satisfies Record<string, CSSProperties>;
