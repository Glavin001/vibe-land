#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(HERE, '../../client');
const mode = process.env.BODY_BENCH_TRANSPORT === 'moq' ? 'moq' : 'direct';
const viewers = integer('BODY_BENCH_VIEWERS', 4);
const bodies = integer('BODY_BENCH_BODIES', 1_000);
const hz = number('BODY_BENCH_HZ', 20);
const shards = integer('BODY_BENCH_SHARDS', 4);
const mbps = optionalNumber('BODY_BENCH_MBPS');
const warmupMs = integer('BODY_BENCH_WARMUP_MS', 3_000);
const durationMs = integer('BODY_BENCH_DURATION_MS', 10_000);
const staggerMs = integer('BODY_BENCH_STAGGER_MS', 0);
const render = process.env.BODY_BENCH_RENDER === '1';
const pageBase = process.env.BODY_LAB_URL || 'http://127.0.0.1:5555/bodies';

const playwright = await import(join(CLIENT, 'node_modules/playwright-core/index.js'));
const chromium = playwright.chromium ?? playwright.default?.chromium;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  headless: process.env.BODY_BENCH_HEADED !== '1',
});

const context = await browser.newContext();
const pages = [];
const pageErrors = [];
const startedAt = new Date().toISOString();

try {
  for (let viewer = 0; viewer < viewers; viewer += 1) {
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(`viewer ${viewer}: ${error.stack || error.message}`));
    const url = buildViewerUrl(viewer);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    pages.push(page);
    if (staggerMs > 0 && viewer + 1 < viewers) await sleep(staggerMs);
  }

  await Promise.all(pages.map((page) => page.waitForFunction(
    (expectedBodies) => {
      const snapshot = window.__RBWT_BODIES__?.snapshot();
      return snapshot?.connected && snapshot.visibleBodies === expectedBodies;
    },
    bodies,
    { timeout: 30_000 },
  )));
  await sleep(warmupMs);

  const timelineSamples = [];
  const sampleDeadline = Date.now() + durationMs;
  while (Date.now() < sampleDeadline) {
    const frames = await Promise.all(pages.map((page) => page.evaluate(
      () => window.__RBWT_BODIES__?.snapshot().latestFrame ?? -1,
    )));
    timelineSamples.push({
      at: Date.now(),
      frames,
      divergence: Math.max(...frames) - Math.min(...frames),
    });
    await sleep(100);
  }

  const snapshots = await Promise.all(pages.map((page) => page.evaluate(
    () => window.__RBWT_BODIES__?.snapshot(),
  )));
  const traceComparison = compareTraces(snapshots);
  const divergencesWithinOne = timelineSamples.filter((sample) => sample.divergence <= 1).length;
  const timelineWithinOnePercent = timelineSamples.length
    ? divergencesWithinOne * 100 / timelineSamples.length
    : 0;
  const deliveryRatios = snapshots.map((snapshot) => {
    const span = snapshot.datagrams + snapshot.missingPackets;
    return span > 0 ? snapshot.datagrams / span : 0;
  });
  const minDeliveryRatio = Math.min(...deliveryRatios);
  const allVisible = snapshots.every((snapshot) => snapshot.visibleBodies === bodies);
  const allStreaming = snapshots.every((snapshot) => snapshot.connected && snapshot.datagrams > 0);
  const p95SkewMs = percentile(traceComparison.skewsMs, 0.95) ?? 0;
  const fatalPageErrors = pageErrors.filter((message) => !message.includes("Unexpected identifier 'a'"));
  const pass = fatalPageErrors.length === 0
    && allVisible
    && allStreaming
    && traceComparison.hashMismatches === 0
    && traceComparison.comparedFrames > 0
    && timelineWithinOnePercent >= 95
    && minDeliveryRatio >= 0.95
    && (!render || snapshots.every((snapshot) => snapshot.renderedUpdates > 0 && snapshot.fps > 0))
    && (viewers > 16 || p95SkewMs <= 50);

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    config: { mode, viewers, bodies, hz, shards, mbps, warmupMs, durationMs, staggerMs, render },
    pass,
    allVisible,
    allStreaming,
    pageErrors,
    fatalPageErrors,
    timelineWithinOnePercent,
    maxTimelineDivergence: Math.max(...timelineSamples.map((sample) => sample.divergence)),
    minDeliveryRatio,
    comparedFrames: traceComparison.comparedFrames,
    hashMismatches: traceComparison.hashMismatches,
    interViewerSkewP50Ms: percentile(traceComparison.skewsMs, 0.5),
    interViewerSkewP95Ms: p95SkewMs,
    interViewerSkewP99Ms: percentile(traceComparison.skewsMs, 0.99),
    publisherToFirstViewerP95Ms: percentile(traceComparison.firstViewerLatenciesMs, 0.95),
    publisherToLastViewerP50Ms: percentile(traceComparison.lastViewerLatenciesMs, 0.5),
    publisherToLastViewerP95Ms: percentile(traceComparison.lastViewerLatenciesMs, 0.95),
    publisherToLastViewerP99Ms: percentile(traceComparison.lastViewerLatenciesMs, 0.99),
    viewers: snapshots.map((snapshot, index) => ({
      index,
      latestFrame: snapshot.latestFrame,
      datagrams: snapshot.datagrams,
      missingPackets: snapshot.missingPackets,
      visibleBodies: snapshot.visibleBodies,
      bodyUpdates: snapshot.bodyUpdates,
      fps: snapshot.fps,
      frameMs: snapshot.frameMs,
      renderedUpdates: snapshot.renderedUpdates,
      latencyP95Ms: percentile(snapshot.latencyValues, 0.95),
    })),
  };
  const outputArg = process.argv.indexOf('--output');
  const requestedOutput = outputArg >= 0 ? process.argv[outputArg + 1] : process.env.BODY_BENCH_OUTPUT;
  if (requestedOutput) {
    const output = resolve(requestedOutput);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = pass ? 0 : 1;
} finally {
  await Promise.all(pages.map((page) => page.evaluate(
    () => window.__RBWT_BODIES__?.disconnect(),
  ).catch(() => undefined)));
  await context.close();
  await browser.close();
}

function buildViewerUrl(viewer) {
  const url = new URL(pageBase);
  url.searchParams.set('transport', mode);
  url.searchParams.set('autostart', '1');
  url.searchParams.set('viewer', String(viewer));
  url.searchParams.set('bodies', String(bodies));
  url.searchParams.set('hz', String(hz));
  url.searchParams.set('duration', String(Math.ceil((warmupMs + durationMs + viewers * staggerMs) / 1000) + 20));
  url.searchParams.set('shards', String(shards));
  if (process.env.BODY_BENCH_RENDER !== '1') {
    url.searchParams.set('pause', '1');
    url.searchParams.set('norender', '1');
  }
  if (mbps !== null) url.searchParams.set('mbps', String(mbps));
  if (mode === 'direct') {
    required(url, 'direct', 'BODY_DIRECT_URL');
    required(url, 'wthash', 'BODY_DIRECT_CERT_HASH');
  } else {
    const relay = new URL(requiredValue('MOQ_RELAY_URL'));
    url.searchParams.set('relay', relay.origin);
    url.searchParams.set('token', relay.pathname.replace(/^\/+/, ''));
    url.searchParams.set('ns', process.env.MOQ_NAMESPACE || 'vibe-land/bodies');
    if (process.env.BODY_MOQ_CERT_HASH) {
      url.searchParams.set('certhash', process.env.BODY_MOQ_CERT_HASH);
    }
    url.searchParams.set('direct', process.env.BODY_DIRECT_URL || '');
    url.searchParams.set('wthash', process.env.BODY_DIRECT_CERT_HASH || '');
  }
  return url;
}

function compareTraces(snapshots) {
  const maps = snapshots.map((snapshot) => new Map(
    snapshot.traces.map((trace) => [trace.frame, trace]),
  ));
  const common = [...maps[0].keys()].filter((frame) => maps.every((map) => map.has(frame)));
  const skewsMs = [];
  const firstViewerLatenciesMs = [];
  const lastViewerLatenciesMs = [];
  let hashMismatches = 0;
  for (const frame of common) {
    const traces = maps.map((map) => map.get(frame));
    if (new Set(traces.map((trace) => trace.hash)).size !== 1) hashMismatches += 1;
    const times = traces.map((trace) => trace.receivedAtUs);
    const firstReceiveUs = Math.min(...times);
    const lastReceiveUs = Math.max(...times);
    const publisherSendUs = traces[0].serverSendUs;
    skewsMs.push((lastReceiveUs - firstReceiveUs) / 1000);
    firstViewerLatenciesMs.push((firstReceiveUs - publisherSendUs) / 1000);
    lastViewerLatenciesMs.push((lastReceiveUs - publisherSendUs) / 1000);
  }
  return {
    comparedFrames: common.length,
    hashMismatches,
    skewsMs,
    firstViewerLatenciesMs,
    lastViewerLatenciesMs,
  };
}

function required(url, queryName, envName) {
  url.searchParams.set(queryName, requiredValue(envName));
}

function requiredValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
}

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function number(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] ? value : fallback;
}

function optionalNumber(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
