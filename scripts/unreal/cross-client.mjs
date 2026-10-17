// A web player and an Unreal player in one match, checked from both sides.
//
// The web /city joins in headless Chromium and stands at the stand-in's fixed point (server
// (20, 1, 60), where VibeCity.Play.KillRemote meets its target). Unreal then runs MeetAndWalk (it
// walks 4 m from that point), KillRemote (it
// must find that player there, shoot it dead, see it ragdoll and its battery drop) and
// CannonAndMeteor (a meteor on the city) and Drive (enters a car and drives it). Meanwhile the web page records, four times a second, the
// players it sees, its own health, and its city stream. It passes when Unreal's tests pass and the
// web player:
//   - saw another player (the Unreal one) move more than 1 m;
//   - lost health to it and died;
//   - applied destruction events from the meteor (its wire 4 stream's eventsApplied rose);
//   - saw a car the Unreal player drove (VibeCity.Play.Drive) move more than 2 m;
//   - never saw a hash mismatch or a decode error.
//
//   node scripts/unreal/cross-client.mjs [--url http://localhost:3003] [--api http://127.0.0.1:4001] [--match citypp-cross]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(resolve(root, 'client/package.json'))('playwright');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const url = arg('--url', 'http://localhost:3003');
const api = arg('--api', 'http://127.0.0.1:4001');
const match = arg('--match', `citypp-cross-${Date.now() % 100000}`);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(`${url}/city?match=${match}`);
await page.waitForFunction(() => window.__VIBE_E2E__, null, { timeout: 60000 });
await page.mouse.click(640, 400);
await page.waitForFunction(() => window.__VIBE_E2E__.snapshot().connected, null, { timeout: 60000 });
await page.evaluate(() => window.__VIBE_E2E__.setDiagnostics(true));
// Stand at the stand-in's point, facing -z (toward where Unreal arrives, 4 m short of it).
await page.evaluate(() => window.__VIBE_E2E__.dropAt({ position: [20, 1, 60], yaw: Math.PI, pitch: 0 }));
await page.waitForTimeout(4000);
const sample = () => page.evaluate(() => {
  const s = window.__VIBE_E2E__.snapshot();
  const c = s.city;
  return {
    playerId: s.playerId, position: s.position, hp: s.hp, dead: s.dead,
    remotes: s.remotePlayers.map((r) => ({ id: r.id, position: r.position })),
    vehicles: s.vehicles.map((v) => ({ id: v.id, driverId: v.driverId, position: v.position })),
    events: c?.perPlayer?.eventsApplied ?? 0, mismatches: c?.hashMismatches ?? 0, decodeErrors: c?.perPlayer?.decodeErrors ?? 0,
  };
});
const first = await sample();
console.log(`web player ${first.playerId} at ${first.position.map((v) => v.toFixed(1)).join(', ')}`);

// Unreal shoots this player (not one an earlier session left), and drives the car nearest it.
const unrealArgs = `-VibeTargetPlayer=${first.playerId} -VibeCarNear=20,1,60`;
const unreal = spawn('scripts/unreal/play-tests.sh', ['--api', api, '--match', match, '--only', 'VibeCity.Play.MeetAndWalk,VibeCity.Play.KillRemote,VibeCity.Play.CannonAndMeteor,VibeCity.Play.Drive'], { cwd: root, env: { ...process.env, VIBE_UE_ARGS: unrealArgs } });
let unrealOut = '';
unreal.stdout.on('data', (d) => { unrealOut += d; });
unreal.stderr.on('data', (d) => { unrealOut += d; });
const unrealDone = new Promise((done) => unreal.on('close', (code) => done(code)));

const seenAt = new Map(); // remote id -> first position
const carAt = new Map(); // vehicle id -> position when a remote player first drove it
let drivenCar = null, drivenBy = null;
let movedRemote = null, minHp = first.hp, died = false, mismatches = 0, decodeErrors = 0, eventsBefore = first.events, eventsAfter = first.events;
let finished = false, wasDead = false;
unrealDone.then(() => { finished = true; });
while (!finished) {
  const s = await sample();
  for (const r of s.remotes) {
    if (!seenAt.has(r.id)) seenAt.set(r.id, r.position);
    const p0 = seenAt.get(r.id);
    if (Math.hypot(r.position[0] - p0[0], r.position[2] - p0[2]) > 1) movedRemote ??= r.id;
  }
  for (const v of s.vehicles) {
    if (!v.driverId || v.driverId === first.playerId) continue;
    if (!carAt.has(v.id)) carAt.set(v.id, v.position);
    const p0 = carAt.get(v.id);
    if (Math.hypot(v.position[0] - p0[0], v.position[2] - p0[2]) > 2) { drivenCar ??= v.id; drivenBy ??= v.driverId; }
  }
  // Respawned (anywhere): back to the point, so the car Unreal drives nearby stays in view.
  if (wasDead && !s.dead) await page.evaluate(() => window.__VIBE_E2E__.dropAt({ position: [20, 1, 60], yaw: Math.PI, pitch: 0 }));
  wasDead = s.dead;
  minHp = Math.min(minHp, s.hp);
  died ||= s.dead;
  mismatches = Math.max(mismatches, s.mismatches);
  decodeErrors = Math.max(decodeErrors, s.decodeErrors);
  eventsAfter = s.events;
  await page.waitForTimeout(250);
}
const code = await unrealDone;
await browser.close();

const unrealPass = code === 0 && /4 passed, 0 failed/.test(unrealOut);
const summary = {
  match,
  unreal: unrealOut.split('\n').filter((l) => /^(pass|FAIL)|Expected|play-tests:/.test(l)),
  web: { remotesSeen: [...seenAt.keys()], movedRemote, carsDrivenByOthers: [...carAt.keys()], drivenCar, drivenBy, minHp, died, eventsApplied: eventsAfter - eventsBefore, mismatches, decodeErrors, pageErrors: pageErrors.slice(0, 5) },
};
console.log(JSON.stringify(summary, null, 2));
const failures = [];
if (!unrealPass) failures.push('Unreal tests');
if (movedRemote === null) failures.push('the web saw no other player move');
if (!(minHp < 100) || !died) failures.push('the web player was not shot dead');
if (!(eventsAfter > eventsBefore)) failures.push('the web applied no destruction events');
if (drivenCar === null) failures.push('the web saw no car driven by the other player move');
if (mismatches > 0 || decodeErrors > 0) failures.push('hash mismatches or decode errors');
if (pageErrors.length > 0) failures.push('page errors');
if (failures.length > 0) {
  console.error(`cross-client: FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.error('cross-client: passed');
