import type { MatchStatsSnapshot } from '../loadtest/serverStats';
import type { LoadTestScenario } from '../loadtest/scenario';

export interface BenchmarkWorkerResultBase {
  kind: 'websocket' | 'webtransport';
  requestedBots: number;
  connectedBots: number;
  failedBots: number;
  shotsFired: number;
  snapshotsReceived: number;
  totalInboundBytes: number;
  totalOutboundBytes: number;
  startedAt: string;
  finishedAt: string;
  errors: string[];
}

export interface WebSocketWorkerResult extends BenchmarkWorkerResultBase {
  kind: 'websocket';
  followTicks: number;
  recoverTicks: number;
  anchorTicks: number;
  deadTicks: number;
  targetSwitches: number;
  profiles: Record<string, number>;
}

export interface WebTransportWorkerResult extends BenchmarkWorkerResultBase {
  kind: 'webtransport';
  bottleneck: string;
  scenario: LoadTestScenario;
}

export interface BenchmarkPageState {
  mode: 'idle' | 'running' | 'completed' | 'failed';
  status: string;
  connectedBots: number;
  requestedBots: number;
  snapshotsReceived: number;
  bottleneck: string;
  error: string | null;
  result: WebTransportWorkerResult | null;
}

export interface BenchmarkObservedMetrics {
  tickP95Ms: number;
  totalPhysicsP95Ms: number;
  playerMovementP95Ms: number;
  playerKccP95Ms: number;
  dynamicsP95Ms: number;
  snapshotEncodeP95Ms: number;
  snapshotBytesPerClientP95: number;
  snapshotBytesPerTickP95: number;
  bodiesPerClientP95: number;
  wtReliableRatio: number;
  datagramFallbacks: number;
  strictSnapshotDrops: number;
  maxPendingInputs: number;
  avgPendingInputs: number;
  voidKills: number;
}

export interface BenchmarkMeasuredWindow {
  matchId: string;
  sampleCount: number;
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  peakMetrics: BenchmarkObservedMetrics;
  representativeMatch: MatchStatsSnapshot | null;
  bottleneck: string;
}

export interface BenchmarkEnvironmentInfo {
  label: string;
  serverHost: string;
  clientUrl: string;
}

export interface ThresholdOutcome {
  metric: string;
  actual: number;
  warn: number;
  fail: number;
  comparator: 'upper' | 'lower';
  verdict: 'pass' | 'warn' | 'fail';
}

export interface BenchmarkScenarioResult {
  scenarioName: string;
  environment: BenchmarkEnvironmentInfo;
  scenario: LoadTestScenario;
  measuredWindow: BenchmarkMeasuredWindow;
  workers: {
    websocket: WebSocketWorkerResult | null;
    webtransport: WebTransportWorkerResult | null;
  };
  connectedRatio: number;
  thresholdOutcomes: ThresholdOutcome[];
  verdict: 'pass' | 'warn' | 'fail';
  anomalies: string[];
  browserConsoleErrors: string[];
  browserPageErrors: string[];
}

export interface BenchmarkSuiteResult {
  suiteName: string;
  generatedAt: string;
  environment: BenchmarkEnvironmentInfo;
  results: BenchmarkScenarioResult[];
  verdict: 'pass' | 'warn' | 'fail';
}
