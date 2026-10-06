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
  let follow = typeof target === 'function' ? target : null;
  let id = typeof target === 'number' ? target : null;
  const where = () => {
    if (follow) return follow();
    const vehicles = ctx.e2e?.snapshot()?.vehicles ?? [];
    if (id == null) {
      const spot = point(target, ctx.place);
      const near = vehicles.reduce((a, b) => (!a || Math.hypot(b.position[0] - spot[0], b.position[2] - spot[2]) < Math.hypot(a.position[0] - spot[0], a.position[2] - spot[2]) ? b : a), null);
      if (!near) return spot;
      id = near.id;
    }
    return vehicles.find((v) => v.id === id)?.position ?? point(target, ctx.place);
  };
  const lookUp = opts.lookOffset ?? [0, 0.5, 0];
  return () => { const p = where(); return { position: add(p, offset), lookAt: add(p, lookUp) }; };
});

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
 * The server's meteor on a place or point, no player needed. The cue's time
 * is when it LANDS (it is launched METEOR_FLIGHT_S before); `flash` adds a
 * white flash to the cut at the impact. Impacts shake a camera near them
 * (shoot's `shake`).
 */
export function strike({ at, height, flash: white = false }) {
  const name = typeof at === 'string' ? at : at?.id ?? 'a point';
  return {
    label: `strike ${name}`,
    steps: [[-METEOR_FLIGHT_S, (ctx) => {
      const p = strikePoint(at, ctx, height), lands = ctx.t + METEOR_FLIGHT_S;
      ctx.session.meteor(p[0], p[1], p[2]);
      ctx.impact(p, lands);
      if (white) ctx.edit({ type: 'flash', at: lands, seconds: 0.15 });
    }]],
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
 * Where the camera goes somewhere a film should not: under 1 m (a spline
 * swooping down to a street can dip through it) or inside a building (named
 * places with bounds). Sampled every 0.1 s; one line per shot and problem.
 */
export function cameraProblems(tl, places = []) {
  const boxes = places.filter((p) => p.min && p.max);
  const problems = [];
  for (const s of tl.shots) {
    const found = new Map();
    for (let t = 0; t <= s.duration + 1e-9; t += 0.1) {
      const [x, y, z] = s.pose(Math.min(t, s.duration)).position;
      if (y < 1 && !found.has('low')) found.set('low', `is ${y.toFixed(1)} m high at ${(s.start + t).toFixed(1)}s`);
      const inside = boxes.find((b) => x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1] && z > b.min[2] && z < b.max[2]);
      if (inside && !found.has(inside.id)) found.set(inside.id, `is inside ${inside.id} at ${(s.start + t).toFixed(1)}s`);
    }
    for (const text of found.values()) problems.push(`shot ${s.name}'s camera ${text}`);
  }
  return problems;
}
