/** Fixed-tick evidence contract. Runtime cost is deliberately not part of quality. */
export const QUALITY_VERSION = 'vehicle-quality/1';
export const HZ = 60;
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Role = 'driver' | 'observer';
export interface Pose { position: Vec3; quaternion: Quat; }
export interface Wheel { attached: boolean; grounded: boolean; tractionN: number; travelM: number; }
export interface QualityFrame {
  tick: number;
  /** Oracle is chosen by the harness: current tick for owner, prescribed delayed tick for observer. */
  reference: Pose;
  actual: Pose | null;
  /** Latest accepted authoritative source tick. Never wall-clock arrival time. */
  sourceTick: number;
  frozen: boolean;
  /** Sampled from pinned authority velocity and embedded terrain, never candidate motion.
   * Surface height is for course coverage only; it is NOT collider clearance. */
  heightfield?: { speedMps:number; surfaceHeightM:number };
  /** Optional independent collision-query signed clearance. Negative = penetration. */
  clearanceM?: number;
  wheels?: Wheel[];
  referenceWheels?: Wheel[];
  topology?: { generation:number; revision:number; membershipHash:string; ownerId:number };
  referenceTopology?: { generation:number; revision:number; membershipHash:string; ownerId:number };
}
export interface Reconciliation { tick: number; errorM: number; angleRad: number; hard: boolean; }
export interface Trigger {
  kind: 'landing' | 'impact' | 'detach' | 'input' | 'ownership' | 'topology' | 'recovery';
  /** A server/oracle-confirmed occurrence, never just a command/marker requesting it. */
  tick: number;
  /** First correct visible response; null means missing. */
  responseTick: number | null;
}
export type Capability = 'clearance' | 'wheels' | 'heightfield' | Trigger['kind'];
export interface QualityEvidence {
  version: typeof QUALITY_VERSION;
  scenario: string;
  role: Role;
  startTick: number;
  endTick: number;
  observerDelayTicks: number;
  lostRecords: number;
  /** Declared reference provenance (native capture vs analytic test fixture). */
  source: string;
  heightfieldSource?: { worldName:string; terrainSha256:string };
  /** Harness-confirmed first usable snapshot delivery after a scripted receive outage. */
  snapshotRecoveries?: {tick:number; sourceTick:number}[];
  frames: QualityFrame[];
  corrections: Reconciliation[];
  triggers: Trigger[];
}
export interface ScenarioContract {
  id: string;
  question: string;
  required: Capability[];
  /** Maximum expected delay of visible response in ticks (not milliseconds of CPU time). */
  responseBudgetTicks: number;
  status: 'replay-ready' | 'needs-native-evidence';
  capture: string;
}
export interface QualityMetric {
  id: string;
  value: number;
  limit: number;
  unit: string;
  /** Exact logical tick to inspect, tied to the failure witness. */
  witnessTick: number;
}
export interface QualityResult {
  version: string;
  scenario: string;
  role: Role;
  verdict: 'pass' | 'fail' | 'blocked';
  problems: string[];
  metrics: QualityMetric[];
}
/** Provisional product budgets, not claimed industry standards. Pin/version before comparing changes. */
export const LIMITS = {
  positionP95M: .15, positionMaxM: .5, orientationMaxDeg: 10,
  worstSecondPositionP95M: .25, visualErrorStepMaxM: .2,
  correctionMaxM: .35, hardCorrectionsPerMinute: 1,
  frozenRunTicks: 12, heldRunTicks: 6, staleRunTicks: 12,
  penetrationMaxM: .03, penetrationRunTicks: 2,
  detachedTractionN: 1, wheelTravelErrorM: .05,
  observerDelayTicks: 12,
} as const;
