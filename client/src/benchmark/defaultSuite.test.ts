import { describe, expect, it } from 'vitest';
import { resolveSuite } from './defaultSuite';

describe('benchmark default suites', () => {
  it('exposes a focused vehicle QA suite for local driver jitter reproduction', () => {
    const suite = resolveSuite('vehicle-qa');

    expect(suite.scenarios.map((scenario) => scenario.name)).toEqual([
      'flat_vehicle_straight_fast_1',
      'terrain_vehicle_straight_1',
      'terrain_vehicle_straight_fast_1',
      'bumps_vehicle_straight_fast_1',
    ]);
    for (const scenario of suite.scenarios) {
      expect(scenario.playClients).toBe(1);
      expect(scenario.scenario.botCount).toBe(0);
      expect(scenario.scenario.playBenchmark?.mode).toBe('vehicle_driver');
    }
    expect(suite.scenarios.find((scenario) => scenario.name === 'terrain_vehicle_straight_1')
      ?.scenario.playBenchmark?.driverProfile).toBe('straight');
  });
});
