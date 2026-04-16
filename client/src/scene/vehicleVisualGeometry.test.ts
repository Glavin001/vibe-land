import { beforeAll, describe, expect, it } from 'vitest';
import {
  getVehicleWheelConnectionOffsets,
  getVehicleSuspensionRestLengthM,
  getVehicleWheelRadiusM,
  getVehicleWheelVisualAnchors,
} from './vehicleVisualGeometry';
import { hydrateSharedVehicleGeometryFromLoadedWasm } from '../wasm/sharedPhysics';
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
    expect(getVehicleSuspensionRestLengthM()).toBeCloseTo(0.3);
    expect(getVehicleWheelRadiusM()).toBeCloseTo(0.35);
    const offsets = getVehicleWheelConnectionOffsets();
    const expectedOffsets = [
      [-0.9, 0.0, 1.1],
      [0.9, 0.0, 1.1],
      [-0.9, 0.0, -1.1],
      [0.9, 0.0, -1.1],
    ];
    expect(offsets).toHaveLength(expectedOffsets.length);
    for (let i = 0; i < expectedOffsets.length; i += 1) {
      expect(offsets[i][0]).toBeCloseTo(expectedOffsets[i][0]);
      expect(offsets[i][1]).toBeCloseTo(expectedOffsets[i][1]);
      expect(offsets[i][2]).toBeCloseTo(expectedOffsets[i][2]);
    }
  });
});
