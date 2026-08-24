/**
 * Gate tables for netlab metrics, destruction-codec style: gates sit on
 * frame-tail values (p99 of per-window p95) and worst-frame values, never on
 * global means — a good average hides a visible lurch.
 *
 * Baseline gates assume an unimpaired local link. Under an induced impairment
 * profile the report still evaluates them but labels the run impaired; the
 * interesting question there is attribution, not pass/fail.
 */

export type Verdict = 'pass' | 'warn' | 'fail';

export interface Gate {
  /** Inclusive warn threshold; exceeding it yields at least 'warn'. */
  warn: number;
  /** Inclusive fail threshold. */
  fail: number;
  unit: string;
  description: string;
}

export interface GateOutcome {
  metric: string;
  value: number;
  verdict: Verdict;
  gate: Gate | null;
}

export function evaluateGate(metric: string, value: number, gate: Gate | null): GateOutcome {
  if (!gate || !Number.isFinite(value)) return { metric, value, verdict: 'pass', gate };
  const verdict: Verdict = value >= gate.fail ? 'fail' : value >= gate.warn ? 'warn' : 'pass';
  return { metric, value, verdict, gate };
}

/** Gates whose thresholds are absolute. */
export const ABSOLUTE_GATES: Record<string, Gate> = {
  frameGapP99Ms: {
    warn: 25, fail: 50, unit: 'ms',
    description: 'p99 requestAnimationFrame delta (vsync-quantised; big values = render stalls)',
  },
  frameGapMaxMs: {
    warn: 100, fail: 250, unit: 'ms',
    description: 'worst frame delta',
  },
  hitchesPerMin: {
    warn: 2, fail: 10, unit: '/min',
    description: 'frames taking >4x the nominal frame time — visible hitches (too rare to move a p99)',
  },
  microReversalPct: {
    warn: 0.5, fail: 2, unit: '%',
    description: 'moving frames whose rendered velocity opposes the previous frame',
  },
  // CALIBRATION: two back-to-back unimpaired `city-strafe` runs (Rapier
  // full-prediction, 30 Hz snapshots, local link) measured correction tails of
  // 13.9-21.5 cm, worst frames of 20.7-37.0 cm, and 4.7-7.1 onsets/min. That
  // spread is the A/A noise floor, not signal, so these gates sit above it —
  // otherwise every clean run reports a rubber-band fault. For reference, the
  // same scenario under the `lte` profile read 38 cm / 57 cm / 291 per min.
  // Re-derive these if the movement mode or snapshot rate changes.
  correctionP95CmP99: {
    warn: 25, fail: 40, unit: 'cm',
    description: 'p99 over 1s windows of the window-p95 reconciliation correction',
  },
  correctionMaxCm: {
    warn: 45, fail: 300, unit: 'cm',
    description: 'worst single-frame correction (300 cm = the hard-snap threshold)',
  },
  correctionOnsetsPerMin: {
    warn: 12, fail: 30, unit: '/min',
    description: 'rate of corrections rising past the 0.15 m visibility threshold',
  },
  excessStepP95CmP99: {
    warn: 2, fail: 10, unit: 'cm',
    description: 'p99 over windows of window-p95 rendered displacement beyond what authoritative velocity explains',
  },
  teleportSteps: {
    warn: 1, fail: 1, unit: 'count',
    description: 'frames whose rendered step exceeded authoritative velocity by >50 cm',
  },
  freezePct: {
    warn: 1, fail: 5, unit: '%',
    description: 'moving frames where the render stood still while authoritative velocity > 0.5 m/s',
  },
  freezeRunMaxMs: {
    warn: 100, fail: 250, unit: 'ms',
    description: 'longest continuous freeze while moving',
  },
  hardSnaps: {
    warn: 1, fail: 1, unit: 'count',
    description: 'prediction hard snaps (replay error > 3 m): visible teleports',
  },
  pendingInputsP95: {
    warn: 8, fail: 20, unit: 'inputs',
    description: 'p95 unacked input backlog (catch-up dropping starts at 3-4 ticks)',
  },
  clockJumps: {
    warn: 1, fail: 3, unit: 'count',
    description: 'clock-offset steps larger than one sim tick between frames (resync-shaped)',
  },
  remoteTeleportSteps: {
    warn: 1, fail: 1, unit: 'count',
    description: 'observer: watched player jumped >1.5 m in a single frame',
  },
  // Destructible city. Bandwidth ceilings are the project's own, from
  // client/e2e/specs/city-destruction.spec.ts (BURST 4.0 / STEADY 2.5 Mbps).
  // The encoder's byte ceiling is a cap, never a fill target, so sitting near
  // it means clients are being starved of records, not served well.
  cityPeakMbps: {
    warn: 4, fail: 6, unit: 'Mbps',
    description: 'peak city chunk-stream bandwidth during collapse (project burst ceiling: 4.0)',
  },
  citySettledMbps: {
    warn: 0.1, fail: 0.5, unit: 'Mbps',
    description: 'city bandwidth once every body is asleep — should approach zero, not idle-chatter',
  },
  cityTopoSeqGaps: {
    warn: 1, fail: 1, unit: 'count',
    description: 'missed topology sequence numbers — the client\'s structure model has diverged from the server\'s',
  },
  cityChunkUpdateP95MaxMs: {
    warn: 4, fail: 8, unit: 'ms',
    description: 'worst per-frame cost of recomposing chunk transforms (layer-scoped, not vsync-quantised)',
  },
  cityOrphanedChunks: {
    warn: 1, fail: 1, unit: 'count',
    description: 'chunks whose owning body vanished from the ledger — must be 0',
  },
  cityChunksBelowGround: {
    warn: 1, fail: 20, unit: 'count',
    description: 'chunks sunk below the ground plane at y=0',
  },
  // Per-chunk pose anomalies during collapse. The count-based ones are
  // correctness invariants — any non-zero value is a defect, not a budget.
  cityMembershipViolations: {
    warn: 1, fail: 1, unit: 'count',
    description: 'chunkBody[slot] and the owning body\'s chunkSlots disagree — shadow members whose offsets rot in a dead frame',
  },
  cityMigrateAnomalies: {
    warn: 1, fail: 1, unit: 'count',
    description: 'migrations the ledger could not apply correctly (missing or empty destination island)',
  },
  citySettleRollbacks: {
    warn: 1, fail: 1, unit: 'count',
    description: 'a pre-settle pose applied to a body after it woke — a visible rollback',
  },
  cityCorruptFrames: {
    warn: 1, fail: 1, unit: 'count',
    description: 'small islands whose members sit further apart than the island could span',
  },
  // Rate-based ones are calibrated against the measured collapse floor.
  cityStaleDrawnChunks: {
    warn: 1, fail: 20, unit: 'count',
    description: 'chunks still drawn >0.5 m from the ledger at run end — standing screen staleness (in-flight transients are excluded by gating the final sample)',
  },
  cityResyncDivergentChunks: {
    // CALIBRATION FINDING (2026-08-17): an UNTOUCHED city already reads ~3,900
    // "divergent" chunks at 7-47 cm — a systematic difference between the
    // live-streamed and bootstrap/reset pose-composition conventions, equal on
    // every client, invisible in play. Until that convention gap is
    // root-caused the differential cannot hard-gate; it still catches gross
    // divergence (a truly desynced client reads far above this floor).
    warn: 4200, fail: 8000, unit: 'count',
    description: 'chunks that moved when a forced resync replaced the ledger (known systematic floor ~3,900 from composition-convention mismatch; see thresholds.ts note)',
  },
  cityChunkTeleportsPerMin: {
    warn: 5, fail: 30, unit: '/min',
    description: 'chunk transforms that moved >1.5 m in a single frame',
  },
  cityClockRollbacksPerMin: {
    warn: 60, fail: 300, unit: '/min',
    description: 'render time moved backwards, rewinding a body\'s pose without smoothing',
  },
  citySnapsPerMin: {
    warn: 10, fail: 60, unit: '/min',
    description: 'corrections abandoned as too large — the body hard-snaps onto the new path',
  },
  remoteFreezePct: {
    warn: 2, fail: 8, unit: '%',
    description: 'observer: watched player frozen between position updates while in motion overall',
  },
};

/** Gates expressed as multiples of the expected snapshot cadence (1000/snapshot_hz). */
export const CADENCE_GATES: Record<string, { warn: number; fail: number; description: string }> = {
  snapshotGapP95Ms: {
    warn: 2, fail: 4,
    description: 'p95 snapshot inter-arrival gap, as a multiple of the nominal cadence',
  },
  snapshotGapMaxMs: {
    warn: 6, fail: 15,
    description: 'worst snapshot gap, as a multiple of the nominal cadence',
  },
};

/** Rates gated per minute of run time. */
export const PER_MINUTE_GATES: Record<string, Gate> = {
  staleDropsPerMin: {
    warn: 2, fail: 30, unit: '/min',
    description: 'snapshots discarded as stale/out-of-order (reordering or duplicated delivery)',
  },
};
