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

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BODY_DEBUG_STATES, setBodyDebugEnabled, setBodyDebugStates } from './bodyDebugColors';
import { renderStats } from './renderStats';
import { isTouchDevice } from '../device';

/** Matches the server's CityStatsSnapshot in server/src/main.rs. */
interface CityServerStats {
  structures: number;
  wire_version?: number;
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
  /// Optional: servers older than the pile-freezing build do not send these.
  sleeping_bodies?: number;
  frozen_bodies?: number;
  freeze_flips?: number;
  unfreeze_flips?: number;
  contact_wakes?: number;
  chunk_sleep_events?: number;
  chunk_wake_events?: number;
  pose_quiet_awake_bodies?: number;
  frozen_serial_blocks?: number;
  solver_island_count?: number;
  solver_islands_skipped?: number;
  solve_ms: number;
  begin_ms: number;
  end_ms: number;
  /// Native-side phases that were plumbed all the way to /match-stats but had
  /// no row here. Their absence is not harmless: reading `0.0` off a panel
  /// that simply never showed them is how the unattributed-gap hunt started
  /// down the wrong path. Optional -- older servers omit them.
  readback_ms?: number;
  events_ms?: number;
  filters_ms?: number;
  ccd_ms?: number;
  support_loads_ms?: number;
  shape_readback_ms?: number;
  quiet_slot_ticks?: number;
  readback_ms_host: number;
  settle_ms: number;
  ingest_ms: number;
  /// Optional: added with the tick-accounting pass; older servers omit them.
  tick_ffi_ms?: number;
  drain_ms?: number;
  stats_ffi_ms?: number;
  post_step_ms?: number;
  fan_out_ms?: number;
  publish_ms?: number;
  city_desync_repairs?: number;
  encode_shared_ms: number;
  client_datagrams_ms: number;
  gpu_stress_structures: number;
  gpu_stress_solve_ms: number;
  settle_deferred_penetrating: number;
  unmapped_body_skips: number;
  duplicate_body_records: number;
  degraded: boolean;
}

interface MatchStats {
  server_build?: string;
  server_started?: string;
  server_tick: number;
  player_count: number;
  physics_backend: string;
  physics_gpu_active: boolean;
  physics_last_step_ms: number;
  physics_active_dynamic_bodies: number;
  timings?: { total_ms?: { avg?: number; p95?: number; max?: number } };
  city?: CityServerStats;
}

declare const __CLIENT_BUILD__: string;
const CLIENT_BUILD = typeof __CLIENT_BUILD__ === 'string' ? __CLIENT_BUILD__ : 'dev';

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
/**
 * Shared style for the show/hide controls.
 *
 * `pointerEvents: 'auto'` is the point of it: the panel opts out of pointer
 * events entirely so it can never swallow a shot, and these controls are the
 * only things inside it that opt back in. The hit box is sized for a thumb
 * rather than a cursor, since a touch device has no F9 to fall back on.
 */
const toggleButton: React.CSSProperties = {
  position: 'absolute',
  zIndex: 41,
  pointerEvents: 'auto',
  minWidth: 44,
  minHeight: 28,
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid rgba(214,245,214,0.25)',
  background: 'rgba(8,12,10,0.82)',
  color: '#d6f5d6',
  font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
  cursor: 'pointer',
  // Stops iOS Safari treating a fast tap as a double-tap zoom.
  touchAction: 'manipulation',
};
const heading: React.CSSProperties = {
  opacity: 0.55,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  fontSize: 9,
  marginTop: 6,
  marginBottom: 2,
};

/**
 * Client fps, server tick rate and stream rate, in one line that is on screen
 * whether or not the panel is open.
 *
 * These three answer "is it running well right now", which is a question worth
 * asking constantly and not worth opening a panel for -- especially on a phone,
 * where the panel covers a third of the screen. Collapsed, this IS the panel's
 * tap target; expanded, it is its header.
 */
function LiveHud({
  fps,
  serverHz,
  mbps,
  compact,
}: {
  fps: number;
  serverHz: number;
  mbps: number;
  compact: boolean;
}) {
  const cell: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
  return (
    <span style={{ display: 'inline-flex', gap: compact ? 8 : 10, alignItems: 'baseline' }}>
      <span style={{ ...cell, color: fps < 45 ? '#ff8080' : '#d6f5d6' }}>
        {fps.toFixed(0)}
        <span style={{ opacity: 0.5 }}>fps</span>
      </span>
      {/* Zero means the server has not reported yet, which is not the same as
          a server running at 0 Hz -- show a dash rather than a false alarm. */}
      <span style={{ ...cell, color: serverHz > 0 && serverHz < 55 ? '#ff8080' : '#d6f5d6' }}>
        {serverHz > 0 ? serverHz.toFixed(0) : '--'}
        <span style={{ opacity: 0.5 }}>hz</span>
      </span>
      <span style={{ ...cell, opacity: 0.75 }}>
        {mbps.toFixed(1)}
        <span style={{ opacity: 0.6 }}>mb</span>
      </span>
    </span>
  );
}

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

import { getMatchStats, subscribeMatchStats } from '../app/connectPhase';
import { acquireCityDiagnostics } from './cityDiagnostics';
import {
  HULL_POOL_CHOICES,
  setHullPoolSize,
  setQualityTier,
  setShadowsEnabled,
  shadowsEnabled,
  useHullPoolSize,
  useQualityTier,
} from '../app/renderQuality';

export function CityStatsOverlay({
  matchId,
  statsBaseUrl = '',
  getCityStats,
  transport,
  pingMs,
}: {
  matchId: string;
  /** Origin serving this match's stats; null when unreachable from this page. */
  statsBaseUrl?: string | null;
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
    chunkUpdateP95Ms: number;
    orphanedChunks: number;
    rendered: boolean;
    wireVersion: number;
    bootstraps: number;
    settleRejects: number;
  } | null;
  transport: string;
  pingMs: number;
}) {
  // Collapsed by default on a phone: expanded, the panel covers most of a
  // small screen, and the pill it collapses to now carries the numbers worth
  // watching continuously. Desktop keeps the full panel open.
  const [visible, setVisible] = useState(() => !isTouchDevice());
  const [resetState, setResetState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  // Snapshot of the FULL /match-stats payload, saved to a file. The panel
  // deliberately shows a curated subset -- every phase timer would not fit and
  // would not be readable if it did -- but debugging a bottleneck needs all of
  // it, from one instant, in a form that can be attached to a message.
  //
  // A file rather than the clipboard: the payload is ~8 KB of JSON, which is
  // awkward to paste and trivial to truncate by accident, and a download
  // survives the page being closed. It also sidesteps navigator.clipboard
  // needing a secure context, which this page only has once a self-signed
  // certificate has been accepted.
  //
  // Re-fetched on click rather than reusing the 1 Hz poll, so the file is the
  // moment you pressed the button rather than up to a second stale.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>(
    'idle',
  );
  const [savedName, setSavedName] = useState<string | null>(null);
  const [shadows, setShadows] = useState(shadowsEnabled);
  const [bodyColors, setBodyColors] = useState(false);
  // Poll per-body freeze states only while the toggle is on: no reason to
  // fetch thousands of pairs for a feature that is off.
  useEffect(() => {
    setBodyDebugEnabled(bodyColors);
    if (!bodyColors || statsBaseUrl === null) {
      return;
    }
    let cancelled = false;
    const fetchStates = async () => {
      try {
        const response = await fetch(
          `${statsBaseUrl}/match-stats/${encodeURIComponent(matchId)}/bodies`,
        );
        if (!response.ok || cancelled) {
          return;
        }
        const pairs = (await response.json()) as Array<[number, number]>;
        if (!cancelled) {
          setBodyDebugStates(pairs);
        }
      } catch {
        // Debug overlay: silence is fine, the colors just go stale.
      }
    };
    void fetchStates();
    const timer = window.setInterval(fetchStates, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bodyColors, matchId, statsBaseUrl]);

  const tier = useQualityTier();
  const hullPool = useHullPoolSize();
  // The per-chunk sweeps behind these rows cost 3.1 ms at 33k chunks, so they
  // only run while the panel is actually on screen. Collapsed to the pill --
  // and hidden by default on touch -- nobody is reading them.
  useEffect(() => (visible ? acquireCityDiagnostics() : undefined), [visible]);
  // The tier the canvas was created with: antialias and tonemapping only apply
  // at context creation, so a mismatch means "reload to finish applying".
  const [mountTier] = useState(tier);
  const [server, setServer] = useState<MatchStats | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const frame = useFrameTime();
  const clientStats = getCityStats();
  const datagramsRef = useRef({ last: 0, perSec: 0, at: 0 });
  // Freeze churn per second. The cumulative total means nothing on its own; the
  // RATE is what separates a healthy server (a few hundred flips over a whole
  // session) from one that has fallen into a freeze/thaw loop and stopped
  // settling anything -- measured at 407,984 flips with 0 bodies asleep, while
  // every other number on this panel looked ordinary.
  const freezeRef = useRef({ last: 0, perSec: 0, at: 0 });

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

  // Stats pushed over the session describe the server actually being played
  // on, so they win. Polling remains for older servers that do not send them.
  const pushed = useSyncExternalStore(
    subscribeMatchStats,
    getMatchStats,
    getMatchStats,
  ) as MatchStats | null;

  useEffect(() => {
    // Runs while collapsed too: the pill reports the server's tick rate, and
    // a readout that goes stale the moment you hide the panel is worse than
    // no readout at all.
    if (pushed) {
      setServer(pushed);
      setServerError(null);
      return undefined;
    }
    if (statsBaseUrl === null) {
      // Better to say nothing than to report another server's simulation as
      // though it were this one.
      setServer(null);
      setServerError('waiting for stats from the server…');
      return undefined;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(
          `${statsBaseUrl}/match-stats/${encodeURIComponent(matchId)}`,
        );
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
  }, [matchId, pushed, statsBaseUrl]);

  const tickAvgMs = server?.timings?.total_ms?.avg ?? 0;
  const serverHz = tickAvgMs > 0 ? Math.min(SIM_HZ, 1000 / tickAvgMs) : 0;
  const streamMbps = ((clientStats?.bytesPerSecond ?? 0) * 8) / 1e6;

  // Touch devices have no F9, so the overlay needs a tap target to come back
  // from. It doubles as the hidden-state indicator and as the always-on
  // readout: collapsed to a pill, it still answers "is it running well" without
  // costing the screen space the full panel does.
  if (!visible) {
    return (
      <button
        type="button"
        onClick={() => setVisible(true)}
        style={{
          ...toggleButton,
          top: 56,
          left: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
        data-testid="city-stats-show"
        aria-label="Show city stats"
      >
        <LiveHud fps={frame.fps} serverHz={serverHz} mbps={streamMbps} compact />
        <span style={{ opacity: 0.45 }}>▸</span>
      </button>
    );
  }

  // Datagram rate from the monotonic received counter.
  const now = performance.now();
  const tracker = datagramsRef.current;
  if (clientStats && now - tracker.at > 900) {
    tracker.perSec = ((clientStats.datagramsReceived - tracker.last) * 1000) / (now - tracker.at || 1);
    tracker.last = clientStats.datagramsReceived;
    tracker.at = now;
  }

  const freezeFlips = server?.city?.freeze_flips ?? 0;
  const freezeTracker = freezeRef.current;
  if (freezeFlips > 0 && now - freezeTracker.at > 900) {
    if (freezeTracker.last > 0) {
      freezeTracker.perSec = ((freezeFlips - freezeTracker.last) * 1000) / (now - freezeTracker.at || 1);
    }
    freezeTracker.last = freezeFlips;
    freezeTracker.at = now;
  }

  const tick = server?.timings?.total_ms;
  const tickAvg = tickAvgMs;
  const effectiveHz = serverHz;
  const city = server?.city;

  // The children the server times inside its 60 Hz city step. The stream-encode
  // pair is excluded on purpose: that is a separate 30 Hz pass.
  // `tick_ffi_ms` is the host bracket around the whole native destruction tick
  // and is the PARENT of begin/solve/end, so it replaces them in the sum
  // rather than adding to them.
  const cityStepChildrenMs = city
    ? (city.tick_ffi_ms ?? city.begin_ms + city.solve_ms + city.end_ms)
      + (city.drain_ms ?? 0)
      + city.readback_ms_host
      + city.settle_ms
      + (city.stats_ffi_ms ?? 0)
      + city.ingest_ms
    : 0;
  // Clamped at 0: the children are sampled from the last native tick while
  // step_ms is host wall time for the same step, so a slow host tick can
  // briefly report children summing just past it.
  const cityStepUnattributedMs = Math.max(0, (city?.step_ms ?? 0) - cityStepChildrenMs);

  return (
    <div
      style={{
        position: 'absolute',
        top: 56,
        left: 12,
        zIndex: 40,
        // Never wider than the viewport allows: at 268 px the panel ran off
        // the side of a phone, and the rows that mattered were the clipped
        // ones. Height is capped the same way so the list scrolls instead of
        // running off the bottom -- dvh rather than vh because mobile browser
        // chrome is part of vh and the last rows ended up under it.
        width: 'min(268px, calc(100vw - 24px))',
        // The scroll area below is interactive, so the panel must not reach
        // the on-screen controls: on a phone AIM and CROUCH sit in the
        // bottom-left, exactly under a full-height panel, and an expanded
        // panel would eat their taps. Desktop only needs to clear the edge.
        maxHeight: `calc(100dvh - 76px - ${isTouchDevice() ? 200 : 20}px)`,
        display: 'flex',
        flexDirection: 'column',
        padding: '8px 10px',
        borderRadius: 6,
        background: 'rgba(8,12,10,0.82)',
        color: '#d6f5d6',
        font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
        // The panel opts out of pointer events so it can never swallow a shot.
        // The scroll area below opts back in -- safely, because while the
        // pointer is locked the canvas receives every event regardless of
        // where it is, and the one moment that is not true (clicking to
        // re-lock) is forwarded by the handler on it.
        pointerEvents: 'none',
        lineHeight: 1.5,
      }}
      data-testid="city-stats-overlay"
    >
      <div
        style={{
          ...row,
          opacity: 0.9,
          fontWeight: 700,
          flex: '0 0 auto',
          alignItems: 'center',
          paddingBottom: 4,
          borderBottom: '1px solid rgba(214,245,214,0.15)',
        }}
      >
        <LiveHud fps={frame.fps} serverHz={serverHz} mbps={streamMbps} compact={false} />
        {/* The panel itself is pointer-transparent so it never eats a shot;
            this control opts back in for its own hit box only. */}
        <button
          type="button"
          onClick={() => setVisible(false)}
          style={{ ...toggleButton, position: 'static', padding: '1px 6px' }}
          data-testid="city-stats-hide"
          aria-label="Hide city stats"
          title="Hide (F9)"
        >
          F9 ✕
        </button>
      </div>

      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          // Vertical drags scroll this list; anything else still reaches the
          // game underneath.
          touchAction: 'pan-y',
          pointerEvents: 'auto',
          marginTop: 2,
          // Room for the scrollbar on platforms that reserve space for one.
          paddingRight: 2,
        }}
        onPointerDown={(event) => {
          // Clicking the panel to re-acquire pointer lock must still work: the
          // canvas's own handler cannot see this event, so forward the intent.
          if (event.pointerType === 'mouse' && !document.pointerLockElement) {
            document.querySelector('canvas')?.requestPointerLock();
          }
        }}
        data-testid="city-stats-scroll"
      >

      <div style={{ ...row, marginTop: 4, marginBottom: 2 }}>
        <button
          type="button"
          disabled={saveState === 'saving'}
          onClick={async () => {
            setSaveState('saving');
            try {
              const response = await fetch(
                `${statsBaseUrl ?? ''}/match-stats/${encodeURIComponent(matchId)}`,
                { cache: 'no-store' },
              );
              if (!response.ok) throw new Error(`${response.status}`);
              const snapshot = await response.json();
              // Pretty-printed: this gets read by a human (or pasted into a
              // tool) far more often than it gets parsed by a machine.
              const text = JSON.stringify(snapshot, null, 2);
              // Name has to be unique per click AND self-describing, because
              // these arrive detached from the session that made them. The
              // server tick identifies the simulation instant exactly -- two
              // snapshots a second apart are different ticks -- and the
              // wall-clock stamp orders them for a human. Colons are stripped
              // because Windows and macOS both reject them in filenames.
              const stamp = new Date().toISOString().replace(/[:.]/g, '-');
              const tick = snapshot?.server_tick ?? 'unknown';
              const name = `match-stats-${matchId}-tick${tick}-${stamp}.json`;
              const url = URL.createObjectURL(
                new Blob([text], { type: 'application/json' }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = name;
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
              // Revoked on a later turn of the loop: revoking synchronously
              // races the download in some browsers and yields an empty file.
              window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
              setSavedName(name);
              setSaveState('saved');
            } catch {
              setSaveState('failed');
            }
            window.setTimeout(() => setSaveState('idle'), 4000);
          }}
          style={{ ...toggleButton, position: 'static', width: '100%' }}
          data-testid="city-stats-download"
          aria-label="Download the full stats snapshot as a JSON file"
        >
          {saveState === 'saving'
            ? 'SAVING...'
            : saveState === 'saved'
              ? 'SNAPSHOT SAVED'
              : saveState === 'failed'
                ? 'SAVE FAILED'
                : 'DOWNLOAD FULL STATS'}
        </button>
      </div>
      {savedName && (
        // The filename is the only way to tell the browser's download list
        // which click produced which file, so show the last one.
        <div style={{ ...row, opacity: 0.6, fontSize: 10, marginBottom: 2 }}>
          <span style={{ wordBreak: 'break-all' }}>{savedName}</span>
        </div>
      )}

      <div style={{ ...row, marginTop: 4, marginBottom: 2 }}>
        <button
          type="button"
          disabled={resetState === 'sending'}
          onClick={async () => {
            setResetState('sending');
            try {
              const response = await fetch(
                `${statsBaseUrl ?? ''}/city-reset/${encodeURIComponent(matchId)}`,
                { method: 'POST' },
              );
              // The server rebuilds on its next tick and re-bootstraps every
              // client, so a success here means "accepted", not "done".
              setResetState(response.ok ? 'sent' : 'failed');
            } catch {
              setResetState('failed');
            }
            window.setTimeout(() => setResetState('idle'), 2000);
          }}
          style={{ ...toggleButton, position: 'static', width: '100%' }}
          data-testid="city-reset"
          aria-label="Rebuild the city"
        >
          {resetState === 'sending'
            ? 'RESETTING...'
            : resetState === 'sent'
              ? 'RESET SENT'
              : resetState === 'failed'
                ? 'RESET FAILED'
                : 'RESET CITY'}
        </button>
      </div>

      <div style={{ ...row, marginBottom: 2 }}>
        <button
          type="button"
          onClick={() => setQualityTier(tier === 'fast' ? 'pretty' : 'fast')}
          style={{ ...toggleButton, position: 'static', width: '100%' }}
          data-testid="city-quality-toggle"
          aria-label="Toggle render quality"
          title="FAST drops resolution, sky, weather, PBR and a light. Antialias and tonemapping apply after a reload."
        >
          {tier === 'fast' ? 'QUALITY: FAST' : 'QUALITY: PRETTY'}
          {tier !== mountTier ? ' (reload for AA)' : ''}
        </button>
      </div>

      <div style={{ ...row, marginBottom: 2 }}>
        <button
          type="button"
          onClick={() => {
            // Cycle the library size. Each step rebuilds the chunk meshes,
            // which takes a second or two -- the pool decides which geometry
            // every hull instance points at, and that is fixed at build time.
            const index = HULL_POOL_CHOICES.indexOf(
              hullPool as (typeof HULL_POOL_CHOICES)[number],
            );
            const next = HULL_POOL_CHOICES[(index + 1) % HULL_POOL_CHOICES.length];
            setHullPoolSize(next);
          }}
          style={{ ...toggleButton, position: 'static', width: '100%' }}
          data-testid="city-hull-pool"
          aria-label="Cycle fracture pattern pool size"
          title="Replaces each unique fracture shard with one of N shared shapes so hulls can be instanced. OFF draws the authored shards exactly; a pool is much faster but an intact wall's shards no longer tile it."
        >
          {hullPool === 0 ? 'SHARDS: EXACT' : `SHARDS: POOL ${hullPool}`}
        </button>
      </div>

      <div style={{ ...row, marginBottom: 2 }}>
        <button
          type="button"
          onClick={() => {
            const next = !shadows;
            setShadowsEnabled(next);
            setShadows(next);
          }}
          style={{ ...toggleButton, position: 'static', width: '100%' }}
          data-testid="city-shadows-toggle"
          aria-label="Toggle shadows"
          title="The city is the bulk of the shadow map; off skips that pass entirely"
        >
          {shadows ? 'SHADOWS: ON' : 'SHADOWS: OFF'}
        </button>
      <button
        style={{ ...toggleButton, position: 'static', width: '100%' }}
        onClick={() => setBodyColors((value) => !value)}
        data-testid="city-body-colors"
      >
        {bodyColors ? 'BODY COLORS: ON' : 'BODY COLORS: OFF'}
      </button>
      {bodyColors && (
        <div style={{ margin: '4px 0 6px' }}>
          {BODY_DEBUG_STATES.map((entry) => (
            <div key={entry.code} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  background: entry.css,
                  display: 'inline-block',
                  borderRadius: 2,
                }}
              />
              <span style={{ opacity: 0.8 }}>{entry.label}</span>
            </div>
          ))}
        </div>
      )}
      </div>

      {/* Which code is actually running. The client hot-reloads and the
          server restarts independently, so a screenshot without both stamps
          cannot be dated -- and reading a metric off a stale build has cost
          this project real time more than once. */}
      <div style={{ ...row, opacity: 0.75, marginTop: 4 }}>
        <span>build srv/cli</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {`${server?.server_build ?? '?'} / ${CLIENT_BUILD}`}
        </span>
      </div>
      <div style={{ ...row, opacity: 0.75 }}>
        <span>srv started</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {server?.server_started ?? '?'}
        </span>
      </div>

      {/*
        The three agreement checks. Every one of these was missing during a
        multi-day hunt where the city silently stopped being destroyed on
        screen while the server kept fracturing, and each would have shown it
        at a glance.
      */}
      <div style={heading}>agreement</div>
      {/* Wire: client and server pick this independently -- the server per
          match, the client from the session config -- and a rebuild used to
          reset the server's half. A mismatch means the client DISCARDS the
          other wire's pose records by design, so the city freezes on screen
          with no error anywhere. */}
      <Stat
        label="wire cli/srv"
        value={`${clientStats?.wireVersion ?? '?'} / ${city?.wire_version ?? '?'}`}
        warn={
          clientStats != null
          && city?.wire_version != null
          && clientStats.wireVersion !== city.wire_version
        }
      />
      {/* Does this client's ledger agree with the simulation? The single most
          diagnostic number here: server climbing while client sits at zero is
          exactly "my shots do nothing". */}
      <Stat
        label="bonds cli/srv"
        value={`${clientStats?.brokenBonds ?? 0} / ${city?.broken_bonds ?? 0}`}
        warn={
          (city?.broken_bonds ?? 0) > 50
          && (clientStats?.brokenBonds ?? 0) < (city?.broken_bonds ?? 0) * 0.9
        }
      />
      {/* Ledger rebuilds. One at join is normal; a climbing count means the
          client keeps losing agreement and asking for a fresh world. */}
      <Stat
        label="bootstraps"
        value={`${clientStats?.bootstraps ?? 0}`}
        warn={(clientStats?.bootstraps ?? 0) > 1}
      />
      <Stat
        label="settle rejects"
        value={`${clientStats?.settleRejects ?? 0}`}
        warn={(clientStats?.settleRejects ?? 0) > 0}
      />
      {/* Freeze churn RATE, not the total. A server that has stopped settling
          anything spins this into the hundreds per second while looking
          otherwise healthy. */}
      <Stat
        label="freeze flips/s"
        value={`${freezeTracker.perSec.toFixed(0)}`}
        warn={freezeTracker.perSec > 200}
      />

      <div style={heading}>browser</div>
      <Stat label="fps" value={frame.fps.toFixed(0)} warn={frame.fps < 45} />
      <Stat label="frame p95" value={`${frame.p95.toFixed(1)} ms`} warn={frame.p95 > 25} />
      <Stat label="chunks drawn" value={`${clientStats?.chunksTotal ?? 0}`} />
      <Stat
        label="chunk update"
        value={`${(clientStats?.chunkUpdateP95Ms ?? 0).toFixed(1)} ms`}
        warn={(clientStats?.chunkUpdateP95Ms ?? 0) > 8}
      />
      {/*
        GPU-load proxies (mobile exposes no GPU timers): triangles in the
        millions means vertex-bound -- the win is geometry LOD / distance
        culling of small debris; high calls means batching; both low with low
        fps means pixel fill or React orchestration.
      */}
      <Stat label="draw calls" value={`${renderStats.drawCalls}`} />
      <Stat
        label="triangles"
        value={`${(renderStats.triangles / 1e6).toFixed(2)} M`}
        warn={renderStats.triangles > 1_500_000}
      />
      <Stat
        label="gl.render"
        value={`${renderStats.glRenderMs.toFixed(1)} ms`}
        warn={renderStats.glRenderMs > 12}
      />
      <Stat label="inst writes" value={`${renderStats.instanceWrites}`} />
      {/* The only thing that makes chunk geometry disappear. A hole opening
          in a building starts here, so it is on screen rather than inferred. */}
      <Stat
        label="chunks hidden"
        value={`${renderStats.chunksHidden}`}
        warn={renderStats.chunksHidden > 0}
      />
      {/* Chunks the ledger could not place. Must be 0: each one is a frame
          where a chunk had no known pose at all. */}
      <Stat
        label="chunks unplaced"
        value={`${renderStats.chunksUnresolved}`}
        warn={renderStats.chunksUnresolved > 0}
      />
      <Stat label="frame total" value={`${renderStats.frameTotalMs.toFixed(1)} ms`} />
      {/*
        cpu frame is the number a worker offload can shrink: frame start
        through the end of gl.render. frame total minus it is vsync idle plus
        whatever ran between frames (decode, below) -- headroom, not work.
        The phases below sum to cpu frame, with "of which" rows indented.
      */}
      <Stat
        label="cpu frame"
        value={`${renderStats.cpuFrameMs.toFixed(1)} ms`}
        warn={renderStats.cpuFrameMs > 12}
      />
      <Stat label="off-frame" value={`${renderStats.offFrameMs.toFixed(1)} ms`} />
      <Stat label="↳ decode" value={`${renderStats.decodeMs.toFixed(1)} ms`} warn={renderStats.decodeMs > 6} />
      <Stat label="world frame" value={`${renderStats.beforeCityMs.toFixed(1)} ms`} warn={renderStats.beforeCityMs > 6} />
      <Stat label="↳ debug/e2e" value={`${renderStats.debugE2eMs.toFixed(1)} ms`} warn={renderStats.debugE2eMs > 3} />
      <Stat label="city frame" value={`${renderStats.cityFrameMs.toFixed(1)} ms`} warn={renderStats.cityFrameMs > 6} />
      <Stat label="↳ sample" value={`${renderStats.sampleMs.toFixed(1)} ms`} />
      <Stat label="↳ dirty write" value={`${renderStats.dirtyWriteMs.toFixed(1)} ms`} />
      <Stat label="↳ spheres" value={`${renderStats.sphereMs.toFixed(1)} ms`} />
      {/* Once every 30 frames; this is the cost of one occurrence. */}
      <Stat label="↳ 2Hz block" value={`${renderStats.telemetryMs.toFixed(1)} ms`} warn={renderStats.telemetryMs > 4} />
      <Stat
        label="unattributed"
        value={`${renderStats.unattributedMs.toFixed(1)} ms`}
        warn={renderStats.unattributedMs > 3}
      />
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
      {/*
        The body population, fully partitioned -- the four rows sum to the
        total, so a gap means something is misclassified.

        awake   what the solver actually simulates this tick. The measured
                knee on this hardware is ~3,000; past it the tick misses 60 Hz.
        asleep  engine-slept dynamics, not yet retired.
        frozen  settled rubble made kinematic and taken out of the solver.
                Costs ~nothing; this rising is the pile-freezing working.
        rooted  kinematic actors still anchored to the ground. NOT one per
                building: every fracture fragment that keeps a support node
                becomes its own rooted actor, so this climbs with damage --
                measured 38 -> 153 over one downtown session. It is the count
                of standing stumps, and it is derived rather than reported so
                that it absorbs any residue and the partition always closes.
      */}
      <Stat label="bodies total" value={`${city?.chunk_bodies ?? 0}`} />
      <Stat
        label="├ awake"
        value={`${city?.awake_bodies ?? 0}`}
        warn={(city?.awake_bodies ?? 0) > 2500}
      />
      <Stat label="├ asleep" value={`${city?.sleeping_bodies ?? 0}`} />
      <Stat
        label="├ frozen"
        value={`${city?.frozen_bodies ?? 0}${
          (city?.chunk_bodies ?? 0) > 0
            ? ` (${Math.round((100 * (city?.frozen_bodies ?? 0)) / (city?.chunk_bodies ?? 1))}%)`
            : ''
        }`}
      />
      <Stat
        label="└ rooted"
        value={`${Math.max(
          0,
          (city?.chunk_bodies ?? 0) -
            (city?.awake_bodies ?? 0) -
            (city?.sleeping_bodies ?? 0) -
            (city?.frozen_bodies ?? 0),
        )}`}
      />
      {/*
        Wake plumbing health. contact wakes = frozen rubble released because
        moving debris struck it (rises during collapses onto old rubble, flat
        at rest). freeze/thaw = cumulative transitions; sustained churn with
        no new damage means the policy is fighting the engine. serial blocks
        must stay zero -- non-zero is identity aliasing.
      */}
      <Stat label="contact wakes" value={`${city?.contact_wakes ?? 0}`} />
      <Stat
        label="freeze / thaw"
        value={`${city?.freeze_flips ?? 0} / ${city?.unfreeze_flips ?? 0}`}
      />
      {(city?.frozen_serial_blocks ?? 0) > 0 && (
        <Stat label="serial blocks" value={`${city?.frozen_serial_blocks}`} warn />
      )}
      <Stat label="broken bonds" value={`${city?.broken_bonds ?? 0}`} />
      <Stat
        label="islands (solver)"
        value={`${clientStats?.liveIslands ?? 0} (${city?.solver_island_count ?? 0})`}
      />
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
      {/* The phases that used to be invisible. ccd + support loads are both
          O(live bodies) every tick and run before the quiet-skip gate, so they
          are paid even by a city with nothing happening in it. */}
      <Stat label="ccd walk" value={`${(city?.ccd_ms ?? 0).toFixed(1)} ms`} warn={(city?.ccd_ms ?? 0) > 1} />
      <Stat
        label="support loads"
        value={`${(city?.support_loads_ms ?? 0).toFixed(1)} ms`}
        warn={(city?.support_loads_ms ?? 0) > 1}
      />
      <Stat label="native readback" value={`${(city?.readback_ms ?? 0).toFixed(1)} ms`} />
      <Stat label="shape readback" value={`${(city?.shape_readback_ms ?? 0).toFixed(1)} ms`} />
      {/* Both are 0.0 on a quiet slot-tick by design -- the topology diff is
          skipped. `quiet ticks` beside them is what tells the two apart from a
          broken measurement. */}
      <Stat label="events" value={`${(city?.events_ms ?? 0).toFixed(2)} ms`} />
      <Stat label="filters" value={`${(city?.filters_ms ?? 0).toFixed(2)} ms`} />
      <Stat label="quiet slot-ticks" value={`${city?.quiet_slot_ticks ?? 0}`} />
      {/* Host bracket around the whole native tick: the parent of the three
          blast rows above, and measurably larger than their sum (per-slot
          dispatch and the topology-diff decision live in the gap). */}
      <Stat label="native tick" value={`${(city?.tick_ffi_ms ?? 0).toFixed(1)} ms`} />
      <Stat label="event drain" value={`${(city?.drain_ms ?? 0).toFixed(1)} ms`} />
      <Stat label="readback" value={`${(city?.readback_ms_host ?? 0).toFixed(1)} ms`} />
      <Stat label="settle scan" value={`${(city?.settle_ms ?? 0).toFixed(1)} ms`} />
      <Stat label="stats ffi" value={`${(city?.stats_ffi_ms ?? 0).toFixed(1)} ms`} warn={(city?.stats_ffi_ms ?? 0) > 2} />
      <Stat
        label="encoder ingest"
        value={`${(city?.ingest_ms ?? 0).toFixed(1)} ms`}
        warn={(city?.ingest_ms ?? 0) > 4}
      />
      {/*
        Everything above is inside the 60 Hz city step, so it sums to it. What
        it does not sum to is the untimed remainder -- the post-fracture push
        re-apply, topology drain and baseline emit. Showing that gap explicitly
        keeps a missing measurement visible instead of silently absorbed into
        "city step is big"; it has run to a quarter of the step under load.
      */}
      <Stat label="↳ unattributed" value={`${cityStepUnattributedMs.toFixed(1)} ms`} warn={cityStepUnattributedMs > 4} />
      {/* Outside the city step but on the same tick thread: broadcasting the
          tick's packets to every viewer, and the once-a-second stats publish
          (JSON per player + a blocking telemetry write) that lands on one
          tick and shows up only as a spike. */}
      <Stat label="fan-out" value={`${(city?.fan_out_ms ?? 0).toFixed(1)} ms`} warn={(city?.fan_out_ms ?? 0) > 2} />
      <Stat label="1Hz publish" value={`${(city?.publish_ms ?? 0).toFixed(1)} ms`} warn={(city?.publish_ms ?? 0) > 8} />
      {/* Every repair means a client's ledger had a hole: it was rendering a
          city that had stopped being destroyed until the server noticed. */}
      <Stat
        label="desync repairs"
        value={`${city?.city_desync_repairs ?? 0}`}
        warn={(city?.city_desync_repairs ?? 0) > 0}
      />
      {/*
        Below here is the SEPARATE 30 Hz stream pass, not part of city step.
        Listed flush with the step's children it invited adding the whole
        column, which double-counts across two tick rates.
      */}
      <Stat label="— stream (30 Hz) —" value="" />
      <Stat
        label="stream encode"
        value={`${(city?.encode_shared_ms ?? 0).toFixed(1)} ms`}
        warn={(city?.encode_shared_ms ?? 0) > 4}
      />
      <Stat
        label="per-client pack"
        value={`${(city?.client_datagrams_ms ?? 0).toFixed(1)} ms`}
        warn={(city?.client_datagrams_ms ?? 0) > 4}
      />
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
    </div>
  );
}
