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
};

type BrowserWorkerRun = {
  result: WebTransportWorkerResult | null;
  consoleErrors: string[];
  pageErrors: string[];
  error?: string;
};

type TimedMatchSample = {
  atMs: number;
  at: string;
  match: MatchStatsSnapshot;
  simHz: number;
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
            this.samples.push({ atMs, at, match, simHz: snapshot.sim_hz });
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

async function assertClientLoadtestAvailable(clientUrl: string): Promise<void> {
  const loadtestUrl = new URL('/loadtest?benchmark=1', clientUrl);
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

function combineConnectedRatio(
  spec: BenchmarkScenarioSpec,
  wsResult: BenchmarkScenarioResult['workers']['websocket'],
  wtResult: BenchmarkScenarioResult['workers']['webtransport'],
): number {
  const connected = (wsResult?.connectedBots ?? 0) + (wtResult?.connectedBots ?? 0);
  return spec.scenario.botCount > 0 ? connected / spec.scenario.botCount : 1;
}

async function writeScenarioArtifact(outputDir: string, generatedAt: string, result: BenchmarkScenarioResult): Promise<void> {
  const filename = `${generatedAt.replace(/[:.]/g, '-')}-${result.scenarioName}.json`;
  await writeFile(path.join(outputDir, filename), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

async function runScenario(spec: BenchmarkScenarioSpec, environment: BenchmarkEnvironmentInfo, headless: boolean): Promise<BenchmarkScenarioResult> {
  console.log(`\n=== benchmark: ${spec.name} ===`);
  console.log(`match=${spec.scenario.matchId} players=${spec.scenario.botCount} ws=${spec.scenario.transportMix.websocket} wt=${spec.scenario.transportMix.webtransport}`);

  const statsStream = new StatsStream(`ws://${environment.serverHost}/ws/stats`);
  await statsStream.connect();

  const wsPromise = runWebSocketWorker({
    scenario: spec.scenario,
    serverHost: environment.serverHost,
    token: process.env.TOKEN ?? 'mvp-token',
    onStatus: (line) => console.log(`  ${line}`),
  });
  const wtPromise = runWebTransportWorker(spec, environment.clientUrl, headless);

  console.log(`  warmup ${spec.warmupS}s, measure ${spec.measureS}s`);
  await sleep(spec.warmupS * 1000);
  const measureStartMs = Date.now();
  console.log('  measuring...');
  await sleep(spec.measureS * 1000);
  const measureEndMs = Date.now();

  const [wsOutcome, wtOutcome] = await Promise.allSettled([wsPromise, wtPromise]);
  statsStream.close();

  const wsResult = wsOutcome.status === 'fulfilled' ? wsOutcome.value : null;
  const wtRun = wtOutcome.status === 'fulfilled'
    ? wtOutcome.value
    : { result: null, consoleErrors: [], pageErrors: [], error: wtOutcome.reason instanceof Error ? wtOutcome.reason.message : String(wtOutcome.reason) };

  const measuredSamples = statsStream.windowSamples(spec.scenario.matchId, measureStartMs, measureEndMs);
  const measuredWindow = buildMeasuredWindow(spec.scenario.matchId, measuredSamples, statsStream.simHz(spec.scenario.matchId));

  const anomalies = [
    ...(wsResult?.errors ?? []),
    ...(wtRun.result?.errors ?? []),
  ];
  if (wsOutcome.status === 'rejected') {
    anomalies.push(wsOutcome.reason instanceof Error ? wsOutcome.reason.message : String(wsOutcome.reason));
  }
  if (wtRun.error) {
    anomalies.push(wtRun.error);
  }
  const totalShotsFired = (wsResult?.shotsFired ?? 0) + (wtRun.result?.shotsFired ?? 0);
  if (spec.scenario.behavior.fireMode !== 'off' && totalShotsFired === 0) {
    anomalies.push('Scenario requested combat behavior, but no benchmark shots were fired.');
  }
  const connectedRatio = combineConnectedRatio(spec, wsResult, wtRun.result);
  const evaluation = evaluateScenario(spec, measuredWindow, connectedRatio, anomalies, wtRun.consoleErrors, wtRun.pageErrors);
  const result: BenchmarkScenarioResult = {
    scenarioName: spec.name,
    environment,
    scenario: spec.scenario,
    measuredWindow,
    workers: {
      websocket: wsResult,
      webtransport: wtRun.result,
    },
    connectedRatio,
    thresholdOutcomes: evaluation.thresholdOutcomes,
    verdict: evaluation.verdict,
    anomalies: evaluation.anomalies,
    browserConsoleErrors: wtRun.consoleErrors,
    browserPageErrors: wtRun.pageErrors,
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

  if (scenarios.some((scenario) => scenario.scenario.transportMix.webtransport > 0)) {
    await assertWebTransportAutomationAvailable();
    await assertClientLoadtestAvailable(environment.clientUrl);
  }

  await mkdir(args.outputDir, { recursive: true });

  const results: BenchmarkScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario, environment, args.headless);
    results.push(result);
    await writeScenarioArtifact(args.outputDir, new Date().toISOString(), result);
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
