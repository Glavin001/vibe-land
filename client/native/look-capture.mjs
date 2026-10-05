// The native app's side of the look comparison (scripts/native-mac.sh look):
// park the camera at each e2e/helpers/lookPoses.mjs pose and save the frame
// to LOOK_OUT/<pose>.png (mystral's __mystralSaveScreenshot). The web side
// is e2e/look-capture.mjs with the same poses.
import { lookPoses, lookReady } from '../e2e/helpers/lookPoses.mjs';

/* global LOOK_OUT */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`[look] ${text}`);

async function waitFor(what, predicate, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Frame intervals over `ms`: what each pose costs to draw. */
function frameTimes(ms) {
  return new Promise((resolve) => {
    const gaps = [];
    let last = performance.now();
    const until = last + ms;
    const tick = (now) => {
      gaps.push(now - last);
      last = now;
      if (now < until) { requestAnimationFrame(tick); return; }
      gaps.sort((a, b) => a - b);
      resolve({ median: gaps[gaps.length >> 1], p95: gaps[Math.floor(gaps.length * 0.95)] });
    };
    requestAnimationFrame(tick);
  });
}

async function run() {
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  await waitFor('the city and its textures', () => lookReady(e2e));
  globalThis.__VIBE_NATIVE_HUD__.visible = false;
  await sleep(2000);
  for (const pose of lookPoses(e2e.cityStructures())) {
    e2e.setCapturePose({ position: pose.position, lookAt: pose.lookAt });
    await sleep(1500);
    const file = `${LOOK_OUT}/${pose.name}.png`;
    const saved = __mystralSaveScreenshot(file);
    const frames = await frameTimes(2000);
    log(`${pose.name}: ${saved ? file : 'FAILED'}  frame ms median ${frames.median.toFixed(1)} p95 ${frames.p95.toFixed(1)}`);
  }
  log('done');
  setTimeout(() => process.exit(0), 200);
}

run().catch((error) => {
  log(`FAILED: ${error && (error.stack || error.message || error)}`);
  setTimeout(() => process.exit(1), 200);
});
