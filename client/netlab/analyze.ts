/**
 * netlab analyzer: turns one iteration's artifacts (frames.clientK.csv,
 * events.clientK.jsonl, server-stats.jsonl, run.json) into per-defect metrics,
 * gate outcomes, and a layer-attribution verdict.
 *
 * Metric philosophy (ported from destruction-codec): windows of 1 s; gates on
 * the tail of per-window p95 values and on worst frames, never global means.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  ABSOLUTE_GATES,
  CADENCE_GATES,
  PER_MINUTE_GATES,
  evaluateGate,
  type GateOutcome,
} from './thresholds';
import { attribute, type AttributionInput, type ChannelFinding } from './attribute';

const WINDOW_MS = 1000;
const MOVING_SPEED_MPS = 0.5;
const FREEZE_EPSILON_M = 0.001;
const CORRECTION_ONSET_M = 0.15;
const TELEPORT_STEP_M = 0.5;
const REMOTE_TELEPORT_STEP_M = 1.5;
/**
 * Skip the first seconds of a run: spawn placement, initial reconciliation,
 * and the camera settling all read as artifacts but aren't ones anyone sees
 * as netcode faults (same pattern as the vehicle benchmark's 5 s settle).
 */
const SETTLE_MS = 3000;
/** Below this many moving frames, rate metrics are sampling noise — report NaN. */
const MIN_MOVING_FRAMES = 120;

// ---------------------------------------------------------------------------
// Artifact loading
// ---------------------------------------------------------------------------

export interface FrameTable {
  columns: string[];
  rows: number[][];
  col(name: string): number;
}

export function loadFrames(csvPath: string): FrameTable {
  const lines = fs.readFileSync(csvPath, 'utf-8').trimEnd().split('\n');
  const columns = lines[0].split(',');
  const rows = lines.slice(1).map((line) => line.split(',').map(Number));
  const index = new Map(columns.map((c, i) => [c, i]));
  return {
    columns,
    rows,
    col(name: string): number {
      const i = index.get(name);
      if (i === undefined) throw new Error(`missing column ${name} in ${csvPath}`);
      return i;
    },
  };
}

export interface RecorderEventRow {
  tMs: number;
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

export function loadEvents(jsonlPath: string): RecorderEventRow[] {
  if (!fs.existsSync(jsonlPath)) return [];
  return fs
    .readFileSync(jsonlPath, 'utf-8')
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecorderEventRow);
}

interface ServerStatsSample {
  receivedAtMs: number;
  stats: {
    sim_hz: number;
    snapshot_hz: number;
    matches: Array<{
      id: string;
      server_tick: number;
      timings: { total_ms: { avg: number; p95: number; max: number } };
      network: {
        strict_snapshot_drops: number;
        dropped_outbound_snapshots: number;
        malformed_packets: number;
      };
      players: Array<{
        one_way_ms: number;
        pending_inputs: number;
        input_jitter_ms: number;
        correction_m: number;
      }>;
    }>;
  };
}

export function loadServerStats(jsonlPath: string, matchId: string): ServerStatsSample[] {
  if (!fs.existsSync(jsonlPath)) return [];
  const samples: ServerStatsSample[] = [];
  for (const line of fs.readFileSync(jsonlPath, 'utf-8').trimEnd().split('\n')) {
    if (!line) continue;
    const sample = JSON.parse(line) as ServerStatsSample;
    sample.stats.matches = sample.stats.matches.filter((m) => m.id === matchId);
    samples.push(sample);
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function percentile(sortedAsc: number[], f: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.round((sortedAsc.length - 1) * f));
  return sortedAsc[idx];
}

function quantiles(values: number[]): { p50: number; p95: number; p99: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : Number.NaN,
  };
}

/** Tail of per-window p95s: p99 across 1 s windows, plus the global max. */
function windowTail(
  times: number[],
  values: number[],
): { p95P99: number; max: number; windows: number } {
  const windows = new Map<number, number[]>();
  for (let i = 0; i < values.length; i += 1) {
    const bucket = Math.floor(times[i] / WINDOW_MS);
    let arr = windows.get(bucket);
    if (!arr) {
      arr = [];
      windows.set(bucket, arr);
    }
    arr.push(values[i]);
  }
  const windowP95s: number[] = [];
  let max = Number.NaN;
  for (const arr of windows.values()) {
    arr.sort((a, b) => a - b);
    windowP95s.push(percentile(arr, 0.95));
    const m = arr[arr.length - 1];
    if (!(m <= max)) max = Math.max(m, Number.isNaN(max) ? -Infinity : max);
  }
  windowP95s.sort((a, b) => a - b);
  return { p95P99: percentile(windowP95s, 0.99), max, windows: windowP95s.length };
}

function linearSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

// ---------------------------------------------------------------------------
// Per-client metrics
// ---------------------------------------------------------------------------

export interface ClientMetrics {
  clientIndex: number;
  role: string;
  frames: number;
  durationS: number;
  transport: { changes: number };
  fpsMean: number;

  // jitter
  frameGapP99Ms: number;
  frameGapMaxMs: number;
  /** Frames whose true gap exceeded 4x nominal — visible hitches. */
  hitchesPerMin: number;
  hitchCount: number;
  renderAccelRmsP99: number;
  snapshotGapP50Ms: number;
  snapshotGapP95Ms: number;
  snapshotGapMaxMs: number;
  snapshotCadenceMs: number;
  microReversalPct: number;

  // rubber-band
  correctionP95CmP99: number;
  correctionMaxCm: number;
  correctionOnsetsPerMin: number;
  presOffP95CmP99: number;
  presOffMaxCm: number;

  // teleport
  hardSnaps: number;
  staleDropsPerMin: number;
  excessStepP95CmP99: number;
  excessStepMaxCm: number;
  teleportSteps: number;
  clockJumps: number;

  // freeze
  freezePct: number;
  freezeRunMaxMs: number;
  movingFrames: number;

  // latency/sync
  pendingInputsP95: number;
  pendingInputsMax: number;
  pingP95Ms: number;
  clockDriftUsPerS: number;

  /** Destructible city, when the match streams one. */
  city: {
    chunksTotal: number;
    peakAwake: number;
    peakLiveIslands: number;
    peakBrokenBonds: number;
    peakMbps: number;
    steadyMbps: number;
    topoSeqGaps: number;
    chunkUpdateP95MaxMs: number;
    orphanedChunks: number;
    chunksBelowGround: number;
    staleDrawnChunksMax: number;
    /** Standing staleness: the last sample, after streaming has settled. */
    staleDrawnChunksFinal: number;
    floatingSettledIslandsFinal: number;
    /** Biggest live island at peak and at end: does sustained fire break it down? */
    largestIslandChunksPeak: number;
    largestIslandChunksFinal: number;
    /** Frame-gap p99 while >500 bodies were awake, vs while settled. */
    frameGapP99BusyMs: number;
    frameGapP99IdleMs: number;
    busyFrames: number;

    /**
     * Presented-pose anomalies, from the in-page detectors. Counts are exact
     * (the recorder reports totals even when its rate cap thins the samples);
     * magnitudes come from the sampled events.
     */
    anomalies: {
      clockRollbacksPerMin: number;
      clockRollbackMaxTicks: number;
      /** Rollbacks that dropped a correction mid-glide — the visible ones. */
      clockRollbackAbandonedMaxM: number;
      clockRollbacksWithCorrectionPct: number;
      snapsPerMin: number;
      snapMaxM: number;
      implausibleJumpsPerMin: number;
      flickerBodies: number;
      chunkTeleportsPerMin: number;
      chunkTeleportMaxM: number;
      membershipViolations: number;
      migrateMissingDestination: number;
      migrateEmptyDestination: number;
      settleRollbacks: number;
      corruptFrames: number;
      /** Share of snaps that landed while the record stream was at its ceiling. */
      snapsDuringStarvationPct: number;
    };
  } | null;

  // observer view of the watched remote player
  remote: {
    samples: number;
    teleportSteps: number;
    freezePct: number;
    accelRmsP99: number;
  } | null;
}

export function computeClientMetrics(
  frames: FrameTable,
  events: RecorderEventRow[],
  clientIndex: number,
  role: string,
  snapshotHz: number,
): ClientMetrics {
  const t = frames.col('tMs');
  const dt = frames.col('frameDeltaMs');
  const rx = frames.col('renderX');
  const ry = frames.col('renderY');
  const rz = frames.col('renderZ');
  const ax = frames.col('authX');
  const ay = frames.col('authY');
  const az = frames.col('authZ');
  const avx = frames.col('authVelX');
  const avy = frames.col('authVelY');
  const avz = frames.col('authVelZ');
  const corr = frames.col('playerCorrectionM');
  const presOff = frames.col('presOffMag');
  const pending = frames.col('pendingInputs');
  const ping = frames.col('pingMs');
  const clockOff = frames.col('clockOffsetUs');
  const fps = frames.col('fps');
  const remX = frames.col('remoteX');
  const remY = frames.col('remoteY');
  const remZ = frames.col('remoteZ');

  const firstTMs = frames.rows.length > 0 ? frames.rows[0][t] : 0;
  const rows = frames.rows.filter((r) => r[t] >= firstTMs + SETTLE_MS);
  const n = rows.length;
  const durationS = n >= 2 ? (rows[n - 1][t] - rows[0][t]) / 1000 : 0;
  const minutes = Math.max(durationS / 60, 1e-6);

  const times: number[] = [];
  const frameDeltas: number[] = [];
  const accel: number[] = [];
  const accelTimes: number[] = [];
  const corrValues: number[] = [];
  const presOffValues: number[] = [];
  const excessSteps: number[] = [];
  const excessTimes: number[] = [];
  const pendingValues: number[] = [];
  const pingValues: number[] = [];
  const clockTimes: number[] = [];
  const clockValues: number[] = [];
  let microReversals = 0;
  let movingFrames = 0;
  let freezeFrames = 0;
  let freezeRunMs = 0;
  let freezeRunMaxMs = 0;
  let teleportSteps = 0;
  let corrOnsets = 0;
  let clockJumps = 0;
  let fpsSum = 0;

  let prevVx = 0;
  let prevVz = 0;
  let prevAuthDx = 0;
  let prevAuthDz = 0;
  let prevSpeedValid = false;

  for (let i = 0; i < n; i += 1) {
    const row = rows[i];
    times.push(row[t]);
    // Measure the frame gap from the recorder's own timestamps, not the app's
    // frameDeltaMs: GameWorld clamps that to 100 ms so a stalled tab keeps
    // simulating sanely, which also means it cannot report a longer stall.
    frameDeltas.push(i > 0 ? row[t] - rows[i - 1][t] : row[dt]);
    corrValues.push(row[corr]);
    presOffValues.push(row[presOff]);
    pendingValues.push(row[pending]);
    pingValues.push(row[ping]);
    // `fps` in DebugStats is only filled by the debug-overlay hook, so derive
    // it from the frame delta the recorder measures directly.
    fpsSum += row[dt] > 0 ? 1000 / row[dt] : 0;
    if (Number.isFinite(row[clockOff]) && row[clockOff] !== 0) {
      clockTimes.push(row[t] / 1000);
      clockValues.push(row[clockOff]);
    }

    if (i > 0) {
      const dtSec = Math.max(row[dt] / 1000, 1e-4);
      const dx = row[rx] - rows[i - 1][rx];
      const dy = row[ry] - rows[i - 1][ry];
      const dz = row[rz] - rows[i - 1][rz];
      const step = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const authSpeed = Math.sqrt(row[avx] ** 2 + row[avy] ** 2 + row[avz] ** 2);
      // "Moving" must mean the authoritative POSITION advanced, not that the
      // server reported a velocity. A player walked into rubble keeps a 6 m/s
      // desired KCC velocity while going nowhere; comparing that velocity to
      // rendered displacement scores a perfectly-tracking client as frozen.
      const authDx = row[ax] - rows[i - 1][ax];
      const authDy = row[ay] - rows[i - 1][ay];
      const authDz = row[az] - rows[i - 1][az];
      const authStep = Math.sqrt(authDx * authDx + authDy * authDy + authDz * authDz);
      const moving = authSpeed > MOVING_SPEED_MPS && authStep > FREEZE_EPSILON_M;

      // Excess step: displacement beyond what authoritative velocity explains.
      const excess = Math.max(0, step - authSpeed * dtSec * 1.5);
      excessSteps.push(excess * 100);
      excessTimes.push(row[t]);
      if (excess > TELEPORT_STEP_M) teleportSteps += 1;

      if (moving) {
        movingFrames += 1;
        if (step < FREEZE_EPSILON_M) {
          freezeFrames += 1;
          freezeRunMs += row[dt];
          freezeRunMaxMs = Math.max(freezeRunMaxMs, freezeRunMs);
        } else {
          freezeRunMs = 0;
        }
        const vx = dx / dtSec;
        const vz = dz / dtSec;
        // Only count a reversal the CLIENT introduced. Walking over rubble
        // genuinely bounces the player, and the authoritative path reverses
        // too; rendering that faithfully is correct, not jitter. The netcode
        // fault is a direction change the server never commanded.
        if (prevSpeedValid && vx * prevVx + vz * prevVz < 0) {
          const authReversed =
            authDx * prevAuthDx + authDz * prevAuthDz < 0;
          if (!authReversed) microReversals += 1;
        }
        prevVx = vx;
        prevVz = vz;
        prevAuthDx = authDx;
        prevAuthDz = authDz;
        prevSpeedValid = step >= FREEZE_EPSILON_M;
      } else {
        freezeRunMs = 0;
        prevSpeedValid = false;
      }

      // Rendered acceleration (second difference): non-smoothness measure.
      if (i > 1) {
        const pdtSec = Math.max(rows[i - 1][dt] / 1000, 1e-4);
        const pdx = rows[i - 1][rx] - rows[i - 2][rx];
        const pdy = rows[i - 1][ry] - rows[i - 2][ry];
        const pdz = rows[i - 1][rz] - rows[i - 2][rz];
        const ax = dx / dtSec - pdx / pdtSec;
        const ay = dy / dtSec - pdy / pdtSec;
        const az = dz / dtSec - pdz / pdtSec;
        accel.push(Math.sqrt(ax * ax + ay * ay + az * az) / ((dtSec + pdtSec) / 2));
        accelTimes.push(row[t]);
      }

      if (rows[i - 1][corr] < CORRECTION_ONSET_M && row[corr] >= CORRECTION_ONSET_M) {
        corrOnsets += 1;
      }
      const clockStep = Math.abs(row[clockOff] - rows[i - 1][clockOff]);
      if (rows[i - 1][clockOff] !== 0 && clockStep > 16_700) clockJumps += 1;
    }
  }

  // Events share the frames' settle window so the two views agree.
  const settledEvents = events.filter((e) => e.tMs >= firstTMs + SETTLE_MS);
  const snapshotGaps = settledEvents
    .filter((e) => e.type === 'snapshot_received')
    .map((e) => Number(e.data.gapMs))
    .filter(Number.isFinite);
  const staleDrops = settledEvents.filter((e) => e.type === 'stale_drop').length;
  const hardSnaps = settledEvents.filter((e) => e.type === 'hard_snap').length;
  const transportChanges = settledEvents.filter((e) => e.type === 'transport_change').length;

  const gapQ = quantiles(snapshotGaps);
  const frameQ = quantiles(frameDeltas);
  // A periodic hitch is exactly what "I see stutter" means, and it is too rare
  // to move a p99: 15 stalls in 1800 frames is under 1%. Count them instead.
  const nominalFrameMs = frameQ.p50 > 0 ? frameQ.p50 : 16.7;
  const hitchCount = frameDeltas.filter((d) => d > 4 * nominalFrameMs).length;
  const corrTail = windowTail(times, corrValues);
  const presTail = windowTail(times, presOffValues);
  const excessTail = windowTail(excessTimes, excessSteps);
  const accelTail = windowTail(accelTimes, accel);
  const pendingQ = quantiles(pendingValues);
  const pingQ = quantiles(pingValues);

  // Destructible city: peaks matter, not averages — the interesting moment is
  // the collapse, which is a few seconds inside a much longer run.
  let city: ClientMetrics['city'] = null;
  const cityTotalIdx = frames.col('cityChunksTotal');
  if (rows.some((r) => Number.isFinite(r[cityTotalIdx]) && r[cityTotalIdx] > 0)) {
    const awakeIdx = frames.col('cityChunksAwake');
    const maxOf = (name: string): number => {
      let max = 0;
      for (const r of rows) {
        const v = r[frames.col(name)];
        if (Number.isFinite(v) && v > max) max = v;
      }
      return max;
    };
    // Split frame gaps by city load so "does the collapse cost frames?" is
    // answered directly instead of inferred from a run-wide average.
    const busy: number[] = [];
    const idle: number[] = [];
    for (let i = 1; i < rows.length; i += 1) {
      const gap = rows[i][t] - rows[i - 1][t];
      (rows[i][awakeIdx] > 500 ? busy : idle).push(gap);
    }
    const bps = rows.map((r) => r[frames.col('cityBytesPerSecond')]).filter(Number.isFinite);
    const settledBps = rows
      .filter((r) => r[awakeIdx] === 0)
      .map((r) => r[frames.col('cityBytesPerSecond')])
      .filter(Number.isFinite);
    // Exact per-type totals, emitted once at stop(); the rate cap thins the
    // individual samples but never the counts.
    const totalsNote = settledEvents
      .filter((e) => e.type === 'note' && e.data.cityEventTotals)
      .pop();
    const totals = (totalsNote?.data.cityEventTotals ?? {}) as Record<
      string,
      { total: number; suppressed: number }
    >;
    const totalOf = (type: string): number =>
      totals[type]?.total ?? settledEvents.filter((e) => e.type === type).length;
    const magMax = (type: string, field: string): number => {
      let max = 0;
      for (const e of settledEvents) {
        if (e.type !== type) continue;
        const v = Number(e.data[field]);
        if (Number.isFinite(v) && v > max) max = v;
      }
      return max;
    };
    const lastCountOf = (type: string, field: string): number => {
      let last = 0;
      for (const e of settledEvents) {
        if (e.type !== type) continue;
        const v = Number(e.data[field]);
        if (Number.isFinite(v)) last = v;
      }
      return last;
    };

    // Starvation correlation: was the pose stream pinned at its byte ceiling
    // when a body snapped? That separates "budget starved this body until it
    // had to jump" from a topology/migration cause.
    const bpsIdx = frames.col('cityBytesPerSecond');
    const ceilingBps = (10400 * 30) * 0.9;
    const starvedWindows = new Set<number>();
    for (const r of rows) {
      if (r[bpsIdx] >= ceilingBps) starvedWindows.add(Math.floor(r[t] / 1000));
    }
    const snapEvents = settledEvents.filter((e) => e.type === 'city_snap');
    const snapsDuringStarvation = snapEvents.filter((e) =>
      starvedWindows.has(Math.floor(e.tMs / 1000)),
    ).length;

    const uniqueFlickerBodies = new Set(
      settledEvents.filter((e) => e.type === 'city_flicker').map((e) => e.data.body),
    ).size;

    city = {
      chunksTotal: maxOf('cityChunksTotal'),
      peakAwake: maxOf('cityChunksAwake'),
      peakLiveIslands: maxOf('cityLiveIslands'),
      peakBrokenBonds: maxOf('cityBrokenBonds'),
      peakMbps: (Math.max(0, ...bps) * 8) / 1e6,
      steadyMbps: settledBps.length ? (quantiles(settledBps).p50 * 8) / 1e6 : 0,
      topoSeqGaps: maxOf('cityTopoSeqGaps'),
      chunkUpdateP95MaxMs: maxOf('cityChunkUpdateP95Ms'),
      orphanedChunks: maxOf('cityOrphanedChunks'),
      staleDrawnChunksMax: maxOf('cityStaleDrawnChunks'),
      largestIslandChunksPeak: maxOf('cityLargestIslandChunks'),
      largestIslandChunksFinal: (() => {
        const idx = frames.col('cityLargestIslandChunks');
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (Number.isFinite(rows[i][idx])) return rows[i][idx];
        }
        return 0;
      })(),
      floatingSettledIslandsFinal: (() => {
        const idx = frames.col('cityFloatingSettledIslands');
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (Number.isFinite(rows[i][idx])) return rows[i][idx];
        }
        return 0;
      })(),
      staleDrawnChunksFinal: (() => {
        const idx = frames.col('cityStaleDrawnChunks');
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (Number.isFinite(rows[i][idx])) return rows[i][idx];
        }
        return 0;
      })(),
      chunksBelowGround: maxOf('cityChunksBelowGround'),
      frameGapP99BusyMs: busy.length ? quantiles(busy).p99 : Number.NaN,
      frameGapP99IdleMs: idle.length ? quantiles(idle).p99 : Number.NaN,
      busyFrames: busy.length,
      anomalies: {
        clockRollbacksPerMin: totalOf('city_clock_rollback') / minutes,
        clockRollbackMaxTicks: magMax('city_clock_rollback', 'magnitude'),
        clockRollbackAbandonedMaxM: magMax('city_clock_rollback', 'abandonedCorrectionM'),
        clockRollbacksWithCorrectionPct: (() => {
          const sampled = settledEvents.filter((e) => e.type === 'city_clock_rollback');
          if (sampled.length === 0) return 0;
          const withCorrection = sampled.filter(
            (e) => Number(e.data.abandonedCorrectionM) > 0.01,
          ).length;
          return (withCorrection / sampled.length) * 100;
        })(),
        snapsPerMin: totalOf('city_snap') / minutes,
        snapMaxM: magMax('city_snap', 'magnitude'),
        implausibleJumpsPerMin: totalOf('city_implausible_jump') / minutes,
        flickerBodies: uniqueFlickerBodies,
        chunkTeleportsPerMin: totalOf('city_chunk_teleport') / minutes,
        chunkTeleportMaxM: magMax('city_chunk_teleport', 'stepM'),
        membershipViolations: lastCountOf('city_membership', 'violations'),
        migrateMissingDestination: lastCountOf('city_migrate_anomaly', 'missingDestination'),
        migrateEmptyDestination: lastCountOf('city_migrate_anomaly', 'emptyDestination'),
        settleRollbacks: totalOf('city_settle_rollback'),
        corruptFrames: totalOf('city_frame_diag'),
        snapsDuringStarvationPct:
          snapEvents.length > 0 ? (snapsDuringStarvation / snapEvents.length) * 100 : 0,
      },
    };
  }

  // Observer view of the watched remote player.
  let remote: ClientMetrics['remote'] = null;
  const remoteRows = rows.filter((r) => Number.isFinite(r[remX]));
  if (remoteRows.length > 30) {
    let rTeleports = 0;
    let rMoving = 0;
    let rFrozen = 0;
    const rAccel: number[] = [];
    const rAccelTimes: number[] = [];
    for (let i = 1; i < remoteRows.length; i += 1) {
      const cur = remoteRows[i];
      const prev = remoteRows[i - 1];
      const dtSec = Math.max((cur[t] - prev[t]) / 1000, 1e-4);
      const dx = cur[remX] - prev[remX];
      const dy = cur[remY] - prev[remY];
      const dz = cur[remZ] - prev[remZ];
      const step = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (step > REMOTE_TELEPORT_STEP_M) rTeleports += 1;
      // "Moving" from the remote's own recent motion (media speed over 0.5 s).
      const speed = step / dtSec;
      if (speed > MOVING_SPEED_MPS) rMoving += 1;
      else if (i > 2) {
        const lookback = remoteRows[i - 3];
        const lbStep = Math.hypot(cur[remX] - lookback[remX], cur[remY] - lookback[remY], cur[remZ] - lookback[remZ]);
        const lbDt = Math.max((cur[t] - lookback[t]) / 1000, 1e-4);
        if (lbStep / lbDt > MOVING_SPEED_MPS && step < FREEZE_EPSILON_M) rFrozen += 1;
      }
      if (i > 1) {
        const pprev = remoteRows[i - 2];
        const pdtSec = Math.max((prev[t] - pprev[t]) / 1000, 1e-4);
        const ax = dx / dtSec - (prev[remX] - pprev[remX]) / pdtSec;
        const ay = dy / dtSec - (prev[remY] - pprev[remY]) / pdtSec;
        const az = dz / dtSec - (prev[remZ] - pprev[remZ]) / pdtSec;
        rAccel.push(Math.sqrt(ax * ax + ay * ay + az * az) / ((dtSec + pdtSec) / 2));
        rAccelTimes.push(cur[t]);
      }
    }
    remote = {
      samples: remoteRows.length,
      teleportSteps: rTeleports,
      freezePct: rMoving > 0 ? (rFrozen / rMoving) * 100 : 0,
      accelRmsP99: windowTail(rAccelTimes, rAccel).p95P99,
    };
  }

  return {
    clientIndex,
    role,
    frames: n,
    durationS,
    transport: { changes: transportChanges },
    fpsMean: n > 0 ? fpsSum / n : 0,
    frameGapP99Ms: frameQ.p99,
    frameGapMaxMs: frameQ.max,
    hitchesPerMin: hitchCount / minutes,
    hitchCount,
    renderAccelRmsP99: accelTail.p95P99,
    snapshotGapP50Ms: gapQ.p50,
    snapshotGapP95Ms: gapQ.p95,
    snapshotGapMaxMs: gapQ.max,
    snapshotCadenceMs: 1000 / Math.max(snapshotHz, 1),
    // Rates over a handful of moving frames are sampling noise, not signal:
    // report NaN so the gate abstains rather than failing on 1-of-11 frames.
    microReversalPct:
      movingFrames >= MIN_MOVING_FRAMES ? (microReversals / movingFrames) * 100 : Number.NaN,
    correctionP95CmP99: corrTail.p95P99 * 100,
    correctionMaxCm: corrTail.max * 100,
    correctionOnsetsPerMin: corrOnsets / minutes,
    presOffP95CmP99: presTail.p95P99 * 100,
    presOffMaxCm: presTail.max * 100,
    hardSnaps,
    staleDropsPerMin: staleDrops / minutes,
    excessStepP95CmP99: excessTail.p95P99,
    excessStepMaxCm: excessTail.max,
    teleportSteps,
    clockJumps,
    freezePct:
      movingFrames >= MIN_MOVING_FRAMES ? (freezeFrames / movingFrames) * 100 : Number.NaN,
    freezeRunMaxMs,
    movingFrames,
    pendingInputsP95: pendingQ.p95,
    pendingInputsMax: pendingQ.max,
    pingP95Ms: pingQ.p95,
    clockDriftUsPerS: linearSlope(clockTimes, clockValues),
    city,
    remote,
  };
}

// ---------------------------------------------------------------------------
// Server metrics
// ---------------------------------------------------------------------------

export interface ServerMetrics {
  samples: number;
  simHz: number;
  snapshotHz: number;
  tickBudgetMs: number;
  tickP95MaxMs: number;
  tickMaxMs: number;
  strictSnapshotDrops: number;
  droppedOutboundSnapshots: number;
  malformedPackets: number;
  oneWayMaxMs: number;
  inputJitterMaxMs: number;
  serverPendingInputsMax: number;
  /** 1 s buckets (receivedAtMs) where tick p95 exceeded the budget. */
  tickSpikeAtMs: number[];
  /**
   * Whether the server kept real-time pace, measured from server_tick advance
   * versus wall time. A fully stalled server (GC pause, SIGSTOP, starvation)
   * reports healthy tick timings because it cannot measure its own absence --
   * the only trace is ticks that never happened.
   */
  measuredTickHz: number;
  tickDeficitPct: number;
  statsGapMaxMs: number;
}

export function computeServerMetrics(samples: ServerStatsSample[]): ServerMetrics | null {
  const withMatch = samples.filter((s) => s.stats.matches.length > 0);
  if (withMatch.length === 0) return null;
  const first = withMatch[0].stats.matches[0];
  const last = withMatch[withMatch.length - 1].stats.matches[0];
  const simHz = withMatch[0].stats.sim_hz;
  const tickBudgetMs = 1000 / Math.max(simHz, 1);

  let tickP95Max = 0;
  let tickMax = 0;
  let oneWayMax = 0;
  let inputJitterMax = 0;
  let pendingMax = 0;
  let statsGapMax = 0;
  const tickSpikeAtMs: number[] = [];
  for (let i = 0; i < withMatch.length; i += 1) {
    const sample = withMatch[i];
    if (i > 0) {
      statsGapMax = Math.max(statsGapMax, sample.receivedAtMs - withMatch[i - 1].receivedAtMs);
    }
    const m = sample.stats.matches[0];
    tickP95Max = Math.max(tickP95Max, m.timings.total_ms.p95);
    tickMax = Math.max(tickMax, m.timings.total_ms.max);
    if (m.timings.total_ms.p95 > tickBudgetMs) tickSpikeAtMs.push(sample.receivedAtMs);
    for (const p of m.players) {
      oneWayMax = Math.max(oneWayMax, p.one_way_ms);
      inputJitterMax = Math.max(inputJitterMax, p.input_jitter_ms);
      pendingMax = Math.max(pendingMax, p.pending_inputs);
    }
  }

  const wallSpanMs = withMatch[withMatch.length - 1].receivedAtMs - withMatch[0].receivedAtMs;
  const tickSpan = last.server_tick - first.server_tick;
  const measuredTickHz = wallSpanMs > 0 ? (tickSpan / wallSpanMs) * 1000 : Number.NaN;
  const tickDeficitPct = Number.isFinite(measuredTickHz)
    ? Math.max(0, (1 - measuredTickHz / simHz) * 100)
    : Number.NaN;

  return {
    samples: withMatch.length,
    simHz,
    snapshotHz: withMatch[0].stats.snapshot_hz,
    tickBudgetMs,
    measuredTickHz,
    tickDeficitPct,
    statsGapMaxMs: statsGapMax,
    tickP95MaxMs: tickP95Max,
    tickMaxMs: tickMax,
    strictSnapshotDrops: last.network.strict_snapshot_drops - first.network.strict_snapshot_drops,
    droppedOutboundSnapshots:
      last.network.dropped_outbound_snapshots - first.network.dropped_outbound_snapshots,
    malformedPackets: last.network.malformed_packets - first.network.malformed_packets,
    oneWayMaxMs: oneWayMax,
    inputJitterMaxMs: inputJitterMax,
    serverPendingInputsMax: pendingMax,
    tickSpikeAtMs,
  };
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

export function evaluateClientGates(m: ClientMetrics): GateOutcome[] {
  const outcomes: GateOutcome[] = [];
  const abs = (metric: string, value: number): void => {
    outcomes.push(evaluateGate(metric, value, ABSOLUTE_GATES[metric] ?? null));
  };
  abs('frameGapP99Ms', m.frameGapP99Ms);
  abs('frameGapMaxMs', m.frameGapMaxMs);
  abs('hitchesPerMin', m.hitchesPerMin);
  abs('microReversalPct', m.microReversalPct);
  abs('correctionP95CmP99', m.correctionP95CmP99);
  abs('correctionMaxCm', m.correctionMaxCm);
  abs('correctionOnsetsPerMin', m.correctionOnsetsPerMin);
  abs('excessStepP95CmP99', m.excessStepP95CmP99);
  abs('teleportSteps', m.teleportSteps);
  abs('freezePct', m.freezePct);
  abs('freezeRunMaxMs', m.freezeRunMaxMs);
  abs('hardSnaps', m.hardSnaps);
  abs('pendingInputsP95', m.pendingInputsP95);
  abs('clockJumps', m.clockJumps);
  if (m.remote) {
    abs('remoteTeleportSteps', m.remote.teleportSteps);
    abs('remoteFreezePct', m.remote.freezePct);
  }
  if (m.city) {
    outcomes.push(evaluateGate('cityPeakMbps', m.city.peakMbps, ABSOLUTE_GATES.cityPeakMbps));
    outcomes.push(evaluateGate('citySettledMbps', m.city.steadyMbps, ABSOLUTE_GATES.citySettledMbps));
    outcomes.push(evaluateGate('cityTopoSeqGaps', m.city.topoSeqGaps, ABSOLUTE_GATES.cityTopoSeqGaps));
    outcomes.push(
      evaluateGate('cityChunkUpdateP95MaxMs', m.city.chunkUpdateP95MaxMs, ABSOLUTE_GATES.cityChunkUpdateP95MaxMs),
    );
    outcomes.push(
      evaluateGate('cityOrphanedChunks', m.city.orphanedChunks, ABSOLUTE_GATES.cityOrphanedChunks),
    );
    outcomes.push(
      evaluateGate('cityChunksBelowGround', m.city.chunksBelowGround, ABSOLUTE_GATES.cityChunksBelowGround),
    );
    const a = m.city.anomalies;
    const gate = (metric: string, value: number): void => {
      outcomes.push(evaluateGate(metric, value, ABSOLUTE_GATES[metric] ?? null));
    };
    gate('cityMembershipViolations', a.membershipViolations);
    gate('cityMigrateAnomalies', a.migrateMissingDestination + a.migrateEmptyDestination);
    gate('citySettleRollbacks', a.settleRollbacks);
    gate('cityCorruptFrames', a.corruptFrames);
    outcomes.push(evaluateGate('cityStaleDrawnChunks', m.city.staleDrawnChunksFinal, ABSOLUTE_GATES.cityStaleDrawnChunks));
    gate('cityChunkTeleportsPerMin', a.chunkTeleportsPerMin);
    gate('cityClockRollbacksPerMin', a.clockRollbacksPerMin);
    gate('citySnapsPerMin', a.snapsPerMin);
  }
  for (const [metric, gate] of Object.entries(CADENCE_GATES)) {
    const value = metric === 'snapshotGapP95Ms' ? m.snapshotGapP95Ms : m.snapshotGapMaxMs;
    outcomes.push(
      evaluateGate(metric, value, {
        warn: gate.warn * m.snapshotCadenceMs,
        fail: gate.fail * m.snapshotCadenceMs,
        unit: 'ms',
        description: gate.description,
      }),
    );
  }
  outcomes.push(
    evaluateGate('staleDropsPerMin', m.staleDropsPerMin, PER_MINUTE_GATES.staleDropsPerMin),
  );
  return outcomes;
}

// ---------------------------------------------------------------------------
// Iteration analysis
// ---------------------------------------------------------------------------

export interface IterationVerdict {
  iterDir: string;
  runInfo: Record<string, unknown>;
  clients: Array<{
    metrics: ClientMetrics;
    gates: GateOutcome[];
    failCount: number;
    warnCount: number;
  }>;
  server: ServerMetrics | null;
  attribution: ChannelFinding[];
  taggedEvents: Array<{ tMs: number; type: string; magnitude: number; proximateCause: string }>;
}

export function analyzeIteration(iterDir: string): IterationVerdict {
  const runInfo = JSON.parse(fs.readFileSync(path.join(iterDir, 'run.json'), 'utf-8')) as {
    matchId: string;
    clients: Array<{ index: number; role: string }>;
  };

  const serverSamples = loadServerStats(path.join(iterDir, 'server-stats.jsonl'), runInfo.matchId);
  const server = computeServerMetrics(serverSamples);
  const snapshotHz = server?.snapshotHz ?? 30;

  const clients: IterationVerdict['clients'] = [];
  const allEvents: Array<{ events: RecorderEventRow[]; metrics: ClientMetrics }> = [];
  for (const clientInfo of runInfo.clients as Array<{
    index: number;
    role: string;
    resyncDivergentChunks?: number | null;
  }>) {
    const framesPath = path.join(iterDir, `frames.client${clientInfo.index}.csv`);
    if (!fs.existsSync(framesPath)) continue;
    const frames = loadFrames(framesPath);
    const events = loadEvents(path.join(iterDir, `events.client${clientInfo.index}.jsonl`));
    const metrics = computeClientMetrics(
      frames,
      events,
      clientInfo.index,
      clientInfo.role,
      snapshotHz,
    );
    const gates = evaluateClientGates(metrics);
    if (metrics.city && clientInfo.resyncDivergentChunks !== undefined && clientInfo.resyncDivergentChunks !== null) {
      // -1 encodes "forced resync never answered" — as severe as divergence.
      const value = clientInfo.resyncDivergentChunks < 0 ? 9999 : clientInfo.resyncDivergentChunks;
      gates.push(
        evaluateGate('cityResyncDivergentChunks', value, ABSOLUTE_GATES.cityResyncDivergentChunks),
      );
    }
    clients.push({
      metrics,
      gates,
      failCount: gates.filter((g) => g.verdict === 'fail').length,
      warnCount: gates.filter((g) => g.verdict === 'warn').length,
    });
    allEvents.push({ events, metrics });
  }

  const attributionInput: AttributionInput = {
    clients: clients.map((c) => c.metrics),
    server,
    impairment: (runInfo as { impairment?: { profile: string | null; mode: string } }).impairment ?? null,
  };
  const attribution = attribute(attributionInput);

  // Per-event proximate-cause tagging: for each visible artifact event, look
  // back 600 ms for a snapshot gap spike, and at the covering second for a
  // server tick spike. This is what makes the layer verdict trustworthy.
  const taggedEvents: IterationVerdict['taggedEvents'] = [];
  for (const { events, metrics } of allEvents) {
    const gapSpikes = events.filter(
      (e) => e.type === 'snapshot_received' && Number(e.data.gapMs) > 2 * metrics.snapshotCadenceMs,
    );
    const artifacts = events.filter((e) => e.type === 'hard_snap' || e.type === 'correction');
    const runStartWallMs = Date.parse(String((runInfo as { startedAtIso?: string }).startedAtIso));
    for (const artifact of artifacts) {
      const gapBefore = gapSpikes.find(
        (g) => g.tMs <= artifact.tMs && artifact.tMs - g.tMs < 600,
      );
      let cause = 'unknown';
      if (gapBefore) cause = `network (snapshot gap ${Number(gapBefore.data.gapMs).toFixed(0)}ms)`;
      else if (server && Number.isFinite(runStartWallMs)) {
        // Recorder tMs is page-relative; align approximately via run start.
        const wallMs = runStartWallMs + artifact.tMs;
        const spike = server.tickSpikeAtMs.find((s) => Math.abs(s - wallMs) < 1500);
        if (spike) cause = 'server (tick over budget in that second)';
      }
      taggedEvents.push({
        tMs: artifact.tMs,
        type: artifact.type,
        magnitude: Number(artifact.data.magM ?? artifact.data.distM ?? 0),
        proximateCause: cause,
      });
    }
  }

  return { iterDir, runInfo, clients, server, attribution, taggedEvents };
}
