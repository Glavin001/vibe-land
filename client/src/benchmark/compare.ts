import type { BenchmarkScenarioResult, BenchmarkSuiteResult } from './contracts';

type ScenarioComparison = {
  scenarioName: string;
  baseline: BenchmarkScenarioResult;
  candidate: BenchmarkScenarioResult;
  tickDeltaMs: number;
  playerKccDeltaMs: number;
  snapshotDeltaBytes: number;
  wtReliableDelta: number;
  verdictChanged: boolean;
};

function pairScenarios(
  baseline: BenchmarkSuiteResult,
  candidate: BenchmarkSuiteResult,
): ScenarioComparison[] {
  const baselineByName = new Map(baseline.results.map((result) => [result.scenarioName, result]));
  const candidateByName = new Map(candidate.results.map((result) => [result.scenarioName, result]));
  const names = Array.from(new Set([...baselineByName.keys(), ...candidateByName.keys()])).sort();
  const comparisons: ScenarioComparison[] = [];
  for (const name of names) {
    const base = baselineByName.get(name);
    const next = candidateByName.get(name);
    if (!base || !next) {
      continue;
    }
    comparisons.push({
      scenarioName: name,
      baseline: base,
      candidate: next,
      tickDeltaMs: next.measuredWindow.peakMetrics.tickP95Ms - base.measuredWindow.peakMetrics.tickP95Ms,
      playerKccDeltaMs: next.measuredWindow.peakMetrics.playerKccP95Ms - base.measuredWindow.peakMetrics.playerKccP95Ms,
      snapshotDeltaBytes:
        next.measuredWindow.peakMetrics.snapshotBytesPerClientP95 - base.measuredWindow.peakMetrics.snapshotBytesPerClientP95,
      wtReliableDelta:
        next.measuredWindow.peakMetrics.wtReliableRatio - base.measuredWindow.peakMetrics.wtReliableRatio,
      verdictChanged: base.verdict !== next.verdict,
    });
  }
  return comparisons;
}

function formatDelta(value: number, suffix = ''): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}${suffix}`;
}

function mostPositive<T>(items: T[], select: (item: T) => number): T | null {
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => select(b) - select(a));
  return select(sorted[0]) > 0 ? sorted[0] : null;
}

function mostNegative<T>(items: T[], select: (item: T) => number): T | null {
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => select(a) - select(b));
  return select(sorted[0]) < 0 ? sorted[0] : null;
}

export function renderSuiteComparisonMarkdown(
  baseline: BenchmarkSuiteResult,
  candidate: BenchmarkSuiteResult,
): string {
  const comparisons = pairScenarios(baseline, candidate);
  const worstTickRegression = mostPositive(comparisons, (comparison) => comparison.tickDeltaMs);
  const worstKccRegression = mostPositive(comparisons, (comparison) => comparison.playerKccDeltaMs);
  const worstSnapshotRegression = mostPositive(comparisons, (comparison) => comparison.snapshotDeltaBytes);
  const bestTickImprovement = mostNegative(comparisons, (comparison) => comparison.tickDeltaMs);
  const bestKccImprovement = mostNegative(comparisons, (comparison) => comparison.playerKccDeltaMs);
  const bestSnapshotImprovement = mostNegative(comparisons, (comparison) => comparison.snapshotDeltaBytes);

  const lines = [
    '# vibe-land benchmark comparison',
    '',
    `baseline: ${baseline.generatedAt} (${baseline.suiteName})`,
    `candidate: ${candidate.generatedAt} (${candidate.suiteName})`,
    '',
    '| Scenario | Baseline | Candidate | Tick Δ | KCC Δ | Snapshot/client Δ | WT reliable Δ |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...comparisons.map((comparison) =>
      `| ${comparison.scenarioName} | ${comparison.baseline.verdict.toUpperCase()} | ${comparison.candidate.verdict.toUpperCase()} | ${formatDelta(comparison.tickDeltaMs, 'ms')} | ${formatDelta(comparison.playerKccDeltaMs, 'ms')} | ${formatDelta(comparison.snapshotDeltaBytes, ' B')} | ${formatDelta(comparison.wtReliableDelta * 100, '%')} |`,
    ),
  ];

  if (worstTickRegression || worstKccRegression || worstSnapshotRegression) {
    lines.push('', '## Biggest Regressions', '');
    if (worstTickRegression) {
      lines.push(`- Tick p95: ${worstTickRegression.scenarioName} (${formatDelta(worstTickRegression.tickDeltaMs, 'ms')})`);
    }
    if (worstKccRegression) {
      lines.push(`- Player KCC p95: ${worstKccRegression.scenarioName} (${formatDelta(worstKccRegression.playerKccDeltaMs, 'ms')})`);
    }
    if (worstSnapshotRegression) {
      lines.push(`- Snapshot/client p95: ${worstSnapshotRegression.scenarioName} (${formatDelta(worstSnapshotRegression.snapshotDeltaBytes, ' B')})`);
    }
  }

  if (bestTickImprovement || bestKccImprovement || bestSnapshotImprovement) {
    lines.push('', '## Biggest Improvements', '');
    if (bestTickImprovement) {
      lines.push(`- Tick p95: ${bestTickImprovement.scenarioName} (${formatDelta(bestTickImprovement.tickDeltaMs, 'ms')})`);
    }
    if (bestKccImprovement) {
      lines.push(`- Player KCC p95: ${bestKccImprovement.scenarioName} (${formatDelta(bestKccImprovement.playerKccDeltaMs, 'ms')})`);
    }
    if (bestSnapshotImprovement) {
      lines.push(`- Snapshot/client p95: ${bestSnapshotImprovement.scenarioName} (${formatDelta(bestSnapshotImprovement.snapshotDeltaBytes, ' B')})`);
    }
  }

  return lines.join('\n');
}
