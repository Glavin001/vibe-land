import { useEffect, useRef, useState, useCallback } from 'react';
import type { DebugStats } from './DebugOverlay';
import { DEFAULT_STATS } from './DebugOverlay';

const FPS_SAMPLE_COUNT = 60;
const OVERLAY_UPDATE_INTERVAL_MS = 100; // 10Hz UI refresh
const JITTER_SAMPLE_COUNT = 30; // rolling window of snapshot intervals
const DEEP_CAPTURE_WINDOW_MS = 10_000;
const DEEP_CAPTURE_EXPORT_MAX_SAMPLES = 120;
// Must match `shared/src/debug_render.rs`.
const DESTRUCTIBLE_BODY_GROUPS_MODE_BIT = 1 << 30;
const RAPIER_DEBUG_MODES = [
  { bits: 0, label: 'off' },
  { bits: 0b11, label: 'shapes' },
  { bits: DESTRUCTIBLE_BODY_GROUPS_MODE_BIT, label: 'destructibles' },
  { bits: 0b1111, label: 'joints' },
  { bits: 0b1111111, label: 'full' },
] as const;

export type VehicleDeepCaptureSample = {
  atMs: number;
  frameTimeMs: number;
  speedMs: number;
  groundedWheels: number;
  wheelContactBits: number;
  wheelContactBitChanges: number;
  wheelContactNormalDeltaRad: number;
  wheelGroundObjectSwitches: number;
  ackBacklogMs: number;
  resendWindow: number;
  replayErrorM: number;
  correctionM: number;
  predictedFrameDeltaM: number;
  predictedPlanarDeltaM: number;
  predictedHeaveDeltaM: number;
  predictedYawDeltaRad: number;
  predictedPitchDeltaRad: number;
  predictedRollDeltaRad: number;
  predictedResidualDeltaM: number;
  predictedResidualPlanarDeltaM: number;
  predictedResidualHeaveDeltaM: number;
  predictedResidualYawDeltaRad: number;
  predictedResidualPitchDeltaRad: number;
  predictedResidualRollDeltaRad: number;
  meshFrameDeltaM: number;
  meshFrameRotDeltaRad: number;
  meshOffsetToPredictedM: number;
  meshOffsetToCurrentAuthM: number;
  cameraFrameDeltaM: number;
  cameraFrameRotDeltaRad: number;
  suspensionLengthSpreadM: number;
  suspensionForceSpreadN: number;
  suspensionLengthDeltaM: number;
  suspensionForceDeltaN: number;
  currentAuthDeltaM: number;
  currentAuthPlanarDeltaM: number;
  currentAuthVerticalDeltaM: number;
  currentAuthUnexplainedDeltaM: number;
  expectedLeadM: number;
  groundedTransitionThisFrame: boolean;
};

function rms(values: number[]): number {
  if (values.length === 0) return 0;
  let sumSquares = 0;
  for (const value of values) sumSquares += value * value;
  return Math.sqrt(sumSquares / values.length);
}

function peak(values: number[]): number {
  let max = 0;
  for (const value of values) {
    if (value > max) max = value;
  }
  return max;
}

function downsampleDeepCaptureSamples(
  samples: VehicleDeepCaptureSample[],
  maxSamples = DEEP_CAPTURE_EXPORT_MAX_SAMPLES,
): VehicleDeepCaptureSample[] {
  if (samples.length <= maxSamples) return samples;
  const step = Math.ceil(samples.length / maxSamples);
  const downsampled: VehicleDeepCaptureSample[] = [];
  for (let index = 0; index < samples.length; index += step) {
    downsampled.push(samples[index]);
  }
  const last = samples[samples.length - 1];
  if (downsampled[downsampled.length - 1] !== last) {
    downsampled.push(last);
  }
  return downsampled;
}

export function buildVehicleDeepCaptureMarkdown(samples: VehicleDeepCaptureSample[]): string {
  if (samples.length === 0) {
    return [
      '## Vehicle Deep Capture',
      '- state: enabled but empty',
    ].join('\n');
  }

  const startMs = samples[0].atMs;
  const endMs = samples[samples.length - 1].atMs;
  const predictedPlanar = samples.map((sample) => sample.predictedPlanarDeltaM);
  const predictedYaw = samples.map((sample) => sample.predictedYawDeltaRad);
  const residualPlanar = samples.map((sample) => sample.predictedResidualPlanarDeltaM);
  const residualHeave = samples.map((sample) => sample.predictedResidualHeaveDeltaM);
  const meshFrame = samples.map((sample) => sample.meshFrameDeltaM);
  const cameraFrame = samples.map((sample) => sample.cameraFrameDeltaM);
  const unexplained = samples.map((sample) => sample.currentAuthUnexplainedDeltaM);
  const currentAuth = samples.map((sample) => sample.currentAuthDeltaM);
  const groundedTransitions = samples.reduce((count, sample) => count + (sample.groundedTransitionThisFrame ? 1 : 0), 0);
  const wheelContactBitChanges = samples.reduce((count, sample) => count + sample.wheelContactBitChanges, 0);
  const wheelContactNormalDelta = samples.map((sample) => sample.wheelContactNormalDeltaRad);
  const wheelGroundObjectSwitches = samples.reduce((count, sample) => count + sample.wheelGroundObjectSwitches, 0);
  const suspensionForceDelta = samples.map((sample) => sample.suspensionForceDeltaN);
  const suspensionLengthDelta = samples.map((sample) => sample.suspensionLengthDeltaM);
  const downsampled = downsampleDeepCaptureSamples(samples);

  const lines = [
    '## Vehicle Deep Capture',
    `- window_ms: ${(endMs - startMs).toFixed(1)}`,
    `- samples: ${samples.length}`,
    `- predicted_planar_rms_10s_m: ${rms(predictedPlanar).toFixed(3)}`,
    `- predicted_planar_peak_10s_m: ${peak(predictedPlanar).toFixed(3)}`,
    `- predicted_yaw_rms_10s_rad: ${rms(predictedYaw).toFixed(3)}`,
    `- predicted_yaw_peak_10s_rad: ${peak(predictedYaw).toFixed(3)}`,
    `- predicted_residual_planar_rms_10s_m: ${rms(residualPlanar).toFixed(3)}`,
    `- predicted_residual_planar_peak_10s_m: ${peak(residualPlanar).toFixed(3)}`,
    `- predicted_residual_heave_rms_10s_m: ${rms(residualHeave).toFixed(3)}`,
    `- predicted_residual_heave_peak_10s_m: ${peak(residualHeave).toFixed(3)}`,
    `- mesh_frame_rms_10s_m: ${rms(meshFrame).toFixed(3)}`,
    `- mesh_frame_peak_10s_m: ${peak(meshFrame).toFixed(3)}`,
    `- camera_frame_rms_10s_m: ${rms(cameraFrame).toFixed(3)}`,
    `- camera_frame_peak_10s_m: ${peak(cameraFrame).toFixed(3)}`,
    `- suspension_length_delta_rms_10s_m: ${rms(suspensionLengthDelta).toFixed(3)}`,
    `- suspension_force_delta_rms_10s_n: ${rms(suspensionForceDelta).toFixed(3)}`,
    `- current_auth_rms_10s_m: ${rms(currentAuth).toFixed(3)}`,
    `- current_auth_peak_10s_m: ${peak(currentAuth).toFixed(3)}`,
    `- unexplained_auth_rms_10s_m: ${rms(unexplained).toFixed(3)}`,
    `- unexplained_auth_peak_10s_m: ${peak(unexplained).toFixed(3)}`,
    `- grounded_transitions_10s: ${groundedTransitions}`,
    `- wheel_contact_bit_changes_10s: ${wheelContactBitChanges}`,
    `- wheel_contact_normal_delta_rms_10s_rad: ${rms(wheelContactNormalDelta).toFixed(3)}`,
    `- wheel_ground_object_switches_10s: ${wheelGroundObjectSwitches}`,
    '```text',
    't_ms speed gw bits ack_ms exp_lead unexpl_auth curr_auth pred_planar resid_planar resid_heave mesh_frame normal_d ground_sw susp_len_d susp_force_d replay corr',
    ...downsampled.map((sample) => [
      (sample.atMs - startMs).toFixed(1),
      sample.speedMs.toFixed(3),
      sample.groundedWheels,
      sample.wheelContactBits.toString(2).padStart(4, '0'),
      sample.ackBacklogMs.toFixed(1),
      sample.expectedLeadM.toFixed(3),
      sample.currentAuthUnexplainedDeltaM.toFixed(3),
      sample.currentAuthDeltaM.toFixed(3),
      sample.predictedPlanarDeltaM.toFixed(3),
      sample.predictedResidualPlanarDeltaM.toFixed(3),
      sample.predictedResidualHeaveDeltaM.toFixed(3),
      sample.meshFrameDeltaM.toFixed(3),
      sample.wheelContactNormalDeltaRad.toFixed(3),
      sample.wheelGroundObjectSwitches,
      sample.suspensionLengthDeltaM.toFixed(3),
      sample.suspensionForceDeltaN.toFixed(3),
      sample.replayErrorM.toFixed(3),
      sample.correctionM.toFixed(3),
    ].join(' ')),
    '```',
  ];

  return lines.join('\n');
}

export function useDebugStats() {
  const [visible, setVisible] = useState(false);
  const [displayStats, setDisplayStats] = useState<DebugStats>({ ...DEFAULT_STATS });
  const [rapierDebugPresetIndex, setRapierDebugPresetIndex] = useState(0);
  const [deepCaptureEnabled, setDeepCaptureEnabled] = useState(false);
  const statsRef = useRef<DebugStats>({ ...DEFAULT_STATS });
  const frameTimes = useRef<number[]>([]);
  const snapshotTimestamps = useRef<number[]>([]);
  const snapshotIntervals = useRef<number[]>([]);
  const lastSnapshotTs = useRef<number>(0);
  const lastUiUpdate = useRef(0);
  const visibleRef = useRef(false);
  const deepCaptureEnabledRef = useRef(false);
  const deepCaptureSamplesRef = useRef<VehicleDeepCaptureSample[]>([]);

  const isLocalTransport = useCallback((transport: string): boolean => transport === 'local', []);
  const cycleRapierDebugPreset = useCallback((reverse = false) => {
    setRapierDebugPresetIndex((index) => {
      if (reverse) {
        return index === 0 ? RAPIER_DEBUG_MODES.length - 1 : index - 1;
      }
      return (index + 1) % RAPIER_DEBUG_MODES.length;
    });
  }, []);

  // F3 toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'F3') {
        e.preventDefault();
        setVisible((v) => {
          visibleRef.current = !v;
          return !v;
        });
        return;
      }
      if (e.code === 'F6') {
        e.preventDefault();
        if (e.shiftKey) {
          cycleRapierDebugPreset(false);
          return;
        }
        setRapierDebugPresetIndex((index) => (index === 0 ? 1 : 0));
        return;
      }
      if (e.code === 'F7') {
        e.preventDefault();
        setDeepCaptureEnabled((enabled) => {
          const next = !enabled;
          deepCaptureEnabledRef.current = next;
          deepCaptureSamplesRef.current = [];
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycleRapierDebugPreset]);

  const recordSnapshot = useCallback(() => {
    const now = performance.now();
    snapshotTimestamps.current.push(now);

    // Track inter-arrival intervals for jitter calculation
    if (lastSnapshotTs.current > 0) {
      const interval = now - lastSnapshotTs.current;
      const intervals = snapshotIntervals.current;
      intervals.push(interval);
      if (intervals.length > JITTER_SAMPLE_COUNT) intervals.shift();
    }
    lastSnapshotTs.current = now;
  }, []);

  const updateFrame = useCallback((
    frameTimeMs: number,
    rendererInfo: { render: { calls: number; triangles: number }; memory: { geometries: number; textures: number } },
    network: {
      pingMs: number;
      serverTick: number;
      interpolationDelayMs: number;
      dynamicBodyInterpolationDelayMs: number;
      clockOffsetUs: number;
      remotePlayers: number;
      transport: string;
      playerId: number;
    },
    debug: { rapierDebugLabel: string; rapierDebugModeBits: number },
    physics: {
      pendingInputs: number;
      predictionTicks: number;
      playerCorrectionMagnitude: number;
      vehicleCorrectionMagnitude: number;
      dynamicGlobalMaxCorrectionMagnitude: number;
      dynamicNearPlayerMaxCorrectionMagnitude: number;
      dynamicInteractiveMaxCorrectionMagnitude: number;
      dynamicOverThresholdCount: number;
      dynamicTrackedBodies: number;
      dynamicInteractiveBodies: number;
      lastDynamicShotBodyId: number;
      lastDynamicShotAgeMs: number;
      vehiclePendingInputs: number;
      vehicleAckSeq: number;
      vehicleLatestLocalSeq: number;
      vehiclePendingInputsAgeMs: number;
      vehicleAckBacklogMs: number;
      vehicleResendWindow: number;
      vehicleReplayErrorM: number;
      vehiclePosErrorM: number;
      vehicleVelErrorMs: number;
      vehicleRotErrorRad: number;
      vehicleCorrectionAgeMs: number;
      physicsStepMs: number;
      velocity: [number, number, number];
    },
    vehicle: {
      id: number;
      driverConfirmed: boolean;
      localSpeedMs: number;
      serverSpeedMs: number;
      posDeltaM: number;
      groundedWheels: number;
      steering: number;
      engineForce: number;
      brake: number;
      meshDeltaM: number;
      meshRotDeltaRad: number;
      meshDeltaRms5sM: number;
      meshDeltaPeak5sM: number;
      restJitterRms5sM: number;
      straightJitterRms5sM: number;
      rawHeaveDeltaRms5sM: number;
      rawHeaveDeltaPeak5sM: number;
      rawPlanarDeltaRms5sM: number;
      rawPlanarDeltaPeak5sM: number;
      rawYawDeltaRms5sRad: number;
      rawYawDeltaPeak5sRad: number;
      rawPitchDeltaRms5sRad: number;
      rawPitchDeltaPeak5sRad: number;
      rawRollDeltaRms5sRad: number;
      rawRollDeltaPeak5sRad: number;
      residualDeltaRms5sM: number;
      residualDeltaPeak5sM: number;
      residualPlanarDeltaRms5sM: number;
      residualPlanarDeltaPeak5sM: number;
      residualHeaveDeltaRms5sM: number;
      residualHeaveDeltaPeak5sM: number;
      residualYawDeltaRms5sRad: number;
      residualYawDeltaPeak5sRad: number;
      residualPitchDeltaRms5sRad: number;
      residualPitchDeltaPeak5sRad: number;
      residualRollDeltaRms5sRad: number;
      residualRollDeltaPeak5sRad: number;
      rawRestHeaveDeltaRms5sM: number;
      rawStraightHeaveDeltaRms5sM: number;
      wheelContactBits: number;
      wheelContactBitChanges5s: number;
      wheelContactNormals: Array<[number, number, number]>;
      wheelContactNormalDeltaRms5sRad: number;
      wheelGroundObjectIds: [number, number, number, number];
      wheelGroundObjectSwitches5s: number;
      suspensionLengths: [number, number, number, number];
      suspensionForces: [number, number, number, number];
      suspensionRelativeVelocities: [number, number, number, number];
      suspensionLengthSpreadM: number;
      suspensionLengthSpreadPeak5sM: number;
      suspensionLengthDeltaRms5sM: number;
      suspensionForceSpreadN: number;
      suspensionForceSpreadPeak5sN: number;
      suspensionForceDeltaRms5sN: number;
      meshFrameDeltaRms5sM: number;
      meshFrameDeltaPeak5sM: number;
      meshFrameRotDeltaRms5sRad: number;
      meshFrameRotDeltaPeak5sRad: number;
      cameraFrameDeltaRms5sM: number;
      cameraFrameDeltaPeak5sM: number;
      cameraFrameRotDeltaRms5sRad: number;
      cameraFrameRotDeltaPeak5sRad: number;
      groundedTransitions5s: number;
      groundedMin5s: number;
      groundedMax5s: number;
      latestAuthDeltaM: number;
      sampledAuthDeltaM: number;
      meshAuthDeltaM: number;
      latestVsSampledAuthDeltaM: number;
      currentAuthDeltaM: number;
      meshCurrentAuthDeltaM: number;
      expectedLeadM: number;
      currentAuthUnexplainedDeltaM: number;
      currentAuthPlanarDeltaM: number;
      currentAuthVerticalDeltaM: number;
      authObservedAgeMs: number;
      authSampleOffsetMs: number;
      authSampleServerDeltaMs: number;
      authCurrentOffsetMs: number;
      predictedAuthDeltaRms5sM: number;
      predictedAuthDeltaPeak5sM: number;
      capture: {
        predictedFrameDeltaM: number;
        predictedPlanarDeltaM: number;
        predictedHeaveDeltaM: number;
        predictedYawDeltaRad: number;
        predictedPitchDeltaRad: number;
        predictedRollDeltaRad: number;
        predictedResidualDeltaM: number;
        predictedResidualPlanarDeltaM: number;
        predictedResidualHeaveDeltaM: number;
        predictedResidualYawDeltaRad: number;
        predictedResidualPitchDeltaRad: number;
        predictedResidualRollDeltaRad: number;
        meshFrameDeltaM: number;
        meshFrameRotDeltaRad: number;
        cameraFrameDeltaM: number;
        cameraFrameRotDeltaRad: number;
        groundedTransitionThisFrame: boolean;
        wheelContactBits: number;
        wheelContactBitChangesThisFrame: number;
        wheelContactNormalDeltaRad: number;
        wheelGroundObjectSwitchesThisFrame: number;
        suspensionLengthSpreadM: number;
        suspensionForceSpreadN: number;
        suspensionLengthDeltaM: number;
        suspensionForceDeltaN: number;
        expectedLeadM: number;
        currentAuthUnexplainedDeltaM: number;
        currentAuthPlanarDeltaM: number;
        currentAuthVerticalDeltaM: number;
        predictedPosition: [number, number, number] | null;
        meshPosition: [number, number, number] | null;
        currentAuthPosition: [number, number, number] | null;
        cameraPosition: [number, number, number];
      };
    },
    telemetry: {
      lastSnapshotGapMs: number;
      snapshotGapP95Ms: number;
      snapshotGapMaxMs: number;
      lastSnapshotSource: string;
      staleSnapshotsDropped: number;
      reliableSnapshotsReceived: number;
      datagramSnapshotsReceived: number;
      localSnapshotsReceived: number;
      directSnapshotsReceived: number;
      playerCorrectionPeak5sM: number;
      vehicleCorrectionPeak5sM: number;
      dynamicCorrectionPeak5sM: number;
      pendingInputsPeak5s: number;
      shotsFired: number;
      shotsPending: number;
      shotAuthoritativeMoves: number;
      shotMismatches: number;
      lastShotOutcome: string;
      lastShotOutcomeAgeMs: number;
      lastShotPredictedBodyId: number;
      lastShotProxyHitBodyId: number;
      lastShotProxyHitToi: number;
      lastShotBlockedByBlocker: boolean;
      lastShotLocalPredictedDeltaM: number;
      lastShotDynamicSampleAgeMs: number;
      lastShotPredictedBodyRecentInteraction: boolean;
      lastShotBlockerDistance: number;
      lastShotRenderedBodyId: number;
      lastShotRenderedBodyToi: number;
      lastShotRenderProxyDeltaM: number;
      lastShotRenderedBodyProxyPresent: boolean;
      lastShotRenderedBodyProxyToi: number;
      lastShotRenderedBodyProxyCenterDeltaM: number;
      lastShotNearestProxyBodyId: number;
      lastShotNearestProxyBodyToi: number;
      lastShotNearestProxyBodyMissDistanceM: number;
      lastShotNearestProxyBodyRadiusM: number;
      lastShotNearestRenderedBodyId: number;
      lastShotNearestRenderedBodyToi: number;
      lastShotNearestRenderedBodyMissDistanceM: number;
      lastShotNearestRenderedBodyRadiusM: number;
      lastShotServerResolution: number;
      lastShotServerDynamicBodyId: number;
      lastShotServerDynamicHitToiM: number;
      lastShotServerDynamicImpulseMag: number;
      recentEvents: string[];
    },
    destructibles: {
      chunkCount: number;
      fractureEventsTotal: number;
      debugState: DebugStats['destructibleDebugState'];
      debugConfig: DebugStats['destructibleDebugConfig'];
      loggingEnabled: boolean;
    },
    position: [number, number, number],
    player: { velocity: [number, number, number]; hp: number; energy: number; localFlags: number },
  ) => {
    // Rolling FPS
    const times = frameTimes.current;
    times.push(frameTimeMs);
    if (times.length > FPS_SAMPLE_COUNT) times.shift();
    const avgMs = times.reduce((a, b) => a + b, 0) / times.length;

    // Snapshot rate
    const now = performance.now();
    const snaps = snapshotTimestamps.current;
    while (snaps.length > 0 && snaps[0] < now - 1000) snaps.shift();
    const snapshotsPerSec = snaps.length;

    const localTransport = isLocalTransport(network.transport);

    // Jitter: std dev of inter-arrival intervals (in ms). For `/practice`,
    // snapshot cadence comes from the local browser Rust authority, so any
    // variance here is just timer scheduling noise rather than network jitter.
    const intervals = snapshotIntervals.current;
    let jitterMs = 0;
    if (!localTransport && intervals.length >= 2) {
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intervals.length;
      jitterMs = Math.sqrt(variance);
    }

    // JS heap memory (Chrome only)
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    const heapUsedMb = mem ? mem.usedJSHeapSize / 1_048_576 : -1;
    const heapTotalMb = mem ? mem.totalJSHeapSize / 1_048_576 : -1;

    const vel = player.velocity;
    const speedMs = Math.hypot(vel[0], vel[1], vel[2]);

    const s = statsRef.current;
    s.fps = avgMs > 0 ? 1000 / avgMs : 0;
    s.frameTimeMs = frameTimeMs;
    s.drawCalls = rendererInfo.render.calls;
    s.triangles = rendererInfo.render.triangles;
    s.geometries = rendererInfo.memory.geometries;
    s.textures = rendererInfo.memory.textures;
    s.transport = network.transport;
    s.pingMs = localTransport ? 0 : network.pingMs;
    s.serverTick = network.serverTick;
    s.interpolationDelayMs = localTransport ? 0 : network.interpolationDelayMs;
    s.dynamicBodyInterpolationDelayMs = localTransport ? 0 : network.dynamicBodyInterpolationDelayMs;
    s.clockOffsetUs = localTransport ? 0 : network.clockOffsetUs;
    s.remotePlayers = network.remotePlayers;
    s.snapshotsPerSec = snapshotsPerSec;
    s.jitterMs = jitterMs;
    s.lastSnapshotGapMs = telemetry.lastSnapshotGapMs;
    s.snapshotGapP95Ms = telemetry.snapshotGapP95Ms;
    s.snapshotGapMaxMs = telemetry.snapshotGapMaxMs;
    s.lastSnapshotSource = telemetry.lastSnapshotSource;
    s.staleSnapshotsDropped = telemetry.staleSnapshotsDropped;
    s.reliableSnapshotsReceived = telemetry.reliableSnapshotsReceived;
    s.datagramSnapshotsReceived = telemetry.datagramSnapshotsReceived;
    s.localSnapshotsReceived = telemetry.localSnapshotsReceived;
    s.directSnapshotsReceived = telemetry.directSnapshotsReceived;
    s.playerId = network.playerId;
    s.rapierDebugLabel = debug.rapierDebugLabel;
    s.rapierDebugModeBits = debug.rapierDebugModeBits;
    s.pendingInputs = physics.pendingInputs;
    s.predictionTicks = physics.predictionTicks;
    s.playerCorrectionMagnitude = physics.playerCorrectionMagnitude;
    s.vehicleCorrectionMagnitude = physics.vehicleCorrectionMagnitude;
    s.dynamicGlobalMaxCorrectionMagnitude = physics.dynamicGlobalMaxCorrectionMagnitude;
    s.dynamicNearPlayerMaxCorrectionMagnitude = physics.dynamicNearPlayerMaxCorrectionMagnitude;
    s.dynamicInteractiveMaxCorrectionMagnitude = physics.dynamicInteractiveMaxCorrectionMagnitude;
    s.dynamicOverThresholdCount = physics.dynamicOverThresholdCount;
    s.dynamicTrackedBodies = physics.dynamicTrackedBodies;
    s.dynamicInteractiveBodies = physics.dynamicInteractiveBodies;
    s.lastDynamicShotBodyId = physics.lastDynamicShotBodyId;
    s.lastDynamicShotAgeMs = physics.lastDynamicShotAgeMs;
    s.vehiclePendingInputs = physics.vehiclePendingInputs;
    s.vehicleAckSeq = physics.vehicleAckSeq;
    s.vehicleLatestLocalSeq = physics.vehicleLatestLocalSeq;
    s.vehiclePendingInputsAgeMs = physics.vehiclePendingInputsAgeMs;
    s.vehicleAckBacklogMs = physics.vehicleAckBacklogMs;
    s.vehicleResendWindow = physics.vehicleResendWindow;
    s.vehicleReplayErrorM = physics.vehicleReplayErrorM;
    s.vehiclePosErrorM = physics.vehiclePosErrorM;
    s.vehicleVelErrorMs = physics.vehicleVelErrorMs;
    s.vehicleRotErrorRad = physics.vehicleRotErrorRad;
    s.vehicleCorrectionAgeMs = physics.vehicleCorrectionAgeMs;
    s.playerCorrectionPeak5sM = telemetry.playerCorrectionPeak5sM;
    s.vehicleCorrectionPeak5sM = telemetry.vehicleCorrectionPeak5sM;
    s.dynamicCorrectionPeak5sM = telemetry.dynamicCorrectionPeak5sM;
    s.pendingInputsPeak5s = telemetry.pendingInputsPeak5s;
    s.physicsStepMs = physics.physicsStepMs;
    s.shotsFired = telemetry.shotsFired;
    s.shotsPending = telemetry.shotsPending;
    s.shotAuthoritativeMoves = telemetry.shotAuthoritativeMoves;
    s.shotMismatches = telemetry.shotMismatches;
    s.lastShotOutcome = telemetry.lastShotOutcome;
    s.lastShotOutcomeAgeMs = telemetry.lastShotOutcomeAgeMs;
    s.lastShotPredictedBodyId = telemetry.lastShotPredictedBodyId;
    s.lastShotProxyHitBodyId = telemetry.lastShotProxyHitBodyId;
    s.lastShotProxyHitToi = telemetry.lastShotProxyHitToi;
    s.lastShotBlockedByBlocker = telemetry.lastShotBlockedByBlocker;
    s.lastShotLocalPredictedDeltaM = telemetry.lastShotLocalPredictedDeltaM;
    s.lastShotDynamicSampleAgeMs = telemetry.lastShotDynamicSampleAgeMs;
    s.lastShotPredictedBodyRecentInteraction = telemetry.lastShotPredictedBodyRecentInteraction;
    s.lastShotBlockerDistance = telemetry.lastShotBlockerDistance;
    s.lastShotRenderedBodyId = telemetry.lastShotRenderedBodyId;
    s.lastShotRenderedBodyToi = telemetry.lastShotRenderedBodyToi;
    s.lastShotRenderProxyDeltaM = telemetry.lastShotRenderProxyDeltaM;
    s.lastShotRenderedBodyProxyPresent = telemetry.lastShotRenderedBodyProxyPresent;
    s.lastShotRenderedBodyProxyToi = telemetry.lastShotRenderedBodyProxyToi;
    s.lastShotRenderedBodyProxyCenterDeltaM = telemetry.lastShotRenderedBodyProxyCenterDeltaM;
    s.lastShotNearestProxyBodyId = telemetry.lastShotNearestProxyBodyId;
    s.lastShotNearestProxyBodyToi = telemetry.lastShotNearestProxyBodyToi;
    s.lastShotNearestProxyBodyMissDistanceM = telemetry.lastShotNearestProxyBodyMissDistanceM;
    s.lastShotNearestProxyBodyRadiusM = telemetry.lastShotNearestProxyBodyRadiusM;
    s.lastShotNearestRenderedBodyId = telemetry.lastShotNearestRenderedBodyId;
    s.lastShotNearestRenderedBodyToi = telemetry.lastShotNearestRenderedBodyToi;
    s.lastShotNearestRenderedBodyMissDistanceM = telemetry.lastShotNearestRenderedBodyMissDistanceM;
    s.lastShotNearestRenderedBodyRadiusM = telemetry.lastShotNearestRenderedBodyRadiusM;
    s.lastShotServerResolution = telemetry.lastShotServerResolution;
    s.lastShotServerDynamicBodyId = telemetry.lastShotServerDynamicBodyId;
    s.lastShotServerDynamicHitToiM = telemetry.lastShotServerDynamicHitToiM;
    s.lastShotServerDynamicImpulseMag = telemetry.lastShotServerDynamicImpulseMag;
    s.recentEvents = telemetry.recentEvents;
    s.vehicleDebugId = vehicle.id;
    s.vehicleDriverConfirmed = vehicle.driverConfirmed;
    s.vehicleLocalSpeedMs = vehicle.localSpeedMs;
    s.vehicleServerSpeedMs = vehicle.serverSpeedMs;
    s.vehiclePosDeltaM = vehicle.posDeltaM;
    s.vehicleGroundedWheels = vehicle.groundedWheels;
    s.vehicleSteering = vehicle.steering;
    s.vehicleEngineForce = vehicle.engineForce;
    s.vehicleBrake = vehicle.brake;
    s.vehicleMeshDeltaM = vehicle.meshDeltaM;
    s.vehicleMeshRotDeltaRad = vehicle.meshRotDeltaRad;
    s.vehiclePredictedFrameDeltaM = vehicle.capture.predictedFrameDeltaM;
    s.vehiclePredictedPlanarDeltaM = vehicle.capture.predictedPlanarDeltaM;
    s.vehiclePredictedHeaveDeltaM = vehicle.capture.predictedHeaveDeltaM;
    s.vehiclePredictedYawDeltaRad = vehicle.capture.predictedYawDeltaRad;
    s.vehiclePredictedPitchDeltaRad = vehicle.capture.predictedPitchDeltaRad;
    s.vehiclePredictedRollDeltaRad = vehicle.capture.predictedRollDeltaRad;
    s.vehiclePredictedResidualDeltaM = vehicle.capture.predictedResidualDeltaM;
    s.vehiclePredictedResidualPlanarDeltaM = vehicle.capture.predictedResidualPlanarDeltaM;
    s.vehiclePredictedResidualHeaveDeltaM = vehicle.capture.predictedResidualHeaveDeltaM;
    s.vehiclePredictedResidualYawDeltaRad = vehicle.capture.predictedResidualYawDeltaRad;
    s.vehiclePredictedResidualPitchDeltaRad = vehicle.capture.predictedResidualPitchDeltaRad;
    s.vehiclePredictedResidualRollDeltaRad = vehicle.capture.predictedResidualRollDeltaRad;
    s.vehicleMeshFrameDeltaM = vehicle.capture.meshFrameDeltaM;
    s.vehicleMeshFrameRotDeltaRad = vehicle.capture.meshFrameRotDeltaRad;
    s.vehicleCameraFrameDeltaM = vehicle.capture.cameraFrameDeltaM;
    s.vehicleCameraFrameRotDeltaRad = vehicle.capture.cameraFrameRotDeltaRad;
    s.vehicleMeshDeltaRms5sM = vehicle.meshDeltaRms5sM;
    s.vehicleMeshDeltaPeak5sM = vehicle.meshDeltaPeak5sM;
    s.vehicleRestJitterRms5sM = vehicle.restJitterRms5sM;
    s.vehicleStraightJitterRms5sM = vehicle.straightJitterRms5sM;
    s.vehicleRawHeaveDeltaRms5sM = vehicle.rawHeaveDeltaRms5sM;
    s.vehicleRawHeaveDeltaPeak5sM = vehicle.rawHeaveDeltaPeak5sM;
    s.vehicleRawPlanarDeltaRms5sM = vehicle.rawPlanarDeltaRms5sM;
    s.vehicleRawPlanarDeltaPeak5sM = vehicle.rawPlanarDeltaPeak5sM;
    s.vehicleRawYawDeltaRms5sRad = vehicle.rawYawDeltaRms5sRad;
    s.vehicleRawYawDeltaPeak5sRad = vehicle.rawYawDeltaPeak5sRad;
    s.vehicleRawPitchDeltaRms5sRad = vehicle.rawPitchDeltaRms5sRad;
    s.vehicleRawPitchDeltaPeak5sRad = vehicle.rawPitchDeltaPeak5sRad;
    s.vehicleRawRollDeltaRms5sRad = vehicle.rawRollDeltaRms5sRad;
    s.vehicleRawRollDeltaPeak5sRad = vehicle.rawRollDeltaPeak5sRad;
    s.vehicleResidualDeltaRms5sM = vehicle.residualDeltaRms5sM;
    s.vehicleResidualDeltaPeak5sM = vehicle.residualDeltaPeak5sM;
    s.vehicleResidualPlanarDeltaRms5sM = vehicle.residualPlanarDeltaRms5sM;
    s.vehicleResidualPlanarDeltaPeak5sM = vehicle.residualPlanarDeltaPeak5sM;
    s.vehicleResidualHeaveDeltaRms5sM = vehicle.residualHeaveDeltaRms5sM;
    s.vehicleResidualHeaveDeltaPeak5sM = vehicle.residualHeaveDeltaPeak5sM;
    s.vehicleResidualYawDeltaRms5sRad = vehicle.residualYawDeltaRms5sRad;
    s.vehicleResidualYawDeltaPeak5sRad = vehicle.residualYawDeltaPeak5sRad;
    s.vehicleResidualPitchDeltaRms5sRad = vehicle.residualPitchDeltaRms5sRad;
    s.vehicleResidualPitchDeltaPeak5sRad = vehicle.residualPitchDeltaPeak5sRad;
    s.vehicleResidualRollDeltaRms5sRad = vehicle.residualRollDeltaRms5sRad;
    s.vehicleResidualRollDeltaPeak5sRad = vehicle.residualRollDeltaPeak5sRad;
    s.vehicleRawRestHeaveDeltaRms5sM = vehicle.rawRestHeaveDeltaRms5sM;
    s.vehicleRawStraightHeaveDeltaRms5sM = vehicle.rawStraightHeaveDeltaRms5sM;
    s.vehicleWheelContactBits = vehicle.wheelContactBits;
    s.vehicleWheelContactBitChanges5s = vehicle.wheelContactBitChanges5s;
    s.vehicleWheelContactNormals = vehicle.wheelContactNormals.map((normal) => [...normal] as [number, number, number]);
    s.vehicleWheelContactNormalDeltaRms5sRad = vehicle.wheelContactNormalDeltaRms5sRad;
    s.vehicleWheelGroundObjectIds = [...vehicle.wheelGroundObjectIds] as [number, number, number, number];
    s.vehicleWheelGroundObjectSwitches5s = vehicle.wheelGroundObjectSwitches5s;
    s.vehicleSuspensionLengths = [...vehicle.suspensionLengths] as [number, number, number, number];
    s.vehicleSuspensionForces = [...vehicle.suspensionForces] as [number, number, number, number];
    s.vehicleSuspensionRelativeVelocities = [...vehicle.suspensionRelativeVelocities] as [number, number, number, number];
    s.vehicleSuspensionLengthSpreadM = vehicle.suspensionLengthSpreadM;
    s.vehicleSuspensionLengthSpreadPeak5sM = vehicle.suspensionLengthSpreadPeak5sM;
    s.vehicleSuspensionLengthDeltaRms5sM = vehicle.suspensionLengthDeltaRms5sM;
    s.vehicleSuspensionForceSpreadN = vehicle.suspensionForceSpreadN;
    s.vehicleSuspensionForceSpreadPeak5sN = vehicle.suspensionForceSpreadPeak5sN;
    s.vehicleSuspensionForceDeltaRms5sN = vehicle.suspensionForceDeltaRms5sN;
    s.vehicleMeshFrameDeltaRms5sM = vehicle.meshFrameDeltaRms5sM;
    s.vehicleMeshFrameDeltaPeak5sM = vehicle.meshFrameDeltaPeak5sM;
    s.vehicleMeshFrameRotDeltaRms5sRad = vehicle.meshFrameRotDeltaRms5sRad;
    s.vehicleMeshFrameRotDeltaPeak5sRad = vehicle.meshFrameRotDeltaPeak5sRad;
    s.vehicleCameraFrameDeltaRms5sM = vehicle.cameraFrameDeltaRms5sM;
    s.vehicleCameraFrameDeltaPeak5sM = vehicle.cameraFrameDeltaPeak5sM;
    s.vehicleCameraFrameRotDeltaRms5sRad = vehicle.cameraFrameRotDeltaRms5sRad;
    s.vehicleCameraFrameRotDeltaPeak5sRad = vehicle.cameraFrameRotDeltaPeak5sRad;
    s.vehicleGroundedTransitions5s = vehicle.groundedTransitions5s;
    s.vehicleGroundedMin5s = vehicle.groundedMin5s;
    s.vehicleGroundedMax5s = vehicle.groundedMax5s;
    s.vehicleLatestAuthDeltaM = vehicle.latestAuthDeltaM;
    s.vehicleSampledAuthDeltaM = vehicle.sampledAuthDeltaM;
    s.vehicleMeshAuthDeltaM = vehicle.meshAuthDeltaM;
    s.vehicleLatestVsSampledAuthDeltaM = vehicle.latestVsSampledAuthDeltaM;
    s.vehicleCurrentAuthDeltaM = vehicle.currentAuthDeltaM;
    s.vehicleMeshCurrentAuthDeltaM = vehicle.meshCurrentAuthDeltaM;
    s.vehicleExpectedLeadM = vehicle.expectedLeadM;
    s.vehicleCurrentAuthUnexplainedDeltaM = vehicle.currentAuthUnexplainedDeltaM;
    s.vehicleCurrentAuthPlanarDeltaM = vehicle.currentAuthPlanarDeltaM;
    s.vehicleCurrentAuthVerticalDeltaM = vehicle.currentAuthVerticalDeltaM;
    s.vehicleAuthObservedAgeMs = vehicle.authObservedAgeMs;
    s.vehicleAuthSampleOffsetMs = vehicle.authSampleOffsetMs;
    s.vehicleAuthSampleServerDeltaMs = vehicle.authSampleServerDeltaMs;
    s.vehicleAuthCurrentOffsetMs = vehicle.authCurrentOffsetMs;
    s.vehiclePredictedAuthDeltaRms5sM = vehicle.predictedAuthDeltaRms5sM;
    s.vehiclePredictedAuthDeltaPeak5sM = vehicle.predictedAuthDeltaPeak5sM;
    s.destructibleChunkCount = destructibles.chunkCount;
    s.destructibleFractureEventsTotal = destructibles.fractureEventsTotal;
    s.destructibleDebugState = destructibles.debugState;
    s.destructibleDebugConfig = destructibles.debugConfig;
    s.destructibleLoggingEnabled = destructibles.loggingEnabled;
    s.position = position;
    s.velocity = player.velocity;
    s.speedMs = speedMs;
    s.hp = player.hp;
    s.energy = player.energy;
    s.onGround = (player.localFlags & 0x1) !== 0;  // FLAG_ON_GROUND
    s.inVehicle = (player.localFlags & 0x2) !== 0; // FLAG_IN_VEHICLE
    s.dead = (player.localFlags & 0x4) !== 0;      // FLAG_DEAD
    s.heapUsedMb = heapUsedMb;
    s.heapTotalMb = heapTotalMb;

    if (deepCaptureEnabledRef.current && vehicle.id !== 0) {
      const captureSamples = deepCaptureSamplesRef.current;
      captureSamples.push({
        atMs: now,
        frameTimeMs,
        speedMs: vehicle.localSpeedMs,
        groundedWheels: vehicle.groundedWheels,
        wheelContactBits: vehicle.capture.wheelContactBits,
        wheelContactBitChanges: vehicle.capture.wheelContactBitChangesThisFrame,
        wheelContactNormalDeltaRad: vehicle.capture.wheelContactNormalDeltaRad,
        wheelGroundObjectSwitches: vehicle.capture.wheelGroundObjectSwitchesThisFrame,
        ackBacklogMs: physics.vehicleAckBacklogMs,
        resendWindow: physics.vehicleResendWindow,
        replayErrorM: physics.vehicleReplayErrorM,
        correctionM: physics.vehicleCorrectionMagnitude,
        predictedFrameDeltaM: vehicle.capture.predictedFrameDeltaM,
        predictedPlanarDeltaM: vehicle.capture.predictedPlanarDeltaM,
        predictedHeaveDeltaM: vehicle.capture.predictedHeaveDeltaM,
        predictedYawDeltaRad: vehicle.capture.predictedYawDeltaRad,
        predictedPitchDeltaRad: vehicle.capture.predictedPitchDeltaRad,
        predictedRollDeltaRad: vehicle.capture.predictedRollDeltaRad,
        predictedResidualDeltaM: vehicle.capture.predictedResidualDeltaM,
        predictedResidualPlanarDeltaM: vehicle.capture.predictedResidualPlanarDeltaM,
        predictedResidualHeaveDeltaM: vehicle.capture.predictedResidualHeaveDeltaM,
        predictedResidualYawDeltaRad: vehicle.capture.predictedResidualYawDeltaRad,
        predictedResidualPitchDeltaRad: vehicle.capture.predictedResidualPitchDeltaRad,
        predictedResidualRollDeltaRad: vehicle.capture.predictedResidualRollDeltaRad,
        meshFrameDeltaM: vehicle.capture.meshFrameDeltaM,
        meshFrameRotDeltaRad: vehicle.capture.meshFrameRotDeltaRad,
        meshOffsetToPredictedM: vehicle.meshDeltaM,
        meshOffsetToCurrentAuthM: vehicle.meshCurrentAuthDeltaM,
        cameraFrameDeltaM: vehicle.capture.cameraFrameDeltaM,
        cameraFrameRotDeltaRad: vehicle.capture.cameraFrameRotDeltaRad,
        suspensionLengthSpreadM: vehicle.capture.suspensionLengthSpreadM,
        suspensionForceSpreadN: vehicle.capture.suspensionForceSpreadN,
        suspensionLengthDeltaM: vehicle.capture.suspensionLengthDeltaM,
        suspensionForceDeltaN: vehicle.capture.suspensionForceDeltaN,
        currentAuthDeltaM: vehicle.currentAuthDeltaM,
        currentAuthPlanarDeltaM: vehicle.capture.currentAuthPlanarDeltaM,
        currentAuthVerticalDeltaM: vehicle.capture.currentAuthVerticalDeltaM,
        currentAuthUnexplainedDeltaM: vehicle.capture.currentAuthUnexplainedDeltaM,
        expectedLeadM: vehicle.capture.expectedLeadM,
        groundedTransitionThisFrame: vehicle.capture.groundedTransitionThisFrame,
      });
      while (captureSamples.length > 0 && now - captureSamples[0].atMs > DEEP_CAPTURE_WINDOW_MS) {
        captureSamples.shift();
      }
    }

    // Keep this updated even when the debug overlay is hidden because the
    // always-visible HUD reads from the same display stats object.
    if (now - lastUiUpdate.current >= OVERLAY_UPDATE_INTERVAL_MS) {
      lastUiUpdate.current = now;
      setDisplayStats({ ...s });
    }
  }, []);

  const getStatsSnapshot = useCallback((): DebugStats => ({ ...statsRef.current }), []);
  const getDeepCaptureMarkdown = useCallback((): string | null => {
    if (deepCaptureSamplesRef.current.length === 0) {
      return deepCaptureEnabledRef.current ? buildVehicleDeepCaptureMarkdown([]) : null;
    }
    return buildVehicleDeepCaptureMarkdown([...deepCaptureSamplesRef.current]);
  }, []);

  return {
    visible,
    displayStats,
    updateFrame,
    recordSnapshot,
    getStatsSnapshot,
    getDeepCaptureMarkdown,
    deepCaptureEnabled,
    deepCaptureSampleCount: deepCaptureSamplesRef.current.length,
    rapierDebugModeBits: RAPIER_DEBUG_MODES[rapierDebugPresetIndex].bits,
    rapierDebugLabel: RAPIER_DEBUG_MODES[rapierDebugPresetIndex].label,
    cycleRapierDebugPreset,
  };
}
