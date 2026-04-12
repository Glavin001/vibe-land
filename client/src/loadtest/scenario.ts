export type TransportKind = 'websocket' | 'webtransport';
export type SpawnPattern = 'spread' | 'clustered' | 'mixed';

export interface LinkProfile {
  latencyMs: number;
  jitterMs: number;
  packetLossRate: number;
}

export interface NetworkProfile {
  name: string;
  weight: number;
  transport: TransportKind | 'any';
  uplink: LinkProfile;
  downlink: LinkProfile;
}

export interface BehaviorConfig {
  stopDistanceM: number;
  orbitDistanceM: number;
  sprintDistanceM: number;
  recoveryDistanceM: number;
  targetAcquireDistanceM: number;
  stuckTickThreshold: number;
  jumpCooldownTicks: number;
  fireMode: 'off' | 'nearest_target' | 'center' | 'nearest_target_or_center';
  fireDistanceM: number;
  fireCooldownTicks: number;
}

export interface LoadTestScenario {
  name: string;
  matchId: string;
  durationS: number;
  rampUpS: number;
  botCount: number;
  seed: number;
  inputHz: number;
  transportMix: {
    websocket: number;
    webtransport: number;
  };
  spawnPattern: SpawnPattern;
  behavior: BehaviorConfig;
  networkProfiles: NetworkProfile[];
}

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.next() * Math.max(1, maxExclusive - minInclusive));
  }
}

export const DEFAULT_SCENARIO: LoadTestScenario = {
  name: 'mixed-100',
  matchId: 'loadtest-mixed-100',
  durationS: 30,
  rampUpS: 10,
  botCount: 100,
  seed: 42,
  inputHz: 20,
  transportMix: {
    websocket: 100,
    webtransport: 0,
  },
  spawnPattern: 'mixed',
  behavior: {
    stopDistanceM: 1.6,
    orbitDistanceM: 4.5,
    sprintDistanceM: 8,
    recoveryDistanceM: 32,
    targetAcquireDistanceM: 40,
    stuckTickThreshold: 24,
    jumpCooldownTicks: 30,
    fireMode: 'off',
    fireDistanceM: 18,
    fireCooldownTicks: 8,
  },
  networkProfiles: [
    {
      name: 'lan',
      weight: 0.2,
      transport: 'any',
      uplink: { latencyMs: 6, jitterMs: 2, packetLossRate: 0 },
      downlink: { latencyMs: 6, jitterMs: 2, packetLossRate: 0 },
    },
    {
      name: 'wifi',
      weight: 0.5,
      transport: 'any',
      uplink: { latencyMs: 25, jitterMs: 8, packetLossRate: 0.01 },
      downlink: { latencyMs: 25, jitterMs: 8, packetLossRate: 0.01 },
    },
    {
      name: 'cellular',
      weight: 0.3,
      transport: 'any',
      uplink: { latencyMs: 90, jitterMs: 35, packetLossRate: 0.03 },
      downlink: { latencyMs: 90, jitterMs: 35, packetLossRate: 0.03 },
    },
  ],
};

export function createScenarioFromLegacyArgs(botCount: number, durationS: number): LoadTestScenario {
  const matchId = `loadtest-${botCount}-${durationS || 'open'}`;
  return normalizeScenario({
    name: matchId,
    botCount,
    durationS,
    transportMix: { websocket: botCount, webtransport: 0 },
    matchId,
  });
}

export function normalizeScenario(input: Partial<LoadTestScenario>): LoadTestScenario {
  const merged: LoadTestScenario = {
    ...DEFAULT_SCENARIO,
    ...input,
    transportMix: {
      ...DEFAULT_SCENARIO.transportMix,
      ...(input.transportMix ?? {}),
    },
    behavior: {
      ...DEFAULT_SCENARIO.behavior,
      ...(input.behavior ?? {}),
    },
    networkProfiles: input.networkProfiles?.map((profile) => ({
      ...profile,
      transport: profile.transport ?? 'any',
      uplink: { ...DEFAULT_SCENARIO.networkProfiles[0].uplink, ...profile.uplink },
      downlink: { ...DEFAULT_SCENARIO.networkProfiles[0].downlink, ...profile.downlink },
    })) ?? DEFAULT_SCENARIO.networkProfiles.map((profile) => ({
      ...profile,
      uplink: { ...profile.uplink },
      downlink: { ...profile.downlink },
    })),
  };

  const totalTransport = merged.transportMix.websocket + merged.transportMix.webtransport;
  if (totalTransport <= 0) {
    merged.transportMix.websocket = merged.botCount;
    merged.transportMix.webtransport = 0;
  }
  if (merged.botCount <= 0) {
    merged.botCount = totalTransport;
  }
  if (merged.transportMix.websocket + merged.transportMix.webtransport !== merged.botCount) {
    const wt = Math.min(merged.transportMix.webtransport, merged.botCount);
    merged.transportMix.webtransport = wt;
    merged.transportMix.websocket = Math.max(0, merged.botCount - wt);
  }
  if (!merged.matchId) {
    merged.matchId = merged.name;
  }
  return merged;
}

export function parseScenarioJson(json: string): LoadTestScenario {
  return normalizeScenario(JSON.parse(json) as Partial<LoadTestScenario>);
}

export function chooseWeightedProfile(
  scenario: LoadTestScenario,
  transport: TransportKind,
  rng: SeededRandom,
): NetworkProfile {
  const eligible = scenario.networkProfiles.filter((profile) =>
    profile.transport === 'any' || profile.transport === transport,
  );
  const candidates = eligible.length > 0 ? eligible : scenario.networkProfiles;
  const total = candidates.reduce((sum, profile) => sum + Math.max(profile.weight, 0), 0);
  if (total <= 0) {
    return candidates[0];
  }

  let remaining = rng.next() * total;
  for (const profile of candidates) {
    remaining -= Math.max(profile.weight, 0);
    if (remaining <= 0) {
      return profile;
    }
  }
  return candidates[candidates.length - 1];
}

export function anchorForBot(index: number, scenario: LoadTestScenario): [number, number] {
  const radius = scenario.spawnPattern === 'clustered' ? 6 : scenario.spawnPattern === 'mixed' ? 14 : 22;
  const angle = (index / Math.max(1, scenario.botCount)) * Math.PI * 2;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}
