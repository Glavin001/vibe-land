// The monster truck turning, driven by a closed-loop driver on the player's
// controls alone (client/native/film/driver.mjs): scripts/turning-lab.sh MODE.
// One car per episode (structures/vehicle-lab/turning.mjs), parked at its
// slot; each episode a shot: the player gets in, and every film frame the
// car's server state (session.vehicleDebug) is read, the episode's driver
// decides throttle / brake-or-reverse, steering and handbrake, and they go
// in through ctx.drive -- the keys a player would press, nothing else. Each
// frame is logged as `turn {json}` for client/native/film/sysid.mjs.
//
// MODE sysid, sysid2: the identification runs (open loop but for a speed
// hold). MODE course (or one course's id): the courses, tracked closed loop,
// measured (client/native/film/meter.mjs) and captioned as they go.
/* global TURNING_MODE */
import { boot } from '../film/film.mjs';
import { enter, launchMeteor } from '../film/shots.mjs';
import { placeResolver } from '../film/places.mjs';
import { truckState, clamp, createCourseDriver, createDriver } from '../film/driver.mjs';
import { plan, footprintDistance } from '../film/planner.mjs';
import { project } from '../film/path.mjs';
import { createMeter } from '../film/meter.mjs';
import { simulateCourse } from '../film/simulate.mjs';
import { episodesFor } from '../../../structures/vehicle-lab/turning.mjs';

const MODE = typeof TURNING_MODE === 'string' && TURNING_MODE ? TURNING_MODE : 'sysid';
const r3 = (v) => +v.toFixed(3);
/** Seconds from the shot's start to the driver's first frame (getting in). */
const LEAD = 1.4;
/** Seconds a dropped rock falls (the film toolkit's meteor: 384 m at 140 m/s). */
const FLIGHT = 2.74;

/** The latest state of each car (the cameras follow it). */
const latest = new Map();

/**
 * A chase camera on car `index`: `back` metres behind and `up` above it
 * along its smoothed course (velocity direction once it moves), looking
 * `ahead` metres in front of it. `drone`: a fixed world offset instead.
 */
function chase(index, slot, seconds, { name, cues, back = 11, up = 4.5, ahead = 5, lag = 0.4, drone = null } = {}) {
  return {
    kind: 'chase', name, duration: seconds, cues, follow: false,
    build: () => {
      let pos = null, yaw = (slot[2] * Math.PI) / 180, last = null;
      return (t) => {
        const s = latest.get(index);
        const p = s ? s.p : [slot[0], 1, slot[1]];
        if (s && s.speed > 2) {
          const course = Math.atan2(s.v[0], s.v[2]), k = last == null ? 1 : 1 - Math.exp(-Math.max(0, t - last) / lag);
          yaw += Math.atan2(Math.sin(course - yaw), Math.cos(course - yaw)) * k;
        }
        const k = pos == null || last == null || t < last ? 1 : 1 - Math.exp(-(t - last) / lag);
        pos = pos ? pos.map((v, i) => v + (p[i] - v) * k) : [...p];
        last = t;
        const fx = Math.sin(yaw), fz = Math.cos(yaw);
        if (drone) return { position: [pos[0] + drone[0], pos[1] + drone[1], pos[2] + drone[2]], lookAt: [pos[0], pos[1] + 0.5, pos[2]] };
        return { position: [pos[0] - fx * back, pos[1] + up, pos[2] - fz * back], lookAt: [pos[0] + fx * ahead, pos[1] + 1, pos[2] + fz * ahead] };
      };
    },
  };
}

// ------------------------------------------------------------ identification

/** Throttle to hold `target` m/s forward: proportional, never the brake. */
const holdSpeed = (s, target) => clamp(0.35 + 0.6 * (target - s.vf), 0, 1);

/** An identification episode's program (turning.mjs SYSID): its phases in turn. */
function programDriver(e) {
  let k = 0, since = 0;
  return {
    get phase() { return e.program[Math.min(k, e.program.length - 1)].name; },
    step(s, t) {
      let ph = e.program[k];
      const dt = t - since;
      const done = (ph.seconds != null && dt >= ph.seconds) || (ph.max != null && dt >= ph.max)
        || (ph.untilSpeed != null && s.vf >= ph.untilSpeed) || (ph.untilBelow != null && s.vf < ph.untilBelow);
      if (done && k < e.program.length - 1) { k += 1; since = t; ph = e.program[k]; }
      const forward = ph.forward === 'hold' ? holdSpeed(s, e.speed) : ph.forward ?? 0;
      const strafe = typeof ph.strafe === 'object' ? ph.strafe.sine * Math.sin(2 * Math.PI * ph.strafe.hz * (t - since)) : ph.strafe ?? 0;
      return { forward, strafe, handbrake: !!ph.handbrake };
    },
  };
}

// ------------------------------------------------------------------ courses

const kmh = (v) => `${Math.round(v * 3.6)} km/h`;
/** Every course's result, for the closing card. */
const results = [];

/** A course episode's pilot: the course driver, the meter, captions as it goes. */
function coursePilot(e) {
  const driver = createCourseDriver(e.legs);
  const meter = createMeter(e);
  const knocked = coneWatch(e.cones ?? []);
  let segShown = 0, finished = false, stillSince = null, hullsLogged = false, logged = 0;
  const caption = (ctx, text, seconds = 3.2) => ctx.edit({ type: 'title', style: 'lower', size: 'small', text, from: ctx.t, to: ctx.t + seconds });
  const finish = (ctx, t) => {
    if (finished) return;
    finished = true;
    meter.finish(t);
    const r = { ...meter.result(), ...knocked.result() };
    if (e.check) ctx.log(`cone-check ${JSON.stringify({ struck: r.conesStruck, footprint: [...Array(e.cones.length).keys()].map((i) => r.firstHits.some((h) => h.cone === i)), knocked: knocked.perCone() })}`);
    results.push({ id: e.id, ...r, speed: e.speed ?? null });
    ctx.log(`course ${JSON.stringify({ id: e.id, ...r })}`);
    // Hit: a cone inside the truck's footprint (3.0 x 4.9 m, conservative:
    // the body clears a cone the box does not); run over: a wheel left the
    // flat ground beside one (cone-check calibrates both).
    const parts = [`${r.conesHit} of ${r.cones} cones hit${r.conesStruck ? ` (${r.conesStruck} run over)` : ''}`, `max ${r.maxLatG.toFixed(2)} g`];
    if (r.pathRms != null && !e.circle) parts.push(`path error ${r.pathRms.toFixed(2)} m RMS`);
    if (r.gate) parts.push(r.gate.clean ? `through the gate (${Math.abs(r.gate.offset).toFixed(1)} m off its middle)` : `missed the gate by ${(Math.abs(r.gate.offset) + 1.5 - e.gate.half).toFixed(1)} m`);
    if (r.seconds != null && e.timing) parts.push(`${r.seconds.toFixed(1)} s through`);
    caption(ctx, parts.join(' · '), 4);
  };
  return {
    get phase() { return driver.phase; },
    step(s, t, ctx, d) {
      if (!hullsLogged) { hullsLogged = true; ctx.log(`footprint ${JSON.stringify(footprint(d, s))}`); }
      const u = driver.step(s, t);
      while (logged < driver.events.length) ctx.log(`leg-event ${JSON.stringify({ id: e.id, ...driver.events[logged++] })}`);
      const leg = e.legs[driver.leg];
      meter.sample(s, t, { leg: driver.leg, s: u.info?.s, e: u.info?.e, tracking: leg?.kind === 'track' });
      if (e.cones?.length && Math.round(t * 60) % 6 === 0) knocked.watch(ctx);
      // A circle's segments, captioned as each ends.
      const segs = e.circle?.segments ?? [];
      if (segShown < segs.length && driver.leg === 0 && u.info?.s >= segs[segShown].s1) {
        const g = meter.result().segments[segShown];
        caption(ctx, `${g.label}${g.speed ? ` (${kmh(g.speed)})` : ''}: radius ${g.radius} m · ${g.latG.toFixed(2)} g`, 3.5);
        ctx.log(`segment ${JSON.stringify({ id: e.id, ...g })}`);
        segShown += 1;
      }
      if (!finished && (u.phase === 'stop' || (leg?.kind === 'track' && leg.stop && driver.tracker.done))) {
        stillSince = Math.abs(s.vf) < 0.3 ? stillSince ?? t : null;
        if (stillSince != null && t - stillSince > 0.3) finish(ctx, t);
      }
      return { ...u, log: { leg: driver.leg, err: u.info?.e != null ? r3(u.info.e) : null, vref: u.info?.vref != null ? r3(u.info.vref) : null } };
    },
    end(ctx, t) { finish(ctx, t); },
  };
}

// --------------------------------------------------------------- avoidance

/** The truck's footprint as measured (part centres 2.1 m fore and aft, 1.28 m out; plus half a part). */
const TRUE_FOOTPRINT = { halfLength: 2.45, halfWidth: 1.5 };

/**
 * An avoidance episode's pilot: rocks dropped where the truck would have
 * been (cues), re-planned every 0.1 s, the plan tracked; each rock's real
 * position (the streamed meteor) against the truck's footprint.
 */
function avoidPilot(e) {
  const { route, speed, hazards, reveal, blind } = e.avoid;
  const driver = createDriver();
  const keys = [{ forward: 0, strafe: 0 }, { forward: 0, strafe: 0 }];
  const clear = hazards.map(() => Infinity), rests = hazards.map(() => null), told = hazards.map(() => false);
  let current = null, frame = 0, planMs = 0, plans = 0, brokenStart = null, finished = false, maxPlanMs = 0;
  const caption = (ctx, text, seconds = 3) => ctx.edit({ type: 'title', style: 'lower', size: 'small', text, from: ctx.t, to: ctx.t + seconds });
  const finish = (ctx, s, t) => {
    if (finished) return;
    finished = true;
    const progress = project(route, s.p[0], s.p[2]).s;
    const hit = clear.filter((c) => c < 0).length;
    const result = { id: e.id, seed: e.seed, blind: !!blind, reveal: Number.isFinite(reveal) ? reveal : null, hazards: hazards.length, hit,
      clearances: clear.map((c) => (Number.isFinite(c) ? +c.toFixed(2) : null)), rests, progress: +progress.toFixed(1),
      bondsBroken: s.broken - (brokenStart ?? s.broken), planMs: +(planMs / Math.max(1, plans)).toFixed(1), maxPlanMs };
    results.push(result);
    ctx.log(`avoid ${JSON.stringify(result)}`);
    const seen = clear.filter(Number.isFinite);
    const damage = result.bondsBroken ? `${result.bondsBroken} joints broken` : 'not a scratch';
    if (blind) caption(ctx, hit ? `Hit by ${hit === 1 ? `rock ${clear.findIndex((c) => c < 0) + 1}` : `${hit} rocks`} · ${damage} · stopped ${progress.toFixed(0)} m down the road` : `Missed by all ${hazards.length} · closest ${Math.min(...seen).toFixed(1)} m`, 4);
    else caption(ctx, `${hazards.length - hit} of ${hazards.length} avoided · closest ${Math.min(...seen).toFixed(1)} m · ${damage}`, 4);
  };
  return {
    get phase() { return current ? `D${current.D}x${current.factor}` : 'plan'; },
    step(s, t, ctx) {
      brokenStart ??= s.broken;
      if (frame++ % 6 === 0) {
        const t0 = Date.now();
        // Blind: the same driver on the same road, planning as if the sky were empty.
        current = plan(s, t, { route, speed, hazards: blind ? [] : hazards, last: current, keys, reveal });
        const ms = Date.now() - t0; planMs += ms; plans += 1; maxPlanMs = Math.max(maxPlanMs, ms);
        driver.follow({ path: current.path, profile: current.profile, stop: current.factor === 0 });
      }
      const u = driver.step(s);
      keys.push(u); keys.shift();
      // The real rocks, near where each was aimed, once down to the truck's height.
      const rocks = (ctx.e2e.meteors?.() ?? []).map((m) => m.raw?.position).filter(Boolean);
      hazards.forEach((h, i) => {
        if (t < h.t - 0.5) return;
        let best = null;
        for (const p of rocks) { const d = Math.hypot(p[0] - h.x, p[2] - h.z); if (p[1] < 5 && d < 8 && (!best || d < best.d)) best = { p, d }; }
        if (!best) return;
        rests[i] = best.p.map((v) => +v.toFixed(2));
        clear[i] = Math.min(clear[i], footprintDistance(s.p[0], s.p[2], s.psi, best.p[0], best.p[2], TRUE_FOOTPRINT) - h.radius);
        if (!told[i] && t >= h.t + 0.6) {
          told[i] = true;
          caption(ctx, clear[i] < 0 ? `rock ${i + 1}: HIT` : `rock ${i + 1}: ${clear[i].toFixed(1)} m clear`, 1.8);
        }
      });
      if (t >= e.seconds - 0.6) finish(ctx, s, t);
      return { ...u, log: { D: current.D, f: current.factor, c: Number.isFinite(current.clearance) ? r3(current.clearance) : null } };
    },
    end(ctx, t) { const s = latest.get(e.index); if (s) finish(ctx, s, t); },
  };
}

/**
 * The cones as the game has them: each loose chunk the client draws (the
 * e2e drawn-world sample: every debris body, a few hundred at most, each
 * call) matched once to the cone it stands on, then watched -- knocked when
 * it has moved 10 cm or tilted 5 degrees from where it stood.
 */
function coneWatch(cones) {
  const slotOf = new Map(), rest = new Map(), moved = new Map();
  return {
    watch(ctx) {
      const c = ctx.e2e.drawnWorld?.()?.city;
      if (!c) return;
      for (let k = 0; k < c.slots.length; k += 1) {
        const slot = c.slots[k], p = c.positions.slice(3 * k, 3 * k + 3), q = c.rotations.slice(4 * k, 4 * k + 4);
        if (!slotOf.has(slot)) {
          const i = cones.findIndex(([x, z]) => Math.abs(x - p[0]) < 0.3 && Math.abs(z - p[2]) < 0.3 && p[1] < 1);
          if (i < 0) continue;
          slotOf.set(slot, i); rest.set(slot, p);
        }
        const r0 = rest.get(slot), i = slotOf.get(slot);
        const shift = Math.hypot(p[0] - r0[0], p[1] - r0[1], p[2] - r0[2]), tilt = 2 * Math.asin(Math.min(1, Math.hypot(q[0], q[2])));
        const m = moved.get(i) ?? { shift: 0, tiltDeg: 0, samples: 0 };
        moved.set(i, { shift: Math.max(m.shift, +shift.toFixed(3)), tiltDeg: Math.max(m.tiltDeg, +((tilt * 180) / Math.PI).toFixed(1)), samples: m.samples + 1, slot, at: p.map((v) => +v.toFixed(2)) });
      }
    },
    perCone() { return cones.map((_, i) => moved.get(i) ?? null); },
    result() {
      return { conesSeen: slotOf.size, conesKnocked: slotOf.size ? [...moved.values()].filter((m) => m.shift > 0.1 || m.tiltDeg > 5).length : null };
    },
  };
}

/** Where the car's parts lie about its reference point (the footprint check's half length and width). */
function footprint(d, s) {
  const hulls = d?.hulls ?? [];
  let fwd = 0, lat = 0, back = 0;
  for (const h of hulls) {
    const dx = h.position[0] - s.p[0], dz = h.position[2] - s.p[2];
    const f = dx * Math.sin(s.psi) + dz * Math.cos(s.psi), l = dx * Math.cos(s.psi) - dz * Math.sin(s.psi);
    fwd = Math.max(fwd, f); back = Math.min(back, f); lat = Math.max(lat, Math.abs(l));
  }
  return { hulls: hulls.length, partCentresForward: r3(fwd), partCentresBack: r3(back), partCentresHalfWidth: r3(lat) };
}

/** Where the camera stands for an episode. */
function cameraFor(e, index, seconds, opts) {
  const c = e.camera ?? {};
  if (c.watch) return watchCar(index, e.slot, c.watch, seconds, opts);
  return chase(index, e.slot, seconds, { ...opts, ...(c.chase ?? {}) });
}

/** A fixed camera turning to follow car `index`. */
function watchCar(index, slot, at, seconds, { name, cues, lag = 0.3 } = {}) {
  return {
    kind: 'watch', name, duration: seconds, cues, follow: false,
    build: () => {
      let look = null, last = null;
      return (t) => {
        const s = latest.get(index), p = s ? s.p : [slot[0], 1, slot[1]];
        const k = look == null || last == null || t < last ? 1 : 1 - Math.exp(-(t - last) / lag);
        look = look ? look.map((v, i) => v + (p[i] - v) * k) : [...p];
        last = t;
        return { position: at, lookAt: [look[0], look[1] + 0.8, look[2]] };
      };
    },
  };
}

// ------------------------------------------------------------------ the run

/** One episode as a shot: get in, then every frame read, decide, press, log. */
function episodeShot(e, index, fps) {
  const car = `car-${index}`;
  const pilot = e.program ? programDriver(e) : e.avoid ? avoidPilot({ ...e, index }) : coursePilot(e);
  const cues = [[0, enter(car)]];
  if (e.caption) cues.push([0.2, (ctx) => ctx.edit({ type: 'title', style: 'lower', size: 'small', text: `Monster truck · ${e.caption}`, from: ctx.t, to: ctx.t + 3.4 })]);
  const frames = Math.round((LEAD + e.seconds) * fps);
  // Every frame from the driver's first: one action (the runner logs an
  // action's first step only), each step a third of a frame early -- film
  // time and cue times are both sums of floats.
  const steps = [];
  for (let k = Math.ceil(LEAD * fps); k <= frames; k += 1) {
    const t = k / fps - LEAD;
    steps.push([(k - 0.3) / fps, (ctx) => {
      const d = (() => { try { return JSON.parse(ctx.session.vehicleDebug(index)); } catch { return null; } })();
      const s = d && truckState(d);
      if (!s) return;
      latest.set(index, s);
      const u = pilot.step(s, t, ctx, d);
      ctx.drive.move({ forward: u.forward, strafe: u.strafe });
      if (u.handbrake) ctx.drive.jump(25);
      ctx.log(`turn ${JSON.stringify({
        e: e.id, ph: pilot.phase, t: r3(t), x: r3(s.p[0]), y: r3(s.p[1]), z: r3(s.p[2]), psi: r3(s.psi), vf: r3(s.vf), vl: r3(s.vl), r: r3(s.w[1]),
        ws: s.wheelSteer.map(r3), on: s.wheelsOnRoad, up: r3(s.upY), u: [r3(u.forward), r3(u.strafe), u.handbrake ? 1 : 0], br: s.broken, ...(u.log ?? {}),
      })}`);
    }]);
  }
  cues.push([0, { label: `drive ${e.id}`, steps }]);
  // Each rock dropped straight down (slope 1000: launched from ~384 m above
  // it), landing at its time on its spot, centre at its radius above the ground.
  for (const h of e.avoid?.hazards ?? []) cues.push([LEAD + h.t - FLIGHT, (ctx) => launchMeteor(ctx, [h.x, h.radius, h.z], 0, FLIGHT, 1000)]);
  cues.push([LEAD + e.seconds, (ctx) => {
    pilot.end?.(ctx, e.seconds);
    ctx.drive.move({ forward: 0, strafe: 0 });
    if (ctx.e2e.snapshot()?.drivenVehicleId != null) ctx.drive.interact();
  }]);
  return cameraFor(e, index, LEAD + e.seconds + 0.6, { name: e.id, cues });
}

/** The closing card: the slalom's fastest clean run, or the avoidance runs' tally. */
function closing(episodes) {
  const slaloms = episodes.filter((e) => e.id.startsWith('slalom'));
  const avoids = episodes.filter((e) => e.avoid);
  if (avoids.filter((e) => !e.avoid.blind).length > 1 || avoids.filter((e) => e.avoid.blind).length > 1) {
    const mid = avoids[Math.floor(avoids.length / 2)].slot;
    return [{
      kind: 'hold', name: 'avoid-result', duration: 5, follow: false,
      cues: [[0.1, (ctx) => {
        const runs = results.filter((r) => r.hazards != null);
        const blind = runs.every((r) => r.blind);
        const clean = runs.filter((r) => r.hit === 0 && !r.bondsBroken).length, rocks = runs.reduce((a, r) => a + r.hazards, 0), hits = runs.reduce((a, r) => a + r.hit, 0);
        ctx.log(`avoid-summary ${JSON.stringify({ runs: runs.length, clean, rocks, hits })}`);
        ctx.edit({ type: 'title', style: 'overlay', size: 'normal', text: blind ? `Not looking: ${runs.length - clean} of ${runs.length} runs hit` : `${clean} of ${runs.length} runs untouched · ${rocks - hits} of ${rocks} rocks avoided`, from: ctx.t, to: ctx.t + 4.8 });
      }]],
      build: () => () => ({ position: [mid[0], 120, mid[1] - 60], lookAt: [mid[0], 0, mid[1] + 130] }),
    }];
  }
  if (!slaloms.length) return [];
  const mid = slaloms[Math.floor(slaloms.length / 2)].slot;
  return [{
    kind: 'hold', name: 'slalom-result', duration: 5, follow: false,
    cues: [[0.1, (ctx) => {
      const runs = results.filter((r) => r.id.startsWith('slalom'));
      const clean = runs.filter((r) => r.conesHit === 0).sort((a, b) => b.speed - a.speed)[0];
      const text = clean ? `Fastest clean slalom: ${kmh(clean.speed)} (${clean.speed} m/s), ${clean.seconds?.toFixed(1)} s through 7 cones 24 m apart` : 'No clean slalom run';
      ctx.log(`slalom-summary ${JSON.stringify({ runs: runs.map((r) => ({ speed: r.speed, conesHit: r.conesHit, conesStruck: r.conesStruck, conesKnocked: r.conesKnocked, maxLatG: r.maxLatG, pathRms: r.pathRms, seconds: r.seconds })), fastestClean: clean?.speed ?? null })}`);
      ctx.edit({ type: 'title', style: 'overlay', size: 'normal', text, from: ctx.t, to: ctx.t + 4.8 });
    }]],
    build: () => () => ({ position: [mid[0] + 70, 40, mid[1] + 20], lookAt: [mid[0], 0, mid[1] + 130] }),
  }];
}

async function main() {
  const episodes = episodesFor(MODE).map((e) => {
    if (e.program || e.avoid || e.legs.some((l) => l.kind === 'handbrake')) return e;
    // As long as the model says the course takes, and 2.5 s on the result.
    const sim = simulateCourse(e);
    return { ...e, seconds: Math.min(e.seconds, Math.ceil(((sim.stoppedAt ?? e.seconds) + 2.5) * 2) / 2) };
  });
  const place = placeResolver(episodes.map((e, i) => ({ id: `car-${i}`, kind: 'car', position: [e.slot[0], 0, e.slot[1]], heading: e.slot[2] })));
  // A light haze: the drawn ground ends at +-256 m, and a camera looking out sees its black edge.
  const film = await boot({ scene: 'lab', place, settle: 2, haze: 0.6 });
  film.log(`turning ${MODE}: ${episodes.length} episodes: ${episodes.map((e) => `${e.id} ${e.seconds}s`).join(', ')}`);
  await film.play([...episodes.map((e, i) => episodeShot(e, i, film.fps)), ...closing(episodes)]);
}

main().catch((error) => {
  console.log(`[film] FAILED: ${error?.stack ?? error}`);
  setTimeout(() => process.exit(1), 300);
});
