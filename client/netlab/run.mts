#!/usr/bin/env node
/**
 * netlab — netcode quality measurement runner.
 *
 *   npm run netlab -- run --scenario city-strafe [--impair lte] [--impair-mode inproc|netem]
 *                        [--iterations 3] [--stack dev|attach] [--duration 30000]
 *   npm run netlab -- list-scenarios
 *
 * Per run it produces results/<ts>_<scenario>_<impair>/iter<N>/ containing
 * run.json, frames.clientK.csv, events.clientK.jsonl, server-stats.jsonl.
 * `analyze` (P3) consumes those artifacts.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { GPU_ARGS } from '../e2e/helpers/gpuArgs';
import { defaultStackConfig, fetchMatchStats, startStack, CLIENT_DIR, REPO_ROOT } from './stack';
import { startServerStatsTap } from './serverStats';
import { runDriveTimeline, startWatch, type DriveClientSpec, type DriveStep } from './drive';
import { analyzeIteration, type IterationVerdict } from './analyze';
import { renderReport, summaryLine } from './report';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const RESULTS_DIR = path.join(__dirname, 'results');
const NETEM_SH = path.join(REPO_ROOT, 'scripts', 'netem.sh');

// ---------------------------------------------------------------------------
// Scenario spec
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  description?: string;
  symptom?: string[];
  /** Page path with query, e.g. "/play?match=netlab-strafe-{iter}&autostart=1". */
  path: string;
  matchId: string;
  durationMs: number;
  /** 'click' presses the join overlay; 'auto' assumes the page self-connects. */
  join?: 'click' | 'auto';
  clients: DriveClientSpec[];
  impairment?: { profile?: string; mode?: 'inproc' | 'netem' | 'none'; seed?: number };
  iterations?: number;
  /** Extra env for the spawned game server (city scene, physics backend, ...). */
  serverEnv?: Record<string, string>;
}

function loadScenario(name: string): Scenario {
  const file = path.join(SCENARIOS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    const available = fs
      .readdirSync(SCENARIOS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
    throw new Error(`unknown scenario '${name}'. Available: ${available.join(', ')}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Scenario;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  scenario: string;
  impair: string | null;
  impairMode: 'inproc' | 'netem' | 'none';
  impairSeed: number;
  iterations: number | null;
  durationMs: number | null;
  stack: 'attach' | 'dev';
  clientUrl: string | null;
  serverUrl: string | null;
  headless: boolean;
  /** Deliberate fault injection, used to verify the harness detects each layer. */
  fault: 'none' | 'render-stall' | 'server-stall';
}

function parseArgs(argv: string[]): { command: string; opts: CliOptions } {
  const command = argv[0] ?? 'help';
  const opts: CliOptions = {
    scenario: '',
    impair: null,
    impairMode: 'inproc',
    impairSeed: 42,
    iterations: null,
    durationMs: null,
    stack: 'attach',
    clientUrl: null,
    serverUrl: null,
    headless: false,
    fault: 'none',
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case '--scenario': opts.scenario = next(); break;
      case '--impair': opts.impair = next(); break;
      case '--impair-mode': opts.impairMode = next() as CliOptions['impairMode']; break;
      case '--impair-seed': opts.impairSeed = Number(next()); break;
      case '--iterations': opts.iterations = Number(next()); break;
      case '--duration': opts.durationMs = Number(next()); break;
      case '--stack': opts.stack = next() as CliOptions['stack']; break;
      case '--client-url': opts.clientUrl = next(); break;
      case '--server-url': opts.serverUrl = next(); break;
      case '--headless': opts.headless = true; break;
      case '--fault': opts.fault = next() as CliOptions['fault']; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return { command, opts };
}

// ---------------------------------------------------------------------------
// Display (headful Chrome needs an X server; spawn Xvfb when there is none)
// ---------------------------------------------------------------------------

function ensureDisplay(): { display: string; cleanup(): void } {
  if (process.env.DISPLAY) {
    return { display: process.env.DISPLAY, cleanup: () => {} };
  }
  const display = ':77';
  const xvfb: ChildProcess = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24'], {
    stdio: 'ignore',
    detached: true,
  });
  xvfb.unref();
  console.log(`[netlab] no DISPLAY — started Xvfb on ${display}`);
  return {
    display,
    cleanup: () => {
      if (xvfb.pid) {
        try { process.kill(xvfb.pid, 'SIGTERM'); } catch { /* gone */ }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function waitForBridge(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__VIBE_E2E__, { timeout: 30_000 });
}

async function waitForConnected(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const b = (window as any).__VIBE_E2E__;
      if (!b) return false;
      const s = b.snapshot();
      return s.playerId > 0 || s.mode === 'practice';
    },
    { timeout: timeoutMs },
  );
}

async function clickJoin(page: Page): Promise<void> {
  const overlay = page.locator('[data-testid="join-overlay"]');
  if (await overlay.isVisible({ timeout: 5000 }).catch(() => false)) {
    await overlay.click();
  } else {
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.mouse.click(viewport.width / 2, viewport.height / 2);
  }
}

async function readGpuRenderer(page: Page): Promise<string> {
  return page.evaluate(() => {
    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl2') ?? (canvas.getContext('webgl') as WebGLRenderingContext | null);
      if (!gl) return 'no-webgl';
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (!info) return 'no-debug-renderer-info';
      return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    } catch (err) {
      return `error: ${String(err)}`;
    }
  });
}

// ---------------------------------------------------------------------------
// Recorder drain loop
// ---------------------------------------------------------------------------

interface DrainState {
  frameCursor: number;
  eventCursor: number;
  framesPath: string;
  eventsPath: string;
  wroteHeader: boolean;
  lostFrames: number;
  lostEvents: number;
}

async function drainOnce(page: Page, state: DrainState): Promise<void> {
  const drained = await page.evaluate(
    ([fromFrame, fromEvent]) => {
      const r = (window as any).__VIBE_RECORDER__;
      if (!r) return null;
      return {
        frames: r.drainFrames(fromFrame, 4096),
        events: r.drainEvents(fromEvent, 4096),
      };
    },
    [state.frameCursor, state.eventCursor] as [number, number],
  );
  if (!drained) return;

  const { frames, events } = drained;
  if (frames.rows.length > 0 || !state.wroteHeader) {
    let chunk = '';
    if (!state.wroteHeader) {
      chunk += frames.schema.join(',') + '\n';
      state.wroteHeader = true;
    }
    for (const row of frames.rows) chunk += row.join(',') + '\n';
    fs.appendFileSync(state.framesPath, chunk);
  }
  state.frameCursor = frames.nextIndex;
  state.lostFrames += frames.lostFrames;

  if (events.events.length > 0) {
    fs.appendFileSync(
      state.eventsPath,
      events.events.map((e: unknown) => JSON.stringify(e)).join('\n') + '\n',
    );
  }
  state.eventCursor = events.nextSeq;
  state.lostEvents += events.lostEvents;
}

// ---------------------------------------------------------------------------
// netem control (P4 script; used here when --impair-mode netem)
// ---------------------------------------------------------------------------

function netemApply(profile: string, udpPort: number): void {
  if (!fs.existsSync(NETEM_SH)) {
    throw new Error(`--impair-mode netem requires ${NETEM_SH}`);
  }
  const result = spawnSync(
    'bash',
    [NETEM_SH, 'apply', profile, '--ports', String(udpPort), '--ttl', '1800'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    // netem.sh already printed why (usually a missing CAP_NET_ADMIN). Failing
    // here is deliberate: silently continuing would produce a run labelled
    // "impaired" whose link was never actually impaired.
    throw new Error(
      `netem.sh apply ${profile} failed — see the message above. ` +
        'Re-run with --impair-mode inproc for the privilege-free deterministic alternative.',
    );
  }
}

function netemClear(): void {
  if (!fs.existsSync(NETEM_SH)) return;
  spawnSync('bash', [NETEM_SH, 'clear'], { stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function gitRev(): string {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

async function runIteration(
  browser: Browser,
  scenario: Scenario,
  opts: CliOptions,
  clientUrl: string,
  serverHttpUrl: string,
  iterDir: string,
  iteration: number,
  serverPid: number | null,
): Promise<void> {
  fs.mkdirSync(iterDir, { recursive: true });
  const matchId = scenario.matchId.replace('{iter}', String(iteration));
  const statsTap = startServerStatsTap(serverHttpUrl, path.join(iterDir, 'server-stats.jsonl'));

  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  const drains: DrainState[] = [];
  const watchers: Array<{ stop(): void }> = [];
  const consoleLogs: fs.WriteStream[] = [];

  try {
    // -- Launch clients and get them connected ----------------------------
    // Clients carrying a joinDelayMs are launched later, concurrently with the
    // drive timelines already running, so a late joiner arrives at a world the
    // earlier clients have already changed.
    const launchClient = async (k: number): Promise<void> => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
        // NETLAB_RECORD_VIDEO=1: capture the client's actual pixels. This is
        // the honest perceptual instrument -- the Rust view models in
        // record-city-trace diverged from the shipping client three separate
        // ways (topology timing, lane healing, support-COM convention), and
        // every one of them read as a codec defect on video when it wasn't.
        ...(process.env.NETLAB_RECORD_VIDEO === '1'
          ? { recordVideo: { dir: iterDir, size: { width: 1280, height: 720 } } }
          : {}),
      });
      contexts.push(context);
      const page = await context.newPage();
      pages[k] = page;

      const logStream = fs.createWriteStream(path.join(iterDir, `console.client${k}.log`));
      consoleLogs.push(logStream);
      page.on('console', (msg) => logStream.write(`[${msg.type()}] ${msg.text()}\n`));
      page.on('pageerror', (err) => logStream.write(`[pageerror] ${err.stack ?? err.message}\n`));

      const url = new URL(scenario.path.replace('{iter}', String(iteration)), clientUrl);
      url.searchParams.set('match', matchId);
      if (opts.impair && opts.impairMode === 'inproc') {
        url.searchParams.set('netlab', '1');
        url.searchParams.set('impair', opts.impair);
        url.searchParams.set('impairSeed', String(opts.impairSeed + k * 101));
      }
      if (opts.fault === 'render-stall' && k === 0) {
        // Block the main thread for 200 ms every 2 s. Injected from the runner
        // rather than the app so verification never ships in production code.
        await page.addInitScript(() => {
          setInterval(() => {
            const until = performance.now() + 200;
            while (performance.now() < until) {
              /* deliberate main-thread stall */
            }
          }, 2000);
        });
      }

      console.log(`[netlab] client${k} (${scenario.clients[k].role}) -> ${url.href}`);
      await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      await waitForBridge(page);
      if ((scenario.join ?? 'click') === 'click') await clickJoin(page);
      await waitForConnected(page, 60_000);
      // 200 city events/s/type: enough samples to attribute a burst without
      // drowning the ring (exact totals are kept regardless of the cap).
      await page.evaluate(() =>
        (window as any).__VIBE_RECORDER__.start({ cityEventsPerSecond: 200 }),
      );
      drains[k] = {
        frameCursor: 0,
        eventCursor: 0,
        framesPath: path.join(iterDir, `frames.client${k}.csv`),
        eventsPath: path.join(iterDir, `events.client${k}.jsonl`),
        wroteHeader: false,
        lostFrames: 0,
        lostEvents: 0,
      };
      // The first seconds after connect are their own regime: whatever the
      // client drew before the reliable channel caught up is only visible
      // here, not in an end-of-run frame.
      for (const atMs of [500, 2000, 6000]) {
        void (async () => {
          await new Promise((r) => setTimeout(r, atMs));
          await page
            .screenshot({ path: path.join(iterDir, `join+${atMs}ms.client${k}.png`) })
            .catch(() => {});
        })();
      }
    };

    for (let k = 0; k < scenario.clients.length; k += 1) {
      if (!scenario.clients[k].joinDelayMs) await launchClient(k);
    }

    const gpuRenderer = await readGpuRenderer(pages[0]);
    if (/swiftshader/i.test(gpuRenderer)) {
      console.warn(`[netlab] WARNING: rendering on ${gpuRenderer} — frame timings are not GPU-representative`);
    }


    // -- Observers track their targets ------------------------------------
    for (let k = 0; k < scenario.clients.length; k += 1) {
      const watch = scenario.clients[k].watch;
      if (!watch) continue;
      const targetIdx = scenario.clients.findIndex((c) => c.role === watch);
      if (targetIdx >= 0) watchers.push(startWatch(pages[k], pages[targetIdx]));
    }

    // -- Optional server stall, to prove SERVER attribution ----------------
    let serverStallTimer: NodeJS.Timeout | null = null;
    if (opts.fault === 'server-stall' && serverPid) {
      serverStallTimer = setInterval(() => {
        try {
          process.kill(serverPid, 'SIGSTOP');
          setTimeout(() => {
            try { process.kill(serverPid, 'SIGCONT'); } catch { /* exited */ }
          }, 300);
        } catch {
          /* server already gone */
        }
      }, 5000);
    }

    // -- Drive + drain until the scenario duration elapses -----------------
    const startedAtMs = Date.now();
    const durationMs = opts.durationMs ?? scenario.durationMs;
    const drivePromises = scenario.clients.map(async (client, k) => {
      const joinDelayMs = client.joinDelayMs ?? 0;
      if (joinDelayMs > 0) {
        // Late joiner: the earlier clients are already driving by now.
        const wait = startedAtMs + joinDelayMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        console.log(`[netlab] client${k} (${client.role}) joining late at t+${Math.round(joinDelayMs / 1000)}s`);
        await launchClient(k);
      }
      return runDriveTimeline(pages[k], client.drive ?? [], startedAtMs, `client${k}`);
    });

    while (Date.now() - startedAtMs < durationMs) {
      await new Promise((r) => setTimeout(r, 5000));
      for (let k = 0; k < pages.length; k += 1) {
        if (!pages[k] || !drains[k]) continue; // not joined yet
        await drainOnce(pages[k], drains[k]).catch((err) =>
          console.warn(`[netlab] drain failed for client${k}:`, err),
        );
      }
      const elapsed = ((Date.now() - startedAtMs) / 1000).toFixed(0);
      console.log(`[netlab] t+${elapsed}s frames=${drains.map((d) => d.frameCursor).join('/')}`);
    }
    await Promise.allSettled(drivePromises);
    if (serverStallTimer) {
      clearInterval(serverStallTimer);
      if (serverPid) {
        try { process.kill(serverPid, 'SIGCONT'); } catch { /* exited */ }
      }
    }
    for (const w of watchers) w.stop();

    // -- Stop, final drain, provenance ------------------------------------
    const stopResults: unknown[] = [];
    for (let k = 0; k < pages.length; k += 1) {
      if (!pages[k] || !drains[k]) {
        stopResults.push(null);
        continue;
      }
      stopResults.push(
        await pages[k].evaluate(() => (window as any).__VIBE_RECORDER__.stop()),
      );
      await drainOnce(pages[k], drains[k]);
    }

    // Resync differential: the strongest sync proof available. Snapshot every
    // chunk's ledger pose, force a fresh bootstrap from the server, snapshot
    // again, count chunks that moved (>2 cm — double the wire quantum). Any
    // count > 0 means the client had silently diverged from server truth in a
    // way no streaming-path detector could see.
    const resyncDivergence: Array<number | null> = [];
    for (let k = 0; k < pages.length; k += 1) {
      if (!pages[k]) {
        resyncDivergence.push(null);
        continue;
      }
      const divergent = await pages[k]
        .evaluate(async () => {
          const dbg = (window as any).__VIBE_CITY_DEBUG__;
          if (!dbg) return null;
          const before: number[] = dbg.snapshotLedger();
          const generation: number = dbg.bootstrapCount();
          dbg.requestResync();
          const deadline = Date.now() + 8000;
          while (dbg.bootstrapCount() === generation && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
          }
          if (dbg.bootstrapCount() === generation) return -1; // bootstrap never arrived
          const after: number[] = dbg.snapshotLedger();
          let moved = 0;
          let maxDelta = 0;
          const samples: Array<{ slot: number; d: number }> = [];
          for (let i = 0; i < before.length; i += 3) {
            const dx = after[i] - before[i];
            const dy = after[i + 1] - before[i + 1];
            const dz = after[i + 2] - before[i + 2];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d > maxDelta) maxDelta = d;
            if (d > 0.02) {
              moved += 1;
              if (samples.length < 5) samples.push({ slot: i / 3, d: Number(d.toFixed(3)) });
            }
          }
          console.log('[netlab-differential]', JSON.stringify({ moved, maxDelta: Number(maxDelta.toFixed(3)), samples }));
          return moved;
        })
        .catch(() => null);
      resyncDivergence.push(divergent);
      if (divergent !== null) {
        console.log(
          `[netlab] client${k} resync differential: ${divergent === -1 ? 'BOOTSTRAP TIMEOUT' : `${divergent} divergent chunks`}`,
        );
      }
    }

    // Ground truth for "what did the player actually see": the metrics all read
    // the model, so a screenshot is the only artifact that can contradict them.
    for (let k = 0; k < pages.length; k += 1) {
      if (!pages[k]) continue;
      await pages[k]
        .screenshot({ path: path.join(iterDir, `screen.client${k}.png`) })
        .catch(() => {});
    }

    const matchStats = await fetchMatchStats(serverHttpUrl, matchId);
    const runInfo = {
      scenario: scenario.name,
      iteration,
      matchId,
      startedAtIso: new Date(startedAtMs).toISOString(),
      durationMs,
      clients: scenario.clients.map((c, k) => ({
        index: k,
        role: c.role,
        watch: c.watch ?? null,
        recorder: stopResults[k],
        resyncDivergentChunks: resyncDivergence[k],
        lostFrames: drains[k]?.lostFrames ?? 0,
        lostEvents: drains[k]?.lostEvents ?? 0,
      })),
      impairment: {
        profile: opts.impair,
        mode: opts.impair ? opts.impairMode : 'none',
        seed: opts.impairSeed,
      },
      injectedFault: opts.fault,
      environment: {
        gitRev: gitRev(),
        gpuRenderer,
        serverBuild: (matchStats as { server_build?: string } | null)?.server_build ?? null,
        serverStarted: (matchStats as { server_started?: string } | null)?.server_started ?? null,
        clientUrl,
        serverHttpUrl,
        node: process.version,
      },
      serverStatsMessages: statsTap.count(),
    };
    fs.writeFileSync(path.join(iterDir, 'run.json'), JSON.stringify(runInfo, null, 2));
    if (matchStats) {
      fs.writeFileSync(path.join(iterDir, 'match-stats.final.json'), JSON.stringify(matchStats, null, 2));
    }
    console.log(`[netlab] iteration ${iteration} artifacts -> ${iterDir}`);

    try {
      const verdict = analyzeIteration(iterDir);
      writeVerdict(iterDir, verdict);
      console.log(`[netlab] iteration ${iteration}: ${summaryLine(verdict)}`);
    } catch (err) {
      console.warn('[netlab] analysis failed (artifacts are intact, re-run with `analyze`):', err);
    }
  } finally {
    for (const w of watchers) w.stop();
    await statsTap.close();
    for (const context of contexts) await context.close().catch(() => {});
    for (const log of consoleLogs) log.end();
  }
}

async function commandRun(opts: CliOptions): Promise<void> {
  if (!opts.scenario) throw new Error('run requires --scenario <name>');
  const scenario = loadScenario(opts.scenario);
  const iterations = opts.iterations ?? scenario.iterations ?? 1;

  // Scenario-level defaults for impairment, CLI wins.
  if (!opts.impair && scenario.impairment?.profile) {
    opts.impair = scenario.impairment.profile;
    opts.impairMode = scenario.impairment.mode ?? opts.impairMode;
    opts.impairSeed = scenario.impairment.seed ?? opts.impairSeed;
  }

  const stackConfig = defaultStackConfig(opts.stack);
  if (opts.clientUrl) stackConfig.clientUrl = opts.clientUrl;
  if (opts.serverUrl) stackConfig.serverHttpUrl = opts.serverUrl;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(RESULTS_DIR, `${stamp}_${scenario.name}_${opts.impair ?? 'baseline'}`);
  fs.mkdirSync(runDir, { recursive: true });
  console.log(`[netlab] run dir: ${runDir}`);

  const displayHandle = ensureDisplay();
  const stack = await startStack(
    stackConfig,
    path.join(runDir, 'stack-logs'),
    scenario.serverEnv ?? {},
  );
  let browser: Browser | null = null;
  let netemActive = false;

  const cleanup = async (): Promise<void> => {
    if (netemActive) {
      netemClear();
      netemActive = false;
    }
    await browser?.close().catch(() => {});
    await stack.shutdown();
    displayHandle.cleanup();
  };
  const onSignal = (): void => {
    void cleanup().then(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    if (opts.impair && opts.impairMode === 'netem') {
      netemApply(opts.impair, stack.wtUdpPort);
      netemActive = true;
    }

    browser = await chromium.launch({
      channel: 'chrome',
      headless: opts.headless,
      args: GPU_ARGS,
      env: { ...process.env, DISPLAY: displayHandle.display },
    });

    for (let iter = 1; iter <= iterations; iter += 1) {
      console.log(`[netlab] === iteration ${iter}/${iterations} ===`);
      await runIteration(
        browser,
        scenario,
        opts,
        stack.clientUrl,
        stack.serverHttpUrl,
        path.join(runDir, `iter${iter}`),
        iter,
        stack.serverPid,
      );
    }
    console.log(`[netlab] done. Results: ${runDir}`);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}

function writeVerdict(iterDir: string, verdict: IterationVerdict): void {
  fs.writeFileSync(path.join(iterDir, 'verdict.json'), JSON.stringify(verdict, null, 2));
  fs.writeFileSync(path.join(iterDir, 'report.md'), renderReport(verdict));
}

/** Analyze one iteration dir, or every iter* under a run dir. */
function commandAnalyze(target: string): void {
  const dirs = fs.existsSync(path.join(target, 'run.json'))
    ? [target]
    : fs
        .readdirSync(target)
        .filter((d) => d.startsWith('iter'))
        .map((d) => path.join(target, d));
  if (dirs.length === 0) throw new Error(`no iterations found under ${target}`);
  for (const dir of dirs) {
    const verdict = analyzeIteration(dir);
    writeVerdict(dir, verdict);
    console.log(`${dir}: ${summaryLine(verdict)}`);
    console.log(`  report: ${path.join(dir, 'report.md')}`);
  }
}

/** Compare two analyzed iterations metric-by-metric. */
function commandCompare(dirA: string, dirB: string): void {
  const load = (d: string): IterationVerdict => {
    const p = path.join(d, 'verdict.json');
    if (!fs.existsSync(p)) {
      const verdict = analyzeIteration(d);
      writeVerdict(d, verdict);
      return verdict;
    }
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as IterationVerdict;
  };
  const a = load(dirA);
  const b = load(dirB);
  console.log(`A: ${dirA}\nB: ${dirB}\n`);
  console.log(`${'metric'.padEnd(26)} ${'A'.padStart(10)} ${'B'.padStart(10)} ${'Δ'.padStart(10)}`);
  const clientsToShow = Math.min(a.clients.length, b.clients.length);
  for (let k = 0; k < clientsToShow; k += 1) {
    const ma = a.clients[k].metrics as unknown as Record<string, unknown>;
    const mb = b.clients[k].metrics as unknown as Record<string, unknown>;
    console.log(`-- client${k} (${a.clients[k].metrics.role})`);
    for (const key of Object.keys(ma)) {
      const va = ma[key];
      const vb = mb[key];
      if (typeof va !== 'number' || typeof vb !== 'number') continue;
      if (!Number.isFinite(va) && !Number.isFinite(vb)) continue;
      const delta = vb - va;
      const highlight = Math.abs(delta) > Math.max(0.25 * Math.abs(va), 1e-6) && Math.abs(delta) > 0.01;
      console.log(
        `${key.padEnd(26)} ${va.toFixed(2).padStart(10)} ${vb.toFixed(2).padStart(10)} ${delta.toFixed(2).padStart(10)}${highlight ? '  <<' : ''}`,
      );
    }
  }
}

function commandListScenarios(): void {
  const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const s = JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, file), 'utf-8')) as Scenario;
    const symptoms = s.symptom?.length ? ` [${s.symptom.join(', ')}]` : '';
    console.log(`${s.name.padEnd(18)} ${s.description ?? ''}${symptoms}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'help';
  switch (command) {
    case 'run': {
      const { opts } = parseArgs(argv);
      await commandRun(opts);
      break;
    }
    case 'list-scenarios':
      commandListScenarios();
      break;
    case 'analyze':
      commandAnalyze(argv[1] ?? '.');
      break;
    case 'compare':
      commandCompare(argv[1], argv[2]);
      break;
    default:
      console.log('usage: npm run netlab -- run --scenario <name> [--impair <profile>] [--impair-mode inproc|netem]');
      console.log('       npm run netlab -- analyze <runDir|iterDir>');
      console.log('       npm run netlab -- compare <iterDirA> <iterDirB>');
      console.log('       npm run netlab -- list-scenarios');
      process.exitCode = command === 'help' ? 0 : 1;
  }
}

main().catch((err) => {
  console.error('[netlab] fatal:', err);
  process.exit(1);
});
