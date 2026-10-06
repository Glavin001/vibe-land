// The shots and actions a film is made of (client/native/film), and the
// timeline they compile to. A shot is a camera move of a fixed length in film
// seconds; an action is something done at a time within a shot (fire, a
// meteor, a note in the log). Points anywhere may be vectors or named places
// (places.mjs); they are resolved when the film is played.

import { easeProgress, posePath } from './spline.mjs';
import { point } from './places.mjs';

const add = (a, b) => a.map((v, k) => v + b[k]);
const resolvePose = (pose, ctx) => ({ position: point(pose.position, ctx.place), lookAt: point(pose.lookAt, ctx.place) });

/**
 * A shot: `build(ctx)` resolves its points and returns pose(t) for t in
 * [0, seconds]. Options on every shot: `name` (logs and preview stills),
 * `cues` ([[t, action], ...]: actions at t seconds into the shot), `player`
 * (a point to put the player at as the shot starts: goto()), and on
 * moves `ease` ('both' | 'in' | 'out' | 'none', default 'both') and `ramp`
 * (the eased fraction at each end, default 0.25).
 */
function shot(kind, seconds, opts, build) {
  if (!(seconds > 0)) throw new Error(`${kind}: a length in seconds, got ${seconds}`);
  // `player: 'camera'` keeps the player under the camera all shot (what is
  // streamed, cars above all, is what is near the player).
  const follow = opts.player === 'camera';
  const cues = [...(opts.player && !follow ? [[0, goto(opts.player)]] : []), ...(opts.cues ?? [])];
  return { kind, name: opts.name ?? kind, duration: seconds, cues, build, follow };
}

/** The camera still at one pose. */
export const hold = (pose, seconds, opts = {}) => shot('hold', seconds, opts, (ctx) => {
  const p = resolvePose(pose, ctx);
  return () => p;
});

/** Through every pose in turn on one Catmull-Rom spline: continuous motion, eased only at the ends. */
export const path = (poses, seconds, opts = {}) => shot('path', seconds, opts, (ctx) => {
  if (poses.length < 2) throw new Error('path: two or more poses');
  const curve = posePath(poses.map((p) => resolvePose(p, ctx)));
  return (t) => curve(easeProgress(t / seconds, opts.ease, opts.ramp));
});

/**
 * Round `centre` at `radius` and camera `height` (absolute), looking at it,
 * from one bearing to another in degrees (0 looks from +z, north; 90 from +x,
 * east). `lookHeight` overrides the height looked at.
 */
export const orbit = ({ centre, radius, height, from = 0, to = 90, lookHeight }, seconds, opts = {}) => shot('orbit', seconds, opts, (ctx) => {
  const c = point(centre, ctx.place);
  const look = [c[0], lookHeight ?? c[1], c[2]];
  return (t) => {
    const a = ((from + (to - from) * easeProgress(t / seconds, opts.ease, opts.ramp)) * Math.PI) / 180;
    return { position: [c[0] + Math.sin(a) * radius, height, c[2] + Math.cos(a) * radius], lookAt: look };
  };
});

/**
 * Follow a vehicle: the camera `offset` metres from it (world axes), looking
 * at it. `target` is a vehicle id, a parking place ('car-5': the car nearest
 * that spot when the shot starts) or a function returning a position.
 */
export const track = (target, offset, seconds, opts = {}) => shot('track', seconds, opts, (ctx) => {
  const follow = typeof target === 'function' ? target : null;
  const where = () => (follow ? follow() : vehicleOf(target, ctx)?.position ?? point(target, ctx.place));
  const lookUp = opts.lookOffset ?? [0, 0.5, 0];
  // `lag` seconds of smoothing (a camera operator, not a rigid mount): a
  // bouncing car does not shake the frame. Film time, so a take is the same.
  // `release` (seconds into the shot): from then the camera stops where it
  // is and only turns to keep the vehicle in frame -- for a car about to be
  // thrown, which a following camera would chase into a wall.
  const lag = opts.lag ?? 0.25, release = opts.release ?? Infinity;
  let smooth = null, last = null, held = null;
  return (t) => {
    const p = where();
    if (!smooth || last == null || t < last) { smooth = [...p]; held = null; }
    else { const k = lag > 0 ? 1 - Math.exp(-(t - last) / lag) : 1; smooth = smooth.map((v, i) => v + (p[i] - v) * k); }
    last = t;
    if (t >= release) held ??= add(smooth, offset);
    return { position: held ?? add(smooth, offset), lookAt: add(smooth, lookUp) };
  };
});

/**
 * A fixed camera at `position` turning to follow a vehicle (as track:
 * `target`, `lookOffset`, `lag`): for watching a car come on and what
 * happens to it from where the audience should stand, which a following
 * camera cannot frame. `lookAt` (optional): looked at until the vehicle is
 * found.
 */
export const watch = (position, target, seconds, opts = {}) => shot('watch', seconds, opts, (ctx) => {
  const at = point(position, ctx.place), lookUp = opts.lookOffset ?? [0, 0.5, 0], lag = opts.lag ?? 0.25;
  const fallback = opts.lookAt ? point(opts.lookAt, ctx.place) : null;
  let smooth = null, last = null;
  return (t) => {
    const p = vehicleOf(target, ctx)?.position ?? (smooth ? null : fallback ?? point(target, ctx.place));
    if (p) {
      if (!smooth || last == null || t < last) smooth = [...p];
      else { const k = lag > 0 ? 1 - Math.exp(-(t - last) / lag) : 1; smooth = smooth.map((v, i) => v + (p[i] - v) * k); }
    }
    last = t;
    return { position: at, lookAt: add(smooth, lookUp) };
  };
});

/**
 * The live vehicle a film means: a vehicle id, or a parking place (car-N:
 * the car nearest that spot when first asked, then that car wherever it
 * goes). Each frame's position and velocity come from the runner (ctx.vehicles).
 */
export function vehicleOf(target, ctx) {
  ctx.vehicleIds ??= new Map();
  let id = typeof target === 'number' ? target : ctx.vehicleIds.get(target);
  if (id == null) {
    const spot = point(target, ctx.place);
    let best = null;
    for (const [vid, v] of ctx.vehicles ?? []) {
      const d = Math.hypot(v.position[0] - spot[0], v.position[2] - spot[2]);
      if (!best || d < best.d) best = { vid, d };
    }
    // Only a car at the spot: a far one is some other car (the one meant
    // may not be streamed yet: only cars near the player are).
    if (!best || best.d > 12) return null;
    id = best.vid;
    ctx.vehicleIds.set(target, id);
  }
  return ctx.vehicles?.get(id) ?? null;
}

// ---------------------------------------------------------------- actions
// An action is { label, steps: [[dt, (ctx) => void], ...] }; a cue may also
// be a bare function (ctx) => void.

const brokenBonds = (ctx) => ctx.e2e?.snapshot()?.city?.brokenBonds ?? 0;

/**
 * Fire `shots` rounds of `mode` ('cannonball' | 'meteor' | 'rifle') at a
 * point or place, `every` seconds apart, spread side to side by `spread`
 * metres and alternately up and down by `rise`. `from` (a point or place, or
 * a { position, yaw, pitch } drop pose) puts the player there first, `lead`
 * seconds before the first round. Logs the bonds broken `reportAfter`
 * seconds after the last round.
 */
export function fire({ mode = 'cannonball', from, at, shots = 1, every = 0.8, spread = 1.6, rise = 2, lead = 0.6, holdMs = 60, reportAfter = 1.5 }) {
  let before = 0;
  const shooter = (ctx) => (from ? (from.yaw != null ? from.position : point(from, ctx.place)) : ctx.e2e.snapshot().position);
  const aim = (ctx, k) => {
    const target = point(at, ctx.place), origin = shooter(ctx);
    const dx = target[0] - origin[0], dz = target[2] - origin[2], len = Math.hypot(dx, dz) || 1;
    const side = (k - (shots - 1) / 2) * spread, up = shots > 1 ? (k % 2 ? rise / 2 : -rise / 2) : 0;
    return [target[0] + (dz / len) * side, target[1] + up, target[2] - (dx / len) * side];
  };
  const steps = [[0, (ctx) => {
    before = brokenBonds(ctx);
    ctx.e2e.setShotMode(mode);
    if (!from) return;
    if (from.yaw != null) { ctx.e2e.dropAt(from); return; }
    const p = point(from, ctx.place), t = point(at, ctx.place);
    ctx.e2e.dropAt({ position: p, yaw: Math.atan2(t[0] - p[0], t[2] - p[2]), pitch: 0 });
  }]];
  for (let k = 0; k < shots; k += 1) {
    steps.push([lead + k * every, (ctx) => ctx.drive.lookAt(...aim(ctx, k))]);
    steps.push([lead + k * every + 0.1, (ctx) => ctx.drive.fire({ holdMs })]);
  }
  steps.push([lead + (shots - 1) * every + reportAfter, (ctx) => ctx.log(`${mode}: broken bonds ${before} -> ${brokenBonds(ctx)}`)]);
  const name = typeof at === 'string' ? at : at?.id ?? at?.offsetOf?.id ?? at?.offsetOf
    ?? (Array.isArray(at) ? `[${at.map((v) => +v.toFixed(1)).join(', ')}]` : 'a point');
  return { label: `${mode} x${shots} at ${name}`, steps };
}

/**
 * Put the player at a point or place (the city camera drop), facing `facing`
 * if given. The game streams what is near the player, not the camera: cars
 * further than ~40 m from the player are not drawn, so a film takes the
 * player along to wherever it wants its cars.
 */
export const goto = (where, facing) => ({
  label: `player to ${typeof where === 'string' ? where : where?.id ?? 'a point'}`,
  steps: [[0, (ctx) => {
    const p = point(where, ctx.place), f = facing ? point(facing, ctx.place) : null;
    ctx.e2e.dropAt({ position: p, yaw: f ? Math.atan2(f[0] - p[0], f[2] - p[2]) : 0, pitch: 0 });
  }]],
});

/** A meteor on a point or place (from wherever the player stands, or `from`). */
export const meteor = ({ at, from, lead = 0.3 }) => {
  const action = fire({ mode: 'meteor', at, from, lead, holdMs: 80, reportAfter: 6 });
  return { ...action, label: action.label.replace(/ x1/, '') };
};

/** Walk or drive the player: `forward`/`strafe` in -1..1 for `seconds` of film time. */
export const drive = ({ forward = 0, strafe = 0, seconds = 1 }) => ({
  label: `drive ${forward}/${strafe} for ${seconds}s`,
  steps: [[0, (ctx) => ctx.drive.move({ forward, strafe })], [seconds, (ctx) => ctx.drive.stop()]],
});

/**
 * Seconds a meteor flies. native-mac.sh's `film` fixes its launch range
 * (VIBE_CITY_METEOR_RANGE/HEIGHT: 384 m away at 140 m/s), so a film can time
 * an impact; in play it is 2.1-3.4 s.
 */
export const METEOR_FLIGHT_S = 2.74;

/** Where a strike lands: a building's upper storeys (60% of its height, at most 12 m), else the point. */
function strikePoint(at, ctx, height) {
  const p = typeof at === 'string' ? ctx.place(at) : at;
  if (p && p.top != null) return [p.position[0], height ?? Math.min(p.top * 0.6, 12), p.position[2]];
  const v = point(at, ctx.place);
  return height != null ? [v[0], height, v[2]] : v;
}

/**
 * Launch the server's meteor at `target`: from a random bearing (the game's
 * own meteor), or, with `from` (the compass bearing it comes FROM, degrees:
 * 0 north, +z; 90 east, +x), on the same 300 m out, 240 m up, 140 m/s arc
 * from that side -- through the match's replay of a planned meteor, the arc
 * solved as the server solves it (meteor.rs solve_velocity). Either way it is
 * the real meteor, simulated from launch: `from` only picks where it comes
 * in from, and so which way the blast throws what it hits.
 */
/** The game's meteor slope: 240 m up for every 300 m out. */
export const METEOR_SLOPE = 0.8;

export function launchMeteor(ctx, target, from, flight = METEOR_FLIGHT_S, slope = METEOR_SLOPE) {
  if (from == null) { ctx.session.meteor(target[0], target[1], target[2]); return; }
  const { start, velocity, T } = meteorArc(target, from, flight, slope);
  ctx.session.replayEvent(JSON.stringify({ kind: 'meteor', start, velocity, target, flight_s: T }));
}

/** The server's meteor: radius in metres (server/src/meteor.rs DEFAULT_RADIUS_M). */
export const METEOR_RADIUS_M = 2;

/**
 * A meteor's arc onto `target`: from `flight` seconds away at 140 m/s,
 * `slope` m up for every metre out (the game's 0.8 by default), from compass
 * bearing `from` (degrees, 0 = +z). Shorter, a late shot that leaves a
 * moving target less time to be somewhere else; flatter, a rock that comes
 * in low, across a street and into a wall, and hits sideways.
 */
export function meteorArc(target, from, flight = METEOR_FLIGHT_S, slope = METEOR_SLOPE) {
  const b = (from * Math.PI) / 180, g = -9.81, dist = 140 * flight;
  const out = dist / Math.hypot(1, slope), up = out * slope;
  const start = [target[0] + Math.sin(b) * out, target[1] + up, target[2] + Math.cos(b) * out];
  const T = Math.hypot(...start.map((v, k) => v - target[k])) / 140;
  const velocity = start.map((v, k) => (target[k] - v) / T - (k === 1 ? g * T * 0.5 : 0));
  return { start, velocity, T };
}

/**
 * Where two strikes come closest in flight: each { at (seconds it is
 * launched), target, from, flight, slope }. Returns { distance, t }. Two
 * meteors closer than 2 x METEOR_RADIUS_M hit each other, not their
 * targets: the vehicle lab's near miss, launched from both sides of a
 * street at once, met over the road (2026-10-06), and the chase's pairs of
 * houses passed 1.6 m apart.
 */
export function closestApproach(a, b) {
  const arc = (s) => ({ ...meteorArc(s.target, s.from, s.flight ?? METEOR_FLIGHT_S, s.slope ?? METEOR_SLOPE), at: s.at ?? 0 });
  const A = arc(a), B = arc(b);
  const pos = (m, t) => { const u = t - m.at; return m.start.map((v, k) => v + m.velocity[k] * u + (k === 1 ? -4.905 * u * u : 0)); };
  const from = Math.max(A.at, B.at), to = Math.min(A.at + A.T, B.at + B.T);
  let best = { distance: Infinity, t: null };
  for (let t = from; t <= to; t += 0.002) {
    const d = Math.hypot(...pos(A, t).map((v, k) => v - pos(B, t)[k]));
    if (d < best.distance) best = { distance: d, t };
  }
  return best;
}

/** Throws when any two strikes would meet in flight (closestApproach). */
export function assertStrikesClear(strikes, what = 'strikes') {
  for (let i = 0; i < strikes.length; i += 1) for (let j = i + 1; j < strikes.length; j += 1) {
    const c = closestApproach(strikes[i], strikes[j]);
    if (c.distance < 2 * METEOR_RADIUS_M + 0.5) throw new Error(`${what}: strikes ${i} and ${j} pass ${c.distance.toFixed(1)} m apart in flight and would hit each other`);
  }
}

/**
 * The server's meteor on a place or point, no player needed. The cue's time
 * is when it LANDS (it is launched METEOR_FLIGHT_S before); `from` picks the
 * bearing it comes from (launchMeteor); `flash` adds a white flash to the cut
 * at the impact. Impacts shake a camera near them (shoot's `shake`).
 */
export function strike({ at, height, from, slope, flash: white = false }) {
  const name = typeof at === 'string' ? at : at?.id ?? 'a point';
  if (slope != null && from == null) throw new Error('strike: `slope` needs `from` (the bearing it comes from)');
  return {
    label: `strike ${name}${from != null ? ` from ${from}` : ''}`,
    steps: [[-METEOR_FLIGHT_S, (ctx) => {
      const p = strikePoint(at, ctx, height), lands = ctx.t + METEOR_FLIGHT_S;
      launchMeteor(ctx, p, from, METEOR_FLIGHT_S, slope);
      ctx.impact(p, lands);
      if (white) ctx.edit({ type: 'flash', at: lands, seconds: 0.15 });
    }]],
  };
}

/**
 * A strike where a vehicle WILL be when it lands: its position plus its
 * velocity times the flight, then `ahead` metres further along its heading
 * and `side` metres to its right (negative: left). `side` 0, `ahead` 0 is a
 * direct hit if it keeps its speed. Like strike(), the cue's time is the impact.
 */
export function strikeNear(target, { ahead = 0, side = 0, height = 0.8, from, flight = METEOR_FLIGHT_S, slope, flash: white = false } = {}) {
  if (flight !== METEOR_FLIGHT_S && from == null) throw new Error('strikeNear: a short `flight` needs `from` (the bearing it comes from)');
  return {
    label: `strike near ${typeof target === 'string' ? target : target}${from != null ? ` from ${from}` : ''}`,
    steps: [[-flight, (ctx) => {
      const v = vehicleOf(target, ctx);
      if (!v) { ctx.log(`strike near ${target}: no such vehicle`); return; }
      // Where it will be: its velocity and its acceleration along it, measured
      // over the last frames (a car still gathering speed outruns v * t).
      const [vx, , vz] = v.velocity, speed = Math.hypot(vx, vz);
      const fx = speed > 0.5 ? vx / speed : Math.sin(v.heading ?? 0), fz = speed > 0.5 ? vz / speed : Math.cos(v.heading ?? 0);
      const along = Math.max(-8, Math.min(8, (v.acceleration?.[0] ?? 0) * fx + (v.acceleration?.[2] ?? 0) * fz));
      const run = speed * flight + 0.5 * along * flight * flight;
      const p = [
        v.position[0] + fx * (run + ahead) - fz * side,
        height,
        v.position[2] + fz * (run + ahead) + fx * side,
      ];
      const lands = ctx.t + flight;
      launchMeteor(ctx, p, from, flight, slope);
      ctx.impact(p, lands);
      if (white) ctx.edit({ type: 'flash', at: lands, seconds: 0.15 });
    }]],
  };
}

/**
 * Into a vehicle (a parking place or id): the player dropped beside it,
 * facing it, then the game's enter-the-nearest-vehicle; drive() then drives it.
 */
export function enter(target) {
  return {
    label: `enter ${target}`,
    steps: [
      [0, (ctx) => {
        const v = vehicleOf(target, ctx), p = v?.position ?? point(target, ctx.place);
        ctx.e2e.dropAt({ position: [p[0] - 2.5, p[1] + 1.2, p[2] - 2.5], yaw: Math.atan2(2.5, 2.5), pitch: 0 });
      }],
      [0.4, (ctx) => ctx.drive.interact()],
      [1.0, (ctx) => ctx.log(`entered: driving vehicle ${ctx.e2e.snapshot()?.drivenVehicleId ?? 'none'}`)],
    ],
  };
}

/** Strikes on each target in turn, `every` seconds apart, the first landing at the cue's time. */
export function barrage(targets, { every = 0.35, height } = {}) {
  const steps = targets.flatMap((at, k) => strike({ at, height }).steps.map(([dt, run]) => [dt + k * every, run]));
  return { label: `barrage x${targets.length}`, steps };
}

// ----------------------------------------------------------------- the cut
// Edits for the post-production pass (scripts/film/post.py): logged as
// `edit {json}` at the cue's time, in video seconds (0 = the first recorded frame).

const editAt = (fields, seconds) => ({
  label: `${fields.type}${fields.text ? ` "${fields.text}"` : ''}`,
  steps: [[0, (ctx) => ctx.edit(seconds != null ? { ...fields, from: ctx.t, to: ctx.t + seconds } : { ...fields, at: ctx.t })]],
});
/** Words over the picture (`style: 'card'`: on black, the picture hidden; `size: 'big'` for the hero title). */
export const title = (text, seconds, { style = 'overlay', size = 'normal' } = {}) => editAt({ type: 'title', text, style, size }, seconds);
/** Words on black. */
export const card = (text, seconds, { size = 'normal' } = {}) => title(text, seconds, { style: 'card', size });
/** The next `seconds` at `rate` speed in the cut (record at FILM_FPS=60: half speed keeps every frame). */
export const slowmo = (seconds, rate = 0.5) => editAt({ type: 'slowmo', rate }, seconds);
/** A white flash. */
export const flash = (seconds = 0.15) => editAt({ type: 'flash', seconds });
/** From or to black over `seconds`. */
export const fade = (dir, seconds = 0.8) => editAt({ type: 'fade', dir, seconds });

/** A line in the log, with the bonds broken so far. */
export const note = (text) => ({ label: `note ${text}`, steps: [[0, (ctx) => ctx.log(`${text} (broken bonds ${brokenBonds(ctx)})`)]] });

// --------------------------------------------------------------- timeline

const asAction = (cue) => (typeof cue === 'function' ? { label: cue.name || 'cue', steps: [[0, cue]] } : cue);

/**
 * Shots end to end: each shot's start, the cues in time order (absolute film
 * seconds), and the length. `poseAt(t)` needs `build(ctx)` first.
 */
export function timeline(shots) {
  const entries = [], cues = [];
  let start = 0;
  for (const s of shots) {
    entries.push({ ...s, start });
    for (const [t, cue] of s.cues) {
      const { label, steps } = asAction(cue);
      // `first`: the action's first step (a strike's is its launch, before the cue's time).
      steps.forEach(([dt, run], k) => cues.push({ time: start + t + dt, label, run, first: k === 0 }));
    }
    start += s.duration;
  }
  cues.sort((a, b) => a.time - b.time);
  const tl = {
    shots: entries, cues, duration: start,
    /** Resolve every shot's points (places, vehicles) against the running game. */
    build(ctx) { for (const s of entries) s.pose = s.build(ctx); return tl; },
    /** Which shot is on at film time t (the last one past the end). */
    shotAt(t) { let i = 0; while (i < entries.length - 1 && t >= entries[i].start + entries[i].duration) i += 1; return i; },
    poseAt(t) { const s = entries[tl.shotAt(t)]; return s.pose(Math.min(s.duration, Math.max(0, t - s.start))); },
  };
  return tl;
}

/**
 * What blocks a pose's view: five rays from the camera, one at the point it
 * looks at and four across the frame at that distance (a quarter of the way
 * out to each edge), tested against the scene's trees and buildings
 * (places with bounds; trees padded for their leaves). Whatever contains the
 * looked-at point is the subject, not in the way. Returns the fraction of
 * rays blocked and what blocked them.
 */
export function sightBlocked(pose, occluders) {
  const [cx, cy, cz] = pose.position, [lx, ly, lz] = pose.lookAt;
  const d = [lx - cx, ly - cy, lz - cz], dist = Math.hypot(...d) || 1;
  const f = d.map((v) => v / dist);
  let r = [f[2], 0, -f[0]];
  const rl = Math.hypot(...r) || 1;
  r = r.map((v) => v / rl);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const half = dist * 0.35 * 0.5; // a quarter of the way to the edge of a ~70 degree frame
  const targets = [[0, 0], [1, 0], [-1, 0], [0, 0.6], [0, -0.6]].map(([a, b]) => [lx + r[0] * a * half + u[0] * b * half, ly + r[1] * a * half + u[1] * b * half, lz + r[2] * a * half + u[2] * b * half]);
  const inside = (b, p) => p.every((v, k) => v >= b.min[k] - 0.5 && v <= b.max[k] + 0.5);
  const candidates = occluders.filter((b) => !inside(b, pose.lookAt));
  const by = new Set();
  let blocked = 0;
  for (const t of targets) {
    const dir = t.map((v, k) => v - pose.position[k]);
    const hit = candidates.find((b) => {
      let t0 = 0.02, t1 = 0.92; // not the camera's own spot, not at the subject
      for (let k = 0; k < 3; k += 1) {
        if (Math.abs(dir[k]) < 1e-9) { if (pose.position[k] < b.min[k] || pose.position[k] > b.max[k]) return false; continue; }
        let a = (b.min[k] - pose.position[k]) / dir[k], c = (b.max[k] - pose.position[k]) / dir[k];
        if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, c);
        if (t0 > t1) return false;
      }
      return true;
    });
    if (hit) { blocked += 1; by.add(hit.id); }
  }
  return { fraction: blocked / targets.length, by: [...by] };
}

/**
 * Where the camera goes somewhere a film should not: under 1 m (a spline
 * swooping down to a street can dip through it) or inside a building (named
 * places with bounds). Sampled every 0.1 s; one line per shot and problem.
 */
export function cameraProblems(tl, places = []) {
  const boxes = places.filter((p) => p.min && p.max);
  const problems = [];
  for (const s of tl.shots) {
    const found = new Map(), blockers = new Map();
    let samples = 0, blocked = 0;
    for (let t = 0; t <= s.duration + 1e-9; t += 0.1) {
      const pose = s.pose(Math.min(t, s.duration));
      const [x, y, z] = pose.position;
      if (y < 1 && !found.has('low')) found.set('low', `is ${y.toFixed(1)} m high at ${(s.start + t).toFixed(1)}s`);
      const inside = boxes.find((b) => x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1] && z > b.min[2] && z < b.max[2]);
      if (inside && !found.has(inside.id)) found.set(inside.id, `is inside ${inside.id} at ${(s.start + t).toFixed(1)}s`);
      const sight = sightBlocked(pose, boxes);
      samples += 1; blocked += sight.fraction;
      for (const id of sight.by) blockers.set(id, (blockers.get(id) ?? 0) + 1);
    }
    for (const text of found.values()) problems.push(`shot ${s.name}'s camera ${text}`);
    // A view a quarter blocked or more, on average over the shot (destruction may clear it).
    if (samples && blocked / samples >= 0.25) {
      const top = [...blockers].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id).join(', ');
      problems.push(`shot ${s.name}'s view is ${Math.round((100 * blocked) / samples)}% blocked (${top})`);
    }
  }
  return problems;
}
