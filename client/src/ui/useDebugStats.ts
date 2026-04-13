import { useEffect, useRef, useState, useCallback } from 'react';
import type { DebugStats } from './DebugOverlay';
import { DEFAULT_STATS } from './DebugOverlay';

const FPS_SAMPLE_COUNT = 60;
const OVERLAY_UPDATE_INTERVAL_MS = 100; // 10Hz UI refresh
const JITTER_SAMPLE_COUNT = 30; // rolling window of snapshot intervals
const RAPIER_DEBUG_MODES = [
  { bits: 0, label: 'off' },
  { bits: 0b11, label: 'shapes' },
  { bits: 0b1111, label: 'joints' },
  { bits: 0b1111111, label: 'full' },
] as const;

export function useDebugStats() {
  const [visible, setVisible] = useState(false);
  const [displayStats, setDisplayStats] = useState<DebugStats>({ ...DEFAULT_STATS });
  const [rapierDebugPresetIndex, setRapierDebugPresetIndex] = useState(0);
  const statsRef = useRef<DebugStats>({ ...DEFAULT_STATS });
  const frameTimes = useRef<number[]>([]);
  const snapshotTimestamps = useRef<number[]>([]);
  const snapshotIntervals = useRef<number[]>([]);
  const lastSnapshotTs = useRef<number>(0);
  const lastUiUpdate = useRef(0);
  const visibleRef = useRef(false);

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
        setRapierDebugPresetIndex((index) => {
          if (e.shiftKey) {
            return (index + 1) % RAPIER_DEBUG_MODES.length;
          }
          return index === 0 ? 1 : 0;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    position: [number, number, number],
    player: { velocity: [number, number, number]; hp: number; localFlags: number },
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

    // Jitter: std dev of inter-arrival intervals (in ms)
    const intervals = snapshotIntervals.current;
    let jitterMs = 0;
    if (intervals.length >= 2) {
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
    s.pingMs = network.pingMs;
    s.serverTick = network.serverTick;
    s.interpolationDelayMs = network.interpolationDelayMs;
    s.dynamicBodyInterpolationDelayMs = network.dynamicBodyInterpolationDelayMs;
    s.clockOffsetUs = network.clockOffsetUs;
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
    s.position = position;
    s.velocity = player.velocity;
    s.speedMs = speedMs;
    s.hp = player.hp;
    s.onGround = (player.localFlags & 0x1) !== 0;  // FLAG_ON_GROUND
    s.inVehicle = (player.localFlags & 0x2) !== 0; // FLAG_IN_VEHICLE
    s.dead = (player.localFlags & 0x4) !== 0;      // FLAG_DEAD
    s.heapUsedMb = heapUsedMb;
    s.heapTotalMb = heapTotalMb;

    // Throttled React state update for overlay rendering (10Hz)
    if (visibleRef.current && now - lastUiUpdate.current >= OVERLAY_UPDATE_INTERVAL_MS) {
      lastUiUpdate.current = now;
      setDisplayStats({ ...s });
    }
  }, []);

  const getStatsSnapshot = useCallback((): DebugStats => ({ ...statsRef.current }), []);

  return {
    visible,
    displayStats,
    updateFrame,
    recordSnapshot,
    getStatsSnapshot,
    rapierDebugModeBits: RAPIER_DEBUG_MODES[rapierDebugPresetIndex].bits,
    rapierDebugLabel: RAPIER_DEBUG_MODES[rapierDebugPresetIndex].label,
  };
}
