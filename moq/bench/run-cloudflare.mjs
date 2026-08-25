#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const CLIENT = join(REPO, 'client');
const HARNESS_PORT = Number(process.env.MOQ_BENCH_HARNESS_PORT || 4455);
const RELAY_URL = process.env.MOQ_RELAY_URL;
const WARMUP_MS = Number(process.env.MOQ_BENCH_WARMUP_MS || 2_000);
const DURATION_MS = Number(process.env.MOQ_BENCH_DURATION_MS || 6_000);
const QUICK = process.argv.includes('--quick');
const TRANSPORT = process.env.MOQ_BENCH_TRANSPORT === 'datagram' ? 'datagram' : 'stream';
const DATAGRAM_PAYLOAD_BYTES = Number(process.env.MOQ_BENCH_DATAGRAM_PAYLOAD_BYTES || 900);
const RAMP_TARGETS = numberList(
  process.env.MOQ_BENCH_RAMP_MBPS,
  QUICK ? [1, 10, 50] : [1, 5, 10, 25, 50, 100, 200, 400],
);
const VIEWER_COUNTS = numberList(
  process.env.MOQ_BENCH_VIEWERS,
  QUICK ? [2, 4] : [2, 4, 8, 16],
);

if (!RELAY_URL) {
  throw new Error('set MOQ_RELAY_URL to the authenticated draft-16 relay URL');
}

const relay = new URL(RELAY_URL);
const endpoint = relay.origin;
const token = relay.pathname.replace(/^\/+/, '');
if (!token) throw new Error('MOQ_RELAY_URL must include the token path');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputArg = process.argv.indexOf('--output');
const outputPath =
  outputArg >= 0 && process.argv[outputArg + 1]
    ? resolve(process.argv[outputArg + 1])
    : join(HERE, 'results', `${timestamp}.json`);

const workDir = mkdtempSync(join(tmpdir(), 'moq-bench-'));
const children = new Set();
let server;
let browser;

process.on('SIGINT', () => {
  void cleanup().finally(() => process.exit(130));
});
process.on('SIGTERM', () => {
  void cleanup().finally(() => process.exit(143));
});

try {
  const publisherBin = buildPublisher();
  bundleHarness();
  server = await serveHarness();
  browser = await launchBrowser();

  const report = {
    startedAt: new Date().toISOString(),
    relay: endpoint,
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      chrome: await browser.version(),
    },
    config: {
      warmupMs: WARMUP_MS,
      durationMs: DURATION_MS,
      quick: QUICK,
      transport: TRANSPORT,
      datagramPayloadBytes: TRANSPORT === 'datagram' ? DATAGRAM_PAYLOAD_BYTES : null,
      rampTargetsMbps: RAMP_TARGETS,
      viewerCounts: VIEWER_COUNTS,
    },
    cases: [],
  };

  let sustainableMbps = 0;
  if (process.env.MOQ_BENCH_SKIP_RAMP !== '1') {
    for (const targetMbps of RAMP_TARGETS) {
      const benchmarkCase = throughputCase(targetMbps, 1);
      const result = await runCase(publisherBin, benchmarkCase);
      report.cases.push(result);
      printCase(result);
      if (result.pass) sustainableMbps = targetMbps;
      else if (targetMbps >= 10) break;
    }
  }

  const fanoutTargetMbps = Number(
    process.env.MOQ_BENCH_FANOUT_MBPS || Math.max(1, Math.min(50, sustainableMbps || 10)),
  );
  if (process.env.MOQ_BENCH_SKIP_FANOUT !== '1') {
    for (const viewers of VIEWER_COUNTS) {
      const result = await runCase(publisherBin, throughputCase(fanoutTargetMbps, viewers));
      report.cases.push(result);
      printCase(result);
      if (!result.pass) break;
    }
  }

  if (TRANSPORT === 'datagram' && process.env.MOQ_BENCH_DATAGRAM_SIZES) {
    const sizeTargetMbps = Number(process.env.MOQ_BENCH_DATAGRAM_SIZE_TARGET_MBPS || 5);
    for (const payloadBytes of numberList(process.env.MOQ_BENCH_DATAGRAM_SIZES, [])) {
      const result = await runCase(
        publisherBin,
        throughputCase(sizeTargetMbps, 1, payloadBytes),
      );
      report.cases.push(result);
      printCase(result);
    }
  }

  if (!QUICK && process.env.MOQ_BENCH_SKIP_OBJECT_RATE !== '1') {
    for (const objectRateCase of objectStressCases()) {
      const result = await runCase(publisherBin, objectRateCase);
      report.cases.push(result);
      printCase(result);
      if (!result.pass) break;
    }
  }

  report.finishedAt = new Date().toISOString();
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nRaw results: ${outputPath}`);
} finally {
  await cleanup();
}

function throughputCase(targetMbps, viewers, payloadOverride) {
  const tracks = 4;
  const payloadBytes =
    TRANSPORT === 'datagram'
      ? payloadOverride ?? DATAGRAM_PAYLOAD_BYTES
      : Math.max(32, Math.round((targetMbps * 1_000_000) / 8 / tracks / 20));
  const hz =
    TRANSPORT === 'datagram'
      ? (targetMbps * 1_000_000) / 8 / tracks / payloadBytes
      : 20;
  return {
    id:
      `${TRANSPORT}-throughput-${targetMbps}mbps-${viewers}v` +
      (payloadOverride ? `-${payloadBytes}b` : ''),
    transport: TRANSPORT,
    tracks,
    hz,
    payloadBytes,
    viewers,
    warmupMs: WARMUP_MS,
    durationMs: DURATION_MS,
  };
}

function objectStressCases() {
  const targetMbps = Number(process.env.MOQ_BENCH_OBJECT_TARGET_MBPS || 20);
  const shapes = process.env.MOQ_BENCH_OBJECT_SHAPES
    ? process.env.MOQ_BENCH_OBJECT_SHAPES.split(',').map((shape) => {
        const [tracks, hz] = shape.split('x').map(Number);
        if (!Number.isFinite(tracks) || !Number.isFinite(hz) || tracks < 1 || hz <= 0) {
          throw new Error(`invalid MOQ_BENCH_OBJECT_SHAPES entry: ${shape}`);
        }
        return { tracks, hz };
      })
    : [
        { tracks: 4, hz: 200 },
        { tracks: 16, hz: 60 },
        { tracks: 32, hz: 60 },
        { tracks: 50, hz: 60 },
        { tracks: 51, hz: 60 },
      ];
  return shapes.map(({ tracks, hz }) => {
    const payloadBytes = Math.max(32, Math.round((targetMbps * 1_000_000) / 8 / tracks / hz));
    return {
      id: `object-rate-${tracks}x${hz}x${payloadBytes}`,
      transport: TRANSPORT,
      tracks,
      hz,
      payloadBytes,
      viewers: 1,
      warmupMs: WARMUP_MS,
      durationMs: DURATION_MS,
    };
  });
}

function buildPublisher() {
  const manifest = join(REPO, 'moq/publisher/Cargo.toml');
  runSync('cargo', ['build', '--release', '--manifest-path', manifest], REPO);
  const metadata = JSON.parse(
    runSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', manifest], REPO),
  );
  return join(metadata.target_directory, 'release', 'vibe-moq-publisher');
}

function bundleHarness() {
  const esbuild = join(CLIENT, 'node_modules/.bin/esbuild');
  runSync(
    esbuild,
    [
      join(HERE, 'harness.ts'),
      '--bundle',
      '--format=esm',
      '--target=es2022',
      `--outfile=${join(workDir, 'harness.js')}`,
    ],
    CLIENT,
    { ...process.env, NODE_PATH: join(CLIENT, 'node_modules') },
  );
  writeFileSync(join(workDir, 'harness.html'), readFileSync(join(HERE, 'harness.html')));
}

function serveHarness() {
  return new Promise((resolveServer, rejectServer) => {
    const instance = createServer((request, response) => {
      const requestPath = (request.url ?? '/').split('?')[0];
      const file =
        requestPath === '/' || requestPath === '/harness.html'
          ? 'harness.html'
          : requestPath.replace(/^\//, '');
      if (!['harness.html', 'harness.js'].includes(file)) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html',
        'cache-control': 'no-store',
      });
      response.end(readFileSync(join(workDir, file)));
    });
    instance.on('error', rejectServer);
    instance.listen(HARNESS_PORT, '127.0.0.1', () => resolveServer(instance));
  });
}

async function launchBrowser() {
  const playwright = await import(join(CLIENT, 'node_modules/playwright-core/index.js'));
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });
}

async function runCase(publisherBin, benchmarkCase) {
  const namespace = `vibe-land/bench/${benchmarkCase.id}-${Date.now()}`;
  const requestedMbps =
    (benchmarkCase.tracks * benchmarkCase.hz * benchmarkCase.payloadBytes * 8) / 1_000_000;
  const publisher = startPublisher(publisherBin, benchmarkCase, namespace);
  const startedAt = new Date().toISOString();

  try {
    await publisher.ready;
    await sleep(500);

    const context = await browser.newContext();
    const pageErrors = [];
    const pages = await Promise.all(
      Array.from({ length: benchmarkCase.viewers }, async (_, viewer) => {
        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(`viewer ${viewer}: ${error.message}`));
        const url = new URL(`http://127.0.0.1:${HARNESS_PORT}/harness.html`);
        url.searchParams.set('relay', endpoint);
        url.searchParams.set('token', token);
        url.searchParams.set('ns', namespace);
        url.searchParams.set('tracks', String(benchmarkCase.tracks));
        url.searchParams.set('warmupMs', String(benchmarkCase.warmupMs));
        url.searchParams.set('durationMs', String(benchmarkCase.durationMs));
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return page;
      }),
    );

    const timeout = benchmarkCase.warmupMs + benchmarkCase.durationMs + 30_000;
    await Promise.all(
      pages.map((page) =>
        page.waitForFunction(
          () => ['completed', 'error'].includes(window.__MOQ_BENCH__?.status),
          undefined,
          { timeout },
        ),
      ),
    );

    const viewers = await Promise.all(
      pages.map((page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__MOQ_BENCH__)))),
    );
    await context.close();

    const successful = viewers.filter((viewer) => viewer.status === 'completed' && viewer.result);
    const throughputs = successful.map((viewer) => viewer.result.megabitsPerSecond);
    const ratios = throughputs.map((value) => value / requestedMbps);
    const p99Values = successful
      .map((viewer) => viewer.result.latencyMs.p99)
      .filter((value) => value !== null);
    const malformedObjects = successful.reduce(
      (total, viewer) => total + viewer.result.malformed,
      0,
    );
    const sequenceReordering = successful.reduce(
      (total, viewer) => total + viewer.result.gaps + viewer.result.outOfOrder,
      0,
    );
    const publisherSamples = publisher.throughputSamplesMbps();
    const publisherMbps =
      publisherSamples.length > 0
        ? publisherSamples.reduce((total, value) => total + value, 0) / publisherSamples.length
        : null;
    const minDeliveryRatio = ratios.length > 0 ? Math.min(...ratios) : 0;
    const maxP99LatencyMs = p99Values.length > 0 ? Math.max(...p99Values) : null;
    const latencyBudgetMs = benchmarkCase.transport === 'datagram' ? 250 : 1_000;
    const minimumDeliveryRatio = benchmarkCase.transport === 'datagram' ? 0.95 : 0.9;
    const pass =
      successful.length === benchmarkCase.viewers &&
      minDeliveryRatio >= minimumDeliveryRatio &&
      malformedObjects === 0 &&
      (maxP99LatencyMs === null || maxP99LatencyMs < latencyBudgetMs) &&
      pageErrors.length === 0;

    return {
      ...benchmarkCase,
      namespace,
      startedAt,
      finishedAt: new Date().toISOString(),
      requestedMbps,
      requestedAggregateEgressMbps: requestedMbps * benchmarkCase.viewers,
      publisherMbps,
      meanViewerMbps:
        throughputs.length > 0
          ? throughputs.reduce((total, value) => total + value, 0) / throughputs.length
          : 0,
      minViewerMbps: throughputs.length > 0 ? Math.min(...throughputs) : 0,
      aggregateViewerMbps: throughputs.reduce((total, value) => total + value, 0),
      minDeliveryRatio,
      maxLossPercent: Math.max(0, (1 - minDeliveryRatio) * 100),
      maxP99LatencyMs,
      malformedObjects,
      sequenceReordering,
      pageErrors,
      publisherErrors: publisher.errors(),
      publisherLogTail: publisher.logTail(),
      pass,
      viewers,
    };
  } catch (error) {
    return {
      ...benchmarkCase,
      namespace,
      startedAt,
      finishedAt: new Date().toISOString(),
      requestedMbps,
      requestedAggregateEgressMbps: requestedMbps * benchmarkCase.viewers,
      pass: false,
      error: error instanceof Error ? error.message : String(error),
      publisherErrors: publisher.errors(),
      publisherLogTail: publisher.logTail(),
    };
  } finally {
    await publisher.stop();
    await sleep(500);
  }
}

function startPublisher(publisherBin, benchmarkCase, namespace) {
  const args = [
    RELAY_URL,
    '--namespace',
    namespace,
    '--benchmark-tracks',
    String(benchmarkCase.tracks),
    '--benchmark-hz',
    String(benchmarkCase.hz),
    '--benchmark-payload-bytes',
    String(benchmarkCase.payloadBytes),
    '--group-seconds',
    '1',
    '--stats-seconds',
    '1',
  ];
  if (benchmarkCase.transport === 'datagram') args.push('--benchmark-datagrams');
  const child = spawn(publisherBin, args, {
    cwd: join(REPO, 'moq/publisher'),
    env: {
      ...process.env,
      RUST_LOG: process.env.RUST_LOG || 'info,moq_transport=debug',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error('publisher namespace registration timed out')),
      30_000,
    );
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes('msg_type="REQUEST_OK"')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`publisher exited before setup (code ${code})`));
    });
  });

  return {
    ready,
    errors: () =>
      stderr
        .split('\n')
        .filter((line) => /\b(ERROR|WARN)\b|Error:/.test(line))
        .map(redact),
    logTail: () => stderr.split('\n').slice(-30).map(redact),
    throughputSamplesMbps: () =>
      [...stderr.matchAll(/total_kb_per_second="([0-9.]+)"/g)].map(
        (match) => (Number(match[1]) * 8) / 1000,
      ),
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise((resolveExit) => child.once('exit', resolveExit)),
          sleep(3_000).then(() => child.kill('SIGKILL')),
        ]);
      }
      children.delete(child);
    },
  };
}

function printCase(result) {
  const status = result.pass ? 'PASS' : 'LIMIT';
  const latency = result.maxP99LatencyMs === null || result.maxP99LatencyMs === undefined
    ? 'n/a'
    : `${result.maxP99LatencyMs.toFixed(1)}ms`;
  console.log(
    `${status.padEnd(5)} ${result.id.padEnd(28)} ` +
      `requested=${result.requestedMbps.toFixed(1)}Mbps/viewer ` +
      `received=${(result.meanViewerMbps ?? 0).toFixed(1)}Mbps/viewer ` +
      `aggregate=${(result.aggregateViewerMbps ?? 0).toFixed(1)}Mbps ` +
      `delivered=${((result.minDeliveryRatio ?? 0) * 100).toFixed(1)}% ` +
      `loss=${(result.maxLossPercent ?? 100).toFixed(1)}% p99=${latency}`,
  );
  if (result.error) console.log(`      ${result.error}`);
}

function runSync(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function redact(line) {
  return line.replace(/https:\/\/[^/\s]+\/\S+/g, 'https://<relay>/<token>');
}

function numberList(raw, fallback) {
  if (!raw) return fallback;
  const parsed = raw
    .split(',')
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return parsed.length > 0 ? parsed : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function cleanup() {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  children.clear();
  await browser?.close().catch(() => {});
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(workDir, { recursive: true, force: true });
}
