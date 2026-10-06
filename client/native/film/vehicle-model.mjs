// The monster truck as the closed-loop driver and the planner see it: the
// game's control shaping (server/src/physx_runtime.rs shape_tuned_vehicle_commands,
// copied rule for rule) feeding a kinematic bicycle whose numbers were
// measured, not assumed -- scripts/turning-lab.sh sysid, reduced by
// client/native/film/sysid.mjs (target/native-video/turning-20261006-181847.log,
// 2026-10-06; the monster at 5000 kg, 64 stress iterations, FP32).
//
// Measured (strafe +1 is psi decreasing: yaw rate w_y < 0):
//   steer step, key to front wheels moving   0.05 s (2 ticks of input path + 1 of slew)
//   key to 63% / 90% of the steady yaw rate  0.12-0.22 s / 0.18-0.32 s (full lock, 4.5-24 m/s)
//   release, yaw rate to 37%                 0.10-0.17 s
//   steady curvature                         tan(wheel) / 3.08 m at every speed (no measurable understeer)
//   wheels at full key                       mean of the Ackermann pair 0.339 rad (0.384 inner, 0.294 outer)
//   lateral acceleration, full key            0.24 g at 4.5 m/s (full lock, R 8.9 m); 0.64 g at 7.5 (R 9.0);
//                                             0.69-0.73 g from 10.5 to 24.4 m/s (R 16.5, 26, 39, 59, 83 m):
//                                             the server's driver-assist cap (7.5 m/s^2 commanded)
//   half key                                  half of each (0.12-0.37 g): linear in the key
//   full throttle                             7.2 m/s^2 to 10 m/s, then 0.36 (30 - v) (drive fades to 0 at 30)
//   coasting (no pedal)                       0.16 m/s^2 at 8 m/s .. 0.30 at 24 (0.147 + 0.00026 v^2)
//   reverse key while rolling forward          8.0 m/s^2 (10.5 below 2.5 m/s)
//   reverse                                   7.2 m/s^2 to 8.1 m/s
//   half / quarter throttle, half / quarter key  3.6 / 1.6, -4.0 / -2.0 m/s^2: linear
//                                             (turning-20261006-182857.log, the second run)
//   handbrake + full lock, held to a stop     29 deg from 8.6 m/s, 67 from 12.6, 104 from 16.5, 124 from 20.5;
//                                             peak yaw 0.8 / 1.35 / 1.9 / 1.9 rad/s; ~8 m/s^2 of slowing
//   handbrake 0.8 s from 14.5 m/s, then full lock and throttle   35 deg at release, 90 deg 10.4 m on and 6.9 m over
//   handbrake 1.0 s from 18.5 m/s, then full lock and throttle   42 deg at release, 180 deg 7.5 m on and 10.8 m over
//   J-turn: flat out backwards (8 m/s), full lock   a 9 m circle, no snap; with the handbrake it stops in 20 deg
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

/** The server's shaping constants (physx_runtime.rs) and the monster's tune (resolveDrivingSetup at 5000 kg). */
export const SERVER = {
  slewIn: 5, slewOut: 8, fullLockBelow: 6, minLockAbove: 28, minLockFraction: 0.35,
  pedalThreshold: 1, reverseTop: 8, steeringResponse: 1,
  wheelbase: 3, maxSteer: 0.3839724354387525, grip: 1.4, lateralCap: 7.5,
};

/** Fitted to the identification run (see the header). */
export const MONSTER = {
  /** Ticks from ctx.drive to the server applying the key (60 Hz). */
  inputDelay: 2,
  /**
   * The front wheels: the inner at the key's lock x maxSteer, the outer on
   * Ackermann geometry (track / wheelbase 0.833: 0.294 rad at full lock),
   * and the car turning on their mean (0.339 rad at full lock, 0.375 x lock
   * at small angles) over an effective wheelbase (m).
   */
  ackermann: 0.833, wheelbase: 3.08,
  /** Yaw rate's lag behind the wheels (s). */
  yawLag: 0.07,
  /** Lateral velocity of the reference point per yaw rate: (a - b v^2) m. */
  lateralArm: 1.17, lateralArmFade: 0.0041,
  /** Full throttle: accelMax up to accelKnee m/s, then accelFade (topSpeed - v). */
  accelMax: 7.2, accelFade: 0.36, topSpeed: 30,
  /** What holds it back: coasting (no pedal) and under throttle; and cornering. */
  coastA: 0.147, coastB: 0.00026, dragUnderThrottle: 0.0004, cornerDrag: 0.02,
  /** The reverse key as a brake (m/s^2 at full key), and from rest, reverse. */
  brake: 8.0, reverseAccel: 7.2, reverseTop: 8.1,
  /** Handbrake + full lock held to a stop: entry speed (m/s) -> heading turned (deg). */
  handbrakeTurn: [[0, 0], [8.6, 29], [12.6, 67], [16.5, 104], [20.5, 124]],
  /** The truck's footprint: half length and half width (m), about its reference point. */
  halfLength: 2.6, halfWidth: 1.6,
};

/** Full lock up to 6 m/s, tapering to 35% at 28 m/s (smoothstep): steer_lock_fraction. */
export function lockFraction(v) {
  const t = clamp((Math.abs(v) - SERVER.fullLockBelow) / (SERVER.minLockAbove - SERVER.fullLockBelow), 0, 1);
  return 1 - (1 - SERVER.minLockFraction) * t * t * (3 - 2 * t);
}

/** The driver-assist limit: the lock that asks for the lateral cap at this speed. */
export function lockLimit(v) {
  const a = Math.min(0.65 * SERVER.grip * 9.81, SERVER.lateralCap);
  return Math.min(1, Math.atan((a * SERVER.wheelbase) / Math.max(v * v, 0.01)) / SERVER.maxSteer);
}

/** The lock the server aims the wheels at for key u (-1..1) at forward speed v. */
export const steerTarget = (u, v) => clamp(u, -1, 1) * Math.min(lockFraction(v), lockLimit(v));

/** One tick of the server's steer slew: in at 5 locks/s, back at 8. */
export function slew(cmd, target, dt) {
  const rate = (Math.abs(target) > Math.abs(cmd) ? SERVER.slewIn : SERVER.slewOut) * SERVER.steeringResponse;
  return cmd + clamp(target - cmd, -rate * dt, rate * dt);
}

/** The front wheels' mean angle (rad, unsigned) for a steer command of `lock` locks. */
export function wheelMean(lock, p = MONSTER) {
  const inner = Math.abs(lock) * SERVER.maxSteer;
  if (inner < 1e-9) return 0;
  const outer = Math.atan(1 / (1 / Math.tan(inner) + p.ackermann));
  return (inner + outer) / 2;
}

/** Steady curvature (1/m, in psi's sense) for a steer command (locks) -- strafe +1 turns psi down. */
export function curvatureOf(cmd, p = MONSTER) {
  return (-sign(cmd) * Math.tan(wheelMean(cmd, p))) / p.wheelbase;
}

/** The key that holds curvature kappa at speed v, and whether it is beyond reach (clamped). */
export function keyFor(kappa, v, p = MONSTER) {
  const lock = Math.min(lockFraction(v), lockLimit(v));
  const want = Math.abs(kappa);
  if (want < 1e-9) return { u: 0, saturated: false };
  if (want >= Math.abs(curvatureOf(lock, p))) return { u: -sign(kappa), saturated: true };
  return { u: (-sign(kappa) * lockForCurvature(want, p)) / lock, saturated: false };
}

/** |curvature| -> lock, inverted from a table of the (monotonic) curvature map. */
const TABLES = new WeakMap();
function lockForCurvature(want, p) {
  let t = TABLES.get(p);
  if (!t) {
    const n = 512, k = new Float64Array(n + 1);
    for (let i = 0; i <= n; i += 1) k[i] = Math.abs(curvatureOf(i / n, p));
    t = { n, k }; TABLES.set(p, t);
  }
  let lo = 0, hi = t.n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t.k[mid] < want) lo = mid; else hi = mid; }
  const f = (want - t.k[lo]) / Math.max(1e-12, t.k[hi] - t.k[lo]);
  return (lo + Math.max(0, Math.min(1, f))) / t.n;
}

/** The tightest curvature on offer at speed v (full key). */
export const maxCurvature = (v, p = MONSTER) => Math.abs(curvatureOf(Math.min(lockFraction(v), lockLimit(v)), p));

/** Full-throttle acceleration at forward speed v. */
export const accelFull = (v, p = MONSTER) => Math.max(0, Math.min(p.accelMax, p.accelFade * (p.topSpeed - v)));
export const coastDecel = (v, p = MONSTER) => p.coastA + p.coastB * v * v;

/** Heading (deg) a handbrake turn held to a stop gives from entry speed v. */
export function handbrakeTurnDeg(v, p = MONSTER) {
  const t = p.handbrakeTurn;
  if (v <= t[0][0]) return t[0][1];
  for (let k = 1; k < t.length; k += 1) if (v <= t[k][0]) return t[k - 1][1] + ((t[k][1] - t[k - 1][1]) * (v - t[k - 1][0])) / (t[k][0] - t[k - 1][0]);
  const [a, b] = t.slice(-2);
  return b[1] + ((b[1] - a[1]) * (v - b[0])) / (b[0] - a[0]);
}

/** A model state: { x, z, psi, vf, r, cmd, queue: [[forward, strafe], ...] (the input path) }. */
export function initialState({ x = 0, z = 0, psi = 0, vf = 0, r = 0, cmd = 0 } = {}, p = MONSTER) {
  return { x, z, psi, vf, r, cmd, queue: Array.from({ length: p.inputDelay }, () => [0, 0]) };
}

/**
 * One tick (dt, 1/60 s) of the truck under the keys { forward, strafe }
 * (handbrake not modelled: the driver's handbrake turns are closed-loop on
 * the measured heading). Mutates and returns the state.
 */
export function step(s, keys, dt = 1 / 60, p = MONSTER) {
  s.queue.push([keys.forward ?? 0, keys.strafe ?? 0]);
  const [fwd, str] = s.queue.shift();
  const v = s.vf;
  s.cmd = slew(s.cmd, steerTarget(str, v), dt);
  // Yaw rate toward the kinematic one for the wheels.
  const rss = v * curvatureOf(s.cmd, p);
  s.r += (rss - s.r) * (1 - Math.exp(-dt / p.yawLag));
  // Pedals, with the server's semantics.
  const throttle = Math.max(0, fwd), reverse = Math.max(0, -fwd);
  let a;
  const latA = Math.abs(v * s.r);
  if (v > SERVER.pedalThreshold && reverse > 0 && throttle <= 0) a = -p.brake * reverse;
  else if (v < -SERVER.pedalThreshold && throttle > 0) a = p.brake * throttle;
  else if (throttle > 0) a = throttle * accelFull(v, p) - p.dragUnderThrottle * v * v - p.cornerDrag * latA;
  else if (reverse > 0) a = v > -p.reverseTop ? -reverse * p.reverseAccel : 0;
  else a = -sign(v) * Math.min(Math.abs(v) / dt, coastDecel(v, p) + p.cornerDrag * latA);
  const vNext = v + a * dt;
  // The brake stops it; it does not reverse it.
  s.vf = v > 0 && reverse > 0 && throttle <= 0 && vNext < 0 ? 0 : vNext;
  const vl = s.r * (p.lateralArm - p.lateralArmFade * v * v);
  const sn = Math.sin(s.psi), cs = Math.cos(s.psi);
  s.x += (v * sn + vl * cs) * dt;
  s.z += (v * cs - vl * sn) * dt;
  s.psi += s.r * dt;
  return s;
}
