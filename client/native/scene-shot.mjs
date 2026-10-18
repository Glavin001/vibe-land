// What a scene looks like in the native app (scripts/native-mac.sh shots
// --scene NAME): an overview of every structure from above and the player's
// own view of the nearest one, saved to target/native-scene/<scene>-*.png,
// with the structure and chunk counts logged.
/* global SCENE_NAME */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`[scene] ${text}`);
const scene = typeof SCENE_NAME === 'string' && SCENE_NAME ? SCENE_NAME : 'city';

async function waitFor(what, predicate, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function run() {
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  await waitFor('the city', () => (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0 && e2e.cityStructures().length > 0);
  await waitFor('the shader warmup', () => e2e.shaderBuilds().playing, 90_000);
  // A big scene's first ticks build the solver's state (seconds each): wait
  // for the simulation to be running before judging or photographing it.
  const tick = () => e2e.matchStats()?.server_tick ?? 0;
  const startedMs = Date.now();
  await waitFor('the simulation to reach tick 120', () => tick() >= 120, 180_000);
  log(`simulation reached tick 120 ${((Date.now() - startedMs) / 1000).toFixed(1)} s after the warmup`);
  const t0 = tick();
  await sleep(3000);
  const stats = e2e.matchStats() ?? {};
  log(`tick rate ${((tick() - t0) / 3).toFixed(1)} per second, tick avg ${stats.timings?.total_ms?.avg?.toFixed?.(1)} ms, physx ${stats.physics_last_step_ms?.toFixed?.(1)} ms`);
  const structures = e2e.cityStructures();
  const snap = e2e.snapshot();
  log(`${scene}: ${structures.length} structures, ${snap.city.chunksTotal} chunks, player at ${snap.position.map((v) => v.toFixed(1)).join(', ')}`);
  for (const car of snap.vehicles ?? []) log(`  vehicle ${car.id} at ${car.position.map((v) => v.toFixed(1)).join(', ')}`);
  // Nothing has been shot: any broken bond is the scene breaking by itself
  // (or something spawned inside it).
  log(`broken bonds ${snap.city.brokenBonds}, awake chunks ${snap.city.chunksAwake}`);
  // Town-kit scenes: the details layer (tree leaves, stall canopies).
  const townKit = e2e.townKit?.();
  if (townKit && (townKit.ready || townKit.error)) log(`town-kit details: ${townKit.ready ? `${townKit.attachments} attachments` : `FAILED ${townKit.error}`}`);

  // Overview: above the structures' centre, back by their spread.
  const xs = structures.map((s) => s.position[0]);
  const zs = structures.map((s) => s.position[2]);
  const centre = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
  const spread = Math.max(40, Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  const top = Math.min(80, Math.max(...structures.map((s) => s.top ?? 10)));
  e2e.setCapturePose({ position: [centre[0] + spread * 0.55, top + spread * 0.45, centre[1] + spread * 0.75], lookAt: [centre[0], 2, centre[1]] });
  await sleep(1500);
  log(`overview: ${__mystralSaveScreenshot(`../../target/native-scene/${scene}-overview.png`) ? 'saved' : 'FAILED'}`);

  // The player's eye on the nearest structure.
  const p = snap.position;
  const nearest = [...structures].sort((a, b) => Math.hypot(a.position[0] - p[0], a.position[2] - p[2]) - Math.hypot(b.position[0] - p[0], b.position[2] - p[2]))[0];
  e2e.setCapturePose({ position: [p[0], p[1] + 1.6, p[2]], lookAt: [nearest.position[0], Math.min(nearest.top ?? 4, 6) / 2, nearest.position[2]] });
  await sleep(1500);
  log(`player view: ${__mystralSaveScreenshot(`../../target/native-scene/${scene}-player.png`) ? 'saved' : 'FAILED'}`);
  // A scene's own landmarks (structures/showcase/build-showcase.mjs).
  const VIEWPOINTS = {
    showcase: [
      ['wide', [-20, 95, 175], [-10, 0, 10]],
      ['spawn-kicker', [-140, 3, 10], [-85, 1, -2]],
      ['east-houses', [80, 10, 30], [110, 3, 3]],
      ['highrise', [30, 18, -70], [0, 15, -110]],
      ['hill-house', [-60, 14, 110], [-105, 8, 75]],
    ],
    // structures/vibe-town/build-town.mjs
    town: [
      ['wide', [-20, 38, -105], [-10, 0, -5]],
      ['main-street', [-146, 2.5, 0], [0, 2, 0]],
      ['elm-park', [-40, 28, -95], [-75, 0, -20]],
      ['driveway', [-99, 3.5, 4], [-109, 1, 13]],
      ['bus-station', [20, 4, 6], [20, 1.5, -9]],
      ['market-square', [27, 10, 6], [27, 1, 24]],
      ['towers', [60, 22, -45], [112, 14, -14]],
      ['car-park', [111, 9, 42], [111, 1, 63]],
    ],
  };
  /** Main-thread CPU per frame over a second at the current pose (frame start to end of render). */
  const cpuFrame = async () => {
    const samples = [];
    for (let i = 0; i < 40; i += 1) { samples.push(e2e.frameProfile().cpuFrameMs); await sleep(25); }
    samples.sort((a, b) => a - b);
    return `cpu/frame median ${samples[20].toFixed(1)} ms, p90 ${samples[36].toFixed(1)} ms, ${e2e.frameProfile().drawCalls} draws`;
  };
  for (const [name, position, lookAt] of VIEWPOINTS[scene] ?? []) {
    e2e.setCapturePose({ position, lookAt });
    await sleep(1500);
    log(`${name}: ${__mystralSaveScreenshot(`../../target/native-scene/${scene}-${name}.png`) ? 'saved' : 'FAILED'}; ${await cpuFrame()}`);
  }

  // The nearest car, from the side.
  const car = [...(snap.vehicles ?? [])].sort((a, b) => Math.hypot(a.position[0] - p[0], a.position[2] - p[2]) - Math.hypot(b.position[0] - p[0], b.position[2] - p[2]))[0];
  if (car) {
    const [cx, cy, cz] = car.position;
    e2e.setCapturePose({ position: [cx + 6, cy + 2.5, cz + 7], lookAt: [cx, cy + 0.5, cz] });
    await sleep(1500);
    log(`vehicle ${car.id}: ${__mystralSaveScreenshot(`../../target/native-scene/${scene}-vehicle.png`) ? 'saved' : 'FAILED'}`);
  }
  log('done');
  setTimeout(() => process.exit(0), 300);
}

run().catch((error) => {
  log(`failed: ${error?.stack ?? error}`);
  setTimeout(() => process.exit(1), 300);
});
