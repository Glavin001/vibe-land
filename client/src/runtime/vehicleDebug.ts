export type VehicleDebugSnapshot = {
  speedMs: number;
  groundedWheels: number;
  steering: number;
  engineForce: number;
  brake: number;
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
  wheelContactBits: number;
  suspensionLengths: [number, number, number, number];
  suspensionForces: [number, number, number, number];
  suspensionRelativeVelocities: [number, number, number, number];
  wheelHardPoints: Array<[number, number, number]>;
  wheelContactPoints: Array<[number, number, number]>;
  wheelContactNormals: Array<[number, number, number]>;
  wheelGroundObjectIds: [number, number, number, number];
};

function readVec3x4(raw: ArrayLike<number>, start: number): Array<[number, number, number]> {
  return [
    [raw[start], raw[start + 1], raw[start + 2]],
    [raw[start + 3], raw[start + 4], raw[start + 5]],
    [raw[start + 6], raw[start + 7], raw[start + 8]],
    [raw[start + 9], raw[start + 10], raw[start + 11]],
  ];
}

export function decodeVehicleDebugSnapshot(raw: ArrayLike<number> | null | undefined): VehicleDebugSnapshot | null {
  if (!raw || raw.length < 24) {
    return null;
  }
  return {
    speedMs: raw[0],
    groundedWheels: raw[1],
    steering: raw[2],
    engineForce: raw[3],
    brake: raw[4],
    linearVelocity: [raw[5], raw[6], raw[7]],
    angularVelocity: [raw[8], raw[9], raw[10]],
    wheelContactBits: raw[11],
    suspensionLengths: [raw[12], raw[13], raw[14], raw[15]],
    suspensionForces: [raw[16], raw[17], raw[18], raw[19]],
    suspensionRelativeVelocities: [raw[20], raw[21], raw[22], raw[23]],
    wheelHardPoints: raw.length >= 60 ? readVec3x4(raw, 24) : [],
    wheelContactPoints: raw.length >= 60 ? readVec3x4(raw, 36) : [],
    wheelContactNormals: raw.length >= 60 ? readVec3x4(raw, 48) : [],
    wheelGroundObjectIds: raw.length >= 64
      ? [raw[60], raw[61], raw[62], raw[63]]
      : [0, 0, 0, 0],
  };
}
