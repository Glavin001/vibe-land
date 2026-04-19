export type VehicleTuning = {
  maxSteerRad: number;
  engineForce: number;
  brakeForce: number;
  chassisMassKg: number;
  suspensionStiffness: number;
  suspensionDamping: number;
  suspensionMaxForce: number;
  suspensionRestLength: number;
  suspensionTravel: number;
  wheelRadius: number;
  frictionSlip: number;
};

export type VehicleTuningField = keyof VehicleTuning;

export const DEFAULT_VEHICLE_TUNING: VehicleTuning = Object.freeze({
  maxSteerRad: 0.5,
  engineForce: 4_000,
  brakeForce: 2_000,
  chassisMassKg: 600,
  suspensionStiffness: 80,
  suspensionDamping: 20,
  suspensionMaxForce: 6_000,
  suspensionRestLength: 0.3,
  suspensionTravel: 0.2,
  wheelRadius: 0.35,
  frictionSlip: 1.8,
});

export const VEHICLE_TUNING_FIELD_META: Record<VehicleTuningField, {
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}> = {
  maxSteerRad: { label: 'Max steer', min: 0.1, max: 1.0, step: 0.01, unit: 'rad' },
  engineForce: { label: 'Engine force', min: 1_000, max: 100_000, step: 500, unit: 'N' },
  brakeForce: { label: 'Brake force', min: 1_000, max: 50_000, step: 500, unit: 'N' },
  chassisMassKg: { label: 'Chassis mass', min: 200, max: 10_000, step: 50, unit: 'kg' },
  suspensionStiffness: { label: 'Suspension stiffness', min: 0, max: 100_000, step: 100, unit: '' },
  suspensionDamping: { label: 'Suspension damping', min: 0, max: 10_000, step: 50, unit: '' },
  suspensionMaxForce: { label: 'Suspension max force', min: 0, max: 200_000, step: 500, unit: 'N' },
  suspensionRestLength: { label: 'Suspension rest', min: 0.1, max: 1.0, step: 0.01, unit: 'm' },
  suspensionTravel: { label: 'Suspension travel', min: 0.01, max: 1.0, step: 0.01, unit: 'm' },
  wheelRadius: { label: 'Wheel radius', min: 0.1, max: 1.0, step: 0.01, unit: 'm' },
  frictionSlip: { label: 'Friction slip', min: 0.1, max: 10.0, step: 0.05, unit: '' },
};

export function clampVehicleTuningField(field: VehicleTuningField, value: number): number {
  const meta = VEHICLE_TUNING_FIELD_META[field];
  const fallback = DEFAULT_VEHICLE_TUNING[field];
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value / meta.step) * meta.step;
  return Number(Math.max(meta.min, Math.min(meta.max, rounded)).toFixed(4));
}

export function clampVehicleTuning(tuning: VehicleTuning): VehicleTuning {
  return {
    maxSteerRad: clampVehicleTuningField('maxSteerRad', tuning.maxSteerRad),
    engineForce: clampVehicleTuningField('engineForce', tuning.engineForce),
    brakeForce: clampVehicleTuningField('brakeForce', tuning.brakeForce),
    chassisMassKg: clampVehicleTuningField('chassisMassKg', tuning.chassisMassKg),
    suspensionStiffness: clampVehicleTuningField('suspensionStiffness', tuning.suspensionStiffness),
    suspensionDamping: clampVehicleTuningField('suspensionDamping', tuning.suspensionDamping),
    suspensionMaxForce: clampVehicleTuningField('suspensionMaxForce', tuning.suspensionMaxForce),
    suspensionRestLength: clampVehicleTuningField('suspensionRestLength', tuning.suspensionRestLength),
    suspensionTravel: clampVehicleTuningField('suspensionTravel', tuning.suspensionTravel),
    wheelRadius: clampVehicleTuningField('wheelRadius', tuning.wheelRadius),
    frictionSlip: clampVehicleTuningField('frictionSlip', tuning.frictionSlip),
  };
}

export function vehicleTuningFromArray(values: ArrayLike<number> | null | undefined): VehicleTuning {
  if (!values || values.length < 11) {
    return DEFAULT_VEHICLE_TUNING;
  }
  return clampVehicleTuning({
    maxSteerRad: values[0] ?? DEFAULT_VEHICLE_TUNING.maxSteerRad,
    engineForce: values[1] ?? DEFAULT_VEHICLE_TUNING.engineForce,
    brakeForce: values[2] ?? DEFAULT_VEHICLE_TUNING.brakeForce,
    chassisMassKg: values[3] ?? DEFAULT_VEHICLE_TUNING.chassisMassKg,
    suspensionStiffness: values[4] ?? DEFAULT_VEHICLE_TUNING.suspensionStiffness,
    suspensionDamping: values[5] ?? DEFAULT_VEHICLE_TUNING.suspensionDamping,
    suspensionMaxForce: values[6] ?? DEFAULT_VEHICLE_TUNING.suspensionMaxForce,
    suspensionRestLength: values[7] ?? DEFAULT_VEHICLE_TUNING.suspensionRestLength,
    suspensionTravel: values[8] ?? DEFAULT_VEHICLE_TUNING.suspensionTravel,
    wheelRadius: values[9] ?? DEFAULT_VEHICLE_TUNING.wheelRadius,
    frictionSlip: values[10] ?? DEFAULT_VEHICLE_TUNING.frictionSlip,
  });
}
