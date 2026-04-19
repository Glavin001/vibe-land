import { beforeAll, describe, expect, it } from 'vitest';
import {
  getVehicleDefinition,
  getVehicleWheelConnectionOffsets,
  getVehicleSuspensionRestLengthM,
  getVehicleWheelRadiusM,
  getVehicleWheelVisualAnchors,
} from './vehicleVisualGeometry';
import {
  getSharedVehicleDefinitions,
  hydrateSharedVehicleGeometryFromLoadedWasm,
} from '../wasm/sharedPhysics';
import { initWasmForTests } from '../wasm/testInit';

describe('vehicleVisualGeometry', () => {
  beforeAll(() => {
    initWasmForTests();
    hydrateSharedVehicleGeometryFromLoadedWasm();
  });

  it('places wheel visuals at the suspension rest position below the connection point', () => {
    const anchors = getVehicleWheelVisualAnchors();
    const wheelConnectionOffsets = getVehicleWheelConnectionOffsets();
    const suspensionRestLengthM = getVehicleSuspensionRestLengthM();

    expect(anchors).toEqual(
      wheelConnectionOffsets.map(([x, y, z]) => [
        x,
        y - suspensionRestLengthM,
        z,
      ]),
    );
  });

  it('preserves x/z wheel placement while only shifting along suspension direction', () => {
    const anchors = getVehicleWheelVisualAnchors();
    const wheelConnectionOffsets = getVehicleWheelConnectionOffsets();
    const suspensionRestLengthM = getVehicleSuspensionRestLengthM();

    for (let i = 0; i < anchors.length; i += 1) {
      expect(anchors[i][0]).toBe(wheelConnectionOffsets[i][0]);
      expect(anchors[i][1]).toBe(
        wheelConnectionOffsets[i][1] - suspensionRestLengthM,
      );
      expect(anchors[i][2]).toBe(wheelConnectionOffsets[i][2]);
    }
  });

  it('reads suspension geometry from the shared WASM exports', () => {
    expect(getVehicleSuspensionRestLengthM()).toBeCloseTo(0.42);
    expect(getVehicleWheelRadiusM()).toBeCloseTo(0.35);
    const offsets = getVehicleWheelConnectionOffsets();
    const expectedOffsets = [
      [-0.9, -0.22, 1.1],
      [0.9, -0.22, 1.1],
      [-0.9, -0.22, -1.1],
      [0.9, -0.22, -1.1],
    ];
    expect(offsets).toHaveLength(expectedOffsets.length);
    for (let i = 0; i < expectedOffsets.length; i += 1) {
      expect(offsets[i][0]).toBeCloseTo(expectedOffsets[i][0]);
      expect(offsets[i][1]).toBeCloseTo(expectedOffsets[i][1]);
      expect(offsets[i][2]).toBeCloseTo(expectedOffsets[i][2]);
    }
  });

  it('hydrates both supported vehicle definitions from shared WASM data', () => {
    const definitions = getSharedVehicleDefinitions();
    expect(definitions.map((definition) => definition.key)).toEqual(['delorean', 'cybertruck']);

    const delorean = getVehicleDefinition(definitions[0].vehicleType);
    const cybertruck = getVehicleDefinition(definitions[1].vehicleType);
    expect(delorean.chassisHullVertices).not.toEqual(cybertruck.chassisHullVertices);
    expect(cybertruck.chassisHullVertices[2]?.[1]).toBeCloseTo(0.02);
    expect(cybertruck.chassisHullVertices[3]?.[2]).toBeGreaterThan(cybertruck.chassisHullVertices[4]?.[2] ?? 0);
    expect(cybertruck.chassisHullVertices[4]?.[2]).toBeGreaterThan(cybertruck.chassisHullVertices[5]?.[2] ?? 0);
    expect(cybertruck.chassisHullVertices[5]?.[2]).toBeGreaterThan(cybertruck.chassisHullVertices[6]?.[2] ?? 0);
    expect(cybertruck.chassisHullVertices[4]?.[1]).toBeGreaterThan(cybertruck.chassisHullVertices[5]?.[1] ?? 0);
    expect(cybertruck.chassisHullVertices[5]?.[1]).toBeGreaterThan(cybertruck.chassisHullVertices[6]?.[1] ?? 0);
  });
});
