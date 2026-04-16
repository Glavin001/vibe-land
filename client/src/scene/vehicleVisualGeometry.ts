import { getSharedVehicleGeometry } from '../wasm/sharedPhysics';

export function getVehicleChassisHalfExtents(): { x: number; y: number; z: number } {
  return getSharedVehicleGeometry().chassisHalfExtents;
}

export function getVehicleWheelConnectionOffsets(): [number, number, number][] {
  return getSharedVehicleGeometry().wheelOffsets;
}

export function getVehicleSuspensionRestLengthM(): number {
  return getSharedVehicleGeometry().suspensionRestLengthM;
}

export function getVehicleWheelRadiusM(): number {
  return getSharedVehicleGeometry().wheelRadiusM;
}

// The physics wheel anchor is the suspension connection point. The visual wheel
// mesh should sit at the axle center at rest: connection point plus suspension
// rest length downward along -Y.
export function getVehicleWheelVisualAnchors(): [number, number, number][] {
  const wheelOffsets = getVehicleWheelConnectionOffsets();
  const suspensionRestLengthM = getVehicleSuspensionRestLengthM();
  return wheelOffsets.map(([x, y, z]) => [
    x,
    y - suspensionRestLengthM,
    z,
  ]);
}
