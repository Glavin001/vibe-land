// Scripted single-player /city playthrough for recording a video
// (scripts/native-mac.sh record). Boots the app bundle, then on a timeline:
// look over the city, walk up to the nearest building and shoot across its
// facade, call the player's meteor down on a second building, then the
// vehicle demo (e2e/vehicle-scenarios.mjs demo-full, run as the QA runs it):
// cannonballs through the buggy, the monster truck driven through the wreck,
// the meteor on the truck. Logs what happened; the recorder ends the run.
import { scenarios } from '../e2e/vehicle-scenarios.mjs';
import { runNativeScenario } from './nativeScenario.mjs';

const started = Date.now();
const log = (...args) => console.log(`[demo ${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, predicate, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function lerpLook(drive, from, to, ms) {
  const steps = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const s = t * t * (3 - 2 * t);
    drive.look(from[0] + (to[0] - from[0]) * s, from[1] + (to[1] - from[1]) * s);
    await sleep(ms / steps);
  }
}

function yawPitchTo(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  return [Math.atan2(dx, dz), Math.atan2(dy, Math.max(1e-4, Math.hypot(dx, dz)))];
}

async function shootAcross(drive, e2e, structure, rows, columns, shotsPerPoint) {
  const eye = () => { const p = e2e.snapshot().position; return [p[0], p[1] + 1.6, p[2]]; };
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const height = 1.5 + (structure.top - 2) * (r + 0.5) / rows;
      const across = ((c + 0.5) / columns - 0.5) * 8;
      const target = [structure.position[0] + across, height, structure.position[2]];
      const [yaw, pitch] = yawPitchTo(eye(), target);
      const current = drive.status();
      await lerpLook(drive, [current.yaw ?? yaw, current.pitch ?? pitch], [yaw, pitch], 180);
      for (let s = 0; s < shotsPerPoint; s += 1) {
        drive.fire({ holdMs: 60 });
        await sleep(140);
      }
    }
  }
}

async function run() {
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  const drive = await waitFor('the drive bridge', () => globalThis.__VIBE_DRIVE__);
  const session = await waitFor('the in-process session', () => globalThis.__VIBE_NATIVE_SESSION__);
  await waitFor('the city', () => (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0 && e2e.cityStructures().length > 0);
  const bonds = () => e2e.snapshot().city?.brokenBonds ?? 0;
  log(`city loaded: ${e2e.snapshot().city.chunksTotal} chunks, ${e2e.cityStructures().length} structures`);
  await sleep(1500);

  // 1. Look over the city.
  drive.faceCity();
  await sleep(200);
  const start = drive.status();
  await lerpLook(drive, [start.yaw, start.pitch], [start.yaw - 0.7, 0.05], 2000);
  await lerpLook(drive, [start.yaw - 0.7, 0.05], [start.yaw + 0.5, 0.1], 2500);

  // 2. Walk up to the nearest building and shoot across its facade.
  const byDistance = () => {
    const p = e2e.snapshot().position;
    return e2e.cityStructures()
      .map((s) => ({ s, d: Math.hypot(s.position[0] - p[0], s.position[2] - p[2]) }))
      .sort((a, b) => a.d - b.d);
  };
  const first = byDistance()[0].s;
  log(`approaching structure ${first.structureId} (${first.chunks} chunks, ${first.top.toFixed(1)} m)`);
  e2e.setShotMode('rifle');
  drive.setSprint(true);
  drive.move({ forward: 1, durationMs: 2200 });
  for (let t = 0; t < 22; t += 1) { drive.lookAt(first.position[0], 2.5, first.position[2]); await sleep(100); }
  drive.setSprint(false);
  await sleep(300);
  await shootAcross(drive, e2e, first, 2, 3, 4);
  log(`after the rifle: ${bonds()} broken bonds`);
  await sleep(1500);

  // 3. The player's meteor on a second building, watched all the way down:
  // back away from the first, then pick one the first does not hide.
  drive.move({ forward: -1, durationMs: 2500 });
  for (let t = 0; t < 25; t += 1) { drive.lookAt(first.position[0], 2.5, first.position[2]); await sleep(100); }
  const me = e2e.snapshot().position;
  const bearing = (s) => Math.atan2(s.position[0] - me[0], s.position[2] - me[2]);
  const apart = (s) => Math.abs(Math.atan2(Math.sin(bearing(s) - bearing(first)), Math.cos(bearing(s) - bearing(first))));
  const second = byDistance().find((entry) => entry.d > 20 && entry.s.structureId !== first.structureId && apart(entry.s) > 0.8)?.s
    ?? byDistance().find((entry) => entry.s.structureId !== first.structureId).s;
  const aim = [second.position[0], Math.min(second.top, 6), second.position[2]];
  log(`meteor on structure ${second.structureId}`);
  e2e.setShotMode('meteor');
  const current = drive.status();
  const eye = e2e.snapshot().position;
  await lerpLook(drive, [current.yaw, current.pitch], yawPitchTo([eye[0], eye[1] + 1.6, eye[2]], aim), 800);
  const b0 = bonds();
  drive.fire({ holdMs: 80 });
  let seen = 0;
  for (let t = 0; t < 80; t += 1) {
    seen = Math.max(seen, e2e.meteors().length);
    await sleep(100);
  }
  log(`after the meteor: bonds ${b0} -> ${bonds()}, meteors seen ${seen}`);

  // 4. Vehicles: cannonballs, a drive through the wreck, the meteor on a car.
  const note = (text) => log(text);
  const checks = await runNativeScenario(scenarios['demo-full'], { e2e, drive, session, note, sleep });
  for (const c of checks) log(`${c.pass ? 'PASS' : 'FAIL'} car ${c.car} ${c.check}: ${c.detail}`);

  // 5. Look over the damage until the recording ends.
  const end = drive.status();
  await lerpLook(drive, [end.yaw, end.pitch], [end.yaw + 1.2, 0.1], 6000);
  log('playthrough done');
}

run().catch((error) => console.error('[demo] FAILED:', error && (error.stack || error.message || String(error))));
