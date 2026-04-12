import type { BenchmarkScenarioResult, BenchmarkSuiteResult, ThresholdOutcome } from './contracts';

function formatVerdict(verdict: 'pass' | 'warn' | 'fail'): string {
  return verdict.toUpperCase();
}

function formatOutcome(outcome: ThresholdOutcome): string {
  const actual = Number.isFinite(outcome.actual) ? outcome.actual.toFixed(3) : String(outcome.actual);
  return `- ${outcome.metric}: ${actual} (${outcome.verdict}, warn ${outcome.warn}, fail ${outcome.fail}, ${outcome.comparator})`;
}

function scenarioRow(result: BenchmarkScenarioResult): string {
  const metrics = result.measuredWindow.peakMetrics;
  return `| ${result.scenarioName} | ${formatVerdict(result.verdict)} | ${metrics.tickP95Ms.toFixed(2)}ms | ${metrics.playerKccP95Ms.toFixed(2)}ms | ${(metrics.snapshotBytesPerClientP95 / 1024).toFixed(2)} KiB | ${(metrics.wtReliableRatio * 100).toFixed(1)}% | ${result.workers.websocket?.shotsFired ?? 0}/${result.workers.webtransport?.shotsFired ?? 0} | ${result.measuredWindow.bottleneck} |`;
}

function worstScenarioLine(result: BenchmarkSuiteResult, label: string, select: (scenario: BenchmarkScenarioResult) => number, suffix: string): string | null {
  if (result.results.length === 0) return null;
  const worst = result.results.reduce((best, current) => (select(current) > select(best) ? current : best));
  return `- ${label}: ${worst.scenarioName} (${select(worst).toFixed(2)}${suffix})`;
}

export function renderScenarioMarkdown(result: BenchmarkScenarioResult): string {
  const lines = [
    `## Scenario: ${result.scenarioName}`,
    '',
    `Verdict: **${formatVerdict(result.verdict)}**`,
    '',
    `- Match: \`${result.scenario.matchId}\``,
    `- Environment: \`${result.environment.label}\``,
    `- Connected ratio: ${(result.connectedRatio * 100).toFixed(1)}%`,
    `- Shots fired (ws/wt): ${result.workers.websocket?.shotsFired ?? 0}/${result.workers.webtransport?.shotsFired ?? 0}`,
    `- Bottleneck: ${result.measuredWindow.bottleneck}`,
    `- Samples captured: ${result.measuredWindow.sampleCount}`,
    '',
    '### Peak Metrics',
    '',
    `- tick p95: ${result.measuredWindow.peakMetrics.tickP95Ms.toFixed(2)}ms`,
    `- player KCC p95: ${result.measuredWindow.peakMetrics.playerKccP95Ms.toFixed(2)}ms`,
    `- dynamics p95: ${result.measuredWindow.peakMetrics.dynamicsP95Ms.toFixed(2)}ms`,
    `- snapshot/client p95: ${(result.measuredWindow.peakMetrics.snapshotBytesPerClientP95 / 1024).toFixed(2)} KiB`,
    `- WT reliable ratio: ${(result.measuredWindow.peakMetrics.wtReliableRatio * 100).toFixed(1)}%`,
    `- max pending inputs: ${result.measuredWindow.peakMetrics.maxPendingInputs.toFixed(0)}`,
    '',
    '### Thresholds',
    '',
    ...result.thresholdOutcomes.map(formatOutcome),
  ];

  if (result.anomalies.length > 0) {
    lines.push('', '### Anomalies', '', ...result.anomalies.map((anomaly) => `- ${anomaly}`));
  }

  return lines.join('\n');
}

export function renderSuiteMarkdown(result: BenchmarkSuiteResult): string {
  const lines = [
    '# vibe-land multiplayer benchmark',
    '',
    `suite: ${result.suiteName}`,
    `generated: ${result.generatedAt}`,
    `environment: ${result.environment.label}`,
    '',
    '| Scenario | Verdict | Tick p95 | Player KCC p95 | Snapshot/client | WT reliable | Shots ws/wt | Bottleneck |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...result.results.map(scenarioRow),
  ];

  const summaryLines = [
    worstScenarioLine(result, 'Worst tick p95', (scenario) => scenario.measuredWindow.peakMetrics.tickP95Ms, 'ms'),
    worstScenarioLine(result, 'Worst player KCC p95', (scenario) => scenario.measuredWindow.peakMetrics.playerKccP95Ms, 'ms'),
    worstScenarioLine(result, 'Worst snapshot/client p95', (scenario) => scenario.measuredWindow.peakMetrics.snapshotBytesPerClientP95 / 1024, ' KiB'),
    worstScenarioLine(result, 'Worst WT reliable ratio', (scenario) => scenario.measuredWindow.peakMetrics.wtReliableRatio * 100, '%'),
  ].filter((line): line is string => !!line);

  if (summaryLines.length > 0) {
    lines.push('', '## Worst Subsystems', '', ...summaryLines);
  }

  for (const scenario of result.results) {
    lines.push('', renderScenarioMarkdown(scenario));
  }

  return lines.join('\n');
}
