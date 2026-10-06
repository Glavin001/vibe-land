// A closed-loop driver for the game's cars on the player's controls alone:
// throttle / brake-or-reverse (forward), steering (strafe) and the handbrake
// (jump). Pure: it reads the car's state (truckState, from the server's
// vehicleDebug) and returns the controls; the film harness applies them
// through ctx.drive (client/native/films/turning.mjs). Nothing here sets a
// pose or a velocity.

import { project, pointAt } from './path.mjs';
import { MONSTER, keyFor, maxCurvature, accelFull, coastDecel } from './vehicle-model.mjs';

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const KEY = 1 / 127; // the input's quantum (InputCmd move_x / move_y are i8)

/**
 * The car's state from session.vehicleDebug(index) (Vehicle2's own view):
 * position p, velocity v, angular velocity w, forward f (rotated +z),
 * heading psi = atan2(fx, fz) (so d psi/dt = w_y), planar speed, forward
 * speed vf, lateral speed vl (to the car's left-of-heading, +psi side), up.y,
 * front wheel steer, wheels on the road, wheel mask, broken bond count.
 */
export function truckState(json) {
  let d;
  try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  const v2 = d?.vehicle2;
  if (!v2) return null;
  const [qx, qy, qz, qw] = v2.rotation ?? [0, 0, 0, 1];
  const f = [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)];
  const upY = 1 - 2 * (qx * qx + qz * qz);
  const p = v2.position ?? [0, 0, 0], v = v2.linearVelocity ?? [0, 0, 0], w = v2.angularVelocity ?? [0, 0, 0];
  const fl = Math.hypot(f[0], f[2]) || 1, fx = f[0] / fl, fz = f[2] / fl;
  const broken = (d.bonds ?? []).reduce((n, b) => n + (b.remainingArea <= 0 || b.verdictBroken ? 1 : 0), 0);
  return {
    p, v, w, f, upY, psi: Math.atan2(fx, fz),
    speed: Math.hypot(v[0], v[2]), vf: v[0] * fx + v[2] * fz,
    // Lateral: along (cos psi, -sin psi), the direction a +psi turn swings the nose toward.
    vl: v[0] * fz - v[2] * fx,
    wheelSteer: v2.wheelSteer ?? [], wheelsOnRoad: v2.wheelsOnRoad ?? null,
    wheelMask: d.vehicle?.wheelMask ?? 15, broken,
  };
}


// ------------------------------------------------------------- speed plans

/**
 * Speeds along a path (one per sample): at most `vmax`, at most what keeps
 * the lateral acceleration under `latAcc` and the curvature within the
 * truck's lock at that speed, reached and left at `accel` / `decel` (m/s^2),
 * ending at `endSpeed` (open paths). `limits`: extra [s0, s1, v] caps.
 */
export function speedProfile(path, { vmax, latAcc = 6, accel = 5, decel = 6, endSpeed = null, startSpeed = null, limits = [], model = MONSTER } = {}) {
  const n = path.n, v = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const k = Math.abs(path.kappa[i]);
    let cap = k > 1e-6 ? Math.sqrt(latAcc / k) : vmax;
    // The lock narrows with speed: the fastest speed whose tightest turn is still this tight.
    let hi = Math.min(vmax, cap);
    while (hi > 1 && maxCurvature(hi, model) < k * 1.03) hi -= 0.25;
    v[i] = Math.max(1, hi);
    for (const [s0, s1, lim] of limits) if (path.s[i] >= s0 && path.s[i] <= s1) v[i] = Math.min(v[i], lim);
  }
  if (!path.closed && endSpeed != null) v[n - 1] = Math.min(v[n - 1], endSpeed);
  if (!path.closed && startSpeed != null) v[0] = Math.min(v[0], Math.max(startSpeed, 1));
  const passes = path.closed ? 2 : 1;
  for (let pass = 0; pass < passes; pass += 1) {
    for (let i = n - 2; i >= 0; i -= 1) { const ds = path.s[i + 1] - path.s[i]; v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * decel * ds)); }
    if (path.closed) v[n - 1] = Math.min(v[n - 1], Math.sqrt(v[0] ** 2 + 2 * decel * (path.length - path.s[n - 1])));
    for (let i = 1; i < n; i += 1) { const ds = path.s[i] - path.s[i - 1]; v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * accel * ds)); }
    if (path.closed) v[0] = Math.min(v[0], Math.sqrt(v[n - 1] ** 2 + 2 * accel * (path.length - path.s[n - 1])));
  }
  return v;
}

/** The planned speed at arc length s (interpolated). */
export function speedAt(path, profile, s) {
  const p = pointAt(path, s), i = Math.max(0, Math.min(path.n - 1, Math.round((p.s - path.s[0]) / path.step)));
  return profile[Math.min(path.n - 1, i)];
}

// ---------------------------------------------------------------- the driver

/**
 * The tracking law (tuned on the model, then in the app):
 *   lateral    the pose predicted `predict` s ahead (the input path, the
 *              slew and the yaw lag), its offset e and course error eps
 *              from the path; curvature asked
 *                kappa = kappa_path(ahead) - e / L^2 - 2 eps / L  (L = max(lookMin, lookTime v))
 *              -- a critically damped return to the path over ~L metres --
 *              turned into the key that holds it at this speed (the measured
 *              lock-and-cap map, vehicle-model keyFor), plus a yaw-rate
 *              correction.
 *   speed      the plan's speed a moment ahead (cut toward `recoverSpeed`
 *              when more than `offPath` m or 20 deg off the path); throttle for what it takes
 *              (and what the drag takes), nothing to coast, the reverse key
 *              to brake (only while rolling forward: from rest it reverses).
 */
export const GAINS = { predict: 0.12, lookMin: 4.5, lookTime: 0.55, yawGain: 0.15, speedGain: 1.6, speedLead: 0.35, brakeBelowCoast: 0.25, offPath: 1.5, recoverSpeed: 6 };

/**
 * A driver for one car. follow(plan) gives it a plan: { path, profile
 * (speeds per sample, speedProfile) | speed (a constant), stop (bool:
 * brake to a stop at the end), gains (overrides) }. step(state) returns the keys
 * { forward, strafe, handbrake } and what it saw (info).
 */
export function createDriver({ gains = GAINS, model = MONSTER } = {}) {
  let plan = null, hint = null, done = false;
  const base = { ...GAINS, ...gains };
  return {
    follow(next, { keepHint = false } = {}) { plan = next; if (!keepHint) hint = null; done = false; },
    get plan() { return plan; },
    get done() { return done; },
    get s() { return hint; },
    step(st) {
      if (!plan) return { forward: 0, strafe: 0, handbrake: true, info: null };
      const g = plan.gains ? { ...base, ...plan.gains } : base;
      const v = st.vf, r = st.w ? st.w[1] : st.r;
      // Predicted pose: the turn already under way carries on through the lag.
      const tp = g.predict, psiP = st.psi + r * tp, mid = st.psi + (r * tp) / 2;
      const vl = st.vl ?? 0;
      const px = st.p[0] + tp * (v * Math.sin(mid) + vl * Math.cos(mid)), pz = st.p[2] + tp * (v * Math.cos(mid) - vl * Math.sin(mid));
      const now = project(plan.path, st.p[0], st.p[2], hint);
      hint = now.s;
      const pr = project(plan.path, px, pz, now.s);
      const course = Math.abs(v) > 1 ? psiP + Math.atan2(vl, Math.abs(v)) * Math.sign(v) : psiP;
      const L = Math.max(g.lookMin, g.lookTime * Math.abs(v));
      const ref = pointAt(plan.path, pr.s + Math.min(L * 0.5, 3));
      const eps = wrapAngle(course - pr.psi);
      const kappa = ref.kappa - pr.e / (L * L) - (2 * eps) / L;
      const kmax = maxCurvature(Math.max(1, Math.abs(v)), model);
      const want = clamp(kappa, -kmax, kmax);
      let { u } = keyFor(want, Math.max(1, Math.abs(v)), model);
      // Yaw-rate correction: what the curvature map got wrong.
      if (Math.abs(v) > 2) u += (g.yawGain * (r - want * v)) / Math.max(0.05, kmax * Math.abs(v));
      u = clamp(Math.round(clamp(u, -1, 1) / KEY) * KEY, -1, 1);
      // Speed.
      const remaining = plan.path.closed ? Infinity : plan.path.length - now.s;
      if (!plan.path.closed && remaining < 0.5) done = true;
      const sLead = now.s + Math.max(0, v) * g.speedLead;
      let vref = plan.profile ? speedAt(plan.path, plan.profile, sLead) : plan.speed;
      if (plan.stop && !plan.path.closed) vref = Math.min(vref, Math.sqrt(Math.max(0, 2 * 5 * Math.max(0, remaining - 1))));
      // Off the path (knocked off it, or it could not follow): slow down until
      // back on it -- the lock is wider and the cap further off at low speed.
      const off = Number.isFinite(g.offPath) ? Math.max((Math.abs(now.e) - g.offPath) / 4, (Math.abs(eps) - 0.35) / 0.5) : -1;
      if (off > 0) vref = Math.min(vref, Math.max(g.recoverSpeed, vref * (1 - clamp(off, 0, 1))));
      const aWant = clamp(g.speedGain * (vref - v), -model.brake, model.accelMax);
      let forward = 0;
      const coast = coastDecel(v, model);
      if (aWant > -coast * 0.5) {
        const need = aWant + model.dragUnderThrottle * v * v + model.cornerDrag * Math.abs(v * r);
        forward = need > 0 ? clamp(need / Math.max(0.5, accelFull(v, model)), KEY, 1) : 0;
      } else if (aWant < -coast - g.brakeBelowCoast && v > 1.2) {
        forward = -clamp((-aWant) / model.brake, KEY, 1);
      }
      if (plan.stop && done) forward = v > 1.2 ? -1 : 0;
      forward = Math.round(forward / KEY) * KEY;
      return { forward, strafe: u, handbrake: plan.stop && done && Math.abs(v) < 1.2,
        info: { s: now.s, e: now.e, eps, kappa: want, vref, L, remaining } };
    },
  };
}

// ------------------------------------------------------------------ courses

/**
 * A course as legs driven in turn:
 *   { kind: 'track', path, profile | speed, stop }  follow it to its end
 *   { kind: 'handbrake', turn, hbAngle, hbSpeed, hbMax, powerSpeed, lead, handOver }
 *       a handbrake turn by `turn` radians (sign: psi's), closed-loop on the
 *       measured heading and speed: full lock and the handbrake until it has
 *       turned `hbAngle` or slowed to `hbSpeed` (or `hbMax` s), then full lock
 *       on the throttle (powered out, as the identification found it rotates
 *       on; holding `powerSpeed` if given) until the heading is `lead` seconds
 *       of yaw rate (+ `handOver` radians) short of `turn`; then the next leg
 *       (the exit, tracked).
 *   { kind: 'stop' }  brake to a stop and hold the handbrake
 * step(state, t) returns the keys and { leg, phase, info }.
 */
export function createCourseDriver(legs, { gains } = {}) {
  const tracker = createDriver({ gains });
  let k = -1, leg = null, phase = '', psi0 = 0, since = 0, turned = 0, lastPsi = null;
  const events = [];
  const mark = (what, st, t) => events.push({ what, leg: k, t: +t.toFixed(3), x: +st.p[0].toFixed(2), z: +st.p[2].toFixed(2), psi: +st.psi.toFixed(3), vf: +st.vf.toFixed(2), turned: +turned.toFixed(3) });
  const begin = (i, st, t) => {
    if (leg) mark(`end ${leg.kind}`, st, t);
    k = i; leg = legs[i] ?? { kind: 'stop' }; since = t; phase = leg.kind;
    if (leg.kind === 'track') tracker.follow({ path: leg.path, profile: leg.profile, speed: leg.speed, stop: !!leg.stop, gains: leg.gains });
    if (leg.kind === 'handbrake') { psi0 = st.psi; turned = 0; lastPsi = st.psi; phase = 'handbrake'; }
  };
  return {
    get leg() { return k; },
    get phase() { return phase; },
    get tracker() { return tracker; },
    /** What happened when: each leg's end (and a handbrake turn's release), with the pose. */
    events,
    step(st, t) {
      if (k < 0) begin(0, st, t);
      for (let guard = 0; guard < 4; guard += 1) {
        if (leg.kind === 'track') {
          const u = tracker.step(st);
          if (tracker.done && !leg.stop && k < legs.length - 1) { begin(k + 1, st, t); continue; }
          return { ...u, leg: k, phase, info: u.info };
        }
        if (leg.kind === 'handbrake') {
          turned += wrapAngle(st.psi - lastPsi); lastPsi = st.psi;
          const dir = Math.sign(leg.turn), r = st.w ? st.w[1] : st.r;
          // strafe +1 turns psi down.
          const strafe = -dir;
          if (phase === 'handbrake') {
            if (dir * turned >= leg.hbAngle || st.vf <= (leg.hbSpeed ?? 0) || t - since >= (leg.hbMax ?? 1.5)) { phase = 'power'; mark('release', st, t); }
            else return { forward: 0, strafe, handbrake: true, leg: k, phase, info: { turned } };
          }
          if (phase === 'power') {
            const left = Math.abs(leg.turn) - dir * turned;
            if (left <= Math.abs(r) * (leg.lead ?? 0.25) + (leg.handOver ?? 0)) { begin(k + 1, st, t); continue; }
            // Round on full lock at `powerSpeed` (where full lock is tightest), on the throttle alone.
            const forward = leg.powerSpeed ? clamp(0.3 + 0.5 * (leg.powerSpeed - st.vf), 0, 1) : 1;
            return { forward: Math.round(forward / KEY) * KEY, strafe, handbrake: false, leg: k, phase, info: { turned } };
          }
        }
        // stop
        return { forward: st.vf > 1.2 ? -1 : 0, strafe: 0, handbrake: Math.abs(st.vf) <= 1.2, leg: k, phase: 'stop', info: null };
      }
      return { forward: 0, strafe: 0, handbrake: true, leg: k, phase, info: null };
    },
  };
}
