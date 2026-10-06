/** Real-world grounding for the vehicle builds.
 *
 * Every number that shapes how a car drives, carries load and breaks is
 * compared with what the real class of vehicle or material has. A value
 * outside its range is either a finding (fix the authoring) or a declared
 * concession below, with how far it departs and why. Tuning then happens
 * inside these ranges, or by adding a concession someone can weigh.
 *
 *   node scripts/vehicle-reality.mjs [fixtures.json]   (exit 1 on a finding)
 */
import { jointMaterials } from './strength-profile.mjs';

/** Per model class: the real vehicle each build stands for. Ranges are
 * [low, high]; `note` is where the range comes from. */
export const classes = {
  buggy:   { real: 'Two-seat sand rail', massKg: [700, 1300], wheelKg: [15, 40], topSpeed: [25, 45], accel: [3, 7], travelM: [0.40, 0.65], travelNote: 'sand rails 16-26 in of wheel travel',
    note: 'VW/LS-powered sand rails 700-1300 kg; 30-33 in paddle/knobby tyre on aluminium wheel 15-40 kg; 0-100 km/h 4-9 s' },
  trophy:  { real: 'Trophy truck (Baja)', massKg: [2700, 3300], wheelKg: [55, 95], topSpeed: [40, 60], accel: [3, 7], travelM: [0.60, 0.90], travelNote: 'trophy trucks 24-36 in',
    note: 'Class TT ~2700-3200 kg; 39-40 in tyre ~50 kg plus beadlock wheel; 0-100 km/h 4-9 s' },
  rally:   { real: 'Rally2 hatchback', massKg: [1230, 1450], wheelKg: [15, 25], topSpeed: [45, 55], accel: [5, 8], travelM: [0.20, 0.30], travelNote: 'Rally2 gravel 200-300 mm',
    note: 'Rally2 minimum 1230 kg; gravel wheel and tyre 15-25 kg; 0-100 km/h 3.5-5.5 s' },
  monster: { real: 'Monster Jam truck', massKg: [4500, 5500], wheelKg: [280, 360], topSpeed: [25, 32], accel: [3, 8], travelM: [0.60, 0.80], travelNote: 'Monster Jam 26-30 in',
    note: 'Monster Jam ~5400 kg; 66 in BKT tyre ~290 kg plus wheel; tops ~30 m/s' },
  derby:   { real: 'Stripped full-size sedan (demolition derby)', massKg: [1500, 2000], wheelKg: [15, 25], topSpeed: [40, 55], accel: [2.5, 5], travelM: [0.15, 0.25], travelNote: 'road sedan 6-10 in',
    note: 'body-on-frame sedans 1600-2000 kg stripped; steel wheel and tyre 15-25 kg' },
  sprint:  { real: '410 winged sprint car', massKg: [600, 700], wheelKg: [10, 25], topSpeed: [55, 70], accel: [7, 11], travelM: [0.08, 0.16], travelNote: 'sprint car torsion bars 3-6 in',
    note: 'minimum ~650 kg with driver; 0-100 km/h under 3 s' },
};

/** Ranges every car shares. */
export const common = {
  rideHz:  { range: [0.9, 2.5], note: 'sprung natural frequency: road cars 1-1.5 Hz, race and off-road up to ~2.5 Hz' },
  grip:    { range: [0.6, 1.3], note: 'tyre-road friction: road tyres 0.7-1.0 on dry asphalt, dirt 0.5-0.8, racing slicks up to ~1.3' },
  brakeG:  { range: [0.5, 1.3], note: 'deceleration the brake torque can command, in g (grip-limited in reality)' },
  sagFraction: { range: [0.2, 0.45], note: 'static sag as a share of wheel travel: off-road 25-35%, road and race 20-40%; more leaves too little bump travel and the car bottoms out on its limit' },
};

/** Joint limits (strength-profile.mjs) against the materials they stand for.
 * Fatal is an effective joint stress: parent-metal strength times a joint
 * efficiency (welds, bolts, adhesive) of roughly 0.4-0.9. */
export const jointReferences = {
  steel:      { fatalMPa: [180, 450], modulusMPa: [190000, 210000], note: 'mild/structural steel UTS 400-550 MPa x joint efficiency' },
  stud:       { fatalMPa: [800, 1220], modulusMPa: [190000, 215000], note: 'wheel studs, ISO 898-1 property class 8.8 (UTS 800 MPa) to 12.9 (1220 MPa)' },
  alloy:      { fatalMPa: [110, 270], modulusMPa: [68000, 72000], note: '6061-T6 UTS ~310 MPa x joint efficiency' },
  rubber:     { fatalMPa: [8, 30], modulusMPa: [1, 20], note: 'vulcanised rubber UTS 15-30 MPa; modulus 1-10 MPa (reinforced up to ~20)' },
  composite:  { fatalMPa: [20, 200], modulusMPa: [2000, 40000], note: 'glass/carbon FRP and moulded shells, bonded or bolted' },
  glazing:    { fatalMPa: [20, 120], modulusMPa: [65000, 75000], note: 'laminated/tempered automotive glass flexural 40-120 MPa' },
  belt:       { fatalMPa: [30, 120], modulusMPa: [1000, 5000], note: 'polyester webbing' },
  upholstery: { fatalMPa: [0.1, 2], modulusMPa: [0.5, 10], note: 'foam and fabric' },
};

/** Deliberate departures from reality, each with its reason. A departure not
 * listed here is a finding. `builds` is a list of build ids or '*'. */
export const concessions = [
  { builds: '*', metric: 'grip', reason: 'game handling: drivingDefaults.grip 1.4 and edition grips up to 1.6, above road tyres, so cars corner and launch like the arcade handling the garage tunes against' },
];

const within = (v, [lo, hi]) => v >= lo && v <= hi;
function row(metric, value, range, note, id) {
  const ok = within(value, range);
  const conceded = !ok && concessions.find(c => c.metric === metric && (c.builds === '*' || c.builds.includes(id)));
  const factor = ok ? 1 : value < range[0] ? value / range[0] : value / range[1];
  return { metric, value, range, factor, status: ok ? 'ok' : conceded ? 'concession' : 'finding', note: conceded ? conceded.reason : note };
}

/** Grounding rows for one prepared build (metadata.json + driving setup). */
export function auditBuild(id, model, metadata, driving) {
  const c = classes[model];
  if (!c) throw new Error(`No real-world class for model ${model}`);
  const wheels = metadata.parts.filter(p => /wheel assembly$/.test(p.name));
  const wheelKg = wheels.reduce((n, p) => n + p.mass, 0) / Math.max(1, wheels.length);
  const corner = metadata.mass / 4;
  const tireRadius = metadata.dimensions?.tireRadius ?? 0.4;
  return [
    row('massKg', metadata.mass, c.massKg, c.note, id),
    row('wheelKg', wheelKg, c.wheelKg, c.note, id),
    row('topSpeed', driving.topSpeed, c.topSpeed, c.note, id),
    row('accel', driving.acceleration, c.accel, c.note, id),
    row('rideHz', Math.sqrt(driving.springStiffness / corner) / (2 * Math.PI), common.rideHz.range, common.rideHz.note, id),
    row('grip', driving.tyreFriction, common.grip.range, common.grip.note, id),
    row('brakeG', 4 * driving.brakeTorque / tireRadius / metadata.mass / 9.81, common.brakeG.range, common.brakeG.note, id),
    row('travelM', metadata.suspensionTravel, c.travelM, c.travelNote, id),
    row('sagFraction', corner * 9.81 / driving.springStiffness / metadata.suspensionTravel, common.sagFraction.range, common.sagFraction.note, id),
  ];
}

/** Joint limits against their materials (build-independent). */
export function auditJoints() {
  return Object.entries(jointMaterials).map(([name, p]) => {
    const r = jointReferences[name];
    if (!r) return { metric: `${name} joint`, status: 'finding', note: 'no real-world reference' };
    return [row(`${name}.fatalMPa`, p.tensionFatal / 1e6, r.fatalMPa, r.note, '-'), row(`${name}.modulusMPa`, p.elasticModulus / 1e6, r.modulusMPa, r.note, '-')];
  }).flat();
}
