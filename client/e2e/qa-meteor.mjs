/**
 * Browser QA: join the city, select the meteor, fire at the city, and confirm
 * the launch came back and the rock was drawn.
 *
 * The meteor is the one shot whose projectile does not start at the player,
 * so qa-shot.mjs's "did the ball leave the muzzle" frames say nothing about
 * it. What this checks instead: the launch packet arrived (the e2e bridge's
 * meteors() lists it), the arc is the length the server said, the streamed
 * body took over as it came inside the snapshot's range, and the city lost
 * bonds after it landed.
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
 */
import { mkdirSync } from 'node:fs';
import { openCity, city } from './helpers/qaSession.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const SETTLE = Number(arg('settle', 9000));
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
const startDist = Math.hypot(...flight.start.map((v, i) => v - flight.target[i]));
console.log(`launch: body ${flight.bodyId}, ${startDist.toFixed(0)} m from target, ${flight.flightTimeS.toFixed(2)} s flight`
  + `, start [${flight.start.map((v) => v.toFixed(0))}], target [${flight.target.map((v) => v.toFixed(1))}]`);

// Photograph the fall: quarter, half, three-quarters, landing, and after.
const flightMs = flight.flightTimeS * 1000;
let elapsed = 0;
for (const frac of [0.25, 0.5, 0.75, 1.0]) {
  const at = flightMs * frac;
  await page.waitForTimeout(Math.max(0, at - elapsed));
  elapsed = at;
  await page.screenshot({ path: `${OUT}/01-flight-${Math.round(frac * 100)}.png` });
  const live = await page.evaluate(() => window.__VIBE_E2E__.meteors());
  const stats = await page.evaluate(() => ({ live: window.__VIBE_E2E__.frameProfile().meteorsLive }));
  console.log(`t=${(at / 1000).toFixed(2)}s: ${live.length} flight(s), streamed=${live[0]?.streamed ?? '-'}, drawn=${stats.live ?? '?'}`);
}
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/99-after.png` });
const after = await city(page);
const streamed = (await page.evaluate(() => window.__VIBE_E2E__.meteors()))[0]?.streamed ?? false;
console.log(`bonds ${before.brokenBonds ?? 0} -> ${after.brokenBonds ?? 0}`
  + ` | islands ${before.liveIslands ?? 0} -> ${after.liveIslands ?? 0}`
  + ` | body streamed: ${streamed}`);
console.log(`screenshots in ${OUT}`);
await browser.close();
