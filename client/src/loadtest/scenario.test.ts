import { describe, expect, it } from 'vitest';
import {
  chooseWeightedProfile,
  createScenarioFromLegacyArgs,
  normalizeScenario,
  SeededRandom,
} from './scenario';

describe('loadtest scenario', () => {
  it('normalizes transport counts back to botCount', () => {
    const scenario = normalizeScenario({
      botCount: 8,
      transportMix: { websocket: 6, webtransport: 6 },
    });

    expect(scenario.transportMix.webtransport).toBe(6);
    expect(scenario.transportMix.websocket).toBe(2);
  });

  it('chooses weighted profiles deterministically for a seed', () => {
    const scenario = normalizeScenario({
      networkProfiles: [
        {
          name: 'low',
          weight: 1,
          transport: 'any',
          uplink: { latencyMs: 1, jitterMs: 0, packetLossRate: 0 },
          downlink: { latencyMs: 1, jitterMs: 0, packetLossRate: 0 },
        },
        {
          name: 'high',
          weight: 3,
          transport: 'any',
          uplink: { latencyMs: 100, jitterMs: 10, packetLossRate: 0.1 },
          downlink: { latencyMs: 100, jitterMs: 10, packetLossRate: 0.1 },
        },
      ],
    });

    const rng1 = new SeededRandom(7);
    const rng2 = new SeededRandom(7);
    expect(chooseWeightedProfile(scenario, 'websocket', rng1).name).toBe(
      chooseWeightedProfile(scenario, 'websocket', rng2).name,
    );
  });

  it('legacy args produce a matching scenario name and match id', () => {
    const scenario = createScenarioFromLegacyArgs(10, 30);
    expect(scenario.name).toBe('loadtest-10-30');
    expect(scenario.matchId).toBe('loadtest-10-30');
  });

  it('fills in default combat behavior fields', () => {
    const scenario = normalizeScenario({});
    expect(scenario.behavior.fireMode).toBe('off');
    expect(scenario.behavior.fireDistanceM).toBeGreaterThan(0);
    expect(scenario.behavior.fireCooldownTicks).toBeGreaterThan(0);
  });
});
