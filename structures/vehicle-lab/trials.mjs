// The vehicle test bed: what is in the scene and what is done to each car.
// The scene (build-lab.mjs) is built from LANES and PADS; both harnesses
// (server/src/vehicle_testbed.rs, the headless GPU oracle, and
// client/native/vehicle-lab.mjs in the app) read TRIALS from the meta file
// the builder writes, so neither can drift from the other. What a car must
// achieve on each trial is criteria.mjs.
//
// x east, z north; every lane runs north from START_Z, heading 0 (+z).

export const START_Z = -70;
/** Default lane length past START_Z (m). */
export const LANE_LENGTH = 160;

/**
 * Loose pieces, sized from Vibe Town's own chunks (structures/vibe-town/out,
 * 51,191 dynamic nodes, measured 2026-10-06): mass p10 2 kg, p25 15 kg,
 * median 163 kg, p75 330 kg, p90 744 kg; largest dimension p25 0.7 m, median
 * 1.0 m, p75 1.5 m. Mostly wall (18,819 nodes), siding and slab pieces, so
 * flat-ish: a brick lump, a block of wall, a slab of wall or floor. Brick at
 * the town's 1900 kg/m^3, concrete at 2400.
 */
export const DEBRIS = [
  { name: 'brick lump', half: [0.15, 0.08, 0.1], material: 'brick' },    // 0.3 m, 18 kg (p25)
  { name: 'wall block', half: [0.35, 0.15, 0.25], material: 'brick' },   // 0.7 m, 200 kg (median)
  { name: 'slab piece', half: [0.5, 0.1, 0.35], material: 'concrete' },  // 1.0 m, 336 kg (p75)
  { name: 'wall panel', half: [0.75, 0.12, 0.5], material: 'brick' },    // 1.5 m, 684 kg (p90)
];

/**
 * One obstacle per lane. Paved lanes carry Vibe Town's street surfacing
 * (destructible asphalt on a fixed subgrade), so the wheels stand on chunks
 * as they do in the town.
 */
export const LANES = [
  { id: 'flat', name: 'Flat run (top speed, acceleration)', x: -112, paved: true, length: 300, obstacle: { kind: 'none' } },
  // Steps up onto a 10 m deck and down again: a kerb (15 cm), a high kerb or
  // a loading-dock lip (30 cm), a low wall or a pile of slabs (50 cm).
  { id: 'step-15', name: 'Step 0.15 m', x: -96, obstacle: { kind: 'step', z: 0, height: 0.15, deck: 10 } },
  { id: 'step-30', name: 'Step 0.30 m', x: -80, obstacle: { kind: 'step', z: 0, height: 0.30, deck: 10 } },
  { id: 'step-50', name: 'Step 0.50 m', x: -64, obstacle: { kind: 'step', z: 0, height: 0.50, deck: 10 } },
  // Up to a 1.5 m deck at the angle, 8 m of deck, down at the same angle.
  { id: 'ramp-10', name: 'Ramp 10 degrees', x: -48, obstacle: { kind: 'ramp', z: 0, angle: 10, height: 1.5, deck: 8 } },
  { id: 'ramp-20', name: 'Ramp 20 degrees', x: -32, obstacle: { kind: 'ramp', z: 0, angle: 20, height: 1.5, deck: 8 } },
  { id: 'ramp-30', name: 'Ramp 30 degrees', x: -16, obstacle: { kind: 'ramp', z: 0, angle: 30, height: 1.5, deck: 8 } },
  // 36 loose pieces over 30 m of street: rubble a blast leaves on a road.
  { id: 'debris', name: 'Debris field', x: 0, paved: true, obstacle: { kind: 'debris', z: 0, length: 30, count: 36, seed: 7 } },
  // A heap of wall blocks and slabs about 1 m high, 4.5 m across.
  { id: 'rubble', name: 'Rubble pile', x: 16, paved: true, obstacle: { kind: 'pile', z: 6, height: 1.0, radius: 2.6, seed: 11 } },
  // A free-standing masonry wall: 7 m wide, 2.5 m tall, one block (0.25 m)
  // thick, blocks 0.5 x 0.5 m; a garden or boundary wall of the town's brick.
  { id: 'wall', name: 'Masonry wall', x: 32, paved: true, length: 120, obstacle: { kind: 'wall', z: 20, width: 7, height: 2.5, thickness: 0.25, block: [0.5, 0.5] } },
  // Elm Park's one-storey house (house-1story, 89 t), its 10 m side across the lane.
  { id: 'house', name: 'One-storey house', x: 56, paved: true, length: 120, obstacle: { kind: 'house', z: 24 } },
  // Vibe Town's North Street where the chase runs (structures/vibe-town:
  // house fronts 10.3 m from the road's centre, a one-storey house on one
  // side and a two-storey house on the other), for the near miss.
  { id: 'street', name: 'Town street between two houses', x: 88, paved: true, length: 120,
    obstacle: { kind: 'street', z: 0, setback: 10.3, houses: [{ side: -1, file: 'house-1story.json' }, { side: 1, file: 'house-2story.json' }] } },
];

/** Open pads, far from the lanes and each other (a meteor's blast and debris stay on its pad). */
export const PADS = [
  { id: 'rest', name: 'Rest pad', x: 110, z: -120 },
  { id: 'drift', name: 'Handbrake pad', x: 150, z: 20 },
  { id: 'cannonball', name: 'Cannonball pad', x: 200, z: -150 },
  { id: 'meteor', name: 'Meteor pad', x: -190, z: 170 },
];

const lane = (id) => LANES.find((l) => l.id === id);
const pad = (id) => PADS.find((p) => p.id === id);

/**
 * What is done to the car in each trial. `at`: the lane or pad it starts on.
 * `drive`: how it is driven --
 *   park                      nobody in it
 *   floor                     full throttle, steering straight
 *   cruise { speed }          throttle while under `speed` (m/s), straight
 *   drift { speed, seconds }  cruise to `speed`, then full lock and handbrake for `seconds`
 * `start`: the z the car starts at (lanes; default START_Z). `goal`: a z the
 * car must pass. `seconds`: how long the trial runs.
 * `attack`: the city cannonball or the city meteor at the parked car.
 * `driveAway`: seconds of full throttle after the trial (still drivable?),
 * reversing first for `reverse` seconds when it has hit something ahead.
 */
export const TRIALS = [
  { id: 'rest', at: 'pad/rest', drive: { kind: 'park' }, seconds: 10,
    why: 'a parked car carries only its own weight: nothing may break' },
  { id: 'accel', at: 'lane/flat', drive: { kind: 'floor' }, seconds: 12, goal: 225,
    why: 'acceleration and top speed on a flat paved street' },
  ...['step-15', 'step-30', 'step-50'].map((id) => ({ id, at: `lane/${id}`, start: -25, drive: { kind: 'cruise', speed: 6 }, seconds: 10, goal: lane(id).obstacle.deck + 8,
    why: `a ${lane(id).obstacle.height * 100} cm step up and down at 22 km/h` })),
  ...['ramp-10', 'ramp-20', 'ramp-30'].map((id) => ({ id, at: `lane/${id}`, start: -30, drive: { kind: 'cruise', speed: 8 }, seconds: 12,
    goal: (() => { const o = lane(id).obstacle; return 2 * o.height / Math.tan((o.angle * Math.PI) / 180) + o.deck + 6; })(),
    why: `climbing a ${lane(id).obstacle.angle} degree ramp to 1.5 m and down the other side, at up to 29 km/h` })),
  { id: 'debris', at: 'lane/debris', start: -30, drive: { kind: 'cruise', speed: 10 }, seconds: 10, goal: 40,
    why: 'through 30 m of loose rubble on a street at 36 km/h' },
  { id: 'debris-fast', at: 'lane/debris', start: -50, drive: { kind: 'floor' }, seconds: 7, goal: 40,
    why: 'floored into 30 m of loose rubble from 50 m out (about 20 m/s at the first pieces), as a player drives through what a blast left' },
  { id: 'rubble', at: 'lane/rubble', start: -20, drive: { kind: 'cruise', speed: 6 }, seconds: 10, goal: 16,
    why: 'over a 1 m heap of wall blocks and slabs at 22 km/h' },
  { id: 'wall', at: 'lane/wall', start: -30, drive: { kind: 'floor' }, seconds: 8, impactZ: 20, driveAway: { reverse: 1.5, seconds: 3 },
    why: 'floored from 50 m out (a Vibe Town street is 48 m from the next) into a masonry wall: the wall breaks, the car is damaged and drives on' },
  { id: 'house', at: 'lane/house', start: -30, drive: { kind: 'floor' }, seconds: 8, impactZ: 20, driveAway: { reverse: 1.5, seconds: 3 },
    why: 'floored from 50 m out into a one-storey house' },
  // The chase's near miss (client/native/films/chase-shots.mjs, the
  // 2026-10-06 trailer take where the truck stopped dead with its ride height
  // down from 1.1 m to 0.55 m): a meteor into each house's street-facing wall
  // at half its height, in low (slope 0.25) from across the street, landing
  // as the truck passes 4 m beyond them at full throttle.
  { id: 'near-miss', at: 'lane/street', start: -40, drive: { kind: 'floor' }, seconds: 7, goal: 40,
    attack: { kind: 'strikes', carZ: 4, flight: 1.0, slope: 0.25 },
    why: 'meteors into the houses either side of the street as the truck passes at full throttle: it drives on through the debris' },
  // The 2026-10-06 trailer take itself (target/native-video/trailer-20261006-035206.log),
  // headless in Vibe Town: the monster truck from fleet slot car-10 floored
  // east along North Street, weaving from 3.3 s, and the film's first four
  // pairs of strikes into the houses either side, launched when the film
  // launched them (2.74 s flights, slope 0.25). In the film it stopped dead
  // 3.3 s in, its ride height 1.09 -> 0.55 m, right after the first pair
  // landed 4 m behind it. Times from the throttle (film 31.1 s).
  { id: 'town-chase', scene: 'town', at: 'slot/-144,46,90', seconds: 8, goalProgress: 120,
    drive: { kind: 'script', events: [[0, 1, 0], [3.3, 1, 0.45], [3.8, 1, -0.5], [4.4, 1, 0.5], [4.9, 1, -0.45], [5.5, 1, 0.4], [6.0, 1, -0.4], [6.6, 1, 0]] },
    attack: { kind: 'timeline', strikes: [
      { t: 0.3, target: [-117, 2.3, 36.2], from: 0, slope: 0.25, flight: 2.73 }, { t: 0.3, target: [-117, 3.9, 59.8], from: 180, slope: 0.25, flight: 2.73 },
      { t: 1.1, target: [-100, 3.9, 36.2], from: 0, slope: 0.25, flight: 2.77 }, { t: 1.1, target: [-100, 2.3, 59.8], from: 180, slope: 0.25, flight: 2.77 },
      { t: 2.6, target: [-68, 3.9, 36.2], from: 0, slope: 0.25, flight: 2.70 }, { t: 2.6, target: [-68, 3.9, 59.8], from: 180, slope: 0.25, flight: 2.70 },
      { t: 3.3, target: [-51, 2.3, 36.2], from: 0, slope: 0.25, flight: 2.70 }, { t: 3.3, target: [-51, 3.9, 59.8], from: 180, slope: 0.25, flight: 2.70 },
    ] },
    why: 'the chase that stopped the truck: blasts either side of the street as it passes at full throttle' },
  // Meteors landing near the truck as it drives (the chase: ride height
  // 1.09 -> 0.5-0.7 m within 1-3 s of meteors landing 4-10 m from it). As
  // the film's strikeNear: aimed where the car will be after the flight,
  // `ahead` metres along its heading and `side` to its right, at `height`,
  // coming in from compass bearing `from` (0: from ahead of a car heading
  // north) at `slope` (the game's 0.8, the chase's 0.25). None of these hits
  // the truck: each lands beside, ahead of or past it, or flies over it, the
  // way the chase's rocks crossed North Street into the houses.
  //   blast-beside   from ahead, landing 6 m to its right: the rock runs back down its side
  //   blast-ahead    from its right, landing 8 m ahead: it drives into the crater and the rock's wake
  //   blast-over     from its left, low (0.25), 3 m up 8 m to its right: over the cab, ~0.5 m clear
  ...[['blast-beside', 0, 6, 0.8, 0, 0.8], ['blast-ahead', 8, 0, 0.8, 90, 0.8], ['blast-over', 0, 8, 3.0, 270, 0.25]].map(([id, ahead, side, height, from, slope]) => ({
    id, at: 'lane/flat', start: -100, drive: { kind: 'cruise', speed: 18 }, seconds: 7, goal: 0,
    attack: { kind: 'near', at: 2.0, ahead, side, height, from, flight: 1.0, slope },
    why: `a meteor misses the truck at 65 km/h (${id.slice(6)}): it keeps its wheels and ride height and drives on`,
  })),
  // The chase's last near miss, measured in the app (client/native/chase-probe.mjs,
  // three lockstep takes, 2026-10-06): a rock crossing North Street into a
  // house grazed the truck's cab at 25 m/s; windscreen, side windows, pillars
  // and cage members broke -- and in the same tick both wheels on the far
  // side came off (wheel mask 15 -> 10) and the ride height fell 1.10 ->
  // 0.97 m. A graze of the roof should cost the roof, not the wheels.
  ...[['graze-cab', 0.3], ['graze-cab-deep', 0.6]].map(([id, clip]) => ({
    id, at: 'lane/flat', start: -100, drive: { kind: 'cruise', speed: 18 }, seconds: 7, goal: 0,
    attack: { kind: 'near', at: 2.0, ahead: 0, side: 8, clip, from: 270, flight: 1.0, slope: 0.25 },
    why: `a meteor crossing low over the truck at 65 km/h clips its roof by ${clip * 100} cm: the cab is damaged, the wheels stay on and it drives on`,
  })),
  // A blast's debris thrown at the truck as it drives: a 700 kg wall panel
  // (Vibe Town's p90 chunk, as a ball of the same mass) at 15 m/s, into a
  // front wheel from the side and into the cab side.
  ...[['debris-wheel', 0], ['debris-cab', null]].map(([id, aim]) => ({
    id, at: 'lane/flat', start: -100, drive: { kind: 'cruise', speed: 15 }, seconds: 6, goal: -20,
    attack: { kind: 'debris', at: 2.0, mass: 700, radius: 0.55, speed: 15, from: 90, aim },
    why: `a 700 kg piece of a house at 15 m/s into the truck's ${aim == null ? 'cab' : 'front wheel'} from the side: dented, keeps its wheels, drives on`,
  })),
  // A light part knocked off a parked car (a 150 kg lump at 25 m/s into a
  // door mirror): what is left must sit as high as before (2026-10-06: a
  // lost 5 kg mirror left the monster truck 13 cm lower, its springs
  // carrying twice its weight).
  { id: 'knock-mirror', at: 'pad/rest', drive: { kind: 'park' }, seconds: 5,
    attack: { kind: 'debris', at: 1.0, mass: 150, radius: 0.25, speed: 25, from: 90, aimPart: 'Door mirror' },
    why: 'losing a mirror does not lower the car' },
  // Floored for 5 s, then let go: what it loses to its tyres and the air
  // over the next 5 s (with no pedal Vehicle2's direct drive coasts free).
  { id: 'coast', at: 'lane/flat', start: -140, drive: { kind: 'script', events: [[0, 1, 0], [5, 0, 0]] }, seconds: 10.5,
    why: 'let go of at speed, a car slows: rolling resistance and drag, 0.3-1.2 m/s^2' },
  { id: 'knock-mirror-driving', at: 'lane/flat', start: -100, drive: { kind: 'cruise', speed: 15 }, seconds: 6, goal: -20,
    attack: { kind: 'debris', at: 2.0, mass: 150, radius: 0.25, speed: 25, from: 90, aimPart: 'Door mirror' },
    why: 'losing a mirror at 54 km/h does not lower the car' },
  // Shots at the house (lane/house: front wall z 20.1, back wall 27.9, x 56):
  // the game's cannonball (10.65 t at 60 m/s) and meteor (110 t at 140 m/s)
  // square into the front wall, a window's width off its middle. The car
  // parks out of the way, on the rest pad.
  { id: 'cannonball-house', at: 'pad/rest', drive: { kind: 'park' }, seconds: 4,
    attack: { kind: 'shot', projectile: 'cannonball', at: 0.5, target: [54, 1.4, 20.1], from: 180, slope: 0.02, distance: 30 },
    why: 'a cannonball through a house: in at the front, on through it' },
  // As heavy and as fast as the monster truck flat out (VIBE_CITY_BALL_MASS_KG
  // / _SPEED_MS set by the run): a plain body where the truck is a Vehicle2 carrier.
  { id: 'truck-ball-house', at: 'pad/rest', drive: { kind: 'park' }, seconds: 4,
    attack: { kind: 'shot', projectile: 'cannonball', at: 0.5, target: [56, 1.2, 20.1], from: 180, slope: 0.0, distance: 12 },
    why: 'what the truck would do to the house if it were a plain rigid body' },
  { id: 'meteor-house', at: 'pad/rest', drive: { kind: 'park' }, seconds: 5,
    attack: { kind: 'shot', projectile: 'meteor', at: 0.5, target: [56, 2.0, 20.1], from: 180, slope: 0.3, distance: 140 },
    why: 'a meteor through a house: it goes through, and the house comes down' },
  { id: 'cannonball', at: 'pad/cannonball', drive: { kind: 'park' }, seconds: 6, attack: { kind: 'cannonball', at: 1 }, driveAway: { seconds: 3 },
    why: "the city cannonball into the parked car's side at body height: partly destroyed, still drivable" },
  { id: 'meteor', at: 'pad/meteor', drive: { kind: 'park' }, seconds: 8, attack: { kind: 'meteor', at: 1 },
    why: "the city meteor on the parked car: very destroyed" },
  { id: 'drift', at: 'pad/drift', drive: { kind: 'drift', speed: 15, seconds: 1.2 }, seconds: 8,
    why: 'a handbrake turn from 54 km/h: yaw rate, slip angle and speed kept, against today' },
];

/** Where a trial's car parks: [x, z, heading degrees] (VIBE_CITY_FLEET_SLOTS order). */
export function slotOf(trial) {
  const [kind, id] = trial.at.split('/');
  if (kind === 'slot') return id.split(',').map(Number);
  if (kind === 'lane') return [lane(id).x, trial.start ?? START_Z, 0];
  const p = pad(id);
  return [p.x, p.z, 0];
}
