// What each car must achieve on the test bed's trials (trials.mjs), and why.
// report.mjs judges a measurement report (server/src/vehicle_testbed.rs, or
// the app's client/native/vehicle-lab.mjs) against these.
//
// The rules, in priority order (what the game is for: drive these through
// buildings, get hit, take damage, drive on as a partial vehicle, get thrown):
//
//  1. It stands. A parked car breaks nothing.
//  2. It drives. Top speed reaches its real class's lower bound; the obstacles
//     its own geometry says it can clear, it clears without stalling, losing a
//     wheel or breaking a suspension bond (body dents are allowed on rubble).
//  3. Near misses and debris cost bodywork, not wheels. A meteor that misses,
//     a roof graze, a piece of a house thrown into it: it keeps all four
//     wheels and its ride height, and drives on. Damage goes in this order:
//     glass and trim, then panels, then cage and frame, then the suspension,
//     and the wheels last -- a car that loses a wheel stops being a car.
//  4. It can hurt things. From a standing start on a Vibe Town street it gets
//     fast enough to break a wall and be damaged by it, and drives away.
//  5. The weapons mean something. A cannonball leaves it partly destroyed and
//     drivable; a meteor wrecks it.
//  6. The handbrake turn feels as it does today (the measured reference below).
//
// The monster truck is the most forgiving: it clears every obstacle in the
// lab, keeps every wheel through a wall, and is the hardest to stop (it goes
// through the wall rather than stopping at it).
//
// Every threshold is a measurement or comes from one: the car's own geometry
// (underbody, tyre radius, approach angle, measured by the harness), its real
// class (client/src/vehicles/reality.mjs), the trial (what was thrown at it)
// or today's behaviour (DRIFT_REFERENCE).

import { classes } from '../../client/src/vehicles/reality.mjs';

/** Garage build -> model (client/src/vehicles/builds.mjs). */
const MODEL = { monster: 'monster', desert: 'trophy', trophy: 'trophy', derby: 'derby', circuit: 'sprint', sprint: 'sprint', buggy: 'buggy', trail: 'buggy', rally: 'rally', touge: 'rally', drift: 'derby' };
const ROLE = { monster: 'monster truck: over everything, hardest to stop', trophy: 'trophy truck: long travel, fast off-road', buggy: 'sand rail: light off-roader', derby: 'derby sedan: road car, tough body', sprint: 'sprint car: low, fast, road only', rally: 'rally hatchback' };

/**
 * The handbrake turn today (target/vehicle-testbed/baseline-all.json,
 * 2026-10-06, before any change): 1.2 s of full lock and handbrake from
 * 15 m/s. Kept within DRIFT_TOLERANCE of these.
 */
export const DRIFT_REFERENCE = {
  monster: { peakYawRate: 1.727, peakSlipDeg: 21.09, headingChangeDeg: -74.2 },
  desert: { peakYawRate: 1.956, peakSlipDeg: 45.43, headingChangeDeg: -91.4 },
  derby: { peakYawRate: 2.077, peakSlipDeg: 40.77, headingChangeDeg: -93.0 },
  circuit: { peakYawRate: 2.356, peakSlipDeg: 40.73, headingChangeDeg: -96.9 },
  buggy: { peakYawRate: 2.189, peakSlipDeg: 51.21, headingChangeDeg: -96.7 },
};
/** Relative tolerance on the drift reference (yaw rate, slip) and degrees of heading. */
export const DRIFT_TOLERANCE = { yaw: 0.15, slip: 0.25, headingDeg: 15 };

/** A wheel climbs a step face up to this share of its radius (contact angle acos(1 - 0.7) = 73 deg: beyond it the face is near vertical). */
const STEP_CLIMB_SHARE = 0.7;
/** Ride height kept: within the 10 cm a dent in the floor or a bent mount would explain, not a lost wheel or a broken corner (the chase: 1.10 -> 0.55-0.97). */
const RIDE_KEPT_M = 0.10;
/** A dent, not a wreck: share of the car's bonds a trial may cost where only bodywork may suffer. */
const DENT_SHARE = 0.02;

const NEAR_MISSES = ['knock-mirror', 'knock-mirror-driving', 'near-miss', 'blast-beside', 'blast-ahead', 'blast-over', 'graze-cab', 'graze-cab-deep', 'debris-wheel', 'debris-cab', 'town-chase'];
const OBSTACLES = ['step-15', 'step-30', 'step-50', 'ramp-10', 'ramp-20', 'ramp-30', 'debris', 'debris-fast', 'rubble'];

/** Which obstacles a car is expected to clear, from its own measured geometry and tune. */
function expects(trial, run, meta) {
  const u = run.underbody ?? {};
  const d = run.driving ?? {};
  const r = u.tyreRadius ?? 0.4;
  const lane = meta?.lanes?.find((l) => `lane/${l.id}` === meta?.trials?.find((t) => t.id === trial)?.at);
  const o = lane?.obstacle ?? {};
  if (trial.startsWith('step')) {
    const h = o.height ?? Number(trial.slice(5)) / 100;
    const ok = h <= STEP_CLIMB_SHARE * r && h <= u.clearance;
    return [ok, `step ${h} m vs ${STEP_CLIMB_SHARE} x tyre radius ${r.toFixed(2)} m and clearance ${u.clearance?.toFixed(2)} m`];
  }
  if (trial.startsWith('ramp')) {
    const angle = o.angle ?? Number(trial.slice(5));
    // Traction: tan(angle) <= grip x share of weight on driven wheels (AWD 1, RWD ~0.5); power: sin(angle) <= a / g.
    const driven = d.rearWheelDrive || d.frontWheelDrive ? 0.5 : 1;
    const traction = Math.atan((d.tyreFriction ?? 1) * driven) * 180 / Math.PI;
    const power = Math.asin(Math.min(1, (d.acceleration ?? 5) / 9.81)) * 180 / Math.PI;
    const ok = angle <= u.approachDeg && angle <= traction && angle <= power;
    return [ok, `${angle} deg vs approach ${u.approachDeg?.toFixed(0)}, traction ${traction.toFixed(0)}, power ${power.toFixed(0)} deg`];
  }
  if (trial === 'rubble') {
    // A heap clears when the tyre and the belly together stand taller than it.
    const h = o.height ?? 1;
    return [r + u.clearance >= h, `pile ${h} m vs tyre radius + clearance ${(r + u.clearance).toFixed(2)} m`];
  }
  return [true, 'every car drives through rubble on a street'];
}

export function judge(report, baseline = null, meta = null) {
  const byCar = new Map();
  for (const run of report.runs) {
    if (!byCar.has(run.car)) byCar.set(run.car, []);
    byCar.get(run.car).push(run);
  }
  const baseOf = (car, trial) => baseline?.runs?.find((r) => r.car === car && r.trial === trial);
  const cars = [];
  for (const [car, runs] of byCar) {
    const model = MODEL[car] ?? car;
    const real = classes[model];
    const monster = model === 'monster';
    const rows = [];
    const row = (trial, criterion, value, threshold, pass, why, base) => rows.push({ trial, criterion, value, threshold, pass: !!pass, why, ...(base != null && { baseline: base }) });
    const fmt = (v, d = 1) => (v == null ? '-' : typeof v === 'number' ? v.toFixed(d) : String(v));
    for (const run of runs) {
      const t = run.trial, b = baseOf(car, t);
      const bonds = run.bonds, parts = run.parts;
      if (t === 'rest') {
        row(t, 'bonds broken at rest', run.bondsBroken + run.brokenAtSettle, '0', run.bondsBroken + run.brokenAtSettle === 0, 'a parked car carries only its own weight', b && b.bondsBroken + b.brokenAtSettle);
      } else if (t === 'accel') {
        // Its own tune's top speed: Vehicle2's drive torque fades to zero at it
        // (full to a third of it, then linearly), so 90% is reached in seconds
        // (measured 93-98% in 12 s, 2026-10-06). How the tune compares with the
        // real class is reality.mjs's finding, not a driving failure.
        const tuned = run.driving?.topSpeed;
        row(t, 'top speed (m/s) in 12 s', fmt(run.topSpeed), `>= ${fmt(0.9 * tuned)} (90% of its tune)`, run.topSpeed >= 0.9 * tuned, `tune ${tuned} m/s; real ${real?.real ?? model}: ${real?.topSpeed?.join('-')} m/s`, b && fmt(b.topSpeed));
        row(t, '0-20 m/s (s)', fmt(run.timeTo?.['20'], 2), 'measured', true, 'reported', b && fmt(b.timeTo?.['20'], 2));
      } else if (OBSTACLES.includes(t)) {
        const [expected, because] = monster ? [true, 'the monster truck clears everything in the lab'] : expects(t, run, meta);
        const cleared = run.goalSeconds != null && run.stalledSeconds <= 0.5;
        const label = `clears it${expected ? '' : ' (not expected)'}`;
        row(t, label, cleared ? `${fmt(run.goalSeconds)} s` : `stopped at z ${fmt(run.maxZ)}`, expected ? 'clears' : 'measured', !expected || cleared, because, b && (b.goalSeconds != null ? `${fmt(b.goalSeconds)} s` : 'stopped'));
        if (expected) {
          row(t, 'wheels and suspension intact', `${run.wheelsLost} wheels, ${run.cornerBondsBroken} corner bonds`, '0, 0', run.wheelsLost === 0 && run.cornerBondsBroken === 0, 'driving over things must not cost wheels', b && `${b.wheelsLost}, ${b.cornerBondsBroken}`);
          const allowance = monster || !t.startsWith('debris') && t !== 'rubble' ? 0 : Math.floor(DENT_SHARE * bonds);
          row(t, 'bonds broken', run.bondsBroken, `<= ${allowance}`, run.bondsBroken <= allowance, allowance ? `rubble may dent the body (${DENT_SHARE * 100}% of its bonds)` : 'nothing breaks', b?.bondsBroken);
        }
      } else if (NEAR_MISSES.includes(t)) {
        row(t, 'wheels kept', 4 - run.wheelsLost, '4', run.wheelsLost === 0, 'near misses and debris cost bodywork, not wheels', b && 4 - b.wheelsLost);
        const sag = run.rideHeightStart - run.rideHeightEnd;
        row(t, 'ride height kept (m)', `${fmt(run.rideHeightStart, 2)} -> ${fmt(run.rideHeightEnd, 2)}`, `drop <= ${RIDE_KEPT_M}`, sag <= RIDE_KEPT_M, 'a broken corner or a lost wheel drops it (the chase: 1.10 -> 0.55-0.97)', b && `${fmt(b.rideHeightStart, 2)} -> ${fmt(b.rideHeightEnd, 2)}`);
        row(t, 'bonds broken', run.bondsBroken, `<= ${Math.floor(DENT_SHARE * bonds)}`, run.bondsBroken <= DENT_SHARE * bonds, `a near miss dents (${DENT_SHARE * 100}% of its bonds)`, b?.bondsBroken);
      } else if (t === 'wall' || t === 'house') {
        const target = t === 'wall' ? 'wall' : 'house';
        row(t, 'impact speed (m/s) after 50 m', fmt(run.impactSpeed), 'measured', run.impactSpeed != null, 'a Vibe Town street is 48 m long', b && fmt(b.impactSpeed));
        row(t, `${target} damaged (bonds)`, run.sceneBroken?.[target] ?? 0, '>= 1', (run.sceneBroken?.[target] ?? 0) >= 1, 'it can hurt things', b?.sceneBroken?.[target]);
        row(t, 'car damaged (bonds)', run.bondsBroken, '>= 1', run.bondsBroken >= 1, 'and is hurt by them', b?.bondsBroken);
        const keep = monster ? 4 : 2;
        row(t, 'wheels kept', 4 - run.wheelsLost, `>= ${keep}`, 4 - run.wheelsLost >= keep, monster ? 'the monster truck keeps every wheel' : 'it drives on as a partial vehicle', b && 4 - b.wheelsLost);
        row(t, 'drives away (m in 4.5 s)', fmt(run.driveAway?.metres), '>= 3', (run.driveAway?.metres ?? 0) >= 3, 'still drivable', b && fmt(b.driveAway?.metres));
        if (monster && t === 'wall') {
          const through = run.maxZ - (meta?.trials?.find((x) => x.id === t)?.impactZ ?? 20);
          row(t, 'goes through (m past the wall)', fmt(through), '>= 3', through >= 3, 'the monster truck is the hardest to stop', b && fmt(b.maxZ - 20));
        }
      } else if (t === 'cannonball') {
        row(t, 'damaged (bonds)', run.bondsBroken, `>= ${Math.ceil(0.01 * bonds)}`, run.bondsBroken >= 0.01 * bonds, 'partly destroyed: at least 1% of its bonds', b?.bondsBroken);
        row(t, 'parts off', `${run.partsOff} of ${parts}`, `<= ${Math.floor(0.4 * parts)}`, run.partsOff <= 0.4 * parts, 'partly, not wholly: under 40% of its parts off', b?.partsOff);
        row(t, 'wheels kept', 4 - run.wheelsLost, '>= 3', run.wheelsLost <= 1, 'drivable after', b && 4 - b.wheelsLost);
        row(t, 'drives away (m in 3 s)', fmt(run.driveAway?.metres), '>= 3', (run.driveAway?.metres ?? 0) >= 3, 'drivable after', b && fmt(b.driveAway?.metres));
      } else if (t === 'meteor') {
        const wrecked = run.partsOff >= 0.5 * parts || run.bondsBroken >= 0.3 * bonds;
        row(t, 'wrecked', `${run.partsOff}/${parts} parts off, ${run.bondsBroken}/${bonds} bonds`, '>= 50% parts or 30% bonds', wrecked, 'a meteor wrecks it', b && `${b.partsOff}, ${b.bondsBroken}`);
      } else if (t === 'drift') {
        const ref = DRIFT_REFERENCE[car];
        const d = run.drift ?? {};
        if (ref) {
          const near = (v, r, tol) => Math.abs(v - r) <= tol * Math.abs(r);
          row(t, 'peak yaw rate (rad/s)', fmt(d.peakYawRate, 2), `${ref.peakYawRate} +-${DRIFT_TOLERANCE.yaw * 100}%`, near(d.peakYawRate, ref.peakYawRate, DRIFT_TOLERANCE.yaw), 'the handbrake turn as today', b && fmt(b.drift?.peakYawRate, 2));
          row(t, 'peak slip angle (deg)', fmt(d.peakSlipDeg), `${ref.peakSlipDeg} +-${DRIFT_TOLERANCE.slip * 100}%`, near(d.peakSlipDeg, ref.peakSlipDeg, DRIFT_TOLERANCE.slip), 'the handbrake turn as today', b && fmt(b.drift?.peakSlipDeg));
          row(t, 'heading change (deg)', fmt(d.headingChangeDeg), `${ref.headingChangeDeg} +-${DRIFT_TOLERANCE.headingDeg}`, Math.abs(d.headingChangeDeg - ref.headingChangeDeg) <= DRIFT_TOLERANCE.headingDeg, 'the handbrake turn as today', b && fmt(b.drift?.headingChangeDeg));
        }
        row(t, 'nothing breaks, stays upright', `${run.bondsBroken} bonds, up ${fmt(run.minUpY, 2)}`, '0, > 0.5', run.bondsBroken === 0 && run.minUpY > 0.5, 'a handbrake turn is driving', null);
      }
    }
    cars.push({ car, model, role: ROLE[model] ?? model, mass: runs[0].mass, bonds: runs[0].bonds, parts: runs[0].parts, passed: rows.filter((r) => r.pass).length, rows });
  }
  return { label: report.label, harness: report.harness, cars };
}
