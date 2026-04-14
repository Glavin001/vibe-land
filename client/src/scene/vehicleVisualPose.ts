export const LOCAL_VEHICLE_VISUAL_SNAP_DISTANCE = 0.75;
export const LOCAL_VEHICLE_VISUAL_SNAP_VERTICAL_DISTANCE = 0.25;
export const LOCAL_VEHICLE_VISUAL_SNAP_ANGLE_RAD = 0.18;

export function shouldSnapLocalVehicleVisualPose(
  dx: number,
  dy: number,
  dz: number,
  angleDeltaRad: number,
): boolean {
  return (
    Math.hypot(dx, dy, dz) >= LOCAL_VEHICLE_VISUAL_SNAP_DISTANCE
    || Math.abs(dy) >= LOCAL_VEHICLE_VISUAL_SNAP_VERTICAL_DISTANCE
    || angleDeltaRad >= LOCAL_VEHICLE_VISUAL_SNAP_ANGLE_RAD
  );
}
