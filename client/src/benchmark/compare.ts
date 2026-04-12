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

export function renderSuiteComparisonMarkdown(
  baseline: BenchmarkSuiteResult,
  candidate: BenchmarkSuiteResult,
): string {
  const comparisons = pairScenarios(baseline, candidate);
  const worstTickRegression = [...comparisons].sort((a, b) => b.tickDeltaMs - a.tickDeltaMs)[0] ?? null;
  const worstKccRegression = [...comparisons].sort((a, b) => b.playerKccDeltaMs - a.playerKccDeltaMs)[0] ?? null;
  const worstSnapshotRegression = [...comparisons].sort((a, b) => b.snapshotDeltaBytes - a.snapshotDeltaBytes)[0] ?? null;

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

  return lines.join('\n');
}
