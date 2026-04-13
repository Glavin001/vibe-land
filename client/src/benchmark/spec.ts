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
  thresholds: BenchmarkThresholds;
  scenario: LoadTestScenario;
}

export interface BenchmarkSuiteSpec {
  name: string;
  scenarios: BenchmarkScenarioSpec[];
}

export function totalScenarioDurationS(spec: BenchmarkScenarioSpec): number {
  return spec.warmupS + spec.measureS;
}

export function createScenarioSpec(input: {
  name: string;
  environment: BenchmarkEnvironment;
  warmupS: number;
  measureS: number;
  thresholds: BenchmarkThresholds;
  scenario: Partial<LoadTestScenario>;
}): BenchmarkScenarioSpec {
  const durationS = input.warmupS + input.measureS;
  return {
    name: input.name,
    environment: input.environment,
    warmupS: input.warmupS,
    measureS: input.measureS,
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
