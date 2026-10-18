// Replay a tape recorded by record.mjs in /cityreplay, headless and offline
// (the manifest and the tape are served from the run directory), and compare
// what the replay's renderers drew with what the live client drew at the same
// tape times.
//
//   CLIENT=http://localhost:3103 node e2e/tape-replay/replay.mjs <runDir>
//
// Writes <runDir>/compare.json (per-kind distance statistics and presence
// counts), replay-*.png at the live screenshots' tape times, and
// replay-avatar-*.png from a free camera beside the recording player.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const CLIENT = process.env.CLIENT ?? 'http://localhost:3103';
const RUN = process.argv[2];
const STEP = Number(process.env.STEP ?? 2);
if (!RUN) throw new Error('usage: replay.mjs <runDir>');
const samples = JSON.parse(fs.readFileSync(path.join(RUN, 'live-samples.json'), 'utf8'));
const shots = JSON.parse(fs.readFileSync(path.join(RUN, 'live-shots.json'), 'utf8'));
const header = JSON.parse(fs.readFileSync(path.join(RUN, 'header.json'), 'utf8'));
const manifest = fs.readFileSync(path.join(RUN, `manifest-${header.manifestHash}.bin`));
const tape = fs.readFileSync(path.join(RUN, 'tape.vltape'));
const t0 = Date.now();
const mark = (what) => console.log(`[t=${((Date.now() - t0) / 1000).toFixed(1)}s] ${what}`);

const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
async function openReplay(query = '') {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)); });
  await page.route((url) => url.pathname.startsWith('/city-manifest/'), (route) => route.fulfill({ body: manifest, contentType: 'application/octet-stream' }));
  await page.route((url) => url.pathname === '/__run/tape.vltape', (route) => route.fulfill({ body: tape, contentType: 'application/octet-stream' }));
  await page.goto(`${CLIENT}/cityreplay?src=/__run/tape.vltape${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__VIBE_REPLAY__?.ready(), null, { timeout: 120000 });
  await page.evaluate(() => window.__VIBE_REPLAY__.pause());
  return page;
}
const seekAndRead = (page, tapeMs, frames = 2) => page.evaluate(async ([t, n]) => {
  const r = window.__VIBE_REPLAY__;
  await r.seek(t - r.originMs());
  for (let i = 0; i < n; i += 1) await new Promise((res) => requestAnimationFrame(res));
  return r.drawnWorld();
}, [tapeMs, frames]);

const page = await openReplay();
mark(`replay ready; origin ${await page.evaluate(() => window.__VIBE_REPLAY__.originMs())} ms`);

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +s[s.length - 1].toFixed(3) };
};
const d = { bodies: [], vehicles: [], localPlayer: [], remotePlayers: [], meteorBody: [], clockOffsetMs: [], dynDelayMs: [] };
const presence = { bodiesLiveOnly: 0, bodiesReplayOnly: 0, bodiesBoth: 0, vehiclesLiveOnly: 0, vehiclesBoth: 0, meteorsLive: 0, meteorsReplay: 0 };
const timeline = [];
for (let i = 0; i < samples.length; i += STEP) {
  const live = samples[i];
  // The frame the live renderers drew in, on the tape clock (older runs: the sample time).
  const replay = await seekAndRead(page, live.world.tapeMs ?? live.tapeMs);
  if (!replay) continue;
  const lw = live.world;
  const rBodies = new Map(replay.bodies.map((b) => [b.id, b]));
  for (const b of lw.bodies) {
    const r = rBodies.get(b.id);
    if (r) { presence.bodiesBoth += 1; d.bodies.push(dist(b.position, r.position)); rBodies.delete(b.id); }
    else presence.bodiesLiveOnly += 1;
  }
  presence.bodiesReplayOnly += rBodies.size;
  const rVehicles = new Map(replay.vehicles.map((v) => [v.id, v]));
  for (const v of lw.vehicles) {
    const r = rVehicles.get(v.id);
    if (r) { presence.vehiclesBoth += 1; d.vehicles.push(dist(v.position, r.position)); } else presence.vehiclesLiveOnly += 1;
  }
  const self = replay.players.find((p) => p.id === replay.playerId);
  if (self && lw.local && !live.inVehicle) d.localPlayer.push(dist(lw.local, self.position));
  for (const p of lw.players) {
    const r = replay.players.find((q) => q.id === p.id);
    if (r) d.remotePlayers.push(dist(p.position, r.position));
  }
  for (const m of lw.meteors) {
    presence.meteorsLive += 1;
    const r = replay.meteors.find((q) => q.bodyId === m.bodyId);
    if (r) presence.meteorsReplay += 1;
    if (r && m.position && r.position && m.source === 'body' && r.source === 'body') d.meteorBody.push(dist(m.position, r.position));
  }
  if (replay.recordedClock && Number.isFinite(replay.recordedClock.offsetUs)) {
    d.clockOffsetMs.push(Math.abs(replay.clock.offsetUs - replay.recordedClock.offsetUs) / 1000);
    d.dynDelayMs.push(Math.abs(replay.clock.dynDelayMs - replay.recordedClock.dynDelayMs));
  }
  timeline.push({
    tapeMs: Math.round(live.tapeMs),
    live: { bodies: lw.bodies.length, vehicles: lw.vehicles.length, meteors: lw.meteors.map((m) => m.source) },
    replay: { bodies: replay.bodies.length, vehicles: replay.vehicles.length, players: replay.players.length, meteors: replay.meteors.map((m) => m.source), traces: replay.shotTraces },
  });
}
const summary = {
  tape: { version: header.version, durationS: header.durationMs / 1000, bytes: header.bytes, packets: header.packets, channels: header.channels, prelude: header.prelude, localPlayerId: header.localPlayerId },
  mbPerMinute: +((header.bytes / 1e6) / (header.durationMs / 60000)).toFixed(2),
  samplesCompared: timeline.length,
  distanceM: Object.fromEntries(Object.entries(d).filter(([k]) => !k.endsWith('Ms')).map(([k, v]) => [k, stats(v)])),
  clockDeltaMs: { offset: stats(d.clockOffsetMs), dynDelay: stats(d.dynDelayMs) },
  presence,
};
fs.writeFileSync(path.join(RUN, 'compare.json'), JSON.stringify({ summary, timeline }, null, 2));
console.log(JSON.stringify(summary, null, 2));

// The live screenshots' moments, from the recorded camera.
// Played into at 1x from 2.5 s before (a seek raises no dust from the skipped
// past, playing does), paused on the frame that reaches the moment.
for (const s of shots) {
  await seekAndRead(page, Math.max(0, s.tapeMs - 2500), 2);
  await page.evaluate(async (t) => {
    const r = window.__VIBE_REPLAY__;
    r.play();
    await new Promise((resolve) => {
      const tick = () => (r.tapeTimeMs() >= t ? resolve() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    r.pause();
  }, s.tapeMs);
  await page.waitForTimeout(400); // the bar's clock refreshes at 4 Hz
  await page.screenshot({ path: path.join(RUN, `replay-${s.name}.png`) });
  mark(`replay-${s.name}.png at ${(s.tapeMs / 1000).toFixed(2)} s`);
}
await page.close();

// The recording player seen from outside: a free camera beside it.
const pick = (fromMs) => samples.find((s) => s.tapeMs >= fromMs && s.world.local) ?? samples[samples.length - 1];
for (const [name, atMs] of [['cannon', shots.find((s) => s.name.startsWith('cannonball'))?.tapeMs ?? 5000], ['walk', (shots.find((s) => s.name === 'driving')?.tapeMs ?? 60000) - 12000], ['drive', shots.find((s) => s.name === 'driving')?.tapeMs ?? 70000]]) {
  const s = pick(atMs);
  const target = s.inVehicle ? (s.world.vehicles.find((v) => v.driverId === s.world.playerId)?.position ?? s.world.local) : s.world.local;
  const cam = [target[0] + 7, target[1] + 4, target[2] + 7, target[0], target[1] + 0.5, target[2]].map((v) => v.toFixed(1)).join(',');
  const p = await openReplay(`&cam=${cam}`);
  const world = await seekAndRead(p, s.tapeMs, 10);
  await p.waitForTimeout(600); // characters settle into their pose
  await p.screenshot({ path: path.join(RUN, `replay-avatar-${name}.png`) });
  mark(`replay-avatar-${name}.png at ${(s.tapeMs / 1000).toFixed(2)} s: players ${JSON.stringify(world?.players)} vehicles ${world?.vehicles.length}`);
  await p.close();
}
await context.close();
await browser.close();
