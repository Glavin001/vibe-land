import {
  getSharedVehicleDefinition,
  type SharedVehicleDefinition,
} from '../wasm/sharedPhysics';

export function getVehicleDefinition(vehicleType?: number): SharedVehicleDefinition {
  return getSharedVehicleDefinition(vehicleType);
}

export function getVehicleChassisHalfExtents(vehicleType?: number): { x: number; y: number; z: number } {
  return getVehicleDefinition(vehicleType).chassisHalfExtents;
}

export function getVehicleChassisHullVertices(vehicleType?: number): [number, number, number][] {
  return getVehicleDefinition(vehicleType).chassisHullVertices;
}

export function getVehicleWheelConnectionOffsets(vehicleType?: number): [number, number, number][] {
  return getVehicleDefinition(vehicleType).wheelOffsets;
}

export function getVehicleSuspensionRestLengthM(vehicleType?: number): number {
  return getVehicleDefinition(vehicleType).suspensionRestLengthM;
}

export function getVehicleSuspensionTravelM(vehicleType?: number): number {
  return getVehicleDefinition(vehicleType).suspensionTravelM;
}

export function getVehicleWheelRadiusM(vehicleType?: number): number {
  return getVehicleDefinition(vehicleType).wheelRadiusM;
}

// The physics wheel anchor is the suspension connection point. The visual wheel
// mesh should sit at the axle center at rest: connection point plus suspension
// rest length downward along -Y.
export function getVehicleWheelVisualAnchors(vehicleType?: number): [number, number, number][] {
  const wheelOffsets = getVehicleWheelConnectionOffsets(vehicleType);
  const suspensionRestLengthM = getVehicleSuspensionRestLengthM(vehicleType);
  return wheelOffsets.map(([x, y, z]) => [
    x,
    y - suspensionRestLengthM,
    z,
  ]);
}
