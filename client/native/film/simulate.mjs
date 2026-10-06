// A course or a plan driven on the model instead of the game
// (vehicle-model.mjs as the plant): the driver and meter exactly as the film
// uses them, for tuning and for statistics in seconds. `plant` perturbs the
// model the plant is (a curvature gain, an extra input delay, a yaw lag) so
// a result can be checked for how much it leans on the model being right.
// Handbrake turns are not modelled: a course with one stops before it.
import { MONSTER, initialState, step } from './vehicle-model.mjs';
import { createCourseDriver } from './driver.mjs';
import { createMeter } from './meter.mjs';
import { project } from './path.mjs';

/** The model state as the driver reads a truck (truckState's fields). */
export function asTruck(s, p = MONSTER) {
  const vl = s.r * (p.lateralArm - p.lateralArmFade * s.vf * s.vf);
  return { p: [s.x, 1, s.z], psi: s.psi, vf: s.vf, vl, speed: Math.hypot(s.vf, vl), w: [0, s.r, 0], v: [s.vf * Math.sin(s.psi) + vl * Math.cos(s.psi), 0, s.vf * Math.cos(s.psi) - vl * Math.sin(s.psi)] };
}

/** The model with some numbers off: { curvatureGain, extraDelay (ticks), yawLag, brake, accel }. */
export function perturbed(plant = {}) {
  return {
    ...MONSTER,
    wheelbase: MONSTER.wheelbase / (plant.curvatureGain ?? 1),
    inputDelay: MONSTER.inputDelay + (plant.extraDelay ?? 0),
    yawLag: plant.yawLag ?? MONSTER.yawLag,
    brake: MONSTER.brake * (plant.brake ?? 1),
    accelMax: MONSTER.accelMax * (plant.accel ?? 1),
  };
}

/** Drive a course episode (turning.mjs COURSES) on the model; its meter's result. */
export function simulateCourse(ep, { seconds = ep.seconds, plant = {}, gains } = {}) {
  const p = perturbed(plant);
  const [x, z, h] = ep.slot;
  const s = initialState({ x, z, psi: (h * Math.PI) / 180 }, p);
  const driver = createCourseDriver(ep.legs, { gains });
  const meter = createMeter(ep);
  const trace = [];
  let t = 0, stoppedAt = null;
  for (let k = 0; k < seconds * 60; k += 1) {
    t = k / 60;
    const st = asTruck(s, p);
    const u = driver.step(st, t);
    if (ep.legs[driver.leg]?.kind === 'handbrake') break;
    meter.sample(st, t, { leg: driver.leg, s: u.info?.s, e: u.info?.e, tracking: ep.legs[driver.leg]?.kind === 'track' });
    if (k % 6 === 0) trace.push([+t.toFixed(2), +s.x.toFixed(2), +s.z.toFixed(2), +s.vf.toFixed(2)]);
    step(s, u, 1 / 60, p);
    const leg = ep.legs[driver.leg];
    if ((u.phase === 'stop' || (leg?.stop && driver.tracker.done)) && Math.abs(s.vf) < 0.1) { stoppedAt = t; break; }
  }
  meter.finish(t);
  return { ...meter.result(), stoppedAt, trace };
}

/**
 * An avoidance episode on the model: re-planned every `every` s
 * (planner.mjs), tracked by the driver, the plant perturbed by `plant`.
 * Returns the closest the truck's footprint came to each rock's surface once
 * it was down (negative: it was hit) and the trace.
 */
export async function simulateAvoid({ route, speed, start, hazards, seconds = 20, every = 0.1, plant = {}, settings, reveal = Infinity }) {
  const { plan, footprintDistance, PLAN } = await import('./planner.mjs');
  const { createDriver } = await import('./driver.mjs');
  const p = perturbed(plant);
  const s = initialState({ x: start.x, z: start.z, psi: start.psi }, p);
  const driver = createDriver();
  let current = null;
  const keys = [{ forward: 0, strafe: 0 }, { forward: 0, strafe: 0 }];
  const clear = hazards.map(() => Infinity);
  const trace = [];
  let planMs = 0, plans = 0;
  for (let k = 0; k < seconds * 60; k += 1) {
    const t = k / 60, st = asTruck(s, p);
    if (k % Math.round(every * 60) === 0) {
      const t0 = Date.now();
      current = plan(st, t, { route, speed, hazards, last: current, settings: settings ?? PLAN, keys, reveal });
      planMs += Date.now() - t0; plans += 1;
      driver.follow({ path: current.path, profile: current.profile, stop: current.factor === 0 });
    }
    const u = driver.step(st);
    keys.push(u); keys.shift();
    step(s, u, 1 / 60, p);
    hazards.forEach((h, i) => { if (t >= h.t - 0.05) clear[i] = Math.min(clear[i], footprintDistance(s.x, s.z, s.psi, h.x, h.z, p) - h.radius); });
    if (k % 6 === 0) trace.push([+t.toFixed(1), +s.x.toFixed(1), +s.z.toFixed(1), +s.vf.toFixed(1), current.D, current.factor]);
  }
  const progress = project(route, s.x, s.z).s;
  return { clearances: clear.map((c) => +c.toFixed(2)), hit: clear.some((c) => c < 0), progress: +progress.toFixed(1), planMs: +(planMs / plans).toFixed(1), trace };
}
