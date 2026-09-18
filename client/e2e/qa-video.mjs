/**
 * Record an agent-driven player doing a QA pass, as video.
 *
 * Same controls the scripted tests use, with the camera left on so the run is
 * watchable. Useful for the claims a number cannot settle: whether the ball is
 * drawn, whether debris lands where the server says it did, whether the city looks
 * like it was hit where it was aimed.
 *
 *   node client/e2e/qa-video.mjs --out /tmp/qa-video
 *   node client/e2e/qa-video.mjs --rifle --shots 6
 *
 *   --page <url>      page origin.            default https://127.0.0.1:1111
 *   --wt-port <n>     local WebTransport port. default 4433
 *   --out <dir>       where the webm lands.   default ./qa-video
 *   --rifle           fire the rifle instead of the cannonball
 *   --shots <n>       shots per firing position. default 3
 *   --settle <ms>     wait before driving.    default 9000
 */
import { mkdirSync, renameSync } from 'node:fs';
import { openCity, city, player } from './helpers/qaSession.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);

const OUT = arg('out', 'qa-video');
const SHOTS = Number(arg('shots', 3));
const SETTLE = Number(arg('settle', 9000));
mkdirSync(OUT, { recursive: true });

const { browser, context, page } = await openCity({
  page: arg('page', 'https://127.0.0.1:1111'),
  wtPort: arg('wt-port', '4433'),
  recordVideo: OUT,
  viewport: { width: Number(arg('width', 960)), height: Number(arg('height', 600)) },
});

// Headless Chromium here has no GPU for WebGL -- every launch flag still lands
// on SwiftShader -- so the city renders in software. At PRETTY with 24k chunks
// that is one frame every two seconds, which is not a recording and is slow
// enough that the client falls behind its own destruction stream. Strip the
// renderer down to what software can carry.
await page.evaluate(() => window.__VIBE_E2E__.setRenderQuality({
  tier: 'fast', shadows: false, ao: false,
}));
await page.waitForTimeout(1500);
const renderer = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const d = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'unknown';
});
console.log(`renderer: ${renderer.includes('SwiftShader') ? 'SwiftShader (software)' : renderer}`);

const say = async (what) => {
  const p = await player(page);
  const c = await city(page);
  console.log(`  ${what.padEnd(34)} at [${p.position.map((v) => v.toFixed(1)).join(', ')}]`
    + ` | bonds ${c.brokenBonds ?? 0} | islands ${c.liveIslands ?? 0}`);
};

const look = (yaw, pitch) => page.evaluate(([a, b]) => window.__VIBE_DRIVE__.look(a, b), [yaw, pitch]);
const move = (forward, strafe, ms) =>
  page.evaluate(([f, s, d]) => window.__VIBE_DRIVE__.move({ forward: f, strafe: s, durationMs: d }),
    [forward, strafe, ms]);
// The trigger is held for well over a frame on purpose. The drive sets a
// deadline and the page's input loop reads it once per rendered frame, so at
// one frame a second a 120 ms pulse is set and expires without any frame ever
// seeing it: eight cannonballs were fired and none left the muzzle.
const FIRE_HOLD_MS = Number(arg('fire-hold', 1400));
const fire = () => page.evaluate((ms) => window.__VIBE_DRIVE__.fire({ holdMs: ms }), FIRE_HOLD_MS);

if (!flag('rifle')) {
  await page.evaluate(() => window.__VIBE_E2E__.setCannonball(true));
}
console.log(`shot mode: ${flag('rifle') ? 'rifle' : 'cannonball'}`);

await page.waitForTimeout(SETTLE);
await say('joined, city settled');

// Aim at a building by world position, not by angle. The spawn moves between
// runs, so a fixed yaw points somewhere different every time -- which is how
// an earlier run fired twelve cannonballs into open ground and reported
// perfect frame times. These coordinates came from the headless probe, which
// can name the chunk it is looking at; the browser cannot yet, and that gap is
// why this aims at a point instead of an identity.
// Aim with the drive's own city-facing helper and vary only the pitch.
// Absolute yaw and hand-picked world coordinates both failed here: the spawn
// ring moves between runs, so a fixed angle points somewhere different every
// time, and coordinates copied from another run's probe missed from 151 m.
// faceCity() resolves against the player's actual position, so it is the only
// aim that survives a respawn.
const BALL_SPEED = Number(arg('ball-speed', 60));
const aimAt = async (pitch) => {
  await page.evaluate(() => window.__VIBE_DRIVE__.faceCity());
  await page.waitForTimeout(250);
  const p = await player(page);
  // A thrown ball falls on the way; a hitscan round does not. Range to the
  // city centre is the best estimate available from here.
  const range = Math.hypot(p.position[0], p.position[2]);
  const drop = flag('rifle') ? 0 : 0.5 * 9.81 * (range / BALL_SPEED) ** 2;
  const lift = range > 1 ? Math.atan2(drop, range) : 0;
  await page.evaluate(([y, q]) => window.__VIBE_DRIVE__.look(y, q), [p.yaw, pitch + lift]);
  return { range, drop };
};

const aim0 = await aimAt(0.05);
await page.waitForTimeout(1200);
await say(`aimed at the city, ${aim0.range.toFixed(0)} m out, +${aim0.drop.toFixed(1)} m drop`);

// Software rendering gives about one frame a second here, so everything is
// held long enough to survive on video rather than happening between frames.
for (const pitch of [0.02, 0.09, 0.16, 0.05]) {
  await aimAt(pitch);
  await page.waitForTimeout(900);
  for (let shot = 0; shot < SHOTS; ++shot) {
    await fire();
    await page.waitForTimeout(1400);
  }
  await say(`fired ${SHOTS} at pitch ${pitch}`);
}

// A short walk. It will barely move: the input frames the drive produces are
// generated per rendered frame, so at one frame a second a player walks about
// a third of a metre in three seconds. Recorded anyway, because it is the
// honest limit of browser QA on a box with no GPU for WebGL.
await move(1, 0, 3000);
await page.waitForTimeout(3400);
await say('walked (software-rendering limited)');

await aimAt(0.07);
await page.waitForTimeout(1000);
for (let shot = 0; shot < SHOTS; ++shot) {
  await fire();
  await page.waitForTimeout(1400);
}
await say('fired again');
await page.waitForTimeout(4000);
await say('settled');

const final = await city(page);
console.log(`bonds ${final.brokenBonds ?? 0} | islands ${final.liveIslands ?? 0}`
  + ` | chunks drawn ${final.chunksDrawn ?? 0}, hidden ${final.chunksHidden ?? 0},`
  + ` unplaced ${final.chunksUnplaced ?? 0}`);

// The file is only written when the context closes, and its name is a hash.
const video = page.video();
await context.close();
await browser.close();
if (video) {
  const path = await video.path();
  const named = `${OUT}/agent-drive.webm`;
  try {
    renameSync(path, named);
    console.log(`video: ${named}`);
  } catch {
    console.log(`video: ${path}`);
  }
}
