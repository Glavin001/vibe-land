// Performance through heavy destruction in the native app
// (scripts/native-mac.sh perf): a scripted sequence from a fixed overview
// camera, every rendered frame and the sim's own stats sampled throughout,
// summarised per phase.
//
//   idle               the intact city
//   building meteor    the server meteor on the tallest building
//   cannonballs        four cannonballs through the buggy
//   car meteor         the meteor on the monster truck
//   triple meteor      three buildings hit at once
//
// Per phase: render frame time (median, p95, p99, worst; frames over 20 ms,
// i.e. a missed 60 Hz frame), the sim's ticks per second (worst 1 s window),
// its tick time (worst reported avg and max) and PhysX step, and the peak
// awake chunks / broken bonds.
import { joinDropPose } from '../e2e/helpers/vehicleQaCore.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`[perf] ${text}`);

async function waitFor(what, predicate, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);

/** Time GPU object creation, so a stall can be traced to a pipeline compile. */
function timeGpuCreation() {
  const gpu = navigator.gpu;
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (options) => {
    const adapter = await requestAdapter(options);
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const device = await requestDevice(descriptor);
      for (const name of ['createRenderPipeline', 'createComputePipeline', 'createShaderModule']) {
        const original = device[name].bind(device);
        device[name] = (desc) => {
          const started = performance.now();
          const result = original(desc);
          const ms = performance.now() - started;
          slowCreates.push({ phase, name, ms, label: desc?.label ?? '' });
          return result;
        };
      }
      return device;
    };
    return adapter;
  };
}
const slowCreates = [];
let phase = 'boot';

async function run() {
  timeGpuCreation();
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  const drive = await waitFor('the drive bridge', () => globalThis.__VIBE_DRIVE__);
  const session = await waitFor('the in-process session', () => globalThis.__VIBE_NATIVE_SESSION__);
  await waitFor('the city', () => (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0 && e2e.cityStructures().length > 0);
  await sleep(4000);
  session.reset();
  await sleep(3000);

  // Samples, tagged with the phase they fell in.
  phase = 'warmup';
  const frames = [];
  const stats = [];
  let last = performance.now();
  let phaseStarted = performance.now();
  const longFrames = [];
  const onFrame = (now) => {
    if (now - last > 100) longFrames.push({ phase, ms: now - last, into: last - phaseStarted });
    frames.push({ phase, ms: now - last });
    last = now;
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
  const sampler = setInterval(() => {
    const s = e2e.matchStats() ?? {};
    const city = e2e.snapshot()?.city ?? {};
    stats.push({
      phase,
      at: performance.now(),
      tick: s.server_tick,
      tickAvg: s.timings?.total_ms?.avg,
      tickMax: s.timings?.total_ms?.max,
      physx: s.physics_last_step_ms,
      awake: city.chunksAwake ?? 0,
      bonds: city.brokenBonds ?? 0,
    });
  }, 100);

  const structures = e2e.cityStructures();
  const centre = [0, 2].map((i) => structures.reduce((sum, s) => sum + s.position[i], 0) / structures.length);
  e2e.setCapturePose({ position: [centre[0] + 85, 38, centre[1] + 70], lookAt: [centre[0] + 20, 3, centre[1]] });
  const carAt = (car) => JSON.parse(session.vehicleDebug(car)).snapshot?.position ?? [63, 0.8, car === 0 ? 8 : -8];
  const byHeight = [...structures].sort((a, b) => b.top - a.top);

  const enter = (name) => { phase = name; phaseStarted = performance.now(); };
  enter('idle');
  await sleep(4000);

  enter('building meteor');
  const tallest = byHeight[0];
  session.meteor(tallest.position[0], Math.min(tallest.top, 8), tallest.position[2]);
  await sleep(10000);

  enter('cannonballs');
  const buggy = carAt(4);
  log(`dropAt at ${(performance.now() - phaseStarted).toFixed(0)} ms into "cannonballs"; vehicles known ${e2e.snapshot().vehicles?.length ?? 0}`);
  e2e.dropAt(joinDropPose([buggy[0] + 10, 1, buggy[2]]));
  await sleep(1500);
  e2e.setShotMode('cannonball');
  for (let i = 0; i < 4; i += 1) {
    const at = carAt(4);
    drive.lookAt(at[0], at[1] + 0.5, at[2]);
    await sleep(200);
    drive.fire({ holdMs: 60 });
    await sleep(1300);
  }
  await sleep(3000);

  enter('car meteor');
  const truck = carAt(0);
  session.meteor(truck[0], truck[1], truck[2]);
  await sleep(8000);

  enter('triple meteor');
  for (const s of byHeight.slice(1, 4)) session.meteor(s.position[0], Math.min(s.top, 8), s.position[2]);
  await sleep(12000);
  clearInterval(sampler);

  for (const name of ['idle', 'building meteor', 'cannonballs', 'car meteor', 'triple meteor']) {
    const ms = frames.filter((f) => f.phase === name).map((f) => f.ms).sort((a, b) => a - b);
    const st = stats.filter((s) => s.phase === name);
    // Ticks per second over sliding 1 s windows: the worst one.
    let tpsMin = Infinity;
    for (let i = 0; i < st.length; i += 1) {
      const j = st.findIndex((s, k) => k > i && s.at - st[i].at >= 1000);
      if (j < 0) break;
      if (st[i].tick !== undefined && st[j].tick !== undefined) {
        tpsMin = Math.min(tpsMin, ((st[j].tick - st[i].tick) * 1000) / (st[j].at - st[i].at));
      }
    }
    const max = (key) => Math.max(0, ...st.map((s) => s[key] ?? 0));
    const slow = ms.filter((v) => v > 20).length;
    log(`${name.padEnd(16)} frames ${String(ms.length).padStart(4)}  render ms median ${quantile(ms, 0.5).toFixed(1)} p95 ${quantile(ms, 0.95).toFixed(1)} p99 ${quantile(ms, 0.99).toFixed(1)} worst ${quantile(ms, 1).toFixed(1)}  >20ms ${slow} (${((slow / Math.max(1, ms.length)) * 100).toFixed(1)}%)`
      + `  |  sim TPS min ${Number.isFinite(tpsMin) ? tpsMin.toFixed(0) : '-'}  tick avg<=${max('tickAvg').toFixed(1)} max ${max('tickMax').toFixed(1)} ms  physx<=${max('physx').toFixed(1)} ms  awake<=${max('awake')}  bonds ${max('bonds')}`);
  }
  for (const f of longFrames) log(`long frame ${f.ms.toFixed(0)} ms in "${f.phase}", ${f.into.toFixed(0)} ms into it`);
  // GPU objects created after boot, and the slow ones: a compile mid-play is a stall.
  const late = slowCreates.filter((c) => c.phase !== 'boot' && c.phase !== 'warmup');
  log(`GPU creations after boot: ${late.length}; total ${late.reduce((sum, c) => sum + c.ms, 0).toFixed(0)} ms`);
  for (const c of late.filter((c) => c.ms > 20).sort((a, b) => b.ms - a.ms).slice(0, 12)) {
    log(`  ${c.phase.padEnd(16)} ${c.name} ${c.ms.toFixed(0)} ms ${c.label}`);
  }
  log('done');
  setTimeout(() => process.exit(0), 300);
}

run().catch((error) => {
  log(`FAILED: ${error && (error.stack || error.message || error)}`);
  setTimeout(() => process.exit(1), 300);
});
