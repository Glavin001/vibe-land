// Scripted single-player /city playthrough for recording a video
// (scripts/native-mac.sh record). Boots the app bundle, then on a timeline:
// look over the city, walk up to the nearest building and shoot across its
// facade, bring down a second one, then take the nearest car and drive it
// into a building. Logs what happened; the recorder ends the run.
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
  await waitFor('the city', () => (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0 && e2e.cityStructures().length > 0);
  const city0 = e2e.snapshot().city;
  log(`city loaded: ${city0.chunksTotal} chunks, ${e2e.cityStructures().length} structures`);
  await sleep(1500);

  // 1. Look over the city.
  drive.faceCity();
  await sleep(200);
  const start = drive.status();
  await lerpLook(drive, [start.yaw, start.pitch], [start.yaw - 0.9, 0.05], 2500);
  await lerpLook(drive, [start.yaw - 0.9, 0.05], [start.yaw + 0.9, 0.12], 4000);

  // 2. Walk up to the nearest building and shoot across its facade.
  const byDistance = () => {
    const p = e2e.snapshot().position;
    return e2e.cityStructures()
      .map((s) => ({ s, d: Math.hypot(s.position[0] - p[0], s.position[2] - p[2]) }))
      .sort((a, b) => a.d - b.d);
  };
  const first = byDistance()[0].s;
  log(`approaching structure ${first.structureId} (${first.chunks} chunks, ${first.top.toFixed(1)} m)`);
  drive.lookAt(first.position[0], 2.5, first.position[2]);
  drive.setSprint(true);
  drive.move({ forward: 1, durationMs: 2200 });
  for (let t = 0; t < 22; t += 1) { drive.lookAt(first.position[0], 2.5, first.position[2]); await sleep(100); }
  drive.setSprint(false);
  await sleep(300);
  await shootAcross(drive, e2e, first, 3, 4, 4);
  log(`after the first building: ${e2e.snapshot().city.brokenBonds} broken bonds`);
  await sleep(2500);

  // 3. A second building, upper floors.
  const second = byDistance().find((entry) => entry.s.structureId !== first.structureId).s;
  log(`now structure ${second.structureId} (${second.chunks} chunks)`);
  await shootAcross(drive, e2e, second, 2, 3, 6);
  log(`after the second building: ${e2e.snapshot().city.brokenBonds} broken bonds`);
  await sleep(3000);

  // 4. Take the nearest car and drive it into a building.
  const vehicles = e2e.snapshot().vehicles ?? [];
  if (vehicles.length > 0) {
    const p = e2e.snapshot().position;
    const car = vehicles
      .map((v) => ({ v, d: Math.hypot(v.position[0] - p[0], v.position[2] - p[2]) }))
      .sort((a, b) => a.d - b.d)[0].v;
    log(`walking to vehicle ${car.id}`);
    for (let t = 0; t < 60 && !e2e.snapshot().inVehicle; t += 1) {
      const me = e2e.snapshot().position;
      const vehicle = (e2e.snapshot().vehicles ?? []).find((v) => v.id === car.id) ?? car;
      drive.lookAt(vehicle.position[0], me[1], vehicle.position[2]);
      const distance = Math.hypot(vehicle.position[0] - me[0], vehicle.position[2] - me[2]);
      if (distance < 3) { drive.stop(); drive.interact(); await sleep(400); continue; }
      drive.setSprint(true);
      drive.move({ forward: 1, durationMs: 200 });
      await sleep(150);
    }
    drive.setSprint(false);
    if (e2e.snapshot().inVehicle) {
      const target = byDistance()[0].s;
      log(`driving into structure ${target.structureId}`);
      drive.lookAt(target.position[0], 1.5, target.position[2]);
      for (let t = 0; t < 60; t += 1) {
        drive.lookAt(target.position[0], 1.5, target.position[2]);
        drive.move({ forward: 1, durationMs: 200 });
        await sleep(100);
      }
      drive.stop();
      log(`after the car: ${e2e.snapshot().city.brokenBonds} broken bonds`);
    } else {
      log('could not get into the car; looking over the damage instead');
    }
  }

  // 5. Look over the damage until the recording ends.
  const end = drive.status();
  await lerpLook(drive, [end.yaw, end.pitch], [end.yaw + 1.2, 0.1], 6000);
  log('playthrough done');
}

run().catch((error) => console.error('[demo] FAILED:', error && (error.stack || error.message || String(error))));
