import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { resolveSuite } from './src/benchmark/defaultSuite.js';
import { buildMeasuredWindow, evaluateScenario } from './src/benchmark/evaluate.js';
import { renderSuiteMarkdown } from './src/benchmark/report.js';
import type {
  BenchmarkEnvironmentInfo,
  BenchmarkScenarioResult,
  BenchmarkSuiteResult,
  PlayWorkerResult,
  WebTransportWorkerResult,
} from './src/benchmark/contracts.js';
import type { BenchmarkScenarioSpec, BenchmarkSuiteSpec } from './src/benchmark/spec.js';
import type { GlobalStatsSnapshot, MatchStatsSnapshot } from './src/loadtest/serverStats.js';
import { runWebSocketWorker } from './benchmark/wsWorker.js';

type ParsedArgs = {
  suite: string;
  scenarioName: string | null;
  environment: string;
  clientUrl: string;
  serverHost: string;
  outputDir: string;
  headless: boolean;
  iterations: number;
};

type BrowserWorkerRun = {
  result: WebTransportWorkerResult | null;
  consoleErrors: string[];
  pageErrors: string[];
  error?: string;
};

type PlayWorkerRun = {
  results: PlayWorkerResult[];
  consoleErrors: string[];
  pageErrors: string[];
  error?: string;
};

type PlayWorkerStatePayload = {
  result?: PlayWorkerResult | null;
};

type VehiclePlayThreshold = {
  warn: number;
  fail: number;
};

const VEHICLE_PLAY_THRESHOLDS = {
  benchmarkSamples: { warn: 8, fail: 1 },
  maxSpeedMs: { warn: 8, fail: 4 },
  currentAuthDeltaM: { warn: 0.10, fail: 0.20 },
  meshCurrentAuthDeltaM: { warn: 0.08, fail: 0.15 },
  unexplainedAuthDeltaM: { warn: 0.20, fail: 0.35 },
  restJitterRms5sM: { warn: 0.02, fail: 0.03 },
  straightJitterRms5sM: { warn: 0.05, fail: 0.08 },
  rawHeaveDeltaRms5sM: { warn: 0.02, fail: 0.03 },
  rawPitchDeltaRms5sRad: { warn: 0.02, fail: 0.04 },
  rawRollDeltaRms5sRad: { warn: 0.02, fail: 0.04 },
  residualPlanarDeltaRms5sM: { warn: 0.08, fail: 0.14 },
  residualHeaveDeltaRms5sM: { warn: 0.05, fail: 0.09 },
  residualYawDeltaRms5sRad: { warn: 0.02, fail: 0.04 },
  wheelContactBitChanges5s: { warn: 10, fail: 16 },
  groundedTransitions5s: { warn: 8, fail: 12 },
  suspensionLengthDeltaRms5sM: { warn: 0.02, fail: 0.04 },
  suspensionForceDeltaRms5sN: { warn: 2500, fail: 5000 },
  wheelContactNormalDeltaRms5sRad: { warn: 0.04, fail: 0.08 },
  wheelGroundObjectSwitches5s: { warn: 1, fail: 3 },
  ackBacklogMs: { warn: 100, fail: 150 },
  vehiclePendingInputs: { warn: 6, fail: 8 },
} as const satisfies Record<string, VehiclePlayThreshold>;

function isPlayWorkerResult(value: unknown): value is PlayWorkerResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<PlayWorkerResult>;
  return candidate.kind === 'play' && typeof candidate.clientLabel === 'string';
}

type TimedMatchSample = {
  atMs: number;
  at: string;
  match: MatchStatsSnapshot;
  simHz: number;
  serverBuildProfile: string;
};

class StatsStream {
  private socket: WebSocket | null = null;
  private opened = false;
  readonly samples: TimedMatchSample[] = [];

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    if (this.socket) return;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.on('open', () => {
        this.opened = true;
        resolve();
      });
      socket.on('message', (data) => {
        const text = typeof data === 'string'
          ? data
          : data instanceof Buffer
            ? data.toString('utf8')
            : '';
        if (!text) return;
        try {
          const snapshot = JSON.parse(text) as GlobalStatsSnapshot;
          const atMs = Date.now();
          const at = new Date(atMs).toISOString();
          for (const match of snapshot.matches) {
            this.samples.push({
              atMs,
              at,
              match,
              simHz: snapshot.sim_hz,
              serverBuildProfile: snapshot.server_build_profile,
            });
          }
        } catch {
          // ignore malformed frames
        }
      });
      socket.on('error', (error) => {
        if (!this.opened) reject(error);
      });
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  windowSamples(matchId: string, fromMs: number, toMs: number): Array<{ at: string; match: MatchStatsSnapshot }> {
    return this.samples
      .filter((sample) => sample.match.id === matchId && sample.atMs >= fromMs && sample.atMs <= toMs)
      .map((sample) => ({ at: sample.at, match: sample.match }));
  }

  simHz(matchId: string): number {
    const matchSample = this.samples.find((sample) => sample.match.id === matchId);
    return matchSample?.simHz ?? 60;
  }

  serverBuildProfile(matchId: string): string | null {
    const matchSample = this.samples.find((sample) => sample.match.id === matchId);
    return matchSample?.serverBuildProfile ?? null;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const envClientPort = process.env.CLIENT_PORT ?? '5555';
  const envServerHost = `${process.env.SERVER_HOST ?? 'localhost'}:${process.env.SERVER_PORT ?? '4001'}`;
  const defaultClientProtocol = process.env.WT_CERT_PEM ? 'https' : 'http';
  const args: ParsedArgs = {
    suite: 'default',
    scenarioName: null,
    environment: process.env.BENCHMARK_ENVIRONMENT ?? 'local',
    clientUrl: process.env.BENCHMARK_CLIENT_URL ?? `${defaultClientProtocol}://localhost:${envClientPort}`,
    serverHost: process.env.BENCHMARK_SERVER_HOST ?? envServerHost,
    outputDir: process.env.BENCHMARK_OUTPUT_DIR ?? path.resolve(process.cwd(), 'benchmark-results'),
    headless: process.env.BENCHMARK_HEADLESS !== '0',
    iterations: Math.max(1, Number.parseInt(process.env.BENCHMARK_ITERATIONS ?? '5', 10) || 5),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    switch (value) {
      case '--suite':
        args.suite = argv[i + 1] ?? args.suite;
        i += 1;
        break;
      case '--scenario':
        args.scenarioName = argv[i + 1] ?? null;
        i += 1;
        break;
      case '--environment':
        args.environment = argv[i + 1] ?? args.environment;
        i += 1;
        break;
      case '--client-url':
        args.clientUrl = argv[i + 1] ?? args.clientUrl;
        i += 1;
        break;
      case '--server-host':
        args.serverHost = argv[i + 1] ?? args.serverHost;
        i += 1;
        break;
      case '--output-dir':
        args.outputDir = path.resolve(process.cwd(), argv[i + 1] ?? args.outputDir);
        i += 1;
        break;
      case '--headed':
        args.headless = false;
        break;
      case '--iterations':
        args.iterations = Math.max(1, Number.parseInt(argv[i + 1] ?? '1', 10) || 1);
        i += 1;
        break;
      default:
        break;
    }
  }

  return args;
}

function selectScenarios(suite: BenchmarkSuiteSpec, args: ParsedArgs): BenchmarkScenarioSpec[] {
  let scenarios = suite.scenarios;
  if (args.scenarioName) {
    scenarios = scenarios.filter((scenario) => scenario.name === args.scenarioName);
  } else {
    scenarios = scenarios.filter((scenario) => scenario.environment === args.environment);
  }
  if (scenarios.length === 0) {
    throw new Error(`No benchmark scenarios selected for suite=${args.suite} environment=${args.environment}`);
  }
  return scenarios;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertClientPageAvailable(clientUrl: string, pathWithQuery: string): Promise<void> {
  const loadtestUrl = new URL(pathWithQuery, clientUrl);
  let response: Response;
  try {
    response = await fetch(loadtestUrl, {
      redirect: 'follow',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Benchmark client page is unreachable at ${loadtestUrl.toString()}. ` +
      `Start the Vite client or pass --client-url to a reachable dev server. ` +
      `Underlying error: ${message}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Benchmark client page responded with HTTP ${response.status} at ${loadtestUrl.toString()}. ` +
      `Start the Vite client or pass --client-url to a reachable dev server.`,
    );
  }
}

async function runWebTransportWorker(spec: BenchmarkScenarioSpec, clientUrl: string, headless: boolean): Promise<BrowserWorkerRun> {
  if (spec.scenario.transportMix.webtransport <= 0) {
    return { result: null, consoleErrors: [], pageErrors: [] };
  }

  const scriptPath = path.resolve(process.cwd(), '../infra/webtransport-tests/benchmark-loadtest.mjs');
  const args = [
    scriptPath,
    '--url',
    clientUrl,
    '--scenario',
    JSON.stringify(spec.scenario),
  ];
  if (headless) {
    args.push('--headless');
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

  const stdout = stdoutChunks.join('').trim();
  if (!stdout) {
    throw new Error(`WT worker produced no output. stderr:\n${stderrChunks.join('')}`);
  }
  const parsed = JSON.parse(stdout) as BrowserWorkerRun & { state?: unknown };
  if (exitCode !== 0 && parsed.result === null) {
    return {
      result: null,
      consoleErrors: parsed.consoleErrors ?? [],
      pageErrors: parsed.pageErrors ?? [],
      error: parsed.error ?? (stderrChunks.join('') || 'WT worker failed'),
    };
  }
  return {
    result: parsed.result,
    consoleErrors: parsed.consoleErrors ?? [],
    pageErrors: parsed.pageErrors ?? [],
    error: parsed.error,
  };
}

async function runPlayWorkers(spec: BenchmarkScenarioSpec, clientUrl: string, headless: boolean): Promise<PlayWorkerRun> {
  if (spec.playClients <= 0) {
    return { results: [], consoleErrors: [], pageErrors: [] };
  }

  const scriptPath = path.resolve(process.cwd(), '../infra/webtransport-tests/benchmark-play.mjs');
  const args = [
    scriptPath,
    '--url',
    clientUrl,
    '--scenario',
    JSON.stringify(spec.scenario),
    '--clients',
    String(spec.playClients),
  ];
  if (headless) {
    args.push('--headless');
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

  const stdout = stdoutChunks.join('').trim();
  if (!stdout) {
    throw new Error(`Play worker produced no output. stderr:\n${stderrChunks.join('')}`);
  }
  const parsed = JSON.parse(stdout) as PlayWorkerRun & {
    results?: Array<PlayWorkerResult | null>;
    states?: Array<PlayWorkerStatePayload | null>;
  };
  if (exitCode !== 0 && (!parsed.results || parsed.results.length === 0)) {
    return {
      results: [],
      consoleErrors: parsed.consoleErrors ?? [],
      pageErrors: parsed.pageErrors ?? [],
      error: parsed.error ?? (stderrChunks.join('') || 'play worker failed'),
    };
  }
  const recoveredResults = (parsed.results ?? []).map((result, index) => {
    if (result !== null) {
      return result;
    }
    const stateResult = parsed.states?.[index]?.result;
    return isPlayWorkerResult(stateResult) ? stateResult : null;
  });
  const validResults = recoveredResults.filter((result): result is PlayWorkerResult => result !== null);
  const missingResultCount = recoveredResults.length - validResults.length;
  const error = missingResultCount > 0
    ? `play worker returned ${missingResultCount} missing result payload${missingResultCount === 1 ? '' : 's'}`
    : parsed.error;
  return {
    results: validResults,
    consoleErrors: parsed.consoleErrors ?? [],
    pageErrors: parsed.pageErrors ?? [],
    error,
  };
}

async function assertWebTransportAutomationAvailable(): Promise<void> {
  const scriptPath = path.resolve(process.cwd(), '../infra/webtransport-tests/benchmark-loadtest.mjs');
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, '--check'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(stderrChunks.join('').trim() || stdoutChunks.join('').trim() || 'WT automation preflight failed.');
  }
}

async function assertPlayAutomationAvailable(): Promise<void> {
  const scriptPath = path.resolve(process.cwd(), '../infra/webtransport-tests/benchmark-play.mjs');
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, '--check'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(stderrChunks.join('').trim() || stdoutChunks.join('').trim() || 'Play automation preflight failed.');
  }
}

function combineConnectedRatio(
  spec: BenchmarkScenarioSpec,
  wsResult: BenchmarkScenarioResult['workers']['websocket'],
  wtResult: BenchmarkScenarioResult['workers']['webtransport'],
  playResults: PlayWorkerResult[],
  measuredSamples: Array<{ at: string; match: MatchStatsSnapshot }>,
): number {
  const workerConnected =
    (wsResult?.connectedBots ?? 0)
    + (wtResult?.connectedBots ?? 0)
    + playResults.filter((result) => result.connected && !result.disconnected).length;
  const requested = spec.scenario.botCount + spec.playClients;
  const observedConnected = measuredSamples.reduce((max, sample) => (
    Math.max(
      max,
      sample.match.load.websocket_players + sample.match.load.webtransport_players,
    )
  ), 0);
  const connected = Math.max(workerConnected, observedConnected);
  return requested > 0 ? connected / requested : 1;
}

function observedConnectedPlayers(
  measuredSamples: Array<{ at: string; match: MatchStatsSnapshot }>,
): number {
  return measuredSamples.reduce((max, sample) => (
    Math.max(
      max,
      sample.match.load.websocket_players + sample.match.load.webtransport_players,
    )
  ), 0);
}

function isRecoverableBrowserWorkerError(
  error: string | undefined,
  observedConnected: number,
  requested: number,
): boolean {
  return Boolean(
    error
    && observedConnected >= requested
    && error.includes('page.waitForFunction: Timeout'),
  );
}

function invalidBenchmark(message: string): string {
  return `Invalid benchmark: ${message}`;
}

function pushVehicleMetricAnomaly(
  anomalies: string[],
  clientLabel: string,
  metric: string,
  actual: number,
  threshold: VehiclePlayThreshold,
  unit: string,
): void {
  if (!Number.isFinite(actual)) {
    anomalies.push(invalidBenchmark(`${clientLabel} missing ${metric}`));
    return;
  }
  if (actual > threshold.fail) {
    anomalies.push(invalidBenchmark(
      `${clientLabel} ${metric}=${actual.toFixed(3)}${unit} exceeded fail threshold ${threshold.fail.toFixed(3)}${unit}`,
    ));
  } else if (actual > threshold.warn) {
    anomalies.push(
      `${clientLabel} ${metric}=${actual.toFixed(3)}${unit} exceeded warn threshold ${threshold.warn.toFixed(3)}${unit}`,
    );
  }
}

function pushVehicleLowerMetricAnomaly(
  anomalies: string[],
  clientLabel: string,
  metric: string,
  actual: number,
  threshold: VehiclePlayThreshold,
  unit: string,
): void {
  if (!Number.isFinite(actual)) {
    anomalies.push(invalidBenchmark(`${clientLabel} ${metric} was not finite`));
    return;
  }
  if (actual < threshold.fail) {
    anomalies.push(invalidBenchmark(
      `${clientLabel} ${metric}=${actual.toFixed(3)}${unit} was below fail threshold ${threshold.fail.toFixed(3)}${unit}`,
    ));
  } else if (actual < threshold.warn) {
    anomalies.push(
      `${clientLabel} ${metric}=${actual.toFixed(3)}${unit} was below warn threshold ${threshold.warn.toFixed(3)}${unit}`,
    );
  }
}

function collectVehiclePlayBenchmarkAnomalies(
  scenario: BenchmarkScenarioSpec['scenario'],
  playResults: PlayWorkerResult[],
): string[] {
  if (scenario.playBenchmark?.mode !== 'vehicle_driver') {
    return [];
  }

  const anomalies: string[] = [];
  for (const result of playResults) {
    pushVehicleLowerMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_benchmark_samples',
      result.vehicleBenchmarkSamples,
      VEHICLE_PLAY_THRESHOLDS.benchmarkSamples,
      '',
    );
    pushVehicleLowerMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_max_speed_ms',
      result.vehicleMaxSpeedMs,
      VEHICLE_PLAY_THRESHOLDS.maxSpeedMs,
      'm/s',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_current_auth_delta_m',
      result.vehicleCurrentAuthDeltaM,
      VEHICLE_PLAY_THRESHOLDS.currentAuthDeltaM,
      'm',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_mesh_current_auth_delta_m',
      result.vehicleMeshCurrentAuthDeltaM,
      VEHICLE_PLAY_THRESHOLDS.meshCurrentAuthDeltaM,
      'm',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_current_auth_unexplained_delta_m',
      result.vehicleCurrentAuthUnexplainedDeltaM,
      VEHICLE_PLAY_THRESHOLDS.unexplainedAuthDeltaM,
      'm',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_rest_jitter_rms_5s_m',
      result.vehicleRestJitterRms5sM,
      VEHICLE_PLAY_THRESHOLDS.restJitterRms5sM,
      'm',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_straight_jitter_rms_5s_m',
      result.vehicleStraightJitterRms5sM,
      VEHICLE_PLAY_THRESHOLDS.straightJitterRms5sM,
      'm',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_raw_heave_delta_rms_5s_m',
      result.vehicleRawHeaveDeltaRms5sM,
      VEHICLE_PLAY_THRESHOLDS.rawHeaveDeltaRms5sM,
      'm',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_raw_pitch_delta_rms_5s_rad',
      result.vehicleRawPitchDeltaRms5sRad,
      VEHICLE_PLAY_THRESHOLDS.rawPitchDeltaRms5sRad,
      'rad',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_raw_roll_delta_rms_5s_rad',
      result.vehicleRawRollDeltaRms5sRad,
      VEHICLE_PLAY_THRESHOLDS.rawRollDeltaRms5sRad,
      'rad',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_residual_planar_delta_rms_5s_m',
      result.vehicleResidualPlanarDeltaRms5sM,
      VEHICLE_PLAY_THRESHOLDS.residualPlanarDeltaRms5sM,
      'm',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_residual_heave_delta_rms_5s_m',
      result.vehicleResidualHeaveDeltaRms5sM,
      VEHICLE_PLAY_THRESHOLDS.residualHeaveDeltaRms5sM,
      'm',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_residual_yaw_delta_rms_5s_rad',
      result.vehicleResidualYawDeltaRms5sRad,
      VEHICLE_PLAY_THRESHOLDS.residualYawDeltaRms5sRad,
      'rad',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_wheel_contact_bit_changes_5s',
      result.vehicleWheelContactBitChanges5s,
      VEHICLE_PLAY_THRESHOLDS.wheelContactBitChanges5s,
      '',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_grounded_transitions_5s',
      result.vehicleGroundedTransitions5s,
      VEHICLE_PLAY_THRESHOLDS.groundedTransitions5s,
      '',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_suspension_length_delta_rms_5s_m',
      result.vehicleSuspensionLengthDeltaRms5sM,
      VEHICLE_PLAY_THRESHOLDS.suspensionLengthDeltaRms5sM,
      'm',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_suspension_force_delta_rms_5s_n',
      result.vehicleSuspensionForceDeltaRms5sN,
      VEHICLE_PLAY_THRESHOLDS.suspensionForceDeltaRms5sN,
      'N',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_wheel_contact_normal_delta_rms_5s_rad',
      result.vehicleWheelContactNormalDeltaRms5sRad,
      VEHICLE_PLAY_THRESHOLDS.wheelContactNormalDeltaRms5sRad,
      'rad',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_wheel_ground_object_switches_5s',
      result.vehicleWheelGroundObjectSwitches5s,
      VEHICLE_PLAY_THRESHOLDS.wheelGroundObjectSwitches5s,
      '',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_ack_backlog_ms',
      result.vehicleAckBacklogMs,
      VEHICLE_PLAY_THRESHOLDS.ackBacklogMs,
      'ms',
    );
    pushVehicleMetricAnomaly(
      anomalies,
      result.clientLabel,
      'vehicle_pending_inputs',
      result.vehiclePendingInputs,
      VEHICLE_PLAY_THRESHOLDS.vehiclePendingInputs,
      '',
    );
  }
  return anomalies;
}

async function writeScenarioArtifact(outputDir: string, generatedAt: string, result: BenchmarkScenarioResult): Promise<void> {
  const filename = `${generatedAt.replace(/[:.]/g, '-')}-${result.scenarioName}.json`;
  await writeFile(path.join(outputDir, filename), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

async function writeScenarioRunsArtifact(
  outputDir: string,
  generatedAt: string,
  scenarioName: string,
  results: BenchmarkScenarioResult[],
): Promise<void> {
  const filename = `${generatedAt.replace(/[:.]/g, '-')}-${scenarioName}.runs.json`;
  await writeFile(path.join(outputDir, filename), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
}

function pickMedianScenarioResult(results: BenchmarkScenarioResult[]): BenchmarkScenarioResult {
  const sorted = [...results].sort((a, b) =>
    a.measuredWindow.peakMetrics.playerKccP95Ms - b.measuredWindow.peakMetrics.playerKccP95Ms,
  );
  return sorted[Math.floor(sorted.length / 2)] ?? results[0];
}

async function runScenario(spec: BenchmarkScenarioSpec, environment: BenchmarkEnvironmentInfo, headless: boolean): Promise<BenchmarkScenarioResult> {
  const isolatedMatchId = `${spec.scenario.matchId}__run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const runSpec: BenchmarkScenarioSpec = {
    ...spec,
    scenario: {
      ...spec.scenario,
      matchId: isolatedMatchId,
    },
  };
  console.log(`\n=== benchmark: ${spec.name} ===`);
  console.log(
    `match=${isolatedMatchId} play=${spec.playClients} bots=${spec.scenario.botCount} ws=${spec.scenario.transportMix.websocket} wt=${spec.scenario.transportMix.webtransport}`,
  );

  const statsStream = new StatsStream(`ws://${environment.serverHost}/ws/stats`);
  await statsStream.connect();

  const wsPromise = runWebSocketWorker({
    scenario: runSpec.scenario,
    serverHost: environment.serverHost,
    token: process.env.TOKEN ?? 'mvp-token',
    onStatus: (line) => console.log(`  ${line}`),
  });
  const playPromise = runPlayWorkers(runSpec, environment.clientUrl, headless);
  const wtPromise = runWebTransportWorker(runSpec, environment.clientUrl, headless);

  console.log(`  warmup ${spec.warmupS}s, measure ${spec.measureS}s, cooldown ${spec.cooldownS}s`);
  await sleep(spec.warmupS * 1000);
  const measureStartMs = Date.now();
  console.log('  measuring...');
  await sleep(spec.measureS * 1000);
  const measureEndMs = Date.now();

  const [wsOutcome, playOutcome, wtOutcome] = await Promise.allSettled([wsPromise, playPromise, wtPromise]);
  statsStream.close();

  const wsResult = wsOutcome.status === 'fulfilled' ? wsOutcome.value : null;
  const playRun = playOutcome.status === 'fulfilled'
    ? playOutcome.value
    : { results: [], consoleErrors: [], pageErrors: [], error: playOutcome.reason instanceof Error ? playOutcome.reason.message : String(playOutcome.reason) };
  const wtRun = wtOutcome.status === 'fulfilled'
    ? wtOutcome.value
    : { result: null, consoleErrors: [], pageErrors: [], error: wtOutcome.reason instanceof Error ? wtOutcome.reason.message : String(wtOutcome.reason) };

  const measuredSamples = statsStream.windowSamples(runSpec.scenario.matchId, measureStartMs, measureEndMs);
  const measuredWindow = buildMeasuredWindow(runSpec.scenario.matchId, measuredSamples, statsStream.simHz(runSpec.scenario.matchId));
  const serverBuildProfile = statsStream.serverBuildProfile(runSpec.scenario.matchId);
  const requestedPlayers = spec.scenario.botCount + spec.playClients;
  const observedConnected = observedConnectedPlayers(measuredSamples);

  const anomalies = [
    ...(wsResult?.errors ?? []),
    ...playRun.results
      .filter((result) => result.disconnected)
      .map((result) => `${result.clientLabel} disconnected${result.disconnectReason ? `: ${result.disconnectReason}` : ''}`),
    ...collectVehiclePlayBenchmarkAnomalies(runSpec.scenario, playRun.results),
    ...(wtRun.result?.errors ?? []),
  ];
  if (wsOutcome.status === 'rejected') {
    anomalies.push(wsOutcome.reason instanceof Error ? wsOutcome.reason.message : String(wsOutcome.reason));
  }
  if (playRun.error && !isRecoverableBrowserWorkerError(playRun.error, observedConnected, requestedPlayers)) {
    anomalies.push(playRun.error);
  }
  if (wtRun.error && !isRecoverableBrowserWorkerError(wtRun.error, observedConnected, requestedPlayers)) {
    anomalies.push(wtRun.error);
  }
  const missingPlayResults = Math.max(0, spec.playClients - playRun.results.length);
  if (missingPlayResults > 0) {
    anomalies.push(invalidBenchmark(
      `missing ${missingPlayResults} of ${spec.playClients} play worker result payloads`,
    ));
  }
  if (spec.scenario.transportMix.webtransport > 0 && wtRun.result == null) {
    anomalies.push(invalidBenchmark('missing webtransport worker result payload'));
  }
  if (serverBuildProfile && serverBuildProfile !== 'release') {
    anomalies.push(
      invalidBenchmark(
        `server build profile is ${serverBuildProfile}; use a release server for authoritative performance benchmarks`,
      ),
    );
  }
  const totalShotsFired =
    (wsResult?.shotsFired ?? 0)
    + (wtRun.result?.shotsFired ?? 0)
    + playRun.results.reduce((sum, result) => sum + result.shotsFired, 0);
  const haveWorkerMetrics = wsResult != null || wtRun.result != null || playRun.results.length > 0;
  if (spec.scenario.behavior.fireMode !== 'off' && haveWorkerMetrics && totalShotsFired === 0) {
    anomalies.push(invalidBenchmark('scenario requested combat behavior, but no benchmark shots were fired'));
  }
  const connectedRatio = combineConnectedRatio(
    spec,
    wsResult,
    wtRun.result,
    playRun.results,
    measuredSamples,
  );
  const evaluation = evaluateScenario(
    spec,
    measuredWindow,
    connectedRatio,
    anomalies,
    [...playRun.consoleErrors, ...wtRun.consoleErrors],
    [...playRun.pageErrors, ...wtRun.pageErrors],
  );
  const result: BenchmarkScenarioResult = {
    scenarioName: spec.name,
    environment,
    scenario: runSpec.scenario,
    measuredWindow,
    workers: {
      websocket: wsResult,
      webtransport: wtRun.result,
      play: playRun.results,
    },
    connectedRatio,
    thresholdOutcomes: evaluation.thresholdOutcomes,
    verdict: evaluation.verdict,
    anomalies: evaluation.anomalies,
    browserConsoleErrors: [...playRun.consoleErrors, ...wtRun.consoleErrors],
    browserPageErrors: [...playRun.pageErrors, ...wtRun.pageErrors],
  };

  console.log(`  verdict=${result.verdict.toUpperCase()} bottleneck=${result.measuredWindow.bottleneck}`);
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const suite = resolveSuite(args.suite);
  const scenarios = selectScenarios(suite, args);
  const environment: BenchmarkEnvironmentInfo = {
    label: args.environment,
    serverHost: args.serverHost,
    clientUrl: args.clientUrl,
  };

  console.log(`Running benchmark suite "${suite.name}" on ${environment.label}`);
  console.log(`Server: ${environment.serverHost}`);
  console.log(`Client: ${environment.clientUrl}`);
  console.log(`Iterations: ${args.iterations}`);

  if (scenarios.some((scenario) => scenario.scenario.transportMix.webtransport > 0)) {
    await assertWebTransportAutomationAvailable();
    await assertClientPageAvailable(environment.clientUrl, '/loadtest?benchmark=1');
  }
  if (scenarios.some((scenario) => scenario.playClients > 0)) {
    await assertPlayAutomationAvailable();
    await assertClientPageAvailable(environment.clientUrl, '/play?benchmark=1');
  }

  await mkdir(args.outputDir, { recursive: true });

  const results: BenchmarkScenarioResult[] = [];
  for (const scenario of scenarios) {
    const scenarioRuns: BenchmarkScenarioResult[] = [];
    for (let iteration = 0; iteration < args.iterations; iteration += 1) {
      console.log(`\n--- ${scenario.name} run ${iteration + 1}/${args.iterations} ---`);
      scenarioRuns.push(await runScenario(scenario, environment, args.headless));
    }
    const selected = pickMedianScenarioResult(scenarioRuns);
    results.push(selected);
    const generatedAt = new Date().toISOString();
    await writeScenarioArtifact(args.outputDir, generatedAt, selected);
    await writeScenarioRunsArtifact(args.outputDir, generatedAt, scenario.name, scenarioRuns);
  }

  const verdict = results.some((result) => result.verdict === 'fail')
    ? 'fail'
    : results.some((result) => result.verdict === 'warn')
      ? 'warn'
      : 'pass';

  const suiteResult: BenchmarkSuiteResult = {
    suiteName: suite.name,
    generatedAt: new Date().toISOString(),
    environment,
    results,
    verdict,
  };

  const suiteStamp = suiteResult.generatedAt.replace(/[:.]/g, '-');
  const suiteJsonPath = path.join(args.outputDir, `${suiteStamp}-${suite.name}.json`);
  const suiteMarkdownPath = path.join(args.outputDir, `${suiteStamp}-${suite.name}.md`);
  await writeFile(suiteJsonPath, `${JSON.stringify(suiteResult, null, 2)}\n`, 'utf8');
  await writeFile(suiteMarkdownPath, `${renderSuiteMarkdown(suiteResult)}\n`, 'utf8');

  console.log(`\nSuite verdict: ${suiteResult.verdict.toUpperCase()}`);
  console.log(`JSON: ${suiteJsonPath}`);
  console.log(`Markdown: ${suiteMarkdownPath}`);

  process.exit(suiteResult.verdict === 'fail' ? 1 : 0);
}

main().catch((error: Error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
