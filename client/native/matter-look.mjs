// The native app's Matter material captures (scripts/native-mac.sh
// matter-look): park the camera at each e2e/helpers/matterPoses.mjs pose and
// save the frame to MATTER_OUT/<pose>.png. The web side is e2e/matter-look.mjs.
import { matterPoses, matterReady } from '../e2e/helpers/matterPoses.mjs';

/* global MATTER_OUT, MATTER_OFF */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`[matter] ${text}`);

async function waitFor(what, predicate, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Median and p95 of the GPU time over `ms`: the FPS counter's timestamp
 * readbacks (src/native/NativeFpsCounter.tsx __VIBE_NATIVE_GPU_MS__).
 */
async function gpuFrameMs(ms) {
  const samples = [];
  const frames = [];
  const until = Date.now() + ms;
  let last = globalThis.__VIBE_NATIVE_GPU_MS__;
  let then = performance.now();
  while (Date.now() < until) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const now = performance.now();
    frames.push(now - then);
    then = now;
    const gpu = globalThis.__VIBE_NATIVE_GPU_MS__;
    if (typeof gpu === 'number' && gpu !== last) samples.push(gpu);
    last = gpu;
  }
  samples.sort((a, b) => a - b);
  frames.sort((a, b) => a - b);
  return {
    median: samples[samples.length >> 1] ?? 0,
    p95: samples[Math.floor(samples.length * 0.95)] ?? 0,
    readbacks: samples.length,
    frame: frames[frames.length >> 1] ?? 0,
  };
}

async function run() {
  // MATTER_OFF (scripts/native-mac.sh matter-look with MATTER_OFF=1): the A/B
  // baseline, every chunk on the triplanar textures.
  if (MATTER_OFF) globalThis.__VIBE_MATTER_OFF__ = true;
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  await waitFor('the city and its materials', () => matterReady(e2e));
  globalThis.__VIBE_NATIVE_HUD__.visible = false;
  await sleep(2000);
  const materials = e2e.cityMaterials();
  log(`chunk draws (render cells): ${e2e.frameProfile?.().subDraws}`);
  for (const m of materials) log(`material ${m.index} ${m.name}: ${m.worn ? m.look : `triplanar${m.look ? ` (maps to ${m.look})` : ''}`} (${m.chunks} chunks)`);
  for (const pose of matterPoses(materials)) {
    e2e.setCapturePose({ position: pose.position, lookAt: pose.lookAt });
    await sleep(1600);
    const file = `${MATTER_OUT}/${pose.name}.png`;
    const saved = __mystralSaveScreenshot(file);
    const gpu = await gpuFrameMs(6000);
    log(`${pose.name}: ${saved ? file : 'FAILED'}  gpu ms median ${gpu.median.toFixed(2)} p95 ${gpu.p95.toFixed(2)} readbacks ${gpu.readbacks} frame ms ${gpu.frame.toFixed(2)}`);
  }
  const builds = e2e.shaderBuilds?.();
  if (builds) log(`shader builds: ${JSON.stringify(builds).slice(0, 300)}`);
  log('done');
  setTimeout(() => process.exit(0), 200);
}

run().catch((error) => {
  log(`FAILED: ${error && (error.stack || error.message || error)}`);
  setTimeout(() => process.exit(1), 200);
});
