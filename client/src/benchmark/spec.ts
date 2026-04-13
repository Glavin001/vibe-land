import { normalizeScenario, type LoadTestScenario } from '../loadtest/scenario';

export type BenchmarkEnvironment = 'local' | 'server-box';

export interface BenchmarkThresholdBand {
  comparator: 'upper' | 'lower';
  warn: number;
  fail: number;
}

export interface BenchmarkThresholds {
  tickP95Ms: BenchmarkThresholdBand;
  playerKccP95Ms: BenchmarkThresholdBand;
  dynamicsP95Ms: BenchmarkThresholdBand;
  snapshotBytesPerClientP95: BenchmarkThresholdBand;
  wtReliableRatio: BenchmarkThresholdBand;
  datagramFallbacks: BenchmarkThresholdBand;
  strictSnapshotDrops: BenchmarkThresholdBand;
  maxPendingInputs: BenchmarkThresholdBand;
  connectedRatio: BenchmarkThresholdBand;
  voidKills: BenchmarkThresholdBand;
}

export interface BenchmarkScenarioSpec {
  name: string;
  environment: BenchmarkEnvironment;
  warmupS: number;
  measureS: number;
  cooldownS: number;
  playClients: number;
  thresholds: BenchmarkThresholds;
  scenario: LoadTestScenario;
}

export interface BenchmarkSuiteSpec {
  name: string;
  scenarios: BenchmarkScenarioSpec[];
}

export function totalScenarioDurationS(spec: BenchmarkScenarioSpec): number {
  return spec.warmupS + spec.measureS + spec.cooldownS;
}

export function createScenarioSpec(input: {
  name: string;
  environment: BenchmarkEnvironment;
  warmupS: number;
  measureS: number;
  cooldownS?: number;
  playClients?: number;
  thresholds: BenchmarkThresholds;
  scenario: Partial<LoadTestScenario>;
}): BenchmarkScenarioSpec {
  const cooldownS = input.cooldownS ?? 2;
  const durationS = input.warmupS + input.measureS + cooldownS;
  return {
    name: input.name,
    environment: input.environment,
    warmupS: input.warmupS,
    measureS: input.measureS,
    cooldownS,
    playClients: input.playClients ?? 0,
    thresholds: input.thresholds,
    scenario: normalizeScenario({
      ...input.scenario,
      name: input.name,
      matchId: input.scenario.matchId ?? input.name,
      durationS,
    }),
  };
}

export function scenarioNames(suite: BenchmarkSuiteSpec): string[] {
  return suite.scenarios.map((scenario) => scenario.name);
}
