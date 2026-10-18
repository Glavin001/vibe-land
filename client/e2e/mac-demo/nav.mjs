import { snap, sleep } from './session.mjs';

export const t0 = Date.now();
export const mark = (what) => console.log(`[t=${((Date.now() - t0) / 1000).toFixed(1)}s] ${what}`);

// Walk to a point, re-aiming every half second.
// The Vibe Jam exit portal (client/src/scene/Portals.tsx, EXIT_PORTAL_XZ)
// navigates the page away when walked through; route around it.
const PORTAL = [20, 0], PORTAL_CLEARANCE = 5;

function passesPortal(from, x, z) {
  const dx = x - from[0], dz = z - from[2], len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((PORTAL[0] - from[0]) * dx + (PORTAL[1] - from[2]) * dz) / len2)) : 0;
  return Math.hypot(from[0] + t * dx - PORTAL[0], from[2] + t * dz - PORTAL[1]) < PORTAL_CLEARANCE;
}

export async function walkTo(page, x, z, options = {}) {
  const s = await snap(page);
  if (passesPortal(s.position, x, z)) {
    // Detour on the side of the portal the walk starts from.
    const side = s.position[2] >= PORTAL[1] ? 1 : -1;
    await walkStraight(page, PORTAL[0], PORTAL[1] + side * (PORTAL_CLEARANCE + 3), { ...options, within: 3 });
  }
  return walkStraight(page, x, z, options);
}

async function walkStraight(page, x, z, { within = 2.5, sprint = true, timeoutMs = 40000 } = {}) {
  const end = Date.now() + timeoutMs;
  await page.evaluate((s) => window.__VIBE_DRIVE__.setSprint(s), sprint);
  let last = null, lastAt = Date.now(), side = 1;
  while (Date.now() < end) {
    const s = await snap(page);
    if (Math.hypot(x - s.position[0], z - s.position[2]) < within) break;
    if (!last || Math.hypot(s.position[0] - last[0], s.position[2] - last[2]) > 0.8) {
      last = s.position; lastAt = Date.now();
    } else if (Date.now() - lastAt > 1500) {
      // Blocked by a prop or a steep face: step sideways and jump, then retry.
      await page.evaluate((sd) => { window.__VIBE_DRIVE__.move({ forward: 0.3, strafe: sd, durationMs: 1200 }); window.__VIBE_DRIVE__.jump(200); }, side);
      await sleep(1300);
      side = -side; last = null;
      continue;
    }
    await page.evaluate(([x, z, y]) => { window.__VIBE_DRIVE__.lookAt(x, y, z); window.__VIBE_DRIVE__.move({ forward: 1, durationMs: 700 }); }, [x, z, s.position[1] + 1.4]);
    await sleep(400);
  }
  await page.evaluate(() => window.__VIBE_DRIVE__.stop());
  return snap(page);
}

const vehicleOf = (s, id) => (s.vehicles || []).find((v) => v.id === id);

// Drive the car through waypoints, steering by the heading the car actually moved.
export async function driveTo(page, id, waypoints, { steerSign = 1, throttle = 1, within = 6, legMs = 25000, log = () => {} } = {}) {
  let s = await snap(page);
  let prev = vehicleOf(s, id).position;
  let maxSpeed = 0;
  for (const [tx, tz] of waypoints) {
    const end = Date.now() + legMs;
    let stuck = 0, wedged = 0;
    while (Date.now() < end) {
      await sleep(150);
      s = await snap(page);
      const car = vehicleOf(s, id);
      if (!car) break;
      const p = car.position;
      maxSpeed = Math.max(maxSpeed, car.speedMs);
      const toX = tx - p[0], toZ = tz - p[2];
      if (Math.hypot(toX, toZ) < within) break;
      const hx = p[0] - prev[0], hz = p[2] - prev[2];
      let steer = 0, fwd = throttle;
      if (Math.hypot(hx, hz) > 0.04) {
        const ang = Math.atan2(hx * toZ - hz * toX, hx * toX + hz * toZ);
        steer = Math.max(-1, Math.min(1, steerSign * ang * 1.6));
        stuck = 0;
      } else if (++stuck > 12) {
        // Wedged: back out with the wheel turned; if that fails too (on its
        // side after a steep slope), use the game's Reset Vehicle key.
        wedged += 1;
        if (wedged >= 2) {
          log('car wedged: pressing R (reset vehicle)');
          await resetVehicle(page);
          wedged = 0;
        } else {
          await page.evaluate(() => window.__VIBE_DRIVE__.move({ forward: -1, strafe: 1, durationMs: 1800 }));
          await sleep(1900);
        }
        stuck = 0;
        s = await snap(page);
        if (!vehicleOf(s, id)) break;
        prev = vehicleOf(s, id).position;
        continue;
      }
      await page.evaluate(([f, st]) => window.__VIBE_DRIVE__.move({ forward: f, strafe: st, durationMs: 400 }), [fwd, steer]);
      prev = p;
    }
    const car = vehicleOf(await snap(page), id);
    if (!car) { log(`car ${id} left the snapshot`); break; }
    log(`waypoint (${tx}, ${tz}) reached at [${car.position.map((v) => v.toFixed(1)).join(', ')}], ${car.speedMs.toFixed(1)} m/s`);
  }
  await page.evaluate(() => window.__VIBE_DRIVE__.stop());
  return maxSpeed;
}

export async function enterNearest(page, id) {
  for (let i = 0; i < 12; i++) {
    let s = await snap(page);
    if (s.inVehicle && s.drivenVehicleId === id) return true;
    const car = vehicleOf(s, id);
    if (s.nearestVehicleId === id) {
      await page.evaluate(() => { window.__VIBE_DRIVE__.stop(); window.__VIBE_DRIVE__.interact(); });
      await sleep(1500);
      continue;
    }
    if (car) await page.evaluate(([x, z]) => { window.__VIBE_DRIVE__.lookAt(x, 1, z); window.__VIBE_DRIVE__.move({ forward: 1, durationMs: 400 }); }, [car.position[0], car.position[2]]);
    await sleep(500);
  }
  const s = await snap(page);
  return s.inVehicle && s.drivenVehicleId === id;
}

// The game's Reset Vehicle key. The drive bridge overrides keyboard input while
// active, and the key needs page focus, hence the clear and the click.
export async function resetVehicle(page) {
  await page.evaluate(() => window.__VIBE_DRIVE__.clear());
  const vp = page.viewportSize();
  await page.mouse.click(vp.width / 2, vp.height / 3);
  await sleep(200);
  await page.keyboard.down('KeyR'); await sleep(120); await page.keyboard.up('KeyR');
  await sleep(1500);
}
