import { defaultConfiguration, normalizeConfiguration, resolveVehicleGeometry, vehicleFields } from './configuration.mjs';
import { buildColliders, colliderOptions } from './dune/colliders.mjs';
import { finalizeSimpleColliders } from './dune/audit-simple-native.mjs';
import { visualOwners, groupJoints, simplePhysicsShape } from './simple-physics.mjs';
import { deriveBondSurfaces } from './bond-surfaces.mjs';
import { structuralBonds, requireConnectedAssembly } from './strength-profile.mjs';
import { vehicleFractureGroups, validateWheelOwnership } from './fracture-groups.mjs';

/** Safe, actionable diagnostics shared by the browser worker and server worker. */
export function preparationIssue(error, value) {
  if (error?.preparationIssue) return error.preparationIssue;
  const detail = error instanceof Error ? error.message : String(error);
  let code = 'geometry', message = 'The generated physics geometry could not be built.';
  if (/disconnected|unattached/.test(detail)) {
    code = 'disconnected';
    const count = detail.match(/(?:has|leave) (\d+) disconnected/)?.[1];
    message = `These dimensions leave ${count ? `${count} separate groups of` : 'some'} parts without physical connections. They can be drawn, but cannot form one vehicle.`;
    if (error.unattachedParts?.length) message += ` Unattached parts include: ${error.unattachedParts.join(', ')}.`;
  } else if (/penetrat|contact audit|half-space|stable collider|collision volume|Degenerate/.test(detail)) {
    code = 'collision';
    message = 'Some parts overlap or become too thin for valid collision shapes at these dimensions.';
  } else if (/suspension travel/.test(detail)) {
    code = 'suspension'; message = 'These dimensions leave no usable suspension travel.';
  } else if (/must be between|configuration|vehicle model|finish color/.test(detail)) {
    code = 'configuration'; message = detail;
  }
  let fields = [], recovery = 'Try restoring the preset dimensions. If the preset also fails, this is a model-generation issue.';
  try {
    const config = normalizeConfiguration(value), preset = defaultConfiguration(config.model);
    fields = vehicleFields(config.model).filter(([key]) => config.dimensions[key] !== preset.dimensions[key])
      .map(([key, label]) => ({ key, label, value: preset.dimensions[key] }));
    if (fields.length) recovery = `Restore the preset dimensions: ${fields.map(f => `${f.label.toLowerCase()} ${f.value} m`).join(', ')}.`;
    else recovery = 'These are already the preset dimensions. This is a model-generation issue; choose another model for now.';
  } catch { /* The configuration error itself explains the invalid field. */ }
  return { code, message, recovery, fields };
}

/** The exact same physical checks run before server solid generation and in a
 * cancellable browser worker. Rendering stays responsive during contact audits. */
export async function validateVehicleAssembly(value, progress = () => {}) {
  try {
    const geometry = resolveVehicleGeometry(value);
    const collision = vehicleFractureGroups(await finalizeSimpleColliders(buildColliders(geometry.parameters, colliderOptions('simple'), progress)));
    for (const part of collision.parts) for (const shape of part.shapes) simplePhysicsShape(shape);
    const interfaces = buildColliders(geometry.parameters, colliderOptions('balanced'), progress);
    validateWheelOwnership(collision.parts, interfaces.parts);
    const surfaces = deriveBondSurfaces(interfaces);
    const owners = visualOwners(collision.parts, interfaces.parts);
    const bonds = groupJoints(structuralBonds(interfaces.parts, surfaces), owners);
    requireConnectedAssembly(collision.parts, bonds);
    return { geometry, collision, surfaces, bonds };
  } catch (error) {
    const issue = preparationIssue(error, value);
    throw Object.assign(new Error(`${issue.message} ${issue.recovery}`), { preparationIssue: issue });
  }
}
