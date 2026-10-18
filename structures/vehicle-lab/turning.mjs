// The turning ground: where the monster truck is driven by a closed-loop
// driver on the player's controls alone (client/native/film/driver.mjs) --
// identified, then put through steady turns, a lane change, handbrake turns,
// a slalom, a mixed course, and meteors it must avoid
// (client/native/films/turning.mjs; scripts/turning-lab.sh MODE).
//
// Everything here is pure data and geometry: the cones build-lab.mjs puts
// into the scene, the routes the driver follows, and the parking slot of the
// car each episode uses (scripts/turning-lab.sh hands them to the server as
// VIBE_CITY_FLEET_SLOTS; one car per episode, in order).
//
// x east, z north; a heading in degrees, 0 faces +z, 90 faces +x (the fleet
// slots' convention, and atan2(fx, fz) of the car's forward vector).
import { makePath, route, smoothstep5 } from '../../client/native/film/path.mjs';
import { speedProfile } from '../../client/native/film/driver.mjs';
import { hazardsOnNominal, seeded } from '../../client/native/film/planner.mjs';

/**
 * The cones: thin loose posts, light enough that a 5 t truck knocks one over
 * without feeling it, visible when it does (structures/vehicle-lab build-lab).
 * Half extents in metres; mass from a plastic-ish density.
 */
export const CONE = { half: [0.16, 0.45, 0.16], density: 120, color: '#ff6a13', textureKey: 'brick' };

/**
 * The identification field: far east of the lanes and pads, open ground
 * (the city's slab runs to +-2000 m), slots 350 m apart so a car circling
 * at 24 m/s on full lock (~80 m radius) never meets another.
 */
const FIELD = { xs: [500, 850, 1200], zs: [-600, -200, 200, 600] };
const fieldSlot = (k) => [FIELD.xs[k % 3], FIELD.zs[Math.floor(k / 3)], 0];

/**
 * System identification: one car per episode, each a program of phases run
 * in turn by the film's driver -- open loop but for a speed hold. A phase:
 * `forward` (a key, or 'hold' to hold the episode's `speed` on the throttle
 * alone), `strafe` (a key, or { sine: amplitude, hz }), `handbrake`; it ends
 * after `seconds`, or when the forward speed reaches `untilSpeed` (from below,
 * or `untilBelow` from above), whichever first (`max` seconds at most).
 */
const P = {
  accel: (speed) => ({ name: 'accel', forward: 1, untilSpeed: speed - 0.3, max: 12 }),
  hold: (seconds) => ({ name: 'hold', forward: 'hold', seconds }),
  brakeToStop: { name: 'brake', forward: -1, untilBelow: 0.3, max: 6 },
  stop: { name: 'stop', handbrake: true, seconds: 30 },
};
/** The first run (turning-20261006-181847): steer steps at seven speeds; handbrake turns. */
export const SYSID = [
  ...[4, 7, 10, 13, 16, 20, 24].map((speed) => ({ id: `steps-${speed}`, speed, seconds: 26, program: [
    P.accel(speed), P.hold(1.5),
    { name: 'stepA', forward: 'hold', strafe: 1, seconds: 3 }, { name: 'relA', forward: 'hold', seconds: 2 },
    { name: 'stepB', forward: 'hold', strafe: -0.5, seconds: 2.5 }, { name: 'relB', forward: 'hold', seconds: 1.5 },
    { name: 'coast', seconds: 1.5 }, P.brakeToStop, P.stop,
  ] })),
  ...[[8, 1.6, true], [12, 1.6], [16, 1.6], [20, 1.6], [12, 0.7]].map(([speed, hold, reverse]) => ({
    id: `handbrake-${speed}-${hold}`, speed, seconds: reverse ? 22 : 15, program: [
      P.accel(speed), P.hold(1), { name: 'hb', strafe: 1, handbrake: true, seconds: hold }, { name: 'hbrel', seconds: 1.5 }, P.brakeToStop,
      ...(reverse ? [{ name: 'rest', handbrake: true, seconds: 1 }, { name: 'rev', forward: -1, seconds: 3 }, { name: 'revturn', strafe: 1, seconds: 1.5 }] : []), P.stop,
    ],
  })),
].map((e, k) => ({ ...e, slot: fieldSlot(k) }));

/**
 * The second run: are the pedals linear (half and quarter throttle, half and
 * quarter brake), a J-turn (flat out backwards, then full lock with and
 * without the handbrake), a handbrake turn powered out of on full lock, and
 * steering sines at 13 m/s (the model checked against what it was not fitted to).
 */
export const SYSID2 = [
  { id: 'pedals', speed: 16, seconds: 20, program: [
    { name: 'thr50', forward: 0.5, seconds: 3 }, { name: 'thr25', forward: 0.25, seconds: 2 }, P.accel(16),
    { name: 'brk50', forward: -0.5, seconds: 1 }, { name: 'coast', seconds: 1 }, { name: 'brk25', forward: -0.25, seconds: 1.5 },
    { name: 'coast2', seconds: 1 }, P.brakeToStop, P.stop] },
  { id: 'jturn-hb', speed: 8, seconds: 12, program: [
    { name: 'rev', forward: -1, seconds: 2.5 }, { name: 'jhb', strafe: 1, handbrake: true, seconds: 1.2 },
    { name: 'jout', forward: 1, seconds: 2 }, P.brakeToStop, P.stop] },
  { id: 'jturn', speed: 8, seconds: 12, program: [
    { name: 'rev', forward: -1, seconds: 2.5 }, { name: 'jlock', strafe: 1, seconds: 1.5 },
    { name: 'jout', forward: 1, strafe: 1, seconds: 2 }, P.brakeToStop, P.stop] },
  ...[[14, 0.8], [18, 1.0]].map(([speed, hold]) => ({ id: `hb-power-${speed}`, speed, seconds: 14, program: [
    P.accel(speed), P.hold(1), { name: 'hb', strafe: 1, handbrake: true, seconds: hold },
    { name: 'power', forward: 1, strafe: 1, seconds: 2 }, { name: 'straight', forward: 1, seconds: 1 }, P.brakeToStop, P.stop] })),
  { id: 'sines-13', speed: 13, seconds: 18, program: [
    P.accel(13), P.hold(1), { name: 'sine05', forward: 'hold', strafe: { sine: 0.6, hz: 0.5 }, seconds: 4 },
    { name: 'sine1', forward: 'hold', strafe: { sine: 0.8, hz: 1 }, seconds: 3 }, { name: 'sine2', forward: 'hold', strafe: { sine: 1, hz: 2 }, seconds: 2 },
    P.brakeToStop, P.stop] },
  { id: 'sines-7', speed: 7, seconds: 14, program: [
    P.accel(7), P.hold(1), { name: 'sine05', forward: 'hold', strafe: { sine: 1, hz: 0.5 }, seconds: 4 },
    { name: 'sine1', forward: 'hold', strafe: { sine: 1, hz: 1 }, seconds: 3 }, P.brakeToStop, P.stop] },
].map((e, k) => ({ ...e, slot: fieldSlot(k) }));

// ------------------------------------------------------------------ courses
//
// Inside the drawn ground (the client draws +-256 m; beyond it the slab is
// black): the slaloms west of the flat lane (x -203 to -122, kept 50 m off
// the ground's edge, which a following camera sees), the lane change, the
// cone check, the handbrake turns and the tight course south of the lanes
// (z -250 to -120), the skidpad and the figure eight north of the short lanes
// (z 130-195, between the flat lane and the street), the filmed avoidance
// runs east of the framed-house lane (x 140-205). Every course is a set
// of legs for client/native/film/driver.mjs createCourseDriver: paths to
// track at planned speeds, and handbrake turns closed-loop on the heading.
// Cones mark what it must keep clear of; a cone is hit when it is inside
// the truck's footprint (MONSTER.halfLength / halfWidth).

const deg = Math.PI / 180;
/** The truck's half width and a cone's, and the clearance aimed for (m). */
const HALF_WIDTH = 1.5, CONE_HALF = CONE.half[0];

const line = (x, z, psi, length) => route({ x, z, psi }, [{ line: length }]).points;
const track = (points, speed, extra = {}) => {
  const path = makePath(points);
  const profile = typeof speed === 'number' ? speedProfile(path, { vmax: speed, latAcc: 7.0, startSpeed: extra.startSpeed ?? null, endSpeed: extra.endSpeed ?? null, decel: 5.5 }) : speed(path);
  return { kind: 'track', path, profile, stop: !!extra.stop };
};

/**
 * Steady turns on a skidpad: a 15 m circle (inner ring of cones 3 m inside
 * it), two laps at 7, 9, 10.3 and 11.5 m/s a half lap each -- 0.33, 0.55,
 * 0.72 g, and past the 0.73 g the truck can give (it must run wide).
 */
function skidpad() {
  const R = 15, cx = -45, cz = 165;
  const r = route({ x: cx - R, z: cz - 35, psi: 0 }, [{ line: 35 }, { arc: 4 * Math.PI, R }, { line: 30 }]);
  const path = makePath(r.points);
  const half = Math.PI * R, s0 = 35;
  const segments = [7, 9, 10.3, 11.5].map((v, k) => ({ s0: s0 + k * half, s1: s0 + (k + 1) * half, speed: v, label: `${v} m/s` }));
  const profile = speedProfile(path, { vmax: 12, latAcc: 9, accel: 4, decel: 5.5, startSpeed: 0, endSpeed: 3,
    limits: [[0, s0, 7], ...segments.map((g) => [g.s0, g.s1, g.speed]), [s0 + 4 * half, path.length, 8]] });
  // The lap speeds are held across each half lap (accelerating into the next one just after its start).
  for (let i = 0; i < path.n; i += 1) {
    const g = segments.find((q) => path.s[i] >= q.s0 && path.s[i] < q.s1);
    if (g) profile[i] = g.speed;
  }
  const cones = Array.from({ length: 16 }, (_, k) => [cx + (R - 3) * Math.cos((k * Math.PI) / 8), cz + (R - 3) * Math.sin((k * Math.PI) / 8)]);
  return {
    id: 'skidpad', caption: 'Steady turns: a 15 m circle at rising speed', slot: [cx - R, cz - 35, 0], seconds: 45,
    // No slowing when off the path: the last half lap is meant to show what the truck cannot hold.
    legs: [{ kind: 'track', path, profile, stop: true, gains: { offPath: Infinity } }], cones, circle: { cx, cz, R, segments },
    camera: { watch: [cx + 14, 13, cz + 28] },
  };
}

/** A figure eight: two 12 m circles at 8.5 m/s (0.61 g), left lobe then right. */
function figureEight() {
  const R = 12, x0 = 60, z0 = 170;
  const r = route({ x: x0, z: z0 - 35, psi: 0 }, [{ line: 35 }, { arc: -2 * Math.PI, R }, { arc: 2 * Math.PI, R }, { line: 22 }]);
  const path = makePath(r.points);
  const s0 = 35, lobe = 2 * Math.PI * R;
  const profile = speedProfile(path, { vmax: 8.5, latAcc: 7.2, accel: 4, decel: 5.5, startSpeed: 0, endSpeed: 3 });
  for (let i = 0; i < path.n; i += 1) if (path.s[i] >= s0 && path.s[i] <= s0 + 2 * lobe) profile[i] = 8.5;
  const ring = (cx) => Array.from({ length: 10 }, (_, k) => [cx + (R - 3) * Math.cos((k * Math.PI) / 5), z0 + (R - 3) * Math.sin((k * Math.PI) / 5)]);
  return {
    id: 'figure-eight', caption: 'A figure eight: two 12 m circles at 31 km/h', slot: [x0, z0 - 35, 0], seconds: 40,
    legs: [{ kind: 'track', path, profile, stop: true }], cones: [...ring(x0 - R), ...ring(x0 + R)],
    circle: { segments: [{ s0, s1: s0 + lobe, label: 'left' }, { s0: s0 + lobe, s1: s0 + 2 * lobe, label: 'right' }] },
    camera: { watch: [x0 + 10, 15, z0 + 30] },
  };
}

/**
 * A lane change (ISO 3888-1's shape, the truck's width): a 4.3 m lane
 * (cones 2.15 m either side of its middle) for 15 m, over by 4 m in 25 m,
 * 20 m there, back in 25 m, and a 15 m exit lane, at `speed`.
 */
function laneChange(speed, x0 = -95, id = 'lane-change') {
  const z0 = -240, zA = -190, shift = 4, half = 2.15;
  const d = (z) => {
    if (z < zA) return 0;
    if (z < zA + 25) return shift * smoothstep5((z - zA) / 25);
    if (z < zA + 45) return shift;
    if (z < zA + 70) return shift * (1 - smoothstep5((z - zA - 45) / 25));
    return 0;
  };
  const points = [];
  for (let z = z0; z <= zA + 110; z += 1) points.push([x0 + d(z), z]);
  const legs = [track(points, (path) => speedProfile(path, { vmax: speed, latAcc: 8, accel: 5, decel: 5.5, startSpeed: 0, endSpeed: 0,
    limits: [[path.length - 20, path.length, 6]] }), { stop: true })];
  const cones = [];
  for (const [za, zb, off] of [[zA - 15, zA, 0], [zA + 25, zA + 45, shift], [zA + 70, zA + 85, 0]]) {
    for (let z = za; z <= zb + 1e-6; z += (zb - za) / 3) cones.push([x0 + off - half, z], [x0 + off + half, z]);
  }
  return {
    id, caption: `A lane change at ${Math.round(speed * 3.6)} km/h`, slot: [x0, z0, 0], seconds: 30, legs, cones,
    camera: { chase: { back: 16, up: 9, ahead: 6 } },
  };
}

/**
 * A handbrake turn: in at `speed`, full lock and the handbrake until it has
 * turned `hbAngle`, then powered round on full lock to `turn`, and out
 * through a gate on the exit line. Where the exit line lies is measured
 * (mode hb-tune, turning-20261006-184816.log; repeat runs agreed to 1 cm):
 * 90 deg from 14.5 m/s, released at 35 deg and powered round at 8 m/s,
 * ends 10.7 m on and 5.8 m over; 180 deg from 18.5 m/s, released at 60
 * deg and powered round at 6.5 m/s, 10.2 m on and 8.5 m over (the last
 * few degrees to come: 11 / 6 and 10 / 9.3 here).
 */
function handbrakeTurn({ id, x0, turn, speed, on, over, caption, maneuver, gateAt = 22 }) {
  const zT = -150, z0 = zT - 100; // zT: the trigger point, where the handbrake goes on
  const approach = track(line(x0, z0, 0, zT - z0), (path) => {
    const v = speedProfile(path, { vmax: speed, latAcc: 7, accel: 7, decel: 5, startSpeed: 0 });
    v[v.length - 1] = speed; return v;
  });
  // Exit line: heading psi0 + turn, through the measured end point.
  const psiE = turn, ex = x0 + over * Math.sign(turn), ez = zT + on;
  const exitStart = [ex - Math.sin(psiE) * 2, ez - Math.cos(psiE) * 2];
  const exit = track(line(exitStart[0], exitStart[1], psiE, gateAt + 30), (path) => speedProfile(path, { vmax: 9, latAcc: 7, accel: 5, decel: 5, endSpeed: 0 }), { stop: true });
  // A gate `gateAt` m along the exit line, 7 m wide.
  const gx = ex + Math.sin(psiE) * gateAt, gz = ez + Math.cos(psiE) * gateAt, nx = Math.cos(psiE), nz = -Math.sin(psiE);
  const cones = [[gx + nx * 3.5, gz + nz * 3.5], [gx - nx * 3.5, gz - nz * 3.5], [gx + nx * 3.5 + Math.sin(psiE), gz + nz * 3.5 + Math.cos(psiE)], [gx - nx * 3.5 + Math.sin(psiE), gz - nz * 3.5 + Math.cos(psiE)]];
  // And the trigger marked either side of the approach.
  cones.push([x0 - 4.5, zT], [x0 + 4.5, zT]);
  return {
    id, caption, slot: [x0, z0, 0], seconds: 22,
    legs: [approach, { kind: 'handbrake', turn, ...maneuver }, exit],
    cones, gate: { x: gx, z: gz, psi: psiE, half: 3.5 },
    camera: { watch: [x0 - 22 * Math.sign(turn || 1), 14, zT - 18] },
  };
}

/**
 * Slalom: seven cones on a line 24 m apart, the path past each 2.35 m to
 * alternate sides (the truck's half width, the cone's and 0.7 m), at one
 * speed per run: 0.0402 v^2 m/s^2 at the cones -- 0.33 g at 9 m/s, 0.69 g at
 * 13, past the cap at 13.5.
 */
export const SLALOM = { spacing: 24, count: 7, amplitude: HALF_WIDTH + CONE_HALF + 0.7, speeds: [10, 12, 13, 14, 15, 16] };
function slalom(speed, k) {
  const x0 = -200 + 15 * k, z0 = -240, zc = -170, { spacing, count, amplitude } = SLALOM;
  const zEnd = zc + spacing * (count - 1);
  const ramp = (z) => smoothstep5((z - (zc - spacing * 1.5)) / spacing) * (1 - smoothstep5((z - (zEnd + spacing * 0.5)) / spacing));
  const d = (z) => amplitude * Math.cos((Math.PI * (z - zc)) / spacing) * ramp(z);
  const points = [];
  for (let z = z0; z <= zEnd + 40; z += 1) points.push([x0 + d(z), z]);
  const cones = Array.from({ length: count }, (_, i) => [x0, zc + spacing * i]);
  return {
    id: `slalom-${speed}`, speed, caption: `Slalom at ${Math.round(speed * 3.6)} km/h`, slot: [x0, z0, 0], seconds: Math.ceil(30 + (zEnd + 40 - z0) / speed),
    legs: [track(points, (path) => {
      const v = speedProfile(path, { vmax: speed, latAcc: 9, accel: 5, decel: 5, startSpeed: 0, endSpeed: 0 });
      // The run's speed held through the cones (the lateral cap is the test, not the plan).
      for (let i = 0; i < path.n; i += 1) if (path.z[i] >= zc - spacing && path.z[i] <= zEnd + 6) v[i] = speed;
      return v;
    }, { stop: true })],
    cones, timing: { from: zc - spacing, to: zEnd + spacing / 2 },
    camera: { chase: { back: 18, up: 10, ahead: 8 } },
  };
}

/**
 * Tuning the handbrake turns (mode hb-tune): variants of the maneuver on the
 * identification field, each logging where its turn ends (leg-event lines),
 * two of them twice for how much a turn repeats.
 */
export const HB_TUNE = [
  [90, 14.5, 35, 8], [90, 14.5, 35, 8], [90, 14.5, 45, 7], [90, 12, 30, 7], [90, 16, 40, 8],
  [180, 18.5, 60, 6.5], [180, 18.5, 60, 6.5], [180, 18.5, 75, 6], [180, 16, 60, 6.5], [180, 18.5, 45, 7],
].map(([turnDeg, speed, hbDeg, powerSpeed], k) => {
  const ep = handbrakeTurn({ id: `hb${turnDeg}-v${speed}-a${hbDeg}-p${powerSpeed}-${k}`, x0: 0, turn: turnDeg * deg, speed, on: 10, over: 10, caption: null,
    maneuver: { hbAngle: hbDeg * deg, hbSpeed: 0, hbMax: 2, powerSpeed, lead: 0.2, handOver: 0 } });
  // Moved onto the field: everything shifted with the slot.
  const [fx, fz] = fieldSlot(k), dx = fx - ep.slot[0], dz = fz - ep.slot[1];
  const shift = (leg) => (leg.path ? { ...leg, path: makePath(Array.from({ length: leg.path.n }, (_, i) => [leg.path.x[i] + dx, leg.path.z[i] + dz]), { step: leg.path.step }) } : leg);
  return { ...ep, slot: [fx, fz, 0], legs: ep.legs.map(shift), cones: [], gate: null, seconds: 16 };
});

/**
 * A tight course mixing them, south of the lanes (x 55-165, z -250..-120):
 * four slalom cones 18 m apart at 8 m/s, a 90 degree handbrake turn right
 * from 12 m/s (released at 30 deg, round at 7 m/s: it ends 9 m on and 7.5 m
 * over, hb-tune), a lane change 3.5 m left and back at 10 m/s, a hairpin
 * round a cone on a 10 m radius, and back west through the finish gate.
 * Timed from the start to the gate.
 */
function tightCourse() {
  const x0 = 65, z0 = -245, zc = -215, sp = 18, A = SLALOM.amplitude, zT = -140;
  const ramp = (z) => smoothstep5((z - (zc - 26)) / 20) * (1 - smoothstep5((z - (zc + 3 * sp + 4)) / 14));
  const first = [];
  for (let z = z0; z <= zT; z += 1) first.push([x0 + A * Math.cos((Math.PI * (z - zc)) / sp) * ramp(z), z]);
  const approach = track(first, (path) => {
    const v = speedProfile(path, { vmax: 12, latAcc: 7, accel: 5, decel: 5 });
    for (let i = 0; i < path.n; i += 1) if (path.z[i] >= zc - sp && path.z[i] <= zc + 3 * sp + 4) v[i] = Math.min(v[i], 8);
    v[path.n - 1] = 12; return v;
  });
  // East along the exit line, the lane change, the hairpin (right, round to the west) and back.
  const zE = zT + 9.5, xE = x0 + 7.5, shift = 3.5, xL = 92;
  const d = (x) => (x < xL ? 0 : x < xL + 20 ? shift * smoothstep5((x - xL) / 20) : x < xL + 30 ? shift : x < xL + 50 ? shift * (1 - smoothstep5((x - xL - 30) / 20)) : 0);
  const east = [];
  for (let x = xE - 2; x <= 150; x += 1) east.push([x, zE + d(x)]);
  const R = 10, back = route({ x: 150, z: zE, psi: Math.PI / 2 }, [{ arc: Math.PI, R }, { line: 75 }]).points;
  const exit = track([...east, ...back.slice(1)], (path) => speedProfile(path, { vmax: 11, latAcc: 6.5, accel: 5, decel: 5.5, endSpeed: 0 }), { stop: true });
  const cones = [0, 1, 2, 3].map((i) => [x0, zc + sp * i]);
  cones.push([x0 - 4.5, zT], [x0 + 4.5, zT]);
  for (const x of [xL + 21, xL + 29]) cones.push([x, zE + shift - 2.15], [x, zE + shift + 2.15]);
  cones.push([150, zE - R]); // the hairpin's pivot
  const gate = { x: 90, z: zE - 2 * R, psi: -Math.PI / 2, half: 3.5 };
  cones.push([gate.x, gate.z - 3.5], [gate.x, gate.z + 3.5]);
  return {
    id: 'tight-course', caption: 'A tight course: slalom, handbrake turn, lane change, hairpin', slot: [x0, z0, 0], seconds: 45,
    legs: [approach, { kind: 'handbrake', turn: Math.PI / 2, hbAngle: (30 * Math.PI) / 180, hbSpeed: 0, hbMax: 2, powerSpeed: 7, lead: 0.2 }, exit],
    cones, gate, timeToGate: true, camera: { chase: { back: 16, up: 10, ahead: 6 } },
  };
}

/**
 * What counts as a hit (mode cone-check): straight through a cone at 6 m/s,
 * and past cones whose middles are 1.40, 1.55, 1.70 and 1.90 m from its
 * line -- the footprint test says the first two are hit (half width 1.5 m
 * and the cone's 0.16), the game says which it actually moved.
 */
function coneCheck() {
  const x0 = -40, z0 = -250;
  const cones = [[x0, -215], [x0 + 1.4, -200], [x0 - 1.55, -188], [x0 + 1.7, -176], [x0 - 1.9, -164]];
  return {
    id: 'cone-check', caption: 'Which cones a pass hits', slot: [x0, z0, 0], seconds: 22, cones,
    legs: [track(line(x0, z0, 0, 110), (path) => speedProfile(path, { vmax: 6, accel: 4, decel: 4, endSpeed: 0 }), { stop: true })],
    camera: { chase: { back: 12, up: 6, ahead: 6 } }, check: true,
  };
}

/** The course episodes, in film order. */
export const COURSES = [
  skidpad(), figureEight(), laneChange(14),
  handbrakeTurn({ id: 'handbrake-90', x0: -70, turn: Math.PI / 2, speed: 14.5, on: 11, over: 6, caption: 'A 90° handbrake turn from 52 km/h',
    maneuver: { hbAngle: 35 * deg, hbSpeed: 0, hbMax: 2, powerSpeed: 8, lead: 0.2 } }),
  handbrakeTurn({ id: 'handbrake-180', x0: 20, turn: Math.PI, speed: 18.5, on: 10, over: 9.3, caption: 'A 180° handbrake turn from 67 km/h',
    maneuver: { hbAngle: 60 * deg, hbSpeed: 0, hbMax: 2, powerSpeed: 6.5, lead: 0.2 } }),
  ...SLALOM.speeds.map((v, k) => slalom(v, k)),
  tightCourse(),
  coneCheck(),
];

/** Every cone in the scene (build-lab.mjs): [x, z] and the course it marks. */
export function turningCones() {
  return COURSES.flatMap((c) => c.cones.map(([x, z]) => ({ x, z, course: c.id })));
}

// ---------------------------------------------------------------- avoidance
//
// Meteors where the truck would have been: the truck cruises a straight road
// north at 14 m/s (50 km/h); rocks (the game's meteor, 2 m radius, 110 t)
// are dropped straight down onto points of the path it would have driven
// without avoiding them (planner.mjs hazardsOnNominal: the same driver on
// the model), each landing when it would have been there, give or take 2 m
// along and 1.2 m across. Known in advance: time, place, radius. Dropped
// straight down, a rock lands where it was aimed and stays there (a rock on
// the game's 0.8 slope rolls on at ~30 m/s: a moving hazard, not this one).

/**
 * One avoidance episode per seed. The filmed run is east of the lanes (x
 * 190, from z -240; the blind one at 145); the runs for the success rate side by side on the
 * identification field beyond the drawn ground (the ground is the same slab).
 */
export const AVOID = { speed: 14, length: 340, z0: 300, x0: 300, spacing: 45, film: [190, -240], first: 4, last: 16, gapMin: 1.6, gapRand: 1.6, flight: 2.74 };

/**
 * `hard`: rocks every 0.9-1.9 s instead of 1.6-3.2, up to 3 m either side of
 * the path instead of 1.2, and half of them with a second rock 6-8 m to one
 * side at the same moment (a dodge one way only, or brake).
 */
export function avoidEpisode(seed, k = 0, { reveal = Infinity, at = null, blind = false, hard = false } = {}) {
  const [x, z0] = at ?? [AVOID.x0 + AVOID.spacing * k, AVOID.z0], start = { x, z: z0, psi: 0 };
  const routePath = makePath(route(start, [{ line: AVOID.length }]).points);
  const rand = seeded(seed);
  const times = [];
  const [gapMin, gapRand] = hard ? [0.9, 1.0] : [AVOID.gapMin, AVOID.gapRand];
  for (let t = AVOID.first + rand() * 1.5; t < AVOID.last; t += gapMin + rand() * gapRand) times.push(+t.toFixed(2));
  let hazards = hazardsOnNominal(routePath, AVOID.speed, start, times, { rand, jitterSide: hard ? 3 : 1.2 });
  if (hard) hazards = hazards.flatMap((h) => (rand() < 0.5 ? [h] : [h, { ...h, x: h.x + (rand() < 0.5 ? -1 : 1) * (6 + 2 * rand()) }]));
  hazards = hazards.map((h) => ({ ...h, x: +h.x.toFixed(2), z: +h.z.toFixed(2) }));
  return {
    id: `avoid-${seed}${hard ? '-hard' : ''}${blind ? '-blind' : ''}`, seed,
    caption: blind ? `Not looking: ${hazards.length} meteors where it would be, the same road at 50 km/h` : `Meteors where it would have been: ${hazards.length}, each known in advance`,
    slot: [x, z0, 0], seconds: AVOID.last + 5, avoid: { route: routePath, speed: AVOID.speed, hazards, reveal, blind }, cones: [],
    camera: { chase: { back: 20, up: 13, ahead: 14 } },
  };
}

/** The episodes of a run (scripts/turning-lab.sh MODE). */
export function episodesFor(mode) {
  if (mode === 'sysid') return SYSID;
  if (mode === 'sysid2') return SYSID2;
  if (mode === 'hb-tune') return HB_TUNE;
  // avoid: the filmed run (seed 7); avoid-stats: seeds 1..20 for the success rate;
  // avoid-late: the same seeds, each rock known only from its launch (2.74 s before it lands).
  // avoid: the filmed run (seed 7) after the same rocks on a truck that does not look (blind, beside it).
  if (mode === 'avoid') return [avoidEpisode(7, 0, { at: [AVOID.film[0] - 45, AVOID.film[1]], blind: true }), avoidEpisode(7, 0, { at: AVOID.film })];
  if (mode === 'avoid-hard') return Array.from({ length: 20 }, (_, k) => avoidEpisode(k + 1, k, { hard: true }));
  if (mode === 'avoid-blind') return Array.from({ length: 20 }, (_, k) => avoidEpisode(k + 1, k, { blind: true }));
  if (mode === 'avoid-stats') return Array.from({ length: 20 }, (_, k) => avoidEpisode(k + 1, k));
  if (mode === 'avoid-late') return Array.from({ length: 20 }, (_, k) => avoidEpisode(k + 1, k, { reveal: AVOID.flight }));
  if (mode === 'course') return COURSES;
  if (mode === 'turns') return COURSES.filter((c) => !c.id.startsWith('slalom') && !c.check && c.id !== 'tight-course');
  if (mode === 'slalom') return COURSES.filter((c) => c.id.startsWith('slalom') || c.id === 'tight-course');
  const one = COURSES.find((c) => c.id === mode);
  if (one) return [one];
  throw new Error(`no turning run '${mode}' (sysid, sysid2, hb-tune, course, turns, slalom, avoid, avoid-stats, avoid-late, or a course id: ${COURSES.map((c) => c.id).join(', ')})`);
}

/** VIBE_CITY_FLEET_SLOTS for a run: one car per episode. */
export function slotsFor(mode) {
  return episodesFor(mode).map((e) => e.slot.map((v) => +v.toFixed(2)).join(',')).join(';');
}
