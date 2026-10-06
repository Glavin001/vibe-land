// The vehicle test bed in the app (scripts/native-mac.sh vehicle-lab
// [--build B]): the lab scene (structures/vehicle-lab) with one car of the
// build per chosen trial, parked at its lane or pad; each trial played in
// turn as a shot of the film toolkit (client/native/film): the camera
// follows the car, the player gets in and drives it as the trial says, the
// meteors and the cannonball are the game's own. Every 0.1 s the car's
// server state (session.vehicleDebug) is read and each trial's measurements
// logged as `measure {json}` -- the shape server/src/vehicle_testbed.rs
// reports -- for structures/vehicle-lab/native-report.mjs to judge with
// criteria.mjs. FILM_CHECK=1 (the default there) keeps two stills a second.
//
/* global VEHICLE_LAB_TRIALS, VEHICLE_LAB_BUILD */
import { boot } from './film/film.mjs';
import { track, enter } from './film/shots.mjs';
import { placeResolver } from './film/places.mjs';

const TRIALS = typeof VEHICLE_LAB_TRIALS === 'string' ? VEHICLE_LAB_TRIALS.split(',') : [];
const BUILD = typeof VEHICLE_LAB_BUILD === 'string' ? VEHICLE_LAB_BUILD : 'monster';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Seconds a trial's result stays on screen before the next trial. */
const RESULT_HOLD = 3;

/** What each trial puts the car through, as a caption over its shot (a video: FILM_CHECK=0). */
const CAPTIONS = {
  rest: 'Parked: does it stand?', accel: 'Flat out from a standstill', 'step-15': 'A 15 cm kerb', 'step-30': 'A 30 cm step',
  'step-50': 'A 50 cm step', 'ramp-10': 'A 10° ramp', 'ramp-20': 'A 20° ramp', 'ramp-30': 'A 30° ramp',
  debris: 'A debris field at 36 km/h', 'debris-fast': 'A debris field, flat out', rubble: 'A 1 m rubble pile',
  wall: 'Flat out into a masonry wall', house: 'Flat out into a house', street: 'Down a street of houses',
  'near-miss': 'Meteors beside, ahead and overhead', 'debris-cab': '700 kg of debris into the cab',
  'debris-wheel': '700 kg of debris into a wheel', 'graze-cab': 'A meteor grazes the cab', coast: 'Let go of at speed',
  cannonball: 'Hit by a cannonball', meteor: 'Hit by a meteor', drift: 'A handbrake turn at 54 km/h',
};

/** The outcome of a trial in a line, from its measurements. */
function outcome(trial, m) {
  const wheels = 4 - (m.wheelsLost ?? 0);
  const damage = m.bondsBroken ? `${m.bondsBroken} joints broken, ${m.partsOff} of ${m.parts} parts off` : 'not a scratch';
  const kmh = (v) => `${Math.round(v * 3.6)} km/h`;
  const lines = [];
  if (trial.goal != null) lines.push(m.goalSeconds != null ? `over it in ${m.goalSeconds.toFixed(1)} s` : `stopped at ${(m.maxZ - (m.startZ ?? 0)).toFixed(0)} m`);
  if (trial.id === 'accel') lines.push(`${kmh(m.topSpeed)} top speed`);
  if (trial.impactZ != null && m.impactSpeed != null) lines.push(`in at ${kmh(m.impactSpeed)}, ${Math.max(0, m.maxZ - trial.impactZ).toFixed(0)} m through`);
  if (trial.drive.kind === 'drift' && m.drift) lines.push(`${Math.abs(m.drift.headingChangeDeg ?? 0).toFixed(0)}° round, ${Math.round(100 * (m.drift.speedKept ?? 0))}% of its speed kept`);
  lines.push(`${wheels} wheel${wheels === 1 ? '' : 's'} on`, damage);
  return lines.join(' · ');
}

/** The car's server state, parsed: position, velocity, rotation, wheels, damage. */
function readCar(ctx, index) {
  let d;
  try { d = JSON.parse(ctx.session.vehicleDebug(index)); } catch { return null; }
  const v2 = d.vehicle2 ?? {};
  const [qx, qy, qz, qw] = v2.rotation ?? [0, 0, 0, 1];
  // Rotated +z (forward) and +y (up).
  const forward = [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)];
  const upY = 1 - 2 * (qx * qx + qz * qz);
  const broken = (d.bonds ?? []).filter((b) => b.remainingArea <= 0 || b.verdictBroken).map((b) => b.index);
  const off = new Set((d.hulls ?? []).filter((h) => h.actor !== 0).map((h) => h.part));
  const parts = new Set((d.hulls ?? []).map((h) => h.part)).size;
  return {
    p: v2.position ?? [0, 0, 0], v: v2.linearVelocity ?? [0, 0, 0], w: v2.angularVelocity ?? [0, 0, 0], forward, upY,
    broken, partsOff: off.size, parts, bonds: (d.bonds ?? []).length, wheelMask: d.vehicle?.wheelMask ?? 15,
    mass: (d.actors ?? []).find((a) => a.actor === 0)?.mass,
  };
}

/** One trial as a shot: the camera on its car, its driving and attacks as cues, measured every 0.1 s. */
function trialShot(trial, index, meta, ground) {
  const car = `car-${index}`;
  const lead = 1.4; // getting in
  const seconds = trial.seconds;
  const m = { car: BUILD, trial: trial.id, seconds, harness: 'native' };
  let start = null, last = null, prevT = null, cityBefore = 0;
  let launched = false, driftStart = null, driftHeading0 = 0;
  const speedOf = (s) => Math.hypot(s.v[0], s.v[2]);
  const headingOf = (s) => Math.atan2(s.forward[0], s.forward[2]);
  const groundAt = () => ground(trial);
  const sample = (ctx, t) => {
    const s = readCar(ctx, index);
    if (!s) return;
    positions.set(index, s.p);
    if (!start) {
      start = s; cityBefore = ctx.e2e.snapshot()?.city?.brokenBonds ?? 0;
      Object.assign(m, { bonds: s.bonds, parts: s.parts, mass: s.mass, brokenAtSettle: s.broken.length, topSpeed: 0, maxZ: s.p[2],
        startZ: s.p[2], rideHeightStart: s.p[1] - groundAt(), stalledSeconds: 0, goal: trial.goal ?? null, goalSeconds: null, peakDecelG: 0, minUpY: 1 });
    }
    const speed = speedOf(s);
    m.topSpeed = Math.max(m.topSpeed, speed);
    m.maxZ = Math.max(m.maxZ, s.p[2]);
    m.minUpY = Math.min(m.minUpY, s.upY);
    if (trial.goal != null && m.goalSeconds == null && s.p[2] >= trial.goal) m.goalSeconds = t;
    // Impact: the speed of the last sample before the car's nose reached it (0.1 s apart).
    if (trial.impactZ != null && m.impactSpeed == null && s.p[2] + 2.5 >= trial.impactZ - 0.2) { m.impactSpeed = Math.max(speed, last ? speedOf(last) : 0); m.impactSeconds = t; }
    m.timeTo ??= { 10: null, 20: null };
    for (const v of [10, 20]) if (m.timeTo[v] == null && speed >= v) m.timeTo[v] = t;
    if (last && prevT != null && t > prevT) {
      const dv = Math.hypot(...s.v.map((c, k) => c - last.v[k]));
      m.peakDecelG = Math.max(m.peakDecelG, dv / (t - prevT) / 9.81);
      const throttle = trial.drive.kind !== 'park';
      if (throttle && speed < 0.5 && m.goalSeconds == null && t > 1) m.stalledSeconds += t - prevT;
    }
    if (trial.drive.kind === 'drift' && driftStart != null && t <= driftStart + trial.drive.seconds) {
      m.drift ??= { entrySpeed: 0, peakYawRate: 0, peakSlipDeg: 0 };
      m.drift.peakYawRate = Math.max(m.drift.peakYawRate, Math.abs(s.w[1]));
      if (speed > 2) {
        const f = Math.hypot(s.forward[0], s.forward[2]);
        const cos = (s.forward[0] * s.v[0] + s.forward[2] * s.v[2]) / (f * speed);
        m.drift.peakSlipDeg = Math.max(m.drift.peakSlipDeg, (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
      }
    }
    last = s; prevT = t;
    return s;
  };
  const finish = (ctx) => {
    const s = readCar(ctx, index) ?? last;
    if (!s || !start) { ctx.log(`measure ${JSON.stringify({ ...m, error: 'no car' })}`); return; }
    const broken = new Set(s.broken);
    Object.assign(m, {
      bondsBroken: s.broken.length - start.broken.length, bondsBrokenAfterDriveAway: s.broken.length, cornerBondsBroken: null,
      partsOff: s.partsOff, wheelsLost: [0, 1, 2, 3].filter((w) => !(s.wheelMask & (1 << w))).length,
      rideHeightEnd: s.p[1] - groundAt(), bodyMass: [start.mass, s.mass],
      sceneBroken: { [trial.at.split('/')[1] === 'house' ? 'house' : trial.at.split('/')[1] === 'wall' ? 'wall' : 'scene']: (ctx.e2e.snapshot()?.city?.brokenBonds ?? 0) - cityBefore },
      endPosition: s.p, brokenIndices: [...broken].slice(0, 50),
    });
    ctx.log(`measure ${JSON.stringify(m)}`);
    // Read until the next caption: the drive-away's, or the next trial's.
    ctx.edit({ type: 'title', style: 'lower', size: 'small', text: outcome(trial, m), from: ctx.t, to: ctx.t + (trial.driveAway ? 3.5 : RESULT_HOLD) });
  };
  // Cues: get in (driving trials), drive, attack, sample.
  const cues = [[0, (ctx) => ctx.edit({ type: 'title', style: 'lower', size: 'small', text: `${BUILD} truck · ${CAPTIONS[trial.id] ?? trial.name ?? trial.id}`.replace(/^monster truck/, 'Monster truck'), from: ctx.t + 0.2, to: ctx.t + lead + 1.6 })]];
  const driving = trial.drive.kind !== 'park';
  if (driving) cues.push([0, enter(car)]);
  for (let k = 0; k * 0.1 <= lead + seconds; k += 1) {
    const t = k * 0.1 - lead;
    cues.push([k * 0.1, (ctx) => {
      const s = t >= 0 ? sample(ctx, t) : null;
      if (!s || !driving) return;
      // The trial's driving, re-decided every 0.1 s from the car's own speed.
      const d = trial.drive, speed = speedOf(s);
      let forward = 0, strafe = 0, brake = false;
      if (d.kind === 'floor') forward = 1;
      else if (d.kind === 'cruise') forward = speed < d.speed ? 1 : 0;
      else if (d.kind === 'drift') {
        if (driftStart == null && speed >= d.speed) { driftStart = t; driftHeading0 = headingOf(s); m.drift = { entrySpeed: speed, peakYawRate: 0, peakSlipDeg: 0 }; }
        if (driftStart == null) forward = 1;
        else if (t < driftStart + d.seconds) { strafe = 1; brake = true; }
        else if (m.drift.exitSpeed == null) {
          m.drift.exitSpeed = speed; m.drift.speedKept = speed / m.drift.entrySpeed;
          m.drift.headingChangeDeg = (((headingOf(s) - driftHeading0) * 180) / Math.PI);
        }
      }
      ctx.drive.move({ forward, strafe });
      if (brake) ctx.drive.jump(150);
    }]);
  }
  const a = trial.attack;
  if (!driving) {
    // The player beside the parked car (the game streams what is near the
    // player): 25 m off for a meteor, 12 m to its right for the cannonball.
    cues.push([0, (ctx) => {
      const s = readCar(ctx, index);
      if (!s) return;
      const right = [s.forward[2], 0, -s.forward[0]], d = a?.kind === 'meteor' ? 25 : 12;
      ctx.e2e.dropAt({ position: [s.p[0] + right[0] * d, s.p[1] + 0.6, s.p[2] + right[2] * d], yaw: Math.atan2(-right[0], -right[2]), pitch: 0 });
    }]);
  }
  if (a?.kind === 'cannonball') {
    // The game's cannonball from 12 m to the car's right, aimed at its chassis.
    let target = null;
    cues.push([lead + a.at - 0.3, (ctx) => { ctx.e2e.setShotMode('cannonball'); const s = readCar(ctx, index); if (s) { target = s.p; ctx.drive.lookAt(...s.p); } }]);
    cues.push([lead + a.at - 0.2, (ctx) => { if (target) ctx.drive.lookAt(...target); }]);
    cues.push([lead + a.at, (ctx) => ctx.drive.fire({ holdMs: 60 })]);
  } else if (a?.kind === 'meteor') {
    cues.push([lead + a.at, (ctx) => { const s = readCar(ctx, index); if (s) ctx.session.meteor(s.p[0], s.p[1], s.p[2]); }]);
  } else if (a?.kind === 'strikes') {
    // Launched when the car will be at carZ after the flight (shots.mjs launchMeteor's arc).
    for (let k = 0; k * 0.05 <= seconds; k += 1) cues.push([lead + k * 0.05, (ctx) => {
      if (launched) return;
      const s = readCar(ctx, index);
      if (!s || s.p[2] + s.v[2] * a.flight < a.carZ) return;
      launched = true;
      const lane = meta.lanes.find((l) => `lane/${l.id}` === trial.at);
      for (const strike of lane.obstacle.strikes) {
        const b = (strike.from * Math.PI) / 180, out = (140 * a.flight) / Math.hypot(1, a.slope), target = strike.target;
        const start = [target[0] + Math.sin(b) * out, target[1] + out * a.slope, target[2] + Math.cos(b) * out];
        const T = Math.hypot(...start.map((v, i) => v - target[i])) / 140;
        const velocity = start.map((v, i) => (target[i] - v) / T + (i === 1 ? 9.81 * T * 0.5 : 0));
        ctx.session.replayEvent(JSON.stringify({ kind: 'meteor', start, velocity, target, flight_s: T }));
      }
    }]);
  }
  const away = trial.driveAway;
  let awayFrom = null, quietSince = null, awayStart = null;
  // After the trial: the drive-away, or a few seconds on the result.
  const tail = away ? 9.5 : RESULT_HOLD;
  if (away) {
    // Still drivable? As the headless harness: let it come to rest (up to 5 s),
    // then reverse (when it hit something ahead) and full throttle on full lock.
    if (!driving) cues.push([lead + seconds - 0.6, enter(car)]);
    for (let k = 0; k * 0.1 <= tail; k += 1) cues.push([lead + seconds + k * 0.1, (ctx) => {
      const s = readCar(ctx, index);
      if (!s) return;
      positions.set(index, s.p);
      const t = k * 0.1;
      if (awayStart == null) {
        // On the handbrake (Vehicle2 here coasts on undiminished).
        ctx.drive.move({ forward: 0, strafe: 0 });
        ctx.drive.jump(150);
        quietSince = speedOf(s) < 0.5 ? quietSince ?? t : null;
        if ((quietSince != null && t - quietSince >= 0.5) || t >= 5) { awayStart = t; awayFrom = s.p; }
        return;
      }
      const into = t - awayStart, reverse = away.reverse ?? 0;
      if (into < reverse) ctx.drive.move({ forward: -1, strafe: 0 });
      else if (into < reverse + away.seconds) ctx.drive.move({ forward: 1, strafe: reverse ? 1 : 0 });
      else if (m.driveAway == null) {
        ctx.drive.move({ forward: 0, strafe: 0 });
        m.driveAway = { metres: Math.hypot(s.p[0] - awayFrom[0], s.p[2] - awayFrom[2]), seconds: reverse + away.seconds };
      }
    }]);
  }
  cues.push([lead + seconds, (ctx) => {
    finish(ctx);
    if (!away) ctx.drive.move({ forward: 0, strafe: 0 });
  }]);
  cues.push([lead + seconds + tail, (ctx) => {
    if (away) {
      ctx.log(`measure-away ${JSON.stringify({ trial: trial.id, driveAway: m.driveAway ?? { metres: 0, seconds: 0 } })}`);
      const metres = m.driveAway?.metres ?? 0;
      ctx.edit({ type: 'title', style: 'lower', size: 'small', text: metres >= 3 ? `and drives away: ${metres.toFixed(0)} m` : `and cannot drive away (${metres.toFixed(1)} m)`, from: ctx.t - 2.5, to: ctx.t + 0.3 });
    }
    ctx.drive.move({ forward: 0, strafe: 0 });
    if (ctx.e2e.snapshot()?.drivenVehicleId != null) ctx.drive.interact();
  }]);
  // Behind and above the car, a little to its left; held where it is once a
  // meteor or the cannonball is coming (a thrown car is not chased into a
  // wall), and then further out: close in, a car the cannonball threw 30 m
  // was a speck on the horizon behind the camera's shoulder.
  const follow = () => lastPosition(index, meta, trial);
  const hit = a && ['meteor', 'cannonball'].includes(a.kind);
  return track(follow, hit ? [-13, 7, -17] : [-5, 3.2, -9], lead + seconds + tail + 0.4, { name: trial.id, lookOffset: [0, 1, hit ? 2 : 4], lag: 0.3, cues,
    ...(hit ? { release: lead + a.at } : {}) });
}

/** Where each car was last read (the camera's target), from its slot until read. */
const positions = new Map();
function lastPosition(index, meta, trial) { return positions.get(index) ?? [trial.slot[0], 1, trial.slot[1]]; }

async function main() {
  const meta = JSON.parse(await (await fetch('file://../../structures/vehicle-lab/out/vehicle-lab.meta.json')).text());
  const trials = TRIALS.map((id) => meta.trials.find((t) => t.id === id)).filter(Boolean);
  const places = [...meta.places, ...trials.map((t, i) => ({ id: `car-${i}`, kind: 'car', position: [t.slot[0], 0, t.slot[1]], heading: t.slot[2] }))];
  const place = placeResolver(places);
  const paved = (trial) => {
    const lane = meta.lanes.find((l) => `lane/${l.id}` === trial.at);
    return lane?.paved ? 0.025 : 0;
  };
  const film = await boot({ scene: 'lab', place, settle: 2 });
  film.log(`vehicle lab: ${BUILD} x ${trials.length}: ${trials.map((t) => t.id).join(', ')}`);
  await film.play(trials.map((t, i) => trialShot(t, i, meta, paved)));
}

main().catch((error) => {
  console.log(`[film] FAILED: ${error?.stack ?? error}`);
  setTimeout(() => process.exit(1), 300);
});
