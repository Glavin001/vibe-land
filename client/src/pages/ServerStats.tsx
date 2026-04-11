import { useEffect, useRef, useState } from 'react';
import {
  avgPendingInputs,
  describeBottleneck,
  describeTransport,
  maxPendingInputs,
  tickBudgetMs,
  tickHeadroomMs,
  totalPhysicsP95,
  type GlobalStatsSnapshot,
  type MatchStatsSnapshot,
  type PlayerStatsSnapshot,
  webTransportSnapshotFallbackRatio,
} from '../loadtest/serverStats';

// ── Hook ──────────────────────────────────────────────────────────────────────

type ConnState = 'connecting' | 'connected' | 'disconnected';

function useServerStats() {
  const [stats, setStats] = useState<GlobalStatsSnapshot | null>(null);
  const [connState, setConnState] = useState<ConnState>('connecting');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws/stats`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      setConnState('connecting');

      ws.onopen = () => {
        if (!cancelled) setConnState('connected');
      };

      ws.onmessage = (e) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(e.data as string) as GlobalStatsSnapshot;
          setStats(data);
          setLastUpdate(new Date());
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
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
      if (retryTimer.current) clearTimeout(retryTimer.current);
      wsRef.current?.close();
    };
  }, []);

  return { stats, connState, lastUpdate };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, d = 1): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}
function fmtMsDetailed(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0.00';
  if (n < 0.01) return '<0.01';
  return n < 1 ? n.toFixed(2) : n.toFixed(1);
}
function fmtSpeed(vel: [number, number, number]): string {
  if (!vel.every((v) => Number.isFinite(v))) return '—';
  return fmt(Math.hypot(vel[0], vel[1], vel[2]), 1);
}
function fmtRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) return `${fmt(bytesPerSecond / 1024 / 1024, 2)} MiB/s`;
  if (bytesPerSecond >= 1024) return `${fmt(bytesPerSecond / 1024, 1)} KiB/s`;
  return `${fmt(bytesPerSecond, 0)} B/s`;
}
function fmtPos(pos: [number, number, number]): string {
  return pos.every((value) => Number.isFinite(value))
    ? `${fmt(pos[0], 1)}, ${fmt(pos[1], 1)}, ${fmt(pos[2], 1)}`
    : '—';
}
function statusStr(p: PlayerStatsSnapshot): string {
  if (p.dead) return 'DEAD';
  if (p.in_vehicle) return 'vehicle';
  if (p.on_ground) return 'ground';
  return 'air';
}

function escapeMdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function playerRowMarkdown(p: PlayerStatsSnapshot): string {
  const phys = p.has_debug_stats ? `${fmtMsDetailed(p.physics_ms)}ms` : 'n/a';
  const correction = p.has_debug_stats ? `${fmt(p.correction_m, 3)}m` : 'n/a';
  const speed = fmtSpeed(p.vel_ms);
  return `| ${p.id} | ${p.transport === 'webtransport' ? 'WT' : 'WS'} | ${p.one_way_ms}ms | ${p.pending_inputs} | ${p.dead ? '—' : `${p.hp}`} | ${escapeMdCell(fmtPos(p.pos_m))} | ${speed === '—' ? '—' : `${speed} m/s`} | ${statusStr(p)} | ±${fmt(p.input_jitter_ms)}ms | ${fmt(p.avg_bundle_size, 1)} | ${correction} | ${phys} |`;
}

function matchMarkdown(match: MatchStatsSnapshot, simHz: number): string {
  const wtFallbackRatio = webTransportSnapshotFallbackRatio(match);
  const lines = [
    `## Match: ${match.id}`,
    '',
    `match: ${match.id} | scenario: ${match.scenario_tag} | tick: ${match.server_tick} | players: ${match.player_count} | bodies: ${match.dynamic_body_count} | vehicles: ${match.vehicle_count} | chunks: ${match.chunk_count}`,
    '',
    '### Bottleneck',
    describeBottleneck(match, simHz),
    `tick p95 ${fmt(match.timings.total_ms.p95, 2)}ms`,
    `total physics p95 ${fmt(totalPhysicsP95(match), 2)}ms`,
    `snapshot p95 ${(match.network.snapshot_bytes_per_client.p95 / 1024).toFixed(2)} KiB/client`,
    '',
    '### Health',
    `tick budget ${fmt(tickBudgetMs(simHz), 2)}ms`,
    `headroom ${fmt(tickHeadroomMs(match, simHz), 2)}ms`,
    `max in-buf ${maxPendingInputs(match)} avg ${fmt(avgPendingInputs(match), 1)}`,
    '',
    '### Load Shape',
    `ws ${match.load.websocket_players} wt ${match.load.webtransport_players}`,
    `nearby avg ${fmt(match.load.avg_nearby_players, 1)} max ${match.load.max_nearby_players}`,
    `void kills ${match.load.void_kills}`,
    '',
    '### Network',
    `in ${fmtRate(match.network.inbound_bps)} out ${fmtRate(match.network.outbound_bps)}`,
    `pkts ${match.network.inbound_packets_per_sec}/${match.network.outbound_packets_per_sec} per sec`,
    describeTransport(match),
    `ws snap ${match.network.websocket_snapshot_reliable_sent} wt dgram ${match.network.webtransport_snapshot_datagram_sent} wt rel ${match.network.webtransport_snapshot_reliable_sent}`,
    `fallbacks ${match.network.datagram_fallbacks} malformed ${match.network.malformed_packets}`,
    '',
    '### Snapshot Shape',
    `players/client p95 ${fmt(match.network.snapshot_players_per_client.p95, 1)}`,
    `bodies/client p95 ${fmt(match.network.snapshot_dynamic_bodies_per_client.p95, 1)}`,
    `vehicles/client p95 ${fmt(match.network.snapshot_vehicles_per_client.p95, 1)}`,
    `bodies considered/tick p95 ${fmt(match.network.dynamic_bodies_considered_per_tick.p95, 1)}`,
    `bodies pushed/tick p95 ${fmt(match.network.dynamic_bodies_pushed_per_tick.p95, 1)}`,
    `contacted mass/tick p95 ${fmt(match.network.contacted_dynamic_mass_per_tick.p95, 2)}`,
    `wt reliable ${(wtFallbackRatio * 100).toFixed(1)}%`,
    `bytes/tick p95 ${(match.network.snapshot_bytes_per_tick.p95 / 1024).toFixed(2)} KiB`,
    '',
    '### Tick Breakdown',
    `player movement ${fmt(match.timings.player_sim_ms.p95, 2)}ms`,
    `movement math ${fmt(match.timings.player_move_math_ms.p95, 2)}ms`,
    `player KCC ${fmt(match.timings.player_kcc_ms.p95, 2)}ms`,
    `collider sync ${fmt(match.timings.player_collider_sync_ms.p95, 2)}ms`,
    `dynamic interaction ${fmt(match.timings.player_dynamic_interaction_ms.p95, 2)}ms`,
    `vehicles ${fmt(match.timings.vehicle_ms.p95, 2)}ms`,
    `dynamic bodies ${fmt(match.timings.dynamics_ms.p95, 2)}ms`,
    `snapshot ${fmt(match.timings.snapshot_ms.p95, 2)}ms`,
    '',
    '### Players',
    '| ID | Transport | Latency | In-buf | HP | Position (m) | Speed | Status | Net-jitter | Bundle | Correction | Phys-ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...(match.players.length > 0 ? match.players.map(playerRowMarkdown) : ['| — | — | — | — | — | — | — | — | — | — | — | — |']),
  ];
  return lines.join('\n');
}

function statsMarkdown(stats: GlobalStatsSnapshot, lastUpdate: Date | null, connState: ConnState): string {
  const lines = [
    '# vibe-land / server-stats',
    '',
    `sim: ${stats.sim_hz} Hz | snapshots: ${stats.snapshot_hz} Hz | matches: ${stats.matches.length}`,
    `connection: ${connState}`,
    `updated: ${lastUpdate ? lastUpdate.toISOString() : 'unknown'}`,
    '',
  ];
  for (const match of stats.matches) {
    lines.push(matchMarkdown(match, stats.sim_hz), '');
  }
  return lines.join('\n').trim();
}

// ── Styles (inline, zero dependencies) ───────────────────────────────────────

const BG = '#0a0a0a';
const FG = '#00ff00';
const DIM = '#009900';
const YELLOW = '#ffff00';
const RED = '#ff4444';
const WHITE = '#ffffff';

const styles = {
  page: {
    background: BG,
    color: FG,
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 1.6,
    minHeight: '100vh',
    padding: '16px 20px',
    boxSizing: 'border-box' as const,
  },
  header: {
    borderBottom: `1px solid ${DIM}`,
    paddingBottom: 8,
    marginBottom: 16,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    flexWrap: 'wrap' as const,
    gap: 8,
  },
  title: { color: YELLOW, fontSize: 16, fontWeight: 'bold' as const, margin: 0 },
  connBadge: (state: ConnState) => ({
    padding: '2px 8px',
    borderRadius: 3,
    fontSize: 11,
    background: state === 'connected' ? '#003300' : state === 'connecting' ? '#332200' : '#330000',
    color: state === 'connected' ? '#00ff00' : state === 'connecting' ? '#ffaa00' : RED,
    border: `1px solid ${state === 'connected' ? '#00aa00' : state === 'connecting' ? '#aa6600' : '#aa0000'}`,
  }),
  sectionTitle: {
    color: YELLOW,
    fontWeight: 'bold' as const,
    marginBottom: 4,
    marginTop: 12,
  },
  matchBox: {
    border: `1px solid ${DIM}`,
    borderRadius: 4,
    padding: '10px 14px',
    marginBottom: 16,
  },
  matchSummary: {
    color: DIM,
    marginBottom: 8,
    fontSize: 12,
  },
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 10,
    marginBottom: 12,
  },
  summaryCard: {
    border: `1px solid ${DIM}`,
    borderRadius: 4,
    padding: '8px 10px',
    background: '#060606',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 12,
  },
  th: {
    color: YELLOW,
    textAlign: 'left' as const,
    paddingRight: 16,
    paddingBottom: 4,
    borderBottom: `1px solid ${DIM}`,
    fontWeight: 'bold' as const,
    whiteSpace: 'nowrap' as const,
  },
  td: {
    paddingRight: 16,
    paddingTop: 3,
    paddingBottom: 3,
    whiteSpace: 'nowrap' as const,
    verticalAlign: 'top' as const,
  },
  noPlayers: { color: DIM, fontStyle: 'italic' as const, fontSize: 12 },
  updateTs: { color: DIM, fontSize: 11 },
  serverInfo: { color: FG, fontSize: 12, marginBottom: 8 },
  button: {
    background: '#101010',
    color: YELLOW,
    border: `1px solid ${DIM}`,
    borderRadius: 4,
    padding: '6px 10px',
    fontFamily: 'monospace',
    fontSize: 12,
    cursor: 'pointer',
  },
};

// ── Components ────────────────────────────────────────────────────────────────

function ConnBadge({ state }: { state: ConnState }) {
  const label = state === 'connected' ? '● LIVE' : state === 'connecting' ? '○ CONNECTING...' : '✕ DISCONNECTED';
  return <span style={styles.connBadge(state)}>{label}</span>;
}

function MatchPanel({ match, simHz }: { match: MatchStatsSnapshot; simHz: number }) {
  const wtFallbackRatio = webTransportSnapshotFallbackRatio(match);
  return (
    <div style={styles.matchBox}>
      <div style={styles.matchSummary}>
        {`match: ${match.id}  |  scenario: ${match.scenario_tag}  |  tick: ${match.server_tick}  |  players: ${match.player_count}  |  bodies: ${match.dynamic_body_count}  |  vehicles: ${match.vehicle_count}  |  chunks: ${match.chunk_count}`}
      </div>
      <div style={styles.summaryGrid}>
        <SummaryCard
          title="Bottleneck"
          lines={[
            describeBottleneck(match, simHz),
            `tick p95 ${fmt(match.timings.total_ms.p95, 2)}ms`,
            `total physics p95 ${fmt(totalPhysicsP95(match), 2)}ms`,
            `snapshot p95 ${(match.network.snapshot_bytes_per_client.p95 / 1024).toFixed(2)} KiB/client`,
          ]}
        />
        <SummaryCard
          title="Health"
          lines={[
            `tick budget ${fmt(tickBudgetMs(simHz), 2)}ms`,
            `headroom ${fmt(tickHeadroomMs(match, simHz), 2)}ms`,
            `max in-buf ${maxPendingInputs(match)}  avg ${fmt(avgPendingInputs(match), 1)}`,
          ]}
        />
        <SummaryCard
          title="Load Shape"
          lines={[
            `ws ${match.load.websocket_players}  wt ${match.load.webtransport_players}`,
            `nearby avg ${fmt(match.load.avg_nearby_players, 1)}  max ${match.load.max_nearby_players}`,
            `void kills ${match.load.void_kills}`,
          ]}
        />
        <SummaryCard
          title="Network"
          lines={[
            `in ${fmtRate(match.network.inbound_bps)}  out ${fmtRate(match.network.outbound_bps)}`,
            `pkts ${match.network.inbound_packets_per_sec}/${match.network.outbound_packets_per_sec} per sec`,
            `${describeTransport(match)}`,
            `ws snap ${match.network.websocket_snapshot_reliable_sent}  wt dgram ${match.network.webtransport_snapshot_datagram_sent}  wt rel ${match.network.webtransport_snapshot_reliable_sent}`,
            `fallbacks ${match.network.datagram_fallbacks}  malformed ${match.network.malformed_packets}`,
          ]}
        />
        <SummaryCard
          title="Snapshot Shape"
          lines={[
            `players/client p95 ${fmt(match.network.snapshot_players_per_client.p95, 1)}`,
            `bodies/client p95 ${fmt(match.network.snapshot_dynamic_bodies_per_client.p95, 1)}`,
            `vehicles/client p95 ${fmt(match.network.snapshot_vehicles_per_client.p95, 1)}`,
            `bodies considered/tick p95 ${fmt(match.network.dynamic_bodies_considered_per_tick.p95, 1)}`,
            `bodies pushed/tick p95 ${fmt(match.network.dynamic_bodies_pushed_per_tick.p95, 1)}`,
            `contacted mass/tick p95 ${fmt(match.network.contacted_dynamic_mass_per_tick.p95, 2)}`,
            `wt reliable ${(wtFallbackRatio * 100).toFixed(1)}%`,
            `bytes/tick p95 ${(match.network.snapshot_bytes_per_tick.p95 / 1024).toFixed(2)} KiB`,
          ]}
        />
        <SummaryCard
          title="Tick Breakdown"
          lines={[
            `player movement ${fmt(match.timings.player_sim_ms.p95, 2)}ms`,
            `movement math ${fmt(match.timings.player_move_math_ms.p95, 2)}ms`,
            `player KCC ${fmt(match.timings.player_kcc_ms.p95, 2)}ms`,
            `collider sync ${fmt(match.timings.player_collider_sync_ms.p95, 2)}ms`,
            `dynamic interaction ${fmt(match.timings.player_dynamic_interaction_ms.p95, 2)}ms`,
            `vehicles ${fmt(match.timings.vehicle_ms.p95, 2)}ms`,
            `dynamic bodies ${fmt(match.timings.dynamics_ms.p95, 2)}ms`,
            `snapshot ${fmt(match.timings.snapshot_ms.p95, 2)}ms`,
          ]}
        />
      </div>

      {match.players.length === 0 ? (
        <div style={styles.noPlayers}>no players connected</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              {['ID', 'Transport', 'Latency', 'In-buf', 'HP', 'Position (m)', 'Speed', 'Status', 'Net-jitter', 'Bundle', 'Correction', 'Phys-ms'].map((h) => (
                <th key={h} style={styles.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {match.players.map((p) => (
              <tr key={p.id}>
                <td style={styles.td}>{p.id}</td>
                <td style={{ ...styles.td, color: p.transport === 'webtransport' ? '#6ef2ff' : WHITE }}>
                  {p.transport === 'webtransport' ? 'WT' : 'WS'}
                </td>
                <td style={{ ...styles.td, color: p.one_way_ms > 100 ? RED : p.one_way_ms > 50 ? '#ffaa00' : FG }}>
                  {p.one_way_ms}ms
                </td>
                <td style={{ ...styles.td, color: p.pending_inputs > 20 ? RED : FG }}>
                  {p.pending_inputs}
                </td>
                <td style={{ ...styles.td, color: p.hp === 0 ? RED : p.hp < 30 ? '#ffaa00' : FG }}>
                  {p.dead ? '—' : `${p.hp}`}
                </td>
                <td style={{ ...styles.td, color: WHITE }}>{fmtPos(p.pos_m)}</td>
                <td style={styles.td}>{fmtSpeed(p.vel_ms) === '—' ? '—' : `${fmtSpeed(p.vel_ms)} m/s`}</td>
                <td style={{ ...styles.td, color: p.dead ? RED : DIM }}>{statusStr(p)}</td>
                <td style={{ ...styles.td, color: p.input_jitter_ms > 20 ? RED : p.input_jitter_ms > 10 ? '#ffaa00' : FG }}>
                  ±{fmt(p.input_jitter_ms)}ms
                </td>
                <td style={{ ...styles.td, color: p.avg_bundle_size > 5 ? '#ffaa00' : FG }}>
                  {fmt(p.avg_bundle_size, 1)}
                </td>
                <td style={{ ...styles.td, color: p.has_debug_stats ? (p.correction_m > 0.5 ? RED : p.correction_m > 0.1 ? '#ffaa00' : FG) : DIM }}>
                  {p.has_debug_stats ? `${fmt(p.correction_m, 3)}m` : 'n/a'}
                </td>
                <td style={{ ...styles.td, color: p.has_debug_stats ? (p.physics_ms > 8 ? RED : p.physics_ms > 4 ? '#ffaa00' : FG) : DIM }}>
                  {p.has_debug_stats ? `${fmtMsDetailed(p.physics_ms)}ms` : 'n/a'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SummaryCard({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div style={styles.summaryCard}>
      <div style={{ color: YELLOW, fontWeight: 'bold', marginBottom: 4 }}>{title}</div>
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function ServerStats() {
  const { stats, connState, lastUpdate } = useServerStats();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copyMarkdown(): Promise<void> {
    if (!stats) return;
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
      <div style={styles.header}>
        <div>
          <p style={styles.title}>vibe-land / server-stats</p>
          {stats && (
            <div style={styles.serverInfo}>
              {`sim: ${stats.sim_hz} Hz  |  snapshots: ${stats.snapshot_hz} Hz  |  matches: ${stats.matches.length}`}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <button style={styles.button} onClick={() => void copyMarkdown()} disabled={!stats}>
            {copyState === 'copied' ? 'Copied Markdown' : copyState === 'failed' ? 'Copy Failed' : 'Copy Markdown'}
          </button>
          <ConnBadge state={connState} />
          {lastUpdate && (
            <span style={styles.updateTs}>
              {`updated ${lastUpdate.toLocaleTimeString()}`}
            </span>
          )}
        </div>
      </div>

      {connState !== 'connected' && !stats && (
        <div style={{ color: DIM, marginTop: 32, textAlign: 'center' }}>
          {connState === 'connecting' ? 'Connecting to server...' : 'Disconnected — retrying in 2s...'}
        </div>
      )}

      {stats && stats.matches.length === 0 && (
        <div style={{ color: DIM, marginTop: 16 }}>No active matches.</div>
      )}

      {stats && stats.matches.map((m) => (
        <div key={m.id}>
          <div style={styles.sectionTitle}>{`Match: ${m.id}`}</div>
          <MatchPanel match={m} simHz={stats.sim_hz} />
        </div>
      ))}
    </div>
  );
}
