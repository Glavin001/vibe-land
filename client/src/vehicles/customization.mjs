/** Serializable tuning in physical units. Shared by workshop and asset worker. */
export const drivingDefaults = Object.freeze({
  acceleration: 7.5, topSpeed: 30, grip: 1.4, braking: 1,
  springRate: 1, dampingRatio: 1, steeringResponse: 1, steeringLimit: 1, drivetrain: 'awd',
});
export const drivingFields = [
  ['acceleration', 'Acceleration', 3, 9, .25, 'm/s²'],
  ['topSpeed', 'Top speed', 12, 36, 1, 'm/s'],
  ['grip', 'Tire grip', .8, 1.6, .05, '×'],
  ['braking', 'Brake strength', .7, 1.3, .05, '×'],
  ['springRate', 'Spring firmness', .8, 1.4, .05, '×'],
  ['dampingRatio', 'Shock damping', .7, 1.3, .05, '×'],
  ['steeringResponse', 'Steering response', .6, 1.4, .05, '×'],
  ['steeringLimit', 'Steering lock', .65, 1, .05, '×'],
];
export const appearanceDefaults = finish => ({body: finish, accent: '#f36b29', wheels: '#b0afa4', seats: '#242729', paint: 'satin'});

function record(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw Error(`Expected ${label}: ${keys.join(', ')}`);
}
export function normalizeAppearance(value) {
  record(value, ['body','accent','wheels','seats','paint'], 'appearance');
  const result = {};
  for (const key of ['body','accent','wheels','seats']) {
    if (typeof value[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value[key])) throw Error(`Expected a six-digit ${key} color`);
    result[key] = value[key].toLowerCase();
  }
  if (!['matte','satin','gloss'].includes(value.paint)) throw Error('Unknown paint finish');
  return {...result, paint:value.paint};
}
export function normalizeDriving(value) {
  record(value, [...drivingFields.map(f => f[0]), 'drivetrain'], 'driving settings');
  const result = {};
  for (const [key,label,min,max] of drivingFields) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < min || value[key] > max) throw Error(`${label} must be between ${min} and ${max}`);
    result[key] = Math.round(value[key] * 1e6) / 1e6;
  }
  if (!['awd','fwd','rwd'].includes(value.drivetrain)) throw Error('Choose AWD, FWD or RWD');
  return {...result, drivetrain:value.drivetrain};
}

/** Limits drive force to 80% of the driven axle(s)' static friction budget.
 * Springs retain positive droop/compression inside the authored linkage range.
 * This is an initial setup, not a guarantee against rollover or wheelspin. */
export function drivingSetup(configuration, geometry, mass) {
  const tune = normalizeDriving(configuration.driving);
  if (!Number.isFinite(mass) || mass <= 0) throw Error('Vehicle mass must be positive');
  const drivenWheels = tune.drivetrain === 'awd' ? 4 : 2;
  const acceleration = Math.min(tune.acceleration, .8 * tune.grip * 9.81 * drivenWheels / 4);
  const cornerMass = mass / 4;
  const springStiffness = cornerMass * 9.81 / geometry.neutralJounce * tune.springRate;
  const damping = 2 * Math.sqrt(springStiffness * cornerMass) * tune.dampingRatio;
  return {
    acceleration, driveTorque: mass * acceleration * configuration.dimensions.tireRadius / drivenWheels,
    brakeTorque: mass / 600 * 900 * tune.braking,
    springStiffness, damping, tyreFriction:tune.grip, topSpeed:tune.topSpeed,
    maxSteerRadians:geometry.maxSteerRadians * tune.steeringLimit,
    frontWheelDrive:tune.drivetrain === 'fwd', rearWheelDrive:tune.drivetrain === 'rwd', steeringResponse:tune.steeringResponse,
  };
}
