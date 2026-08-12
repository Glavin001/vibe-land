// In-page performance overlay for /city.
//
// The point is to tell apart the three places a city session can be slow, all
// on one screen:
//   - the browser (frame time, measured with rAF, independent of any app state)
//   - the network (transport, ping, city stream volume, topology gaps)
//   - the server sim (match tick cost, body counts, city step cost)
//
// Diagnosing the "lags after destroying a few buildings" report needed all
// three at once: the client held 60 fps while the match loop was running at
// 21-29 ms against a 16.67 ms budget with ~650 chunk bodies that never slept.
// Without server numbers on screen that reads as "the game is laggy".

import { useEffect, useRef, useState } from 'react';

/** Matches the server's CityStatsSnapshot in server/src/main.rs. */
interface CityServerStats {
  structures: number;
  chunk_bodies: number;
  awake_bodies: number;
  broken_bonds: number;
  step_ms: number;
  stress_solve_ms: number;
  packets_per_sec: number;
  records_per_sec: number;
  bytes_per_sec: number;
  topo_seq: number;
  baseline_id: number;
  min_body_y: number;
  resettled_wakes: number;
  solve_ms: number;
  begin_ms: number;
  end_ms: number;
  gpu_stress_structures: number;
  gpu_stress_solve_ms: number;
  settle_deferred_penetrating: number;
  unmapped_body_skips: number;
  duplicate_body_records: number;
  degraded: boolean;
}

interface MatchStats {
  server_tick: number;
  player_count: number;
  physics_backend: string;
  physics_gpu_active: boolean;
  physics_last_step_ms: number;
  physics_active_dynamic_bodies: number;
  timings?: { total_ms?: { avg?: number; p95?: number; max?: number } };
  city?: CityServerStats;
}

const SIM_HZ = 60;
const TICK_BUDGET_MS = 1000 / SIM_HZ;

function useFrameTime(): { fps: number; p95: number } {
  const [value, setValue] = useState({ fps: 0, p95: 0 });
  useEffect(() => {
    let raf = 0;
    let previous = 0;
    let samples: number[] = [];
    let lastReport = performance.now();
    const tick = (now: number) => {
      if (previous) samples.push(now - previous);
      previous = now;
      if (now - lastReport > 500 && samples.length > 1) {
        const sorted = [...samples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length * 0.5)];
        setValue({
          fps: median > 0 ? 1000 / median : 0,
          p95: sorted[Math.floor(sorted.length * 0.95)],
        });
        samples = [];
        lastReport = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return value;
}

const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12 };
const heading: React.CSSProperties = {
  opacity: 0.55,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  fontSize: 9,
  marginTop: 6,
  marginBottom: 2,
};

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={row}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ color: warn ? '#ff8080' : '#d6f5d6', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  );
}

export function CityStatsOverlay({
  matchId,
  getCityStats,
  transport,
  pingMs,
}: {
  matchId: string;
  getCityStats: () => {
    chunksTotal: number;
    chunksAwake: number;
    chunksSettled: number;
    liveIslands: number;
    brokenBonds: number;
    topoSeqGaps: number;
    bytesPerSecond: number;
    datagramsReceived: number;
    minChunkY: number;
    chunksBelowGround: number;
    orphanedChunks: number;
    rendered: boolean;
  } | null;
  transport: string;
  pingMs: number;
}) {
  const [visible, setVisible] = useState(true);
  const [server, setServer] = useState<MatchStats | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const frame = useFrameTime();
  const clientStats = getCityStats();
  const datagramsRef = useRef({ last: 0, perSec: 0, at: 0 });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F9') {
        event.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/match-stats/${encodeURIComponent(matchId)}`);
        if (!response.ok) throw new Error(`${response.status}`);
        const json = (await response.json()) as MatchStats;
        if (!cancelled) {
          setServer(json);
          setServerError(null);
        }
      } catch (error) {
        if (!cancelled) setServerError(String(error));
      }
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [matchId, visible]);

  if (!visible) return null;

  // Datagram rate from the monotonic received counter.
  const now = performance.now();
  const tracker = datagramsRef.current;
  if (clientStats && now - tracker.at > 900) {
    tracker.perSec = ((clientStats.datagramsReceived - tracker.last) * 1000) / (now - tracker.at || 1);
    tracker.last = clientStats.datagramsReceived;
    tracker.at = now;
  }

  const tick = server?.timings?.total_ms;
  const tickAvg = tick?.avg ?? 0;
  const effectiveHz = tickAvg > 0 ? Math.min(SIM_HZ, 1000 / tickAvg) : 0;
  const city = server?.city;

  return (
    <div
      style={{
        position: 'absolute',
        top: 56,
        left: 12,
        zIndex: 40,
        width: 268,
        padding: '8px 10px',
        borderRadius: 6,
        background: 'rgba(8,12,10,0.82)',
        color: '#d6f5d6',
        font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
        pointerEvents: 'none',
        lineHeight: 1.5,
      }}
      data-testid="city-stats-overlay"
    >
      <div style={{ ...row, opacity: 0.9, fontWeight: 700 }}>
        <span>CITY STATS</span>
        <span style={{ opacity: 0.5 }}>F9</span>
      </div>

      <div style={heading}>browser</div>
      <Stat label="fps" value={frame.fps.toFixed(0)} warn={frame.fps < 45} />
      <Stat label="frame p95" value={`${frame.p95.toFixed(1)} ms`} warn={frame.p95 > 25} />
      <Stat label="chunks drawn" value={`${clientStats?.chunksTotal ?? 0}`} />
      <Stat
        label="rendered"
        value={clientStats?.rendered ? 'yes' : 'NO'}
        warn={clientStats != null && !clientStats.rendered}
      />

      <div style={heading}>network</div>
      <Stat label="transport" value={transport} warn={transport !== 'webtransport'} />
      <Stat label="ping" value={`${pingMs.toFixed(0)} ms`} warn={pingMs > 120} />
      <Stat
        label="city stream"
        value={`${(((clientStats?.bytesPerSecond ?? 0) * 8) / 1e6).toFixed(2)} Mbps`}
        warn={((clientStats?.bytesPerSecond ?? 0) * 8) / 1e6 > 2.5}
      />
      <Stat label="datagrams/s" value={tracker.perSec.toFixed(0)} />
      <Stat
        label="topo gaps"
        value={`${clientStats?.topoSeqGaps ?? 0}`}
        warn={(clientStats?.topoSeqGaps ?? 0) > 0}
      />

      <div style={heading}>server sim{server ? '' : ' (no data)'}</div>
      {serverError ? (
        <Stat label="stats" value={serverError.slice(0, 18)} warn />
      ) : (
        <>
          <Stat
            label="tick avg"
            value={`${tickAvg.toFixed(1)} ms`}
            warn={tickAvg > TICK_BUDGET_MS}
          />
          <Stat label="tick p95" value={`${(tick?.p95 ?? 0).toFixed(1)} ms`} warn={(tick?.p95 ?? 0) > TICK_BUDGET_MS} />
          <Stat
            label="effective hz"
            value={effectiveHz.toFixed(0)}
            warn={effectiveHz < SIM_HZ - 2}
          />
          <Stat
            label="physx step"
            value={`${(server?.physics_last_step_ms ?? 0).toFixed(1)} ms`}
          />
          <Stat
            label="gpu"
            value={server?.physics_gpu_active ? server.physics_backend : `${server?.physics_backend ?? '?'} (cpu)`}
            warn={server != null && !server.physics_gpu_active}
          />
          <Stat label="players" value={`${server?.player_count ?? 0}`} />
        </>
      )}

      <div style={heading}>destruction</div>
      <Stat
        label="bodies (awake)"
        value={`${city?.chunk_bodies ?? 0} (${city?.awake_bodies ?? 0})`}
        warn={(city?.awake_bodies ?? 0) > 200}
      />
      <Stat label="broken bonds" value={`${city?.broken_bonds ?? 0}`} />
      <Stat label="islands" value={`${clientStats?.liveIslands ?? 0}`} />
      <Stat
        label="city step"
        value={`${(city?.step_ms ?? 0).toFixed(1)} ms`}
        warn={(city?.step_ms ?? 0) > TICK_BUDGET_MS / 2}
      />
      <Stat
        label="blast begin"
        value={`${(city?.begin_ms ?? 0).toFixed(1)} ms`}
        warn={(city?.begin_ms ?? 0) > 4}
      />
      <Stat label="blast solve" value={`${(city?.solve_ms ?? 0).toFixed(1)} ms`} />
      <Stat label="blast end" value={`${(city?.end_ms ?? 0).toFixed(1)} ms`} />
      <Stat
        label="stress solver"
        value={
          city == null
            ? '?'
            : city.gpu_stress_structures > 0
              ? `CUDA ${city.gpu_stress_structures}/${city.structures}`
              : 'CPU'
        }
        warn={city != null && city.gpu_stress_structures < city.structures}
      />

      {(city?.degraded
        || (city?.duplicate_body_records ?? 0) > 0
        || (city?.unmapped_body_skips ?? 0) > 0
        || (clientStats?.chunksBelowGround ?? 0) > 0
        || (clientStats?.orphanedChunks ?? 0) > 0) && (
        <>
          <div style={heading}>warnings</div>
          {city?.degraded && <Stat label="backend" value="DEGRADED" warn />}
          {(city?.duplicate_body_records ?? 0) > 0 && (
            <Stat label="dup body ids" value={`${city!.duplicate_body_records}`} warn />
          )}
          {(city?.unmapped_body_skips ?? 0) > 0 && (
            <Stat label="unmapped bodies" value={`${city!.unmapped_body_skips}`} warn />
          )}
          {(clientStats?.orphanedChunks ?? 0) > 0 && (
            <Stat label="orphan chunks" value={`${clientStats!.orphanedChunks}`} warn />
          )}
          {(clientStats?.chunksBelowGround ?? 0) > 0 && (
            <Stat
              label="below ground"
              value={`${clientStats!.chunksBelowGround} @ ${clientStats!.minChunkY.toFixed(1)} m`}
              warn
            />
          )}
        </>
      )}
    </div>
  );
}
