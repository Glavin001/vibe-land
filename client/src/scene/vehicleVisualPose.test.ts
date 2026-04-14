import { describe, expect, it } from 'vitest';
import { shouldSnapLocalVehicleVisualPose } from './vehicleVisualPose';

describe('shouldSnapLocalVehicleVisualPose', () => {
  it('does not snap for small local pose jitter', () => {
    expect(shouldSnapLocalVehicleVisualPose(0.08, 0.03, -0.06, 0.05)).toBe(false);
  });

  it('snaps for large translation deltas', () => {
    expect(shouldSnapLocalVehicleVisualPose(0.8, 0.02, 0.01, 0.01)).toBe(true);
  });

  it('snaps for vertical impact deltas', () => {
    expect(shouldSnapLocalVehicleVisualPose(0.04, 0.3, 0.02, 0.01)).toBe(true);
  });

  it('snaps for large angular deltas', () => {
    expect(shouldSnapLocalVehicleVisualPose(0.04, 0.02, 0.03, 0.2)).toBe(true);
  });
});
