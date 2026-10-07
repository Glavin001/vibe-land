// The hero film: a monster truck across a town being taken apart around it
// (scripts/film/hero-run.sh; scripts/native-mac.sh film hero-run --scene hero).
//
// One drive, Main Street end to end in Vibe Town's hero variant
// (structures/vibe-town/build-town.mjs VIBE_TOWN_VARIANT=hero): off the
// launch ramp west of Elm Park, between the houses, past the furnished corner
// cafe, through the Market Quarter's shops and bus station, and up to the
// towers, where one comes down. The truck is driven on the player's controls
// alone by the closed-loop driver (film/driver.mjs) following the avoidance
// planner (film/planner.mjs), re-planned ten times a second inside the road's
// width, around every other car on the street and every meteor lying in it,
// wherever they have been thrown -- nothing sets its pose. The strikes fire
// on the truck's position, not the clock, so they land where they should
// however a take's physics goes; their results are the physics' own.
//
// Cameras: a low chase over the jump, a still camera on a driveway, the
// driver's seat (film mount()), inside the cafe's first-floor flat, a high
// chase down the gauntlet, wide on the tower, and a rise over it all.
// Captions are subtitles (post.py `caption`), few, and true: nothing claims
// real time, every number is measured in the take.
//
// HERO_ZONE (FILM_DEFINES='--define:HERO_ZONE="cafe"'): one zone alone, the
// truck parked a run-up before it (hero-run.sh moves its slot), for checking a
// zone in under a minute instead of the whole film. Every take logs a
// `judge {json}` line at the end (stuck, flipped, wheels, how far, each
// parked car's damage) that hero-run.sh reads.
/* global HERO_ZONE, FILM_FPS */
import { shoot, hold, path, mount, chase, note } from '../film/film.mjs';
import { enter, meteorArc } from '../film/shots.mjs';
import { truckState, createDriver } from '../film/driver.mjs';
import { plan, PLAN } from '../film/planner.mjs';
import { route as makeRoute, makePath } from '../film/path.mjs';
import { ZONES, HERO_START, ROAD_HALF, KERB_HALF, zoneOf } from './hero-run-plan.mjs';

const ZONE = typeof HERO_ZONE === 'string' && HERO_ZONE && HERO_ZONE !== 'all' ? HERO_ZONE : null;
const FPS = typeof FILM_FPS === 'number' ? FILM_FPS : 30;
/** The parked cast: car-1 to car-9 (the scene's slots after the truck's). */
const CAST_SIZE = 10;
const r2 = (v) => +v.toFixed(2);
/** The tower that comes down: Main Street's first (structures/vibe-town/build-town.mjs), and its pieces. */
const TOWER_X = 90, TOWER_PIECES = 1096;
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ------------------------------------------------------------- the route
// Main Street's centre line, east from the approach; the planner holds the
// truck within ROAD_HALF of it (the asphalt less the truck's half width).
const start = ZONE ? zoneOf(ZONE).runup : HERO_START;
const ROUTE = makePath(makeRoute({ x: start[0], z: 0, psi: Math.PI / 2 }, [{ line: ZONES.at(-1).stopX - start[0] + 30 }]).points, { step: 0.5 });
/**
 * The planner on the street: sideways moves within the asphalt, and up onto
 * the pavement only when the road is blocked (a rock lying in it): the offset
 * weight makes the kerb dear, not forbidden.
 */
const SETTINGS = {
  ...PLAN,
  offsets: [-KERB_HALF, -ROAD_HALF, -ROAD_HALF / 2, 0, ROAD_HALF / 2, ROAD_HALF, KERB_HALF],
  second: [-KERB_HALF, -ROAD_HALF, 0, ROAD_HALF, KERB_HALF],
  minLength: 8,
  w: { ...PLAN.w, offset: 2.0 },
};
/** Route speed by where the truck is (each zone its own). */
const speedAt = (x) => (ZONES.find((z) => x < z.toX) ?? ZONES.at(-1)).speed;

// --------------------------------------------------------- strikes and edits
/**
 * The meteor, on an arc from `from` (compass bearing, degrees: 0 from +z)
 * landing on `at` `flight` seconds after launch, `slope` m up per metre out;
 * `radius`/`mass` for a smaller or larger rock (the server's own otherwise).
 */
function meteorOn(ctx, at, { from, flight = 2.74, slope = 0.8, radius, mass } = {}) {
  const { start: s0, velocity, T } = meteorArc(at, from, flight, slope);
  ctx.session.replayEvent(JSON.stringify({ kind: 'meteor', start: s0, velocity, target: at, flight_s: T,
    ...(radius ? { radius_m: radius } : {}), ...(mass ? { mass_kg: mass } : {}) }));
  ctx.impact(at, ctx.t + T);
  return T;
}
/** The city cannonball from `origin` along `direction` (its own mass and speed). */
function cannon(ctx, origin, direction, eta = 0.3) {
  const n = Math.hypot(...direction);
  ctx.session.replayEvent(JSON.stringify({ kind: 'shot', weapon: 3, origin, direction: direction.map((v) => v / n) }));
  ctx.impact(origin.map((v, k) => v + (direction[k] / n) * 18), ctx.t + eta);
}
/** A subtitle `lead` s from now; never over another (it waits for the one before to go). */
let captionFreeAt = -Infinity;
const sub = (ctx, text, seconds, lead = 0) => {
  const from = Math.max(ctx.t + lead, captionFreeAt + 0.25);
  captionFreeAt = from + seconds;
  ctx.edit({ type: 'title', style: 'caption', text, from, to: from + seconds });
};
const slow = (ctx, lead, seconds, rate = 0.5) => ctx.edit({ type: 'slowmo', from: ctx.t + lead, to: ctx.t + lead + seconds, rate });

/**
 * The film's events, each fired once when the truck first reaches `x`
 * (metres east along Main Street). In a zone run, those behind its start
 * are dropped.
 */
const EVENTS = [
  // The hook: a rock already falling ahead as the take opens, landing on the
  // first house north of the street while the truck is in the air.
  { zone: 'launch', x: -244, run: (ctx) => meteorOn(ctx, [-134, 4.2, 15.5], { from: 75, flight: 3.3, slope: 0.35 }) },
  // The cut opens here: the truck at speed for the ramp, the rock already in the sky.
  { zone: 'launch', x: -238, run: (ctx) => ctx.edit({ type: 'trim', from: ctx.t }) },
  { zone: 'launch', x: -226, run: (ctx) => sub(ctx, 'Physics decides every break.', 2.6, 0.1) },
  // A driveway: the house beside the parked car, hit from the west-north-west
  // and low, so it bursts east over the driveway and its car.
  { zone: 'driveway', x: -146, run: (ctx) => { const T = meteorOn(ctx, [-118.5, 3.6, 15.5], { from: 322, flight: 1.4, slope: 0.45 }); slow(ctx, T - 0.25, 2.2); } },
  // The slalom: a rock beside the derby parked on the right shoulder (it goes
  // over), houses either side hit from across the road (thrown away from it).
  { zone: 'cockpit', x: -128, run: (ctx) => meteorOn(ctx, [-88, 0.8, 5.6], { from: 200, flight: 1.8, slope: 0.35 }) },
  { zone: 'cockpit', x: -96, run: (ctx) => meteorOn(ctx, [-68, 4, 16], { from: 180, flight: 1.3, slope: 0.3 }) },
  { zone: 'cockpit', x: -84, run: (ctx) => meteorOn(ctx, [-51, 4, -15.5], { from: 0, flight: 1.3, slope: 0.3 }) },
  // The cafe: cannonballs through the first-floor flat from Main Avenue's
  // side, one through the living room, one through the kitchen.
  { zone: 'cafe', x: -17, run: (ctx) => { cannon(ctx, [-8, 5.2, 13.2], [-1, 0, 0]); slow(ctx, 0.1, 2.6); } },
  { zone: 'cafe', x: -15, run: (ctx) => cannon(ctx, [-8, 5.0, 21.6], [-1, 0, 0]) },
  { zone: 'cafe', x: -14, run: (ctx) => sub(ctx, 'Nobody animated that fridge.', 2.2, 0.6) },
  // The gauntlet: the bus station and the shops opposite, each hit from
  // across the road just ahead; the car by the far shoulder struck beside it.
  { zone: 'gauntlet', x: -6, run: (ctx) => meteorOn(ctx, [20, 2.2, -10.5], { from: 0, flight: 1.4, slope: 0.28 }) },
  { zone: 'gauntlet', x: 0, run: (ctx) => meteorOn(ctx, [16.5, 4, 12], { from: 180, flight: 1.4, slope: 0.28 }) },
  { zone: 'gauntlet', x: 10, run: (ctx) => meteorOn(ctx, [29.5, 4, 12], { from: 180, flight: 1.3, slope: 0.28 }) },
  // The car on the far shoulder: a cannonball into it from across the road, down
  // onto its roof -- bodywork and glass off, not the whole car gone.
  { zone: 'gauntlet', x: 34, run: (ctx) => cannon(ctx, [60, 7, 13], [0, -0.35, -1], 0.27) },
  { zone: 'gauntlet', x: 40, run: (ctx) => carCaption(ctx, 8, 1.4) },
  // The tower beside the road (Main Street's first, x 90): its north face's
  // base taken out from across the street, so it goes over towards the road.
  { zone: 'tower', x: 62, run: (ctx) => sub(ctx, `Ten storeys. ${fmt(TOWER_PIECES)} pieces.`, 2.2, 0.1) },
  { zone: 'tower', x: 68, run: (ctx) => {
    // Three rocks low across the street into the columns, landing a third of a second apart.
    [-5, 0, 5].forEach((dx, k) => meteorOn(ctx, [TOWER_X + dx, 2.2, -8.6], { from: 345 + k * 15, flight: 1.2 + k * 0.35, slope: 0.22 }));
    slow(ctx, 1.5, 4.5);
  } },
];

/** A car's parts (distinct part ids among its hulls) and how many are off it (their first hull on another actor). */
function partsOf(d) {
  const first = (d?.hulls ?? []).filter((h) => (h.ordinal ?? 0) === 0);
  return { parts: first.length, off: first.filter((h) => h.actor !== 0).length };
}

/** The car struck in the gauntlet: its own count of breakable parts, measured. */
function carCaption(ctx, index, lead) {
  try {
    const parts = partsOf(JSON.parse(ctx.session.vehicleDebug(index))).parts;
    if (parts) sub(ctx, `This car: ${parts} breakable parts.`, 2.2, lead);
  } catch { /* no caption without a count */ }
}

// ------------------------------------------------------------- the drive
const LEAD = 1.4; // getting in, before the first frame driven
/** The truck's latest state (the drive loop's truckState), for the director's cuts. */
let truck = null;
const STOP_SPEED = 0.6;

function driveAction(seconds, fps) {
  const driver = createDriver();
  const keys = [{ forward: 0, strafe: 0 }, { forward: 0, strafe: 0 }];
  // Events behind a zone run's start never fire (indices into EVENTS).
  const fired = new Set(EVENTS.map((e, i) => (e.x < start[0] + 4 ? i : -1)).filter((i) => i >= 0));
  let current = null, frame = 0, stopX = ZONE ? zoneOf(ZONE).stopX ?? ZONES.at(-1).stopX : ZONES.at(-1).stopX;
  const judge = { maxX: -Infinity, stuck: 0, stuckSince: null, minUp: 1, wheelsLost: false, brokenStart: null, broken: 0, planMs: 0, plans: 0, maxHazards: 0, hits: [] };
  const steps = [];
  // Driven from LEAD (in the seat) to the film's last frame; the verdict on it.
  const frames = Math.round(seconds * fps) - 1;
  for (let k = Math.ceil(LEAD * fps); k < frames; k += 1) {
    const t = k / fps - LEAD;
    steps.push([(k - 0.3) / fps, (ctx) => {
      let d = null;
      try { d = JSON.parse(ctx.session.vehicleDebug(0)); } catch { return; }
      const s = d && truckState(d);
      if (!s) return;
      truck = s;
      // Events on the truck's position.
      EVENTS.forEach((e, i) => {
        if (fired.has(i) || s.p[0] < e.x) return;
        fired.add(i);
        ctx.log(`event ${e.zone} at x ${r2(s.p[0])}`);
        try { e.run(ctx); } catch (error) { ctx.log(`event ${e.zone} FAILED: ${error?.message ?? error}`); }
      });
      // Re-plan every 0.1 s around the other cars and the meteors at rest.
      if (frame++ % Math.max(1, Math.round(fps / 10)) === 0) {
        const hazards = [];
        const driven = ctx.e2e.snapshot()?.drivenVehicleId;
        for (const [id, v] of ctx.vehicles ?? []) {
          if (id === driven || Math.abs(v.position[0] - s.p[0]) > 45) continue;
          // A car as two circles along its length.
          const q = v.quaternion ?? [0, 0, 0, 1];
          const fx = 2 * (q[0] * q[2] + q[3] * q[1]), fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
          for (const a of [-1.15, 1.15]) hazards.push({ x: v.position[0] + fx * a, z: v.position[2] + fz * a, t: t - 1, radius: 1.15 });
        }
        for (const m of ctx.e2e.meteors?.() ?? []) {
          const p = m.raw?.position ?? m.drawn?.position;
          if (p && p[1] < 4 && Math.abs(p[0] - s.p[0]) < 45) hazards.push({ x: p[0], z: p[2], t: t - 1, radius: 2.3 });
        }
        judge.maxHazards = Math.max(judge.maxHazards, hazards.length);
        const t0 = Date.now();
        current = plan(s, t, { route: ROUTE, speed: speedAt(s.p[0]), hazards, last: current, keys, settings: SETTINGS });
        judge.planMs += Date.now() - t0; judge.plans += 1;
        driver.follow({ path: current.path, profile: current.profile, stop: current.factor === 0 || s.p[0] >= stopX });
        // Why it stops, once per stop: what it is avoiding.
        if (current.factor === 0 && s.p[0] < stopX && !judge.stopLogged) {
          judge.stopLogged = true;
          ctx.log(`blocked ${JSON.stringify({ t: r2(t), x: r2(s.p[0]), z: r2(s.p[2]), hazards: hazards.filter((h) => Math.abs(h.x - s.p[0]) < 25).map((h) => [r2(h.x), r2(h.z), h.radius]) })}`);
        } else if (current.factor > 0) judge.stopLogged = false;
      }
      let u = driver.step(s);
      // At the end of the road: brake to a stop, the handbrake swinging it round.
      if (s.p[0] >= stopX) u = { forward: s.vf > 0.5 ? -1 : 0, strafe: s.vf > 4 ? 0.6 : 0, handbrake: s.vf > 4 };
      keys.push(u); keys.shift();
      ctx.drive.move({ forward: u.forward, strafe: u.strafe });
      if (u.handbrake) ctx.drive.jump(25);
      // The judge's view of it.
      judge.brokenStart ??= s.broken;
      judge.broken = s.broken - judge.brokenStart;
      judge.maxX = Math.max(judge.maxX, s.p[0]);
      judge.minUp = Math.min(judge.minUp, s.upY);
      if (s.wheelMask != null && s.wheelMask !== 15) judge.wheelsLost = true;
      const wantsToMove = s.p[0] < stopX - 2 && t > 2.5;
      if (wantsToMove && s.speed < STOP_SPEED) { judge.stuckSince ??= t; if (t - judge.stuckSince > 0.7) judge.stuck = Math.max(judge.stuck, t - judge.stuckSince); }
      else judge.stuckSince = null;
      if (k % Math.max(1, Math.round(fps / 10)) === 0) {
        ctx.log(`hero ${JSON.stringify({ t: r2(t), x: r2(s.p[0]), y: r2(s.p[1]), z: r2(s.p[2]), v: r2(s.speed), up: r2(s.upY), w: s.wheelMask ?? null, br: s.broken, D: current?.D ?? null, f: current?.factor ?? null, c: current && Number.isFinite(current.clearance) ? r2(current.clearance) : null })}`);
      }
    }]);
  }
  // The verdict, after the last frame.
  steps.push([(frames - 0.3) / fps, (ctx) => {
    const cars = [];
    for (let i = 1; i < CAST_SIZE; i += 1) {
      try {
        const d = JSON.parse(ctx.session.vehicleDebug(i));
        const { parts, off } = partsOf(d), st = truckState(d);
        const spot = ctx.place(`car-${i}`)?.position;
        cars.push({ car: i, parts, off, broken: st?.broken ?? null, up: st ? r2(st.upY) : null,
          moved: st && spot ? r2(Math.hypot(st.p[0] - spot[0], st.p[2] - spot[2])) : null });
      } catch { cars.push({ car: i, error: true }); }
    }
    ctx.log(`judge ${JSON.stringify({
      zone: ZONE ?? 'all', reached: r2(judge.maxX), stopX, stuckS: r2(judge.stuck), flipped: judge.minUp < 0.5, minUp: r2(judge.minUp),
      wheelsLost: judge.wheelsLost, truckBondsBroken: judge.broken, planMs: r2(judge.planMs / Math.max(1, judge.plans)), maxHazards: judge.maxHazards,
      cityBroken: ctx.e2e.snapshot()?.city?.brokenBonds ?? null, cars,
    })}`);
    ctx.drive.move({ forward: 0, strafe: 0 });
  }]);
  return { label: 'drive', steps };
}

// ------------------------------------------------------------- the shots
/** A still camera turning: keys [[t, lookAt], ...], each turn eased (smoothstep). */
function pan(position, keys, seconds, { name = 'pan', fov = null, cues = [] } = {}) {
  const ease = (u) => { const v = Math.max(0, Math.min(1, u)); return v * v * (3 - 2 * v); };
  return {
    kind: 'pan', name, duration: seconds, cues, follow: false, fov,
    build: () => (t) => {
      let look = keys[0][1];
      for (let i = 1; i < keys.length; i += 1) {
        const [t0, a] = keys[i - 1], [t1, b] = keys[i];
        if (t >= t1) { look = b; continue; }
        if (t > t0) { const u = ease((t - t0) / (t1 - t0)); look = a.map((v, k) => v + (b[k] - v) * u); }
        break;
      }
      return { position, lookAt: look };
    },
  };
}

/**
 * The cameras, cut on the truck's position rather than the clock: each
 * segment comes on when the truck first reaches its `x` (or `after` seconds
 * into the one before), and its camera's own time starts there. The strikes
 * fire on the same positions, so a camera is always on what it was put there
 * for, however a take's physics slows the truck. One shot to the film's
 * timeline; its parts are listed for previews (`parts`).
 */
function director(segments, seconds) {
  const parts = segments.map((g) => g.shot);
  return {
    kind: 'director', name: 'drive', duration: seconds, cues: [], follow: false, fov: null, parts,
    build(ctx) {
      let on = 0, since = 0;
      const poses = segments.map(() => null);
      poses[0] = parts[0].build(ctx);
      const pose = (t) => {
        const next = segments[on + 1];
        if (next && ((next.x != null && truck && truck.p[0] >= next.x) || (next.after != null && t - since >= next.after))) {
          on += 1; since = t;
          poses[on] ??= parts[on].build(ctx);
          // A zone run's cut opens on its zone's first camera (the run-up dropped).
          if (segments[on].trim) ctx.edit({ type: 'trim', from: t });
          segments[on].onCut?.(ctx, t);
          // A segment's own look (an interior lifted by more sky light), back to the default after it.
          if (segments[on - 1].look || segments[on].look) ctx.e2e.setLook?.({ envIntensity: 1, ...(segments[on].look ?? {}) });
          ctx.log(`cut to ${parts[on].name} at ${t.toFixed(2)}s${truck ? `, truck at x ${truck.p[0].toFixed(1)}` : ''}`);
        }
        const p = poses[on](Math.min(parts[on].duration, t - since));
        return parts[on].fov ? { ...p, fov: parts[on].fov } : p;
      };
      pose.mount = (t) => (on >= 0 && poses[on].mount ? poses[on].mount(Math.min(parts[on].duration, t - since)) : null);
      pose.current = () => parts[on].name;
      return pose;
    },
  };
}

/** Every zone's segments: where each camera comes on (truck x) and the camera. */
function segmentsFor(zone) {
  switch (zone.name) {
    case 'launch':
      // Low behind the truck: the ramp, the town ahead and the rock already falling.
      return [{ x: -Infinity, shot: chase('driven', 12, { name: 'launch', back: 8.5, up: 1.9, ahead: 30, lift: 4.5, lag: 0.3, fov: 70,
        fallback: { position: [HERO_START[0] - 9, 2, 0], lookAt: [HERO_START[0] + 30, 4, 0] } }) }];
    case 'driveway':
      // A still camera across the street: the house, the car in its driveway, the road in front.
      return [{ x: -151, shot: hold({ position: [-127.6, 3.0, -9.2], lookAt: [-112.5, 2.6, 8] }, 8, { name: 'driveway', fov: 66 }) }];
    case 'cockpit':
      // The driver's seat, the head turning to the derby going over and back.
      return [
        { x: -114, shot: mount('driven', 12, { name: 'cockpit', at: 'driver', horizon: 0.6, fov: 82,
          look: [[0, { yaw: 0, pitch: -5 }], [1.0, { yaw: -28, pitch: -3 }], [2.3, { yaw: -10, pitch: -4 }], [3.0, { yaw: 0, pitch: -5 }]] }) },
        // Low beside the front wheel through the slalom: the cars and rubble it weaves round.
        { x: -74, shot: mount('driven', 12, { name: 'wheel', at: 'wheel-left', horizon: 'level', headingLag: 0.08, fov: 76,
          look: { yaw: -4, pitch: -1 } }) },
      ];
    case 'cafe':
      // Inside the cafe's first-floor flat, by the front window in its
      // south-west corner: the street and the truck coming, then round to
      // the room -- sofa, dining table, the kitchen and its fridge beyond --
      // as the cannonballs come through it from the far wall.
      // 1 m behind the middle front window: the street through it as the truck
      // goes by, then round to the room, the kitchen and its fridge straight ahead.
      return [{ x: -46, look: { envIntensity: 2.6 }, shot: pan([-25.5, 5.3, 9.6],
        [[0, [-33, 1.4, -2]], [1.3, [-27, 1.4, -2]], [2.2, [-25.8, 4.6, 20]]], 12, { name: 'cafe', fov: 80 }) }];
    case 'gauntlet':
      // High behind it down the Market Quarter: both sides of the street in frame.
      return [{ x: -2, shot: chase('driven', 14, { name: 'gauntlet', back: 10, up: 4.6, ahead: 14, lift: 1.2, lag: 0.45 }) }];
    case 'tower':
      // Wide from behind and to the left of the truck: the whole tower, ground to roof.
      return [
        { x: 58, shot: path([
          { position: [52, 8.5, 15], lookAt: [TOWER_X, 13, -13] },
          { position: [57, 9.5, 17], lookAt: [TOWER_X, 12, -11] },
        ], 9.5, { name: 'tower', ease: 'none', fov: 68 }) },
        { after: 9.5, onCut: (ctx, t) => {
          // The last words over the rise, then black.
          ctx.edit({ type: 'title', style: 'caption', text: 'Now it needs a game.\n@glavinw', from: t + 0.9, to: t + 4.6 });
          ctx.edit({ type: 'fade', dir: 'out', at: t + 4.4, seconds: 0.8 });
        }, shot: path([
          { position: [62, 8, 16], lookAt: [TOWER_X + 2, 3, -4] },
          { position: [44, 38, 50], lookAt: [TOWER_X + 6, 2, -2] },
        ], 5.4, { name: 'rise', ease: 'both' }) },
      ];
    default: return [];
  }
}

const zones = ZONE ? [zoneOf(ZONE)] : ZONES;
shoot({ scene: 'hero', shake: { strength: 0.55, radius: 80 } }, () => {
  const segments = zones.flatMap((z) => segmentsFor(z));
  // A zone alone: a chase from the run-up until its first camera comes on.
  if (ZONE && zoneOf(ZONE).runupSeconds > 0) {
    segments[0] = { ...segments[0], trim: true };
    segments.unshift({ x: -Infinity, shot: chase('driven', 30, { name: 'run-up', back: 9, up: 3, ahead: 12,
      fallback: { position: [start[0] - 9, 3, 0], lookAt: [start[0] + 12, 1, 0] } }) });
  }
  const seconds = ZONE ? zoneOf(ZONE).runupSeconds + zoneOf(ZONE).seconds + (ZONE === 'tower' ? 6 : 0) : 48;
  const film = director(segments, seconds);
  film.cues.push([0, enter([start[0], 0, start[1]])], [0, driveAction(seconds, FPS)], [0.2, note(`hero-run ${ZONE ?? 'all'}`)],
    // Its cannonballs drawn as the cast iron they are.
    [0, (ctx) => ctx.e2e.setLook?.({ ironBalls: 1 })]);
  return [film];
});
