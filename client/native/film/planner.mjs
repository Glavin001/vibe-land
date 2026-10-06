// Kinodynamic avoidance of hazards known in advance: meteors that land at a
// known time and place with a known radius and then lie there (a rock
// dropped straight down stays where it lands). Pure.
//
// A lattice in the route's own frame, re-planned every 0.1 s: each candidate
// moves sideways from where the truck is to an offset D (quintic, over L
// metres) and holds it, at a target speed (the route's, slower to let a
// rock land ahead, a hard stop, or faster to be past first). Each candidate
// is DRIVEN on the identified model (vehicle-model.mjs) by the same driver
// that drives the truck (driver.mjs), from the truck's state -- input delay,
// steer slew, the lateral cap and the brakes included -- so the trajectory
// it is judged on is the one the controls can produce, not the one drawn.
// It is scored on its clearance from every hazard at the time the hazard is
// there, its offset from the route and change from the last plan, and its
// progress. The best one's path and speeds go to the truck's driver.
import { makePath, pointAt, project, offsetPoints, smoothstep5, wrap as wrapAngle } from './path.mjs';
import { createDriver, speedProfile } from './driver.mjs';
import { MONSTER, initialState, step, maxCurvature } from './vehicle-model.mjs';

/** The planner's settings: the lattice, the horizon and the weights. */
export const PLAN = {
  offsets: [-13, -10, -7, -4.5, -2.5, 0, 2.5, 4.5, 7, 10, 13],
  /** Second moves (after `hold` m at the first offset), tried with the shortest first move at `secondSpeeds`. */
  second: [-12, -8, -4, 0, 4, 8, 12], hold: 8, secondSpeeds: [1, 0.6],
  /** Transition lengths: seconds of travel at the current speed (at least `minLength` m). */
  lengths: [1.3, 2.4], minLength: 10,
  /** Target speeds, as fractions of the route's speed (0: stop); never faster than the route. */
  speeds: [1, 0.75, 0.5, 0.25, 0],
  horizon: 4.5, dt: 1 / 30,
  /** Hazard: active from `pre` s before it lands; clearances in metres (footprint edge to rock surface). */
  pre: 0.35, hard: 0.6, soft: 2.5,
  /**
   * A candidate is driven until it has covered the distance the route's speed
   * covers in `horizon` s, or `maxHorizon` s: a slow one is not cheap just
   * because the rock it would meet lies past the horizon (without this it crept
   * up to a pair of rocks it could not then get round -- it does not reverse).
   */
  maxHorizon: 8,
  w: { collision: 1e4, soft: 8, offset: 1.0, change: 0.8, progress: 60, latG: 30 },
};

/** Nearest distance from (hx, hz) to the truck's footprint at a pose (0 inside). */
export function footprintDistance(x, z, psi, hx, hz, p = MONSTER) {
  const dx = hx - x, dz = hz - z;
  const f = Math.abs(dx * Math.sin(psi) + dz * Math.cos(psi)) - (p.halfLength ?? MONSTER.halfLength);
  const l = Math.abs(dx * Math.cos(psi) - dz * Math.sin(psi)) - (p.halfWidth ?? MONSTER.halfWidth);
  return Math.hypot(Math.max(0, f), Math.max(0, l));
}

/**
 * A candidate's path: from s0 (offset d0) over L metres to offset D, held
 * `hold` metres, then over L2 to D2, held to s0 + reach.
 */
function candidatePath(route, s0, d0, D, L, reach, D2 = D, hold = 0, L2 = L, slope = 0) {
  // The first move starts on the truck's own sideways slope (so a move under
  // way carries on, re-planned every 0.1 s, rather than starting over flat
  // each time and never getting anywhere) with no curvature, and ends flat:
  // d(u) = d0 + a1 u + a3 u^3 + a4 u^4 + a5 u^5.
  const a1 = Math.max(-1, Math.min(1, slope)) * L, gap = D - d0 - a1;
  const a3 = 10 * gap + 4 * a1, a4 = -15 * gap - 7 * a1, a5 = 6 * gap + 3 * a1;
  const first = (u) => (u >= 1 ? D : u <= 0 ? d0 + a1 * u : d0 + u * (a1 + u * u * (a3 + u * (a4 + u * a5))));
  const d = (s) => first((s - s0) / L) + (D2 - D) * smoothstep5((s - s0 - L - hold) / L2);
  const s1 = Math.min(route.closed ? Infinity : route.length, s0 + reach);
  return makePath(offsetPoints(route, d, s0, s1, 1), { step: 0.5 });
}

/**
 * Plan from the truck's state `st` (truckState shape) at episode time `t`:
 * { route, speed (the route's), hazards: [{ x, z, t, radius }], last (the
 * previous plan) }. Returns { path, profile, D, L, speed, cost, clearance,
 * trajectory } -- the best candidate -- and the count considered.
 */
export function plan(st, t, { route, speed, hazards, last = null, settings = PLAN, model = MONSTER, keys = null, reveal = Infinity }) {
  const here = project(route, st.p[0], st.p[2], last?.s ?? null, 40);
  const v0 = Math.max(0, st.vf);
  // What it knows: every hazard, or (reveal) only those launched -- known `reveal` s before they land.
  const live = hazards.filter((h) => h.t + 60 > t && t >= h.t - (reveal ?? Infinity));
  let best = null, considered = 0;
  const vv = Math.max(v0, 4);
  // The truck's sideways slope against the route: its course off the route's heading.
  const course = st.psi + (Math.abs(st.vf) > 1 ? Math.atan2(st.vl ?? 0, Math.abs(st.vf)) : 0);
  const slope = v0 > 1 ? Math.tan(Math.max(-1.2, Math.min(1.2, wrapAngle(course - here.psi)))) : 0;
  // Long enough that a move is one the truck can make at this speed: a
  // quintic's peak curvature is 5.77 dD / L^2 -- within 60% of the lock on
  // offer and 5 m/s^2 of lateral acceleration.
  const span = (dD, T) => Math.max(settings.minLength, T * vv, Math.sqrt((5.77 * dD) / (0.6 * maxCurvature(vv, model))), vv * Math.sqrt((5.77 * dD) / 5));
  const moves = [];
  for (const D of settings.offsets) for (const T of settings.lengths) {
    moves.push({ D, T, D2: D });
    // And a second move after it: weaving between rocks that lie either side.
    if (T === settings.lengths[0]) for (const D2 of settings.second) if (D2 !== D) moves.push({ D, T, D2 });
  }
  for (const { D, T, D2 } of moves) {
    {
      const L = span(Math.abs(D - here.e), T), L2 = span(Math.abs(D2 - D), T), hold = settings.hold;
      for (const f of D2 === D ? settings.speeds : settings.secondSpeeds) {
        const target = f * speed;
        const reach = Math.max(40, (Math.max(v0, target) + 2) * settings.horizon + 15);
        const path = candidatePath(route, here.s, here.e, D, L, reach, D2, hold, L2, slope);
        const profile = speedProfile(path, { vmax: Math.max(1, target), latAcc: 6.5, accel: 5, decel: 6.5 });
        if (f === 0) for (let i = 0; i < profile.length; i += 1) profile[i] = 0;
        considered += 1;
        const r = rollout(st, path, profile, f === 0, live, t, settings, model, keys, route, here.s, speed * settings.horizon);
        const cost = score(r, { D, f, L, last, speed, settings });
        if (!best || cost < best.cost) best = { path, profile, D, D2, L, speed: target, factor: f, cost, clearance: r.clearance, trajectory: r.trajectory, hit: r.hit, s: here.s, e: here.e };
      }
    }
  }
  return { ...best, considered };
}

/** Drive a candidate on the model; its clearance from each hazard while the hazard is there. */
function rollout(st, path, profile, stop, hazards, t0, settings, model, keys, route, s0, distance) {
  const s = initialState({ x: st.p[0], z: st.p[2], psi: st.psi, vf: st.vf, r: st.w[1] }, model);
  // The wheels where they are, and the keys already on their way to the server.
  if (st.wheelSteer?.length >= 2) {
    const inner = Math.abs(st.wheelSteer[0]) > Math.abs(st.wheelSteer[1]) ? st.wheelSteer[0] : st.wheelSteer[1];
    s.cmd = -inner / 0.3839724354387525;
  }
  if (keys) s.queue = keys.map((k) => [k.forward, k.strafe]);
  // A narrow projection window: a rollout moves a few metres between its decisions.
  const driver = createDriver({ model, window: 6 });
  driver.follow({ path, profile, stop });
  const dt = settings.dt, sub = Math.max(1, Math.round(dt * 60)), n = Math.round((settings.maxHorizon ?? settings.horizon) / dt);
  let clearance = Infinity, hit = false, latMax = 0, reached = null, along = s0, progress = 0;
  const nearest = hazards.map(() => Infinity);
  const trajectory = [];
  for (let k = 0; k < n; k += 1) {
    const vl = s.r * (model.lateralArm - model.lateralArmFade * s.vf * s.vf);
    const u = driver.step({ p: [s.x, 0, s.z], psi: s.psi, vf: s.vf, vl, w: [0, s.r, 0] });
    for (let j = 0; j < sub; j += 1) step(s, u, 1 / 60, model);
    const t = t0 + (k + 1) * dt;
    latMax = Math.max(latMax, Math.abs(s.vf * s.r));
    if (k % 3 === 2) trajectory.push([+t.toFixed(2), +s.x.toFixed(2), +s.z.toFixed(2)]);
    if (k % 3 === 2) {
      along = project(route, s.x, s.z, along, 12).s;
      progress = along - s0;
      if (progress >= distance) { reached = (k + 1) * dt; }
    }
    hazards.forEach((h, i) => {
      if (t < h.t - settings.pre) return;
      if (Math.abs(h.x - s.x) > 12 || Math.abs(h.z - s.z) > 12) return;
      const c = footprintDistance(s.x, s.z, s.psi, h.x, h.z, model) - h.radius;
      if (c < nearest[i]) nearest[i] = c;
      if (c < settings.hard) hit = true;
    });
    if (reached != null) break;
  }
  for (const c of nearest) clearance = Math.min(clearance, c);
  // Soft: how far inside the comfortable clearance it passes each rock.
  const soft = nearest.reduce((a, c) => a + Math.max(0, settings.soft - c) ** 2, 0);
  return { clearance, hit, soft, latMax, trajectory, end: s, reached, progress };
}

function score(r, { D, f, last, speed, settings }) {
  const w = settings.w;
  let cost = 0;
  if (r.hit) cost += w.collision * (1 + Math.max(0, settings.hard - r.clearance));
  cost += w.soft * r.soft;
  cost += w.offset * Math.abs(D) + (last ? w.change * Math.abs(D - last.D) : 0);
  // Time: how long it takes to cover the distance the route's speed covers
  // in the horizon, against that (and, not getting there, how far short).
  const nominal = settings.horizon;
  cost += w.progress * (r.reached != null ? Math.max(0, r.reached - nominal) / nominal : 1 + Math.max(0, 1 - r.progress / (speed * nominal)));
  cost += last && last.factor !== f ? 1 : 0;
  if (r.latMax > 0.72 * 9.81) cost += w.latG * (r.latMax / 9.81 - 0.72);
  return cost;
}

/**
 * Hazards where the truck would have been: driven on the model along the
 * route at its speed (no avoidance), it is at q(t); each hazard lands at
 * q(t_k) give or take `jitter` metres, at t_k from `times`. `rand` is a
 * seeded [0, 1) generator.
 */
export function hazardsOnNominal(route, speed, start, times, { radius = 2, jitterAlong = 2, jitterSide = 1.2, rand = Math.random, model = MONSTER } = {}) {
  const s = initialState({ x: start.x, z: start.z, psi: start.psi, vf: 0 }, model);
  const driver = createDriver({ model });
  // As the planner's straight-on candidate drives it: the route's speed from the start.
  const profile = speedProfile(route, { vmax: speed, latAcc: 6.5, accel: 5, decel: 6.5 });
  driver.follow({ path: route, profile });
  const at = new Map();
  const last = Math.max(...times);
  for (let k = 0; k <= last * 60 + 1; k += 1) {
    at.set(k, [s.x, s.z, s.psi]);
    const vl = s.r * (model.lateralArm - model.lateralArmFade * s.vf * s.vf);
    step(s, driver.step({ p: [s.x, 0, s.z], psi: s.psi, vf: s.vf, vl, w: [0, s.r, 0] }), 1 / 60, model);
  }
  return times.map((t) => {
    const [x, z, psi] = at.get(Math.round(t * 60));
    const a = (rand() * 2 - 1) * jitterAlong, b = (rand() * 2 - 1) * jitterSide;
    return { x: x + Math.sin(psi) * a + Math.cos(psi) * b, z: z + Math.cos(psi) * a - Math.sin(psi) * b, t, radius };
  });
}

/** A seeded generator (mulberry32). */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export { pointAt };
