#!/usr/bin/env node
/**
 * End-to-end check for the MoQ demo, run entirely on this machine.
 *
 * Boots a real relay, the real Rust publisher and a real headless Chromium, and
 * asserts that the browser client receives and decodes world state on every
 * track — then that unsubscribing actually stops the bytes.
 *
 * Cloudflare's hosted relay speaks the same draft-16 protocol from the same
 * codebase, so a pass here means the only untested variable against Cloudflare
 * is the token in the URL path.
 *
 * Usage:
 *   node moq/e2e/verify-local.mjs --relay-bin /path/to/moq-relay-ietf
 *
 * Build the relay first (it is not vendored):
 *   git clone https://github.com/cloudflare/moq-rs
 *   cd moq-rs && cargo build --bin moq-relay-ietf
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const CLIENT = join(REPO, 'client');

const RELAY_PORT = 4443;
const HARNESS_PORT = 4444;
const NAMESPACE = 'vibe-land/demo';
const TRACKS = ['region-0', 'region-1', 'region-2', 'region-3', 'meta'];

const args = parseArgs(process.argv.slice(2));
const workDir = mkdtempSync(join(tmpdir(), 'moq-e2e-'));
const children = [];
let httpServer = null;

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

try {
  await main();
  console.log('\nPASS — the browser client decoded live world state on every track.');
  process.exit(0);
} catch (error) {
  console.error(`\nFAIL — ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

async function main() {
  const relayBin = args['relay-bin'] ?? findRelayBinary();
  if (!relayBin) {
    throw new Error(
      'could not find moq-relay-ietf. Build it from github.com/cloudflare/moq-rs and pass --relay-bin',
    );
  }

  step('generating a self-signed certificate for the local relay');
  const { certPath, keyPath, fingerprint } = generateCertificate();

  step(`starting the relay on :${RELAY_PORT}`);
  // IPv4 explicitly: moq-rs defaults to [::] and plenty of CI sandboxes have
  // no IPv6 stack at all, where that bind fails outright.
  const relay = run(
    relayBin,
    ['--bind', `0.0.0.0:${RELAY_PORT}`, '--tls-cert', certPath, '--tls-key', keyPath],
    'relay',
  );
  await waitForLog(relay, /listening|serving|bound|started/i, 20_000, 'relay did not start');

  step('starting the publisher');
  const publisher = run(
    'cargo',
    [
      'run',
      '--quiet',
      '--manifest-path',
      join(REPO, 'moq/publisher/Cargo.toml'),
      '--',
      `https://127.0.0.1:${RELAY_PORT}`,
      '--bind',
      '0.0.0.0:0',
      '--tls-disable-verify',
      '--namespace',
      NAMESPACE,
      '--seed',
      '42',
      // Keep groups short so the test does not wait long for a keyframe.
      '--group-seconds',
      '1',
    ],
    'publisher',
  );
  await waitForLog(publisher, /session established/i, 180_000, 'publisher never connected');

  step('bundling the browser harness');
  bundleHarness();

  step(`serving the harness on http://127.0.0.1:${HARNESS_PORT}`);
  await serveHarness();

  step('driving headless Chromium against the MoQ client library');
  const report = await runBrowser(fingerprint);

  step('checking what the browser actually received');
  assertReport(report);

  step('driving the same Chromium against the real /moq demo page');
  const pageReport = await runDemoPage(fingerprint);

  step('checking what the demo page rendered');
  assertPageReport(pageReport);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
      parsed[key] = value;
      index += 1;
    } else {
      parsed[key] = 'true';
    }
  }
  return parsed;
}

function findRelayBinary() {
  const candidates = [
    process.env.MOQ_RELAY_BIN,
    join(REPO, '../moq-rs/target/debug/moq-relay-ietf'),
    join(REPO, '../moq-rs/target/release/moq-relay-ietf'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (spawnSync('test', ['-x', candidate]).status === 0) return candidate;
  }
  return null;
}

/**
 * Chrome only accepts `serverCertificateHashes` for ECDSA P-256 certificates
 * valid for 14 days or less, which is exactly what this produces.
 */
function generateCertificate() {
  const certPath = join(workDir, 'cert.pem');
  const keyPath = join(workDir, 'key.pem');

  execOrThrow('openssl', [
    'req', '-x509', '-nodes',
    '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '13',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
  ]);

  const der = join(workDir, 'cert.der');
  execOrThrow('openssl', ['x509', '-in', certPath, '-outform', 'der', '-out', der]);

  const digest = execOrThrow('openssl', ['dgst', '-sha256', der]).stdout.toString();
  const fingerprint = digest.trim().split(/[\s=]+/).pop();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(`could not read the certificate fingerprint from: ${digest}`);
  }

  return { certPath, keyPath, fingerprint };
}

function bundleHarness() {
  // esbuild resolves bare imports relative to the importing file, and these
  // entry points live outside client/, so point it at the client's modules.
  const esbuild = join(CLIENT, 'node_modules/.bin/esbuild');
  const options = {
    cwd: CLIENT,
    env: { ...process.env, NODE_PATH: join(CLIENT, 'node_modules') },
  };

  execOrThrow(
    esbuild,
    [
      join(HERE, 'harness.ts'),
      '--bundle',
      '--format=esm',
      '--target=es2022',
      `--outfile=${join(workDir, 'harness.js')}`,
    ],
    options,
  );

  execOrThrow(
    esbuild,
    [
      join(HERE, 'page-entry.tsx'),
      '--bundle',
      '--format=esm',
      '--target=es2022',
      '--jsx=automatic',
      '--define:process.env.NODE_ENV="production"',
      `--outfile=${join(workDir, 'page.js')}`,
    ],
    options,
  );

  for (const file of ['harness.html', 'page.html']) {
    writeFileSync(join(workDir, file), readFileSync(join(HERE, file)));
  }
}

function serveHarness() {
  return new Promise((resolveServer, rejectServer) => {
    httpServer = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0];
      const file = path === '/' || path === '/harness.html' ? 'harness.html' : path.replace(/^\//, '');

      if (file === 'favicon.ico') {
        response.writeHead(204).end();
        return;
      }

      try {
        const body = readFileSync(join(workDir, file));
        response.writeHead(200, {
          'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html',
        });
        response.end(body);
      } catch {
        response.writeHead(404).end('not found');
      }
    });

    httpServer.on('error', rejectServer);
    // 127.0.0.1 is a secure context, so WebTransport is allowed from this page.
    httpServer.listen(HARNESS_PORT, '127.0.0.1', () => resolveServer());
  });
}

async function runBrowser(fingerprint) {
  // playwright-core is CommonJS, so an ESM dynamic import lands it on `default`.
  const playwright = await import(join(CLIENT, 'node_modules/playwright-core/index.js'));
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) throw new Error('could not load playwright-core');

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });

  try {
    const page = await browser.newPage();
    page.on('console', (message) => log('chromium', message.text()));
    page.on('pageerror', (error) => log('chromium', `page error: ${error.message}`));

    const url =
      `http://127.0.0.1:${HARNESS_PORT}/harness.html` +
      `?relay=${encodeURIComponent(`https://127.0.0.1:${RELAY_PORT}`)}` +
      `&certhash=${fingerprint}` +
      `&ns=${encodeURIComponent(NAMESPACE)}` +
      `&tracks=${TRACKS.join(',')}`;

    await page.goto(url);

    // Wait for the slowest track (meta at 0.5 Hz) to deliver a few objects.
    await page.waitForFunction(
      (tracks) => {
        const state = window.__MOQ_E2E__;
        if (!state || state.status === 'error') return true;
        return tracks.every((track) => (state.tracks[track]?.objects ?? 0) >= 2);
      },
      TRACKS,
      { timeout: 60_000 },
    );

    const beforeUnsubscribe = await page.evaluate(() =>
      JSON.parse(JSON.stringify(window.__MOQ_E2E__)),
    );
    if (beforeUnsubscribe.status === 'error') {
      throw new Error(`browser client failed: ${beforeUnsubscribe.error}`);
    }

    // Unsubscribing must actually stop the flow, not just hide it.
    await page.evaluate(() => window.__MOQ_E2E_UNSUBSCRIBE__('region-0'));
    const atUnsubscribe = await page.evaluate(
      () => window.__MOQ_E2E__.tracks['region-0'].objects,
    );
    await page.waitForTimeout(3_000);
    const afterUnsubscribe = await page.evaluate(
      () => window.__MOQ_E2E__.tracks['region-0'].objects,
    );

    return { state: beforeUnsubscribe, atUnsubscribe, afterUnsubscribe };
  } finally {
    await browser.close();
  }
}

async function runDemoPage(fingerprint) {
  const playwright = await import(join(CLIENT, 'node_modules/playwright-core/index.js'));
  const chromium = playwright.chromium ?? playwright.default?.chromium;

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => log('page', `page error: ${error.message}`));

    await page.goto(
      `http://127.0.0.1:${HARNESS_PORT}/page.html` +
        `?relay=${encodeURIComponent(`https://127.0.0.1:${RELAY_PORT}`)}` +
        `&certhash=${fingerprint}` +
        `&ns=${encodeURIComponent(NAMESPACE)}`,
    );

    await page.click('[data-testid="moq-connect"]');
    // Gate on the meta track too: at 0.5 Hz it is the last one to report, so
    // waiting on region-0 alone would sample the page before meta arrives.
    await page.waitForFunction(
      () => {
        const tracks = window.__MOQ_DEMO__?.tracks ?? {};
        return (tracks['region-0']?.objects ?? 0) >= 3 && (tracks['meta']?.objects ?? 0) >= 1;
      },
      undefined,
      { timeout: 60_000 },
    );

    const connected = await page.evaluate(() => JSON.parse(JSON.stringify(window.__MOQ_DEMO__)));

    // Unticking a region must tear the subscription down through the UI path.
    await page.uncheck('[data-testid="moq-toggle-region-1"]');
    await page.waitForTimeout(1_000);
    const atUncheck = await page.evaluate(() => window.__MOQ_DEMO__.tracks['region-1'].objects);
    await page.waitForTimeout(3_000);
    const afterUncheck = await page.evaluate(() => window.__MOQ_DEMO__.tracks['region-1'].objects);

    const canvasIsPainted = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return false;
      const context = canvas.getContext('2d');
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const colours = new Set();
      for (let index = 0; index < data.length; index += 4) {
        colours.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
      }
      // A blank canvas is one or two colours; a live world grid is many more.
      return colours.size > 4;
    });

    const logText = await page.textContent('[data-testid="moq-log"]');

    return { state: connected, atUncheck, afterUncheck, canvasIsPainted, logText };
  } finally {
    await browser.close();
  }
}

function assertPageReport({ state, atUncheck, afterUncheck, canvasIsPainted, logText }) {
  const failures = [];

  if (state.status !== 'connected') failures.push(`page status was ${state.status}`);
  if (!canvasIsPainted) failures.push('the world canvas never rendered chunk state');
  if (logText?.includes('duplicate subscription')) {
    failures.push('the page sent duplicate SUBSCRIBE requests while connecting');
  }

  for (const track of TRACKS) {
    const report = state.tracks?.[track];
    if (!report?.subscribed) failures.push(`${track}: page did not subscribe`);
    if ((report?.objects ?? 0) < 1) failures.push(`${track}: page received no objects`);
  }

  for (const region of [0, 1, 2, 3]) {
    // Each region is 8x8, so a keyframe fills all 64 slots.
    if (state.regions?.[region] !== 64) {
      failures.push(`region ${region}: page holds ${state.regions?.[region]} chunks, expected 64`);
    }
  }

  if (!state.meta) failures.push('page never decoded the meta track');

  const leaked = afterUncheck - atUncheck;
  if (leaked > 1) failures.push(`region-1 kept delivering ${leaked} objects after unticking`);

  console.log(`\n  page status: ${state.status}, canvas painted: ${canvasIsPainted}`);
  console.log(`  region-1 objects after unticking: +${leaked}`);
  console.log(`  meta: round ${state.meta?.round}, ${state.meta?.destroyedPct}% destroyed`);

  if (failures.length > 0) throw new Error(`\n  - ${failures.join('\n  - ')}`);
}

function assertReport({ state, atUnsubscribe, afterUnsubscribe }) {
  const failures = [];

  if (state.status !== 'connected') {
    failures.push(`session status was ${state.status}, expected connected`);
  }

  for (const track of TRACKS) {
    const report = state.tracks[track];
    if (!report) {
      failures.push(`${track}: no report at all`);
      continue;
    }
    if (report.error) failures.push(`${track}: ${report.error}`);
    if (!report.subscribed) failures.push(`${track}: never subscribed`);
    if (report.objects < 2) failures.push(`${track}: only ${report.objects} objects`);
    if (report.bytes === 0) failures.push(`${track}: no payload bytes`);

    if (track === 'meta') continue;

    if (report.snapshots < 1) failures.push(`${track}: never received a keyframe`);
    // Every region is an 8x8 block, so a keyframe must carry all 64 chunks.
    if (report.chunkIds.length !== 64) {
      failures.push(`${track}: saw ${report.chunkIds.length} distinct chunks, expected 64`);
    }
  }

  if (!state.meta) failures.push('meta: payload never decoded');
  else if (typeof state.meta.round !== 'number') failures.push('meta: round missing');

  const leaked = afterUnsubscribe - atUnsubscribe;
  // One object can already be in flight when UNSUBSCRIBE reaches the relay.
  if (leaked > 1) {
    failures.push(`region-0 kept delivering ${leaked} objects after UNSUBSCRIBE`);
  }

  console.log('\n  track      objects  bytes   keyframes  deltas  groups');
  for (const track of TRACKS) {
    const report = state.tracks[track] ?? {};
    console.log(
      `  ${track.padEnd(10)} ${String(report.objects ?? 0).padStart(7)}  ` +
        `${String(report.bytes ?? 0).padStart(6)}  ${String(report.snapshots ?? 0).padStart(9)}  ` +
        `${String(report.deltas ?? 0).padStart(6)}  ${String((report.groups ?? []).length).padStart(6)}`,
    );
  }
  console.log(`\n  meta: round ${state.meta?.round}, "${state.meta?.headline}"`);
  console.log(`  region-0 objects after UNSUBSCRIBE: +${leaked}`);

  if (failures.length > 0) {
    throw new Error(`\n  - ${failures.join('\n  - ')}`);
  }
}

function run(command, commandArgs, name) {
  const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.buffer = '';

  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      child.buffer += chunk;
      if (process.env.MOQ_E2E_VERBOSE) log(name, chunk.trimEnd());
    });
  }

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) log(name, `exited with code ${code}`);
  });

  children.push(child);
  return child;
}

function waitForLog(child, pattern, timeoutMs, message) {
  return new Promise((resolveWait, rejectWait) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (pattern.test(child.buffer)) {
        clearInterval(timer);
        resolveWait();
      } else if (child.exitCode !== null) {
        clearInterval(timer);
        rejectWait(new Error(`${message} (process exited)\n${child.buffer.slice(-2000)}`));
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        rejectWait(new Error(`${message} (timed out)\n${child.buffer.slice(-2000)}`));
      }
    }, 200);
  });
}

function execOrThrow(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'buffer', ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.stderr?.toString() || result.error?.message || 'unknown error'}`,
    );
  }
  return result;
}

function step(message) {
  console.log(`\n>> ${message}`);
}

function log(name, message) {
  for (const line of String(message).split('\n')) {
    if (line.trim()) console.log(`   [${name}] ${line}`);
  }
}

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  httpServer?.close();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}
