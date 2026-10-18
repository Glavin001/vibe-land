import { vehicles, vehicleById, vehicleFields } from './dune/vehicle-catalog.mjs';
import { appearanceDefaults, drivingDefaults, normalizeAppearance, normalizeDriving, drivingSetup } from './customization.mjs';
export { drivingFields } from './customization.mjs';
import { defaults } from './dune/buggy.mjs';
import { createRigDefinition } from './dune/vehicle-rig.mjs';

export { vehicles, vehicleFields };
export const CONFIGURATION_VERSION = 2;
export const GENERATOR_VERSION = 'dune-3';
export const dimensionKeys = ['wheelbase', 'track', 'tireRadius', 'cageHeight'];

export function defaultConfiguration(model = 'buggy') {
  const preset = vehicleById(model);
  if (!preset) throw new Error('Unknown vehicle model');
  return { version: CONFIGURATION_VERSION, generatorVersion: GENERATOR_VERSION,
    model, dimensions: { ...preset.parameters }, finish: preset.color,
    appearance: appearanceDefaults(preset.color), driving: {...drivingDefaults} };
}

/** Strict, canonical serialization is the contract shared by browser and server. */
export function normalizeConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a vehicle configuration');
  if (Object.keys(value).some(k => !['version', 'generatorVersion', 'model', 'dimensions', 'finish', ...(value.version === 2 ? ['appearance', 'driving'] : [])].includes(k))) throw new Error('Unknown configuration field');
  if (![1, CONFIGURATION_VERSION].includes(value.version) || value.generatorVersion !== GENERATOR_VERSION) throw new Error('Unsupported vehicle configuration version');
  if (typeof value.model !== 'string' || !vehicleById(value.model)) throw new Error('Unknown vehicle model');
  if (!value.dimensions || Object.keys(value.dimensions).length !== dimensionKeys.length || Object.keys(value.dimensions).some(k => !dimensionKeys.includes(k))) throw new Error('Expected wheelbase, track, tireRadius and cageHeight');
  const dimensions = {};
  for (const [key, label, min, max] of vehicleFields(value.model)) {
    const number = value.dimensions[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) throw new Error(`${label} must be between ${min} and ${max} metres`);
    dimensions[key] = Math.round(number * 1e6) / 1e6;
  }
  if (typeof value.finish !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.finish)) throw new Error('Expected a six-digit finish color');
  return { version: CONFIGURATION_VERSION, generatorVersion: GENERATOR_VERSION,
    model: value.model, dimensions, finish: value.finish.toLowerCase(),
    appearance: normalizeAppearance(value.version === 1 ? appearanceDefaults(value.finish) : value.appearance),
    driving: normalizeDriving(value.version === 1 ? drivingDefaults : value.driving) };
}
export const serializeConfiguration = value => JSON.stringify(normalizeConfiguration(value));
export function geometryKey(value) {
  const {generatorVersion, model, dimensions} = normalizeConfiguration(value);
  // Preserve existing geometry caches; appearance and tuning never change solids.
  return JSON.stringify({version:1, generatorVersion, model, dimensions});
}
export function modelParameters(value) {
  const c = normalizeConfiguration(value);
  return { ...defaults, ...c.dimensions, vehicle: c.model };
}
/** A proper rotation, not a reflection. Named corners are mapped explicitly. */
export const sourceToActorPoint = ([x, y, z], originHeight = 0) => [-x, y - originHeight, -z];
export const sourceCornerForWheel = ['fr', 'fl', 'rr', 'rl'];

export function resolveVehicleGeometry(value) {
  const configuration = normalizeConfiguration(value);
  const parameters = modelParameters(configuration);
  const rig = createRigDefinition(parameters);
  const originHeight = parameters.tireRadius + .25;
  const corners = sourceCornerForWheel.map(id => rig.corners[id]);
  const compression = Math.min(...corners.map(c => c.maxTravel));
  const extension = Math.min(...corners.map(c => -c.minTravel));
  if (!(compression > 0 && extension > 0)) throw new Error('Configuration has no valid suspension travel');
  return { configuration, parameters, originHeight, rig,
    wheelCenters: corners.map(c => sourceToActorPoint(c.hub, originHeight)),
    suspensionTravel: compression + extension,
    // Vehicle2 jounce is measured from droop; the source rig uses neutral travel.
    neutralJounce: extension, compression, extension,
    suspensionAttachmentY: parameters.tireRadius - originHeight + compression,
    wheelHalfWidth: .15 * (configuration.model === 'monster' ? 1.5 : 1),
    maxSteerRadians: rig.steering.maxCentreRad };
}

export function resolveDrivingSetup(value, mass = 1000) {
  const geometry = resolveVehicleGeometry(value);
  return drivingSetup(geometry.configuration, geometry, mass);
}
