/**
 * Browser QA: join the city, select the meteor, fire at the city, and confirm
 * the rock was streamed from its first tick and drawn all the way down.
 *
 * The meteor is the one shot whose projectile does not start at the player,
 * so qa-shot.mjs's "did the ball leave the muzzle" frames say nothing about
 * it. What this checks instead: the body reached this client within a few
 * frames of the fire (the e2e bridge's meteors() lists it, with a fresh
 * sample), stayed listed while it fell, and the city lost bonds after it
 * landed.
 *
 * Usage:
 *   node client/e2e/qa-meteor.mjs --page https://127.0.0.1:1111 --wt-port 4433 \
 *        --lookat 30,8,-20 --out /tmp/qa-meteor
 *
 *   --page <url>       page origin.                 default https://127.0.0.1:1111
 *   --wt-port <n>      local WebTransport port.     default 4433
 *   --look <yaw,pitch> absolute aim, radians.       default faceCity
 *   --lookat <x,y,z>   aim at a world point instead
 *   --out <dir>        where the pngs go.           default ./qa-meteor
 *   --settle <ms>      wait before the shot.        default 9000
 *   --shots <n>        meteors to fire, one per interval. default 1
 *   --interval <ms>    between shots when --shots > 1. default 8000
 *
 * With --shots > 1 the flight frames are skipped: this is the A/B mode, for
 * counting what N meteors do to the server (read its log for exit 70s), and
 * it prints one line per launch and whether the session was still alive.
 */
import { mkdirSync } from 'node:fs';
import { openCity, city } from './helpers/qaSession.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const SETTLE = Number(arg('settle', 9000));
const SHOTS = Number(arg('shots', 1));
const INTERVAL = Number(arg('interval', 8000));
const OUT = arg('out', 'qa-meteor');
const LOOK = arg('look', null);
const LOOKAT = arg('lookat', null);

mkdirSync(OUT, { recursive: true });

const { browser, page } = await openCity({
  page: arg('page', 'https://127.0.0.1:1111'),
  wtPort: arg('wt-port', '4433'),
});

await page.evaluate(() => window.__VIBE_E2E__.setShotMode('meteor'));
await page.waitForTimeout(SETTLE);
if (LOOKAT) {
  const [x, y, z] = LOOKAT.split(',').map(Number);
  await page.evaluate(([a, b, c]) => window.__VIBE_DRIVE__.lookAt(a, b, c), [x, y, z]);
} else if (LOOK) {
  const [yaw, pitch] = LOOK.split(',').map(Number);
  await page.evaluate(([a, b]) => window.__VIBE_DRIVE__.look(a, b), [yaw, pitch]);
} else {
  await page.evaluate(() => window.__VIBE_DRIVE__.faceCity());
}
await page.waitForTimeout(800);

const before = await city(page);
await page.screenshot({ path: `${OUT}/00-before.png` });

if (SHOTS > 1) {
  let launched = 0;
  for (let shot = 1; shot <= SHOTS; ++shot) {
    let live = [];
    try {
      await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 40 }));
      for (let i = 0; i < 20; ++i) {
        await page.waitForTimeout(100);
        live = await page.evaluate(() => window.__VIBE_E2E__.meteors());
        if (live.some((f) => f.ageS < 2.5)) break;
      }
    } catch (error) {
      console.log(`shot ${shot}: session gone (${String(error).slice(0, 80)})`);
      break;
    }
    const fresh = live.find((f) => f.ageS < 2.5);
    if (fresh) launched += 1;
    const stats = await city(page).catch(() => ({}));
    console.log(`shot ${shot}: ${fresh ? `launched body ${fresh.bodyId}` : 'NO LAUNCH'}, bonds ${stats.brokenBonds ?? '?'}`);
    await page.waitForTimeout(INTERVAL);
  }
  await page.screenshot({ path: `${OUT}/99-after.png` }).catch(() => {});
  console.log(`${launched}/${SHOTS} launches reached the client`);
  await browser.close();
  process.exit(0);
}

await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 120 }));

// The launch packet is reliable and small; a second is generous.
let flights = [];
for (let i = 0; i < 20 && flights.length === 0; ++i) {
  await page.waitForTimeout(100);
  flights = await page.evaluate(() => window.__VIBE_E2E__.meteors());
}
if (flights.length === 0) {
  console.log('FAIL: no meteor launch reached the client within 2 s of firing');
  await page.screenshot({ path: `${OUT}/99-no-launch.png` });
  await browser.close();
  process.exit(1);
}
const flight = flights[0];
const firstSpeed = flight.speed;
console.log(`body ${flight.bodyId} streamed ${flight.ageS.toFixed(2)} s after the fire`
  + `, sample age ${flight.sampleAgeMs.toFixed(0)} ms, at [${flight.position.map((v) => v.toFixed(0))}] doing ${firstSpeed.toFixed(0)} m/s`);
if (flight.sampleAgeMs > 250) {
  console.log('FAIL: the first sample was already stale; the body was not streamed from birth');
}

// Photograph the fall every half second until the rock comes to rest.
let landedAtMs = null;
for (let i = 0; i < 16; i += 1) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/01-flight-${String(i).padStart(2, '0')}.png` });
  const live = (await page.evaluate(() => window.__VIBE_E2E__.meteors())).find((m) => m.bodyId === flight.bodyId);
  const stats = await page.evaluate(() => ({ live: window.__VIBE_E2E__.frameProfile().meteorsLive }));
  if (!live) {
    console.log(`t=${((i + 1) * 0.5).toFixed(1)}s: body gone (retired)`);
    break;
  }
  console.log(`t=${((i + 1) * 0.5).toFixed(1)}s: at [${live.position.map((v) => v.toFixed(0))}] ${live.speed.toFixed(0)} m/s, sample age ${live.sampleAgeMs.toFixed(0)} ms, drawn=${stats.live ?? '?'}`);
  if (live.speed < 2 && landedAtMs === null) {
    landedAtMs = (i + 1) * 500;
    break;
  }
}
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/99-after.png` });
const after = await city(page);
console.log(`bonds ${before.brokenBonds ?? 0} -> ${after.brokenBonds ?? 0}`
  + ` | islands ${before.liveIslands ?? 0} -> ${after.liveIslands ?? 0}`
  + ` | at rest after ${landedAtMs === null ? '>8 s' : `${(landedAtMs / 1000).toFixed(1)} s`}`);
console.log(`screenshots in ${OUT}`);
await browser.close();
