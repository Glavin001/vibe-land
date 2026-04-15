import { describe, expect, it } from 'vitest';
import {
  VEHICLE_WHEEL_CONNECTION_OFFSETS,
  VEHICLE_SUSPENSION_REST_LENGTH_M,
  getVehicleWheelVisualAnchors,
} from './vehicleVisualGeometry';

describe('vehicleVisualGeometry', () => {
  it('places wheel visuals at the suspension rest position below the connection point', () => {
    const anchors = getVehicleWheelVisualAnchors();

    expect(anchors).toEqual(
      VEHICLE_WHEEL_CONNECTION_OFFSETS.map(([x, y, z]) => [
        x,
        y - VEHICLE_SUSPENSION_REST_LENGTH_M,
        z,
      ]),
    );
  });

  it('preserves x/z wheel placement while only shifting along suspension direction', () => {
    const anchors = getVehicleWheelVisualAnchors();

    for (let i = 0; i < anchors.length; i += 1) {
      expect(anchors[i][0]).toBe(VEHICLE_WHEEL_CONNECTION_OFFSETS[i][0]);
      expect(anchors[i][1]).toBe(
        VEHICLE_WHEEL_CONNECTION_OFFSETS[i][1] - VEHICLE_SUSPENSION_REST_LENGTH_M,
      );
      expect(anchors[i][2]).toBe(VEHICLE_WHEEL_CONNECTION_OFFSETS[i][2]);
    }
  });
});
