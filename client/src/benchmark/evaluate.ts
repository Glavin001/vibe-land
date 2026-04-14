import { describeBottleneck, maxPendingInputs, totalPhysicsP95, webTransportSnapshotFallbackRatio, type MatchStatsSnapshot } from '../loadtest/serverStats';
import type {
  BenchmarkMeasuredWindow,
  BenchmarkObservedMetrics,
  BenchmarkScenarioResult,
  ThresholdOutcome,
} from './contracts';
import type { BenchmarkScenarioSpec, BenchmarkThresholdBand } from './spec';

function worstByTick(samples: MatchStatsSnapshot[]): MatchStatsSnapshot | null {
  if (samples.length === 0) return null;
  return samples.reduce((worst, sample) =>
    sample.timings.total_ms.p95 > worst.timings.total_ms.p95 ? sample : worst,
  );
}

function maxValue(samples: MatchStatsSnapshot[], select: (sample: MatchStatsSnapshot) => number): number {
  return samples.reduce((max, sample) => Math.max(max, select(sample)), 0);
}

function deltaValue(samples: MatchStatsSnapshot[], select: (sample: MatchStatsSnapshot) => number): number {
  if (samples.length === 0) {
    return 0;
  }
  const first = select(samples[0]);
  const last = select(samples[samples.length - 1]);
  return Math.max(0, last - first);
}

export function buildMeasuredWindow(
  matchId: string,
  samples: Array<{ at: string; match: MatchStatsSnapshot }>,
  simHz: number,
): BenchmarkMeasuredWindow {
  const matches = samples.map((sample) => sample.match);
  const representativeMatch = worstByTick(matches);
  const firstSampleAt = samples[0]?.at ?? null;
  const lastSampleAt = samples.length > 0 ? samples[samples.length - 1].at : null;
  const peakMetrics: BenchmarkObservedMetrics = {
    tickP95Ms: maxValue(matches, (sample) => sample.timings.total_ms.p95),
    totalPhysicsP95Ms: maxValue(matches, (sample) => totalPhysicsP95(sample)),
    playerMovementP95Ms: maxValue(matches, (sample) => sample.timings.player_sim_ms.p95),
    playerKccP95Ms: maxValue(matches, (sample) => sample.timings.player_kcc_ms.p95),
    dynamicsP95Ms: maxValue(matches, (sample) => sample.timings.dynamics_ms.p95),
    snapshotEncodeP95Ms: maxValue(matches, (sample) => sample.timings.snapshot_ms.p95),
    snapshotBytesPerClientP95: maxValue(matches, (sample) => sample.network.snapshot_bytes_per_client.p95),
    snapshotBytesPerTickP95: maxValue(matches, (sample) => sample.network.snapshot_bytes_per_tick.p95),
    bodiesPerClientP95: maxValue(matches, (sample) => sample.network.snapshot_dynamic_bodies_per_client.p95),
    wtReliableRatio: maxValue(matches, (sample) => webTransportSnapshotFallbackRatio(sample)),
    datagramFallbacks: deltaValue(matches, (sample) => sample.network.datagram_fallbacks),
    strictSnapshotDrops: deltaValue(matches, (sample) => sample.network.strict_snapshot_drops),
    maxPendingInputs: maxValue(matches, (sample) => maxPendingInputs(sample)),
    avgPendingInputs: maxValue(matches, (sample) =>
      sample.players.length > 0
        ? sample.players.reduce((sum, player) => sum + player.pending_inputs, 0) / sample.players.length
        : 0,
    ),
    deadPlayersSkippedP95: maxValue(matches, (sample) => sample.network.dead_players_skipped.p95),
    voidKills: deltaValue(matches, (sample) => sample.load.void_kills),
  };

  return {
    matchId,
    sampleCount: samples.length,
    firstSampleAt,
    lastSampleAt,
    peakMetrics,
    representativeMatch,
    bottleneck: representativeMatch ? describeBottleneck(representativeMatch, simHz) : 'no samples captured',
  };
}

function evaluateBand(metric: string, actual: number, band: BenchmarkThresholdBand): ThresholdOutcome {
  let verdict: ThresholdOutcome['verdict'] = 'pass';
  if (band.comparator === 'upper') {
    if (actual > band.fail) verdict = 'fail';
    else if (actual > band.warn) verdict = 'warn';
  } else {
    if (actual < band.fail) verdict = 'fail';
    else if (actual < band.warn) verdict = 'warn';
  }
  return {
    metric,
    actual,
    warn: band.warn,
    fail: band.fail,
    comparator: band.comparator,
    verdict,
  };
}

export function evaluateScenario(
  spec: BenchmarkScenarioSpec,
  measuredWindow: BenchmarkMeasuredWindow,
  connectedRatio: number,
  anomalies: string[],
  browserConsoleErrors: string[],
  browserPageErrors: string[],
): Pick<BenchmarkScenarioResult, 'thresholdOutcomes' | 'verdict' | 'anomalies'> {
  const metrics = measuredWindow.peakMetrics;
  const outcomes: ThresholdOutcome[] = [
    evaluateBand('tick_p95_ms', metrics.tickP95Ms, spec.thresholds.tickP95Ms),
    evaluateBand('player_kcc_p95_ms', metrics.playerKccP95Ms, spec.thresholds.playerKccP95Ms),
    evaluateBand('dynamics_p95_ms', metrics.dynamicsP95Ms, spec.thresholds.dynamicsP95Ms),
    evaluateBand(
      'snapshot_bytes_per_client_p95',
      metrics.snapshotBytesPerClientP95,
      spec.thresholds.snapshotBytesPerClientP95,
    ),
    evaluateBand('wt_reliable_ratio', metrics.wtReliableRatio, spec.thresholds.wtReliableRatio),
    evaluateBand('datagram_fallbacks', metrics.datagramFallbacks, spec.thresholds.datagramFallbacks),
    evaluateBand('strict_snapshot_drops', metrics.strictSnapshotDrops, spec.thresholds.strictSnapshotDrops),
    evaluateBand('max_pending_inputs', metrics.maxPendingInputs, spec.thresholds.maxPendingInputs),
    evaluateBand('connected_ratio', connectedRatio, spec.thresholds.connectedRatio),
    evaluateBand('dead_players_skipped_p95', metrics.deadPlayersSkippedP95, spec.thresholds.deadPlayersSkippedP95),
    evaluateBand('void_kills', metrics.voidKills, spec.thresholds.voidKills),
  ];

  const derivedAnomalies = [...anomalies];
  if (measuredWindow.sampleCount === 0) {
    derivedAnomalies.push('Invalid benchmark: no /ws/stats samples captured during the measurement window.');
  }
  if (browserConsoleErrors.length > 0) {
    derivedAnomalies.push(`${browserConsoleErrors.length} browser console error(s) captured.`);
  }
  if (browserPageErrors.length > 0) {
    derivedAnomalies.push(`${browserPageErrors.length} browser page error(s) captured.`);
  }

  const invalidBenchmark = derivedAnomalies.some((anomaly) => anomaly.startsWith('Invalid benchmark:'));
  const verdict = outcomes.some((outcome) => outcome.verdict === 'fail') || invalidBenchmark
    ? 'fail'
    : outcomes.some((outcome) => outcome.verdict === 'warn') || derivedAnomalies.length > 0
      ? 'warn'
      : 'pass';

  return {
    thresholdOutcomes: outcomes,
    verdict,
    anomalies: derivedAnomalies,
  };
}
