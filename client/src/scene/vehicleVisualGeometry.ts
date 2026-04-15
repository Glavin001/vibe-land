export const VEHICLE_CHASSIS_HALF_EXTENTS = { x: 0.9, y: 0.3, z: 1.8 } as const;
export const VEHICLE_WHEEL_CONNECTION_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [-0.9, -0.3, 1.1],
  [0.9, -0.3, 1.1],
  [-0.9, -0.3, -1.1],
  [0.9, -0.3, -1.1],
] as const;
export const VEHICLE_SUSPENSION_REST_LENGTH_M = 0.42;
export const VEHICLE_WHEEL_RADIUS_M = 0.35;

// The physics wheel anchor is the suspension connection point. The visual wheel
// mesh should sit at the axle center at rest: connection point plus suspension
// rest length downward along -Y.
export function getVehicleWheelVisualAnchors(): [number, number, number][] {
  return VEHICLE_WHEEL_CONNECTION_OFFSETS.map(([x, y, z]) => [
    x,
    y - VEHICLE_SUSPENSION_REST_LENGTH_M,
    z,
  ]);
}
