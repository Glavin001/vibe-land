export type SharedVehicleDefinition = {
  vehicleType: number;
  key: string;
  name: string;
  chassisHalfExtents: { x: number; y: number; z: number };
  chassisHullVertices: [number, number, number][];
  wheelOffsets: [number, number, number][];
  suspensionRestLengthM: number;
  suspensionTravelM: number;
  wheelRadiusM: number;
};

export type SharedVehicleVisualTuningOverride = {
  suspensionRestLengthM: number;
  wheelRadiusM: number;
};

type RawSharedVehicleDefinition = {
  vehicleType?: number;
  key?: string;
  name?: string;
  chassisHalfExtents?: number[];
  chassisHullVertices?: number[][];
  wheelOffsets?: number[][];
  suspensionRestLengthM?: number;
  suspensionTravelM?: number;
  wheelRadiusM?: number;
};

const FALLBACK_SHARED_VEHICLE_DEFINITIONS: SharedVehicleDefinition[] = [
  {
    vehicleType: 0,
    key: 'delorean',
    name: 'DeLorean',
    chassisHalfExtents: { x: 0.9, y: 0.3, z: 1.8 },
    chassisHullVertices: [
      [-0.9, -0.30, -1.80],
      [-0.9, -0.30, 1.80],
      [-0.9, -0.05, 1.80],
      [-0.9, 0.10, 0.55],
      [-0.9, 0.30, 0.05],
      [-0.9, 0.30, -0.90],
      [-0.9, 0.05, -1.25],
      [-0.9, 0.05, -1.80],
      [0.9, -0.30, -1.80],
      [0.9, -0.30, 1.80],
      [0.9, -0.05, 1.80],
      [0.9, 0.10, 0.55],
      [0.9, 0.30, 0.05],
      [0.9, 0.30, -0.90],
      [0.9, 0.05, -1.25],
      [0.9, 0.05, -1.80],
    ],
    wheelOffsets: [
      [-0.9, 0.0, 1.1],
      [0.9, 0.0, 1.1],
      [-0.9, 0.0, -1.1],
      [0.9, 0.0, -1.1],
    ],
    suspensionRestLengthM: 0.3,
    suspensionTravelM: 0.2,
    wheelRadiusM: 0.35,
  },
  {
    vehicleType: 1,
    key: 'cybertruck',
    name: 'Cybertruck',
    chassisHalfExtents: { x: 0.9, y: 0.3, z: 1.8 },
    chassisHullVertices: [
      [-0.9, -0.30, -1.80],
      [-0.9, -0.30, 1.80],
      [-0.9, 0.02, 1.80],
      [-0.9, 0.18, 1.35],
      [-0.9, 0.36, 0.95],
      [-0.9, 0.31, 0.10],
      [-0.9, 0.21, -0.95],
      [-0.9, 0.10, -1.80],
      [0.9, -0.30, -1.80],
      [0.9, -0.30, 1.80],
      [0.9, 0.02, 1.80],
      [0.9, 0.18, 1.35],
      [0.9, 0.36, 0.95],
      [0.9, 0.31, 0.10],
      [0.9, 0.21, -0.95],
      [0.9, 0.10, -1.80],
    ],
    wheelOffsets: [
      [-0.9, 0.0, 1.1],
      [0.9, 0.0, 1.1],
      [-0.9, 0.0, -1.1],
      [0.9, 0.0, -1.1],
    ],
    suspensionRestLengthM: 0.3,
    suspensionTravelM: 0.2,
    wheelRadiusM: 0.35,
  },
];

export const DEFAULT_SHARED_VEHICLE_TYPE = FALLBACK_SHARED_VEHICLE_DEFINITIONS[0]?.vehicleType ?? 0;

let sharedVehicleDefinitions: SharedVehicleDefinition[] = FALLBACK_SHARED_VEHICLE_DEFINITIONS;
let sharedVehicleDefinitionByType = new Map<number, SharedVehicleDefinition>(
  sharedVehicleDefinitions.map((definition) => [definition.vehicleType, definition]),
);
let sharedVehicleVisualTuningOverride: SharedVehicleVisualTuningOverride | null = null;

function normalizeTriples(
  source: number[][] | undefined,
  fallback: [number, number, number][],
): [number, number, number][] {
  if (!Array.isArray(source) || source.length === 0) {
    return fallback;
  }
  return source.map((triple, index) => [
    triple?.[0] ?? fallback[index]?.[0] ?? 0,
    triple?.[1] ?? fallback[index]?.[1] ?? 0,
    triple?.[2] ?? fallback[index]?.[2] ?? 0,
  ]);
}

function normalizeSharedVehicleDefinition(
  raw: RawSharedVehicleDefinition,
  fallback: SharedVehicleDefinition,
): SharedVehicleDefinition {
  const halfExtents = raw.chassisHalfExtents;
  return {
    vehicleType: Math.trunc(raw.vehicleType ?? fallback.vehicleType),
    key: raw.key ?? fallback.key,
    name: raw.name ?? fallback.name,
    chassisHalfExtents: {
      x: halfExtents?.[0] ?? fallback.chassisHalfExtents.x,
      y: halfExtents?.[1] ?? fallback.chassisHalfExtents.y,
      z: halfExtents?.[2] ?? fallback.chassisHalfExtents.z,
    },
    chassisHullVertices: normalizeTriples(raw.chassisHullVertices, fallback.chassisHullVertices),
    wheelOffsets: normalizeTriples(raw.wheelOffsets, fallback.wheelOffsets),
    suspensionRestLengthM: raw.suspensionRestLengthM ?? fallback.suspensionRestLengthM,
    suspensionTravelM: raw.suspensionTravelM ?? fallback.suspensionTravelM,
    wheelRadiusM: raw.wheelRadiusM ?? fallback.wheelRadiusM,
  };
}

export function hydrateSharedVehicleDefinitions(rawDefinitions: string): void {
  try {
    const parsed = JSON.parse(rawDefinitions) as RawSharedVehicleDefinition[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return;
    }
    sharedVehicleDefinitions = parsed.map((raw, index) => normalizeSharedVehicleDefinition(
      raw,
      FALLBACK_SHARED_VEHICLE_DEFINITIONS[index] ?? FALLBACK_SHARED_VEHICLE_DEFINITIONS[0],
    ));
    sharedVehicleDefinitionByType = new Map(
      sharedVehicleDefinitions.map((definition) => [definition.vehicleType, definition]),
    );
  } catch {
    // Keep fallback definitions when the WASM payload is missing or malformed.
  }
}

export function getSharedVehicleDefinitions(): SharedVehicleDefinition[] {
  return sharedVehicleDefinitions;
}

export function getSharedVehicleDefinition(vehicleType?: number | null): SharedVehicleDefinition {
  const resolvedType = Math.trunc(vehicleType ?? DEFAULT_SHARED_VEHICLE_TYPE);
  const definition = sharedVehicleDefinitionByType.get(resolvedType)
    ?? sharedVehicleDefinitionByType.get(DEFAULT_SHARED_VEHICLE_TYPE)
    ?? FALLBACK_SHARED_VEHICLE_DEFINITIONS[0];
  if (!sharedVehicleVisualTuningOverride) {
    return definition;
  }
  return {
    ...definition,
    suspensionRestLengthM: sharedVehicleVisualTuningOverride.suspensionRestLengthM,
    wheelRadiusM: sharedVehicleVisualTuningOverride.wheelRadiusM,
  };
}

export function getSharedVehicleTypeByKey(key: string): number | null {
  const match = sharedVehicleDefinitions.find((definition) => definition.key === key);
  return match?.vehicleType ?? null;
}

export function getSharedVehicleDefaultType(): number {
  return DEFAULT_SHARED_VEHICLE_TYPE;
}

export function getSharedVehicleGeometry(): SharedVehicleDefinition {
  return getSharedVehicleDefinition(DEFAULT_SHARED_VEHICLE_TYPE);
}

export function setSharedVehicleVisualTuningOverride(
  override: SharedVehicleVisualTuningOverride | null,
): void {
  sharedVehicleVisualTuningOverride = override;
}
