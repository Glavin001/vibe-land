/**
 * End-to-end performance run: the real server, the real client, scripted play.
 *
 * Every tick the server simulates is collected from its /match-stats tick ring
 * (300 ticks deep, polled well inside that), and the client's frame rate once a
 * second. The browser must render on the GPU: the run refuses to report a
 * software rasteriser, whose frame times say nothing about the product.
 *
 *   node client/e2e/perf-e2e.mjs --out perf.json
 *   node client/e2e/perf-e2e.mjs --out perf.json --baseline previous.json
 *
 *   --page <origin>     client origin.               default http://localhost:3003
 *   --api <origin>      server HTTP origin.          default http://127.0.0.1:4001
 *   --scenarios a,b     subset of: terrain, city_walk, city_destroy, city_rubble
 *   --seconds <n>       measured seconds per scenario. default 30
 *
 * Scenario inputs are fixed relative to wherever the player spawns (the spawn
 * point is random), so repeat runs are comparable in load, not bit-identical.
 * Run it against a freshly started server so matches start from the same world.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const PAGE = arg('page', 'http://localhost:3003');
const API = arg('api', 'http://127.0.0.1:4001');
const SECONDS = Number(arg('seconds', 30));
const OUT = arg('out', 'perf-e2e.json');
const BASELINE = arg('baseline', null);
const SCENARIOS = arg('scenarios', 'terrain,city_walk,city_destroy,city_rubble').split(',');
const BUDGET_MS = 1000 / 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (v, p) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))]; };

async function openGame(path) {
  const angle = process.platform === 'darwin' ? 'metal' : 'vulkan';
  const browser = await chromium.launch({
    args: ['--ignore-certificate-errors', '--enable-quic', `--use-angle=${angle}`, '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto(`${PAGE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 60000 });
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => window.__VIBE_E2E__.snapshot().transport === 'webtransport', null, { timeout: 90000 });
  await page.waitForFunction(() => !!window.__VIBE_DRIVE__, null, { timeout: 60000 });
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
  });
  if (/SwiftShader|llvmpipe|softpipe/i.test(renderer)) {
    await browser.close();
    throw new Error(`software renderer (${renderer}); frame rates would be meaningless`);
  }
  // Client frame rate, once a second.
  await page.evaluate(() => {
    window.__perfFps = [];
    let frames = 0, since = performance.now();
    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - since >= 1000) { window.__perfFps.push(frames * 1000 / (now - since)); frames = 0; since = now; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return { browser, page, renderer };
}

/** Collect every server tick of a match between start() and stop(). */
function tickCollector(matchId) {
  const ticks = new Map();
  let running = true, gpuWarnings = 0, gpuActive = null;
  const loop = (async () => {
    while (running) {
      try {
        const r = await fetch(`${API}/match-stats/${matchId}`);
        if (r.ok) {
          const d = await r.json();
          gpuWarnings = d.physics_gpu_warning_count; gpuActive = d.physics_gpu_active;
          for (const t of d.tick_ring || []) ticks.set(t.t, t);
        }
      } catch { /* the match may not exist yet */ }
      await sleep(1500);
    }
  })();
  return {
    reset: () => ticks.clear(),
    stop: async () => { running = false; await loop; return { ticks: [...ticks.values()].sort((a, b) => a.t - b.t), gpuWarnings, gpuActive }; },
  };
}

const snap = (page) => page.evaluate(() => window.__VIBE_E2E__.snapshot());
async function walkTo(page, x, z, ms) {
  const end = Date.now() + ms;
  await page.evaluate(() => window.__VIBE_DRIVE__.setSprint(true));
  while (Date.now() < end) {
    const s = await snap(page);
    if (Math.hypot(x - s.position[0], z - s.position[2]) < 3) break;
    await page.evaluate(([x, z]) => { window.__VIBE_DRIVE__.lookAt(x, 1.5, z); window.__VIBE_DRIVE__.move({ forward: 1, durationMs: 700 }); }, [x, z]);
    await sleep(400);
  }
}
/** Walk a closed loop of offsets around the spawn point until `ms` elapses. */
async function patrol(page, offsets, ms) {
  const s0 = await snap(page);
  const end = Date.now() + ms;
  for (let i = 0; Date.now() < end; i = (i + 1) % offsets.length) {
    const [dx, dz] = offsets[i];
    await walkTo(page, s0.position[0] + dx, s0.position[2] + dz, Math.min(8000, end - Date.now()));
  }
  await page.evaluate(() => window.__VIBE_DRIVE__.stop());
}

async function scenario(name, path, matchId, body) {
  console.log(`== ${name}`);
  const { browser, page, renderer } = await openGame(path);
  await sleep(4000);
  const collector = tickCollector(matchId);
  await sleep(1600);
  collector.reset();
  await page.evaluate(() => { window.__perfFps = []; });
  await body(page);
  const { ticks, gpuWarnings, gpuActive } = await collector.stop();
  const fps = await page.evaluate(() => window.__perfFps);
  await browser.close();
  const total = ticks.map((t) => t.total), dyn = ticks.map((t) => t.dyn_ms), city = ticks.map((t) => t.city);
  const result = {
    scenario: name, renderer, ticks: total.length, gpu_active: gpuActive, gpu_warnings: gpuWarnings,
    tick_p50: pct(total, 50), tick_p90: pct(total, 90), tick_p99: pct(total, 99), tick_max: pct(total, 100),
    over_budget: total.filter((ms) => ms > BUDGET_MS).length,
    physics_p50: pct(dyn, 50), physics_max: pct(dyn, 100), city_p50: pct(city, 50), city_max: pct(city, 100),
    awake_max: Math.max(0, ...ticks.map((t) => t.awake ?? 0)),
    client_fps_p50: pct(fps, 50), client_fps_min: pct(fps, 0),
  };
  console.log(JSON.stringify(result));
  return result;
}

const ms = SECONDS * 1000;
const loop = [[12, 0], [12, 12], [0, 12], [0, 0]];
const results = [];
for (const name of SCENARIOS) {
  if (name === 'terrain') {
    results.push(await scenario(name, '/play?match=default', 'default', (page) => patrol(page, loop, ms)));
  } else if (name === 'city_walk') {
    results.push(await scenario(name, '/city', 'city-default', (page) => patrol(page, loop, ms)));
  } else if (name === 'city_destroy') {
    results.push(await scenario(name, '/city', 'city-default', async (page) => {
      const s = await snap(page);
      const r = Math.hypot(s.position[0], s.position[2]);
      // The building face 22 m in and 14 m to the right of the spawn, as the
      // demo recordings aim; then a demolition across the street.
      const at = (d, lat) => [s.position[0] * (1 - d / r) - (s.position[2] / r) * lat, s.position[2] * (1 - d / r) + (s.position[0] / r) * lat];
      const [ax, az] = at(22, 14);
      const end = Date.now() + ms;
      await page.evaluate(() => window.__VIBE_E2E__.setCannonball(true));
      for (const h of [3, 6, 9, 5]) {
        await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [ax, h, az]);
        await sleep(500);
        for (let i = 0; i < 2; i++) { await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 250 })); await sleep(1600); }
      }
      const [dx, dz] = at(24, -14);
      await fetch(`${API}/city-demolish/city-default`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: dx, z: dz, radius_m: 10, below_y: 8, rounds: 48 }),
      });
      await sleep(Math.max(0, end - Date.now()));
    }));
  } else if (name === 'city_rubble') {
    // Runs after city_destroy on the same server: walk through what it left.
    results.push(await scenario(name, '/city', 'city-default', async (page) => {
      const s = await snap(page);
      const r = Math.hypot(s.position[0], s.position[2]);
      const toward = [[-s.position[0] * 22 / r, -s.position[2] * 22 / r], [0, 0]];
      await patrol(page, toward, ms);
    }));
  }
}

const report = { when: new Date().toISOString(), page: PAGE, api: API, seconds: SECONDS, results };
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nreport: ${OUT}`);
const table = (rows) => rows.map((r) => `${r.scenario.padEnd(13)} tick p50 ${r.tick_p50?.toFixed(2)} p99 ${r.tick_p99?.toFixed(2)} max ${r.tick_max?.toFixed(1)} over ${r.over_budget}/${r.ticks} | fps p50 ${r.client_fps_p50?.toFixed(0)} min ${r.client_fps_min?.toFixed(0)} | gpu warnings ${r.gpu_warnings}`).join('\n');
console.log(table(results));
if (BASELINE) {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')).results;
  console.log('\nvs baseline (tick p50 / p99 / max, ms):');
  for (const r of results) {
    const b = base.find((x) => x.scenario === r.scenario);
    if (b) console.log(`${r.scenario.padEnd(13)} ${b.tick_p50.toFixed(2)} -> ${r.tick_p50.toFixed(2)} | ${b.tick_p99.toFixed(2)} -> ${r.tick_p99.toFixed(2)} | ${b.tick_max.toFixed(1)} -> ${r.tick_max.toFixed(1)}`);
  }
}
