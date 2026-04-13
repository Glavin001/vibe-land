import type { DynamicBodyStateMeters } from './protocol';

const WINDOW_MS = 15000;
const MAX_EVENTS = 64;
const MAX_SHOT_WATCH_MS = 1500;
const AUTHORITATIVE_SHOT_MOVE_THRESHOLD_M = 0.08;
const PLAYER_CORRECTION_EVENT_THRESHOLD_M = 0.25;
const VEHICLE_CORRECTION_EVENT_THRESHOLD_M = 0.25;
const DYNAMIC_CORRECTION_EVENT_THRESHOLD_M = 0.25;
const PENDING_INPUTS_EVENT_THRESHOLD = 20;
const SNAPSHOT_GAP_EVENT_THRESHOLD_MS = 100;
const EVENT_COOLDOWN_MS = 500;

type TimedValue = { atMs: number; value: number };

type ShotWatch = {
  shotId: number;
  firedAtMs: number;
  predictedDynamicBodyId: number | null;
  baselinePosition: [number, number, number] | null;
  maxAuthoritativeDeltaM: number;
  resultObserved: boolean;
  resolved: boolean;
};

export type LocalShotTelemetry = {
  predictedDynamicBodyId: number | null;
  baselineBodyPosition: [number, number, number] | null;
  interpDelayMs: number;
  dynamicInterpDelayMs: number;
  blockerDistance: number | null;
  proxyHitBodyId: number | null;
  proxyHitToi: number | null;
  blockedByBlocker: boolean;
  localPredictedDeltaM: number | null;
  dynamicSampleAgeMs: number | null;
  predictedBodyRecentInteraction: boolean;
  renderedBodyId: number | null;
  renderedBodyToi: number | null;
  renderProxyDeltaM: number | null;
  renderedBodyProxyPresent: boolean;
  renderedBodyProxyToi: number | null;
  renderedBodyProxyCenterDeltaM: number | null;
  nearestProxyBodyId: number | null;
  nearestProxyBodyToi: number | null;
  nearestProxyBodyMissDistanceM: number | null;
  nearestProxyBodyRadiusM: number | null;
  nearestRenderedBodyId: number | null;
  nearestRenderedBodyToi: number | null;
  nearestRenderedBodyMissDistanceM: number | null;
  nearestRenderedBodyRadiusM: number | null;
};

export type NetDebugTelemetrySnapshot = {
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
};

function trimTimedValues(values: TimedValue[], nowMs: number): void {
  while (values.length > 0 && nowMs - values[0].atMs > WINDOW_MS) {
    values.shift();
  }
}

function peakValue(values: TimedValue[]): number {
  let peak = 0;
  for (const sample of values) {
    if (sample.value > peak) peak = sample.value;
  }
  return peak;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.round((sorted.length - 1) * 0.95));
  return sorted[idx];
}

export class NetDebugTelemetry {
  private readonly snapshotGapsMs: TimedValue[] = [];
  private readonly playerCorrectionsM: TimedValue[] = [];
  private readonly vehicleCorrectionsM: TimedValue[] = [];
  private readonly dynamicCorrectionsM: TimedValue[] = [];
  private readonly pendingInputs: TimedValue[] = [];
  private readonly recentEvents: Array<{ atMs: number; line: string }> = [];
  private readonly pendingShots = new Map<number, ShotWatch>();
  private lastSnapshotAtMs = 0;
  private lastSnapshotSource = 'none';
  private staleSnapshotsDropped = 0;
  private reliableSnapshotsReceived = 0;
  private datagramSnapshotsReceived = 0;
  private localSnapshotsReceived = 0;
  private directSnapshotsReceived = 0;
  private shotsFired = 0;
  private shotAuthoritativeMoves = 0;
  private shotMismatches = 0;
  private lastShotOutcome = 'none';
  private lastShotOutcomeAtMs = 0;
  private lastShotTelemetry: LocalShotTelemetry | null = null;
  private lastShotServerResolution = 0;
  private lastShotServerDynamicBodyId = 0;
  private lastShotServerDynamicHitToiM = -1;
  private lastShotServerDynamicImpulseMag = -1;
  private lastPlayerCorrectionEventAtMs = -Infinity;
  private lastVehicleCorrectionEventAtMs = -Infinity;
  private lastDynamicCorrectionEventAtMs = -Infinity;
  private lastPendingInputsEventAtMs = -Infinity;
  private lastSnapshotGapEventAtMs = -Infinity;

  observeAcceptedSnapshot(
    source: 'wt-datagram' | 'wt-reliable' | 'websocket' | 'local' | 'direct',
    serverTick: number,
    playerCount: number,
    dynamicBodyCount: number,
  ): void {
    const nowMs = performance.now();
    if (this.lastSnapshotAtMs > 0) {
      const gapMs = nowMs - this.lastSnapshotAtMs;
      this.snapshotGapsMs.push({ atMs: nowMs, value: gapMs });
      trimTimedValues(this.snapshotGapsMs, nowMs);
      if (gapMs >= SNAPSHOT_GAP_EVENT_THRESHOLD_MS && nowMs - this.lastSnapshotGapEventAtMs >= EVENT_COOLDOWN_MS) {
        this.lastSnapshotGapEventAtMs = nowMs;
        this.addEvent(nowMs, `snapshot gap ${gapMs.toFixed(1)}ms (${source}, tick ${serverTick}, players ${playerCount}, bodies ${dynamicBodyCount})`);
      }
    }
    this.lastSnapshotAtMs = nowMs;
    this.lastSnapshotSource = source;
    switch (source) {
      case 'wt-datagram':
        this.datagramSnapshotsReceived += 1;
        break;
      case 'wt-reliable':
      case 'websocket':
        this.reliableSnapshotsReceived += 1;
        break;
      case 'local':
        this.localSnapshotsReceived += 1;
        break;
      case 'direct':
        this.directSnapshotsReceived += 1;
        break;
    }
  }

  observeDroppedSnapshot(source: string, incomingTick: number, latestTick: number): void {
    this.staleSnapshotsDropped += 1;
    this.addEvent(
      performance.now(),
      `dropped stale snapshot tick ${incomingTick} from ${source} (latest ${latestTick})`,
    );
  }

  observeLocalShotFired(shotId: number, shot: LocalShotTelemetry): void {
    const nowMs = performance.now();
    this.shotsFired += 1;
    this.lastShotTelemetry = shot;
    this.pendingShots.set(shotId, {
      shotId,
      firedAtMs: nowMs,
      predictedDynamicBodyId: shot.predictedDynamicBodyId,
      baselinePosition: shot.baselineBodyPosition,
      maxAuthoritativeDeltaM: 0,
      resultObserved: false,
      resolved: false,
    });
    this.addEvent(
      nowMs,
      `shot ${shotId} fired interp=${shot.interpDelayMs.toFixed(1)}ms dyn_interp=${shot.dynamicInterpDelayMs.toFixed(1)}ms dyn_age=${shot.dynamicSampleAgeMs?.toFixed(1) ?? 'n/a'}ms recent_interact=${shot.predictedBodyRecentInteraction ? 'yes' : 'no'} predicted_body=${shot.predictedDynamicBodyId ?? 0} proxy_hit=${shot.proxyHitBodyId ?? 0}@${shot.proxyHitToi?.toFixed(2) ?? 'n/a'} blocker=${shot.blockerDistance?.toFixed(2) ?? 'n/a'} blocked=${shot.blockedByBlocker ? 'yes' : 'no'} local_pred_delta=${shot.localPredictedDeltaM?.toFixed(3) ?? 'n/a'} render_hit=${shot.renderedBodyId ?? 0}@${shot.renderedBodyToi?.toFixed(2) ?? 'n/a'} render_proxy_delta=${shot.renderProxyDeltaM?.toFixed(3) ?? 'n/a'} render_proxy_present=${shot.renderedBodyProxyPresent ? 'yes' : 'no'} render_proxy_toi=${shot.renderedBodyProxyToi?.toFixed(2) ?? 'n/a'} render_proxy_center_delta=${shot.renderedBodyProxyCenterDeltaM?.toFixed(3) ?? 'n/a'} nearest_proxy=${shot.nearestProxyBodyId ?? 0}@${shot.nearestProxyBodyToi?.toFixed(2) ?? 'n/a'} miss=${shot.nearestProxyBodyMissDistanceM?.toFixed(3) ?? 'n/a'} rad=${shot.nearestProxyBodyRadiusM?.toFixed(3) ?? 'n/a'} nearest_render=${shot.nearestRenderedBodyId ?? 0}@${shot.nearestRenderedBodyToi?.toFixed(2) ?? 'n/a'} miss=${shot.nearestRenderedBodyMissDistanceM?.toFixed(3) ?? 'n/a'} rad=${shot.nearestRenderedBodyRadiusM?.toFixed(3) ?? 'n/a'}`,
    );
  }

  observeShotResult(
    shotId: number,
    confirmed: boolean,
    hitPlayerId: number,
    hitZone: number,
    serverResolution: number,
    serverDynamicBodyId: number,
    serverDynamicHitToiCm: number,
    serverDynamicImpulseCenti: number,
  ): void {
    const nowMs = performance.now();
    const watch = this.pendingShots.get(shotId);
    if (watch) {
      watch.resultObserved = true;
    }
    this.lastShotServerResolution = serverResolution;
    this.lastShotServerDynamicBodyId = serverDynamicBodyId;
    this.lastShotServerDynamicHitToiM = serverDynamicHitToiCm >= 0 ? serverDynamicHitToiCm / 100 : -1;
    this.lastShotServerDynamicImpulseMag = serverDynamicImpulseCenti >= 0 ? serverDynamicImpulseCenti / 100 : -1;
    this.lastShotOutcome = hitPlayerId !== 0
      ? `shot ${shotId} hit player ${hitPlayerId} zone ${hitZone}`
      : `shot ${shotId} result confirmed=${confirmed ? 'yes' : 'no'} player_hit=0 server=${serverResolution} dyn_body=${serverDynamicBodyId} dyn_toi=${this.lastShotServerDynamicHitToiM >= 0 ? this.lastShotServerDynamicHitToiM.toFixed(2) : 'n/a'} dyn_impulse=${this.lastShotServerDynamicImpulseMag >= 0 ? this.lastShotServerDynamicImpulseMag.toFixed(2) : 'n/a'}`;
    this.lastShotOutcomeAtMs = nowMs;
    this.addEvent(nowMs, this.lastShotOutcome);
  }

  observeAuthoritativeDynamicBodies(bodies: Map<number, DynamicBodyStateMeters>): void {
    const nowMs = performance.now();
    for (const [shotId, watch] of this.pendingShots) {
      if (watch.resolved || watch.predictedDynamicBodyId == null || watch.baselinePosition == null) {
        if (nowMs - watch.firedAtMs > MAX_SHOT_WATCH_MS) {
          this.pendingShots.delete(shotId);
        }
        continue;
      }
      const body = bodies.get(watch.predictedDynamicBodyId);
      if (body) {
        const deltaM = Math.hypot(
          body.position[0] - watch.baselinePosition[0],
          body.position[1] - watch.baselinePosition[1],
          body.position[2] - watch.baselinePosition[2],
        );
        if (deltaM > watch.maxAuthoritativeDeltaM) {
          watch.maxAuthoritativeDeltaM = deltaM;
        }
        if (deltaM >= AUTHORITATIVE_SHOT_MOVE_THRESHOLD_M) {
          watch.resolved = true;
          this.shotAuthoritativeMoves += 1;
          this.lastShotOutcome = `shot ${shotId} moved body ${watch.predictedDynamicBodyId} by ${deltaM.toFixed(3)}m`;
          this.lastShotOutcomeAtMs = nowMs;
          this.addEvent(nowMs, this.lastShotOutcome);
          this.pendingShots.delete(shotId);
          continue;
        }
      }
      if (nowMs - watch.firedAtMs > MAX_SHOT_WATCH_MS) {
        watch.resolved = true;
        this.shotMismatches += 1;
        this.lastShotOutcome = `shot ${shotId} mismatch body=${watch.predictedDynamicBodyId} auth_delta=${watch.maxAuthoritativeDeltaM.toFixed(3)}m`;
        this.lastShotOutcomeAtMs = nowMs;
        this.addEvent(nowMs, this.lastShotOutcome);
        this.pendingShots.delete(shotId);
      }
    }
  }

  observeFrameMetrics(
    playerCorrectionMagnitude: number,
    vehicleCorrectionMagnitude: number,
    dynamicCorrectionMagnitude: number,
    pendingInputCount: number,
  ): void {
    const nowMs = performance.now();
    this.playerCorrectionsM.push({ atMs: nowMs, value: playerCorrectionMagnitude });
    this.vehicleCorrectionsM.push({ atMs: nowMs, value: vehicleCorrectionMagnitude });
    this.dynamicCorrectionsM.push({ atMs: nowMs, value: dynamicCorrectionMagnitude });
    this.pendingInputs.push({ atMs: nowMs, value: pendingInputCount });
    trimTimedValues(this.playerCorrectionsM, nowMs);
    trimTimedValues(this.vehicleCorrectionsM, nowMs);
    trimTimedValues(this.dynamicCorrectionsM, nowMs);
    trimTimedValues(this.pendingInputs, nowMs);

    if (
      playerCorrectionMagnitude >= PLAYER_CORRECTION_EVENT_THRESHOLD_M
      && nowMs - this.lastPlayerCorrectionEventAtMs >= EVENT_COOLDOWN_MS
    ) {
      this.lastPlayerCorrectionEventAtMs = nowMs;
      this.addEvent(nowMs, `player correction spike ${playerCorrectionMagnitude.toFixed(3)}m`);
    }
    if (
      vehicleCorrectionMagnitude >= VEHICLE_CORRECTION_EVENT_THRESHOLD_M
      && nowMs - this.lastVehicleCorrectionEventAtMs >= EVENT_COOLDOWN_MS
    ) {
      this.lastVehicleCorrectionEventAtMs = nowMs;
      this.addEvent(nowMs, `vehicle correction spike ${vehicleCorrectionMagnitude.toFixed(3)}m`);
    }
    if (
      dynamicCorrectionMagnitude >= DYNAMIC_CORRECTION_EVENT_THRESHOLD_M
      && nowMs - this.lastDynamicCorrectionEventAtMs >= EVENT_COOLDOWN_MS
    ) {
      this.lastDynamicCorrectionEventAtMs = nowMs;
      this.addEvent(nowMs, `dynamic correction spike ${dynamicCorrectionMagnitude.toFixed(3)}m`);
    }
    if (
      pendingInputCount >= PENDING_INPUTS_EVENT_THRESHOLD
      && nowMs - this.lastPendingInputsEventAtMs >= EVENT_COOLDOWN_MS
    ) {
      this.lastPendingInputsEventAtMs = nowMs;
      this.addEvent(nowMs, `pending inputs high-water ${pendingInputCount}`);
    }
  }

  snapshot(): NetDebugTelemetrySnapshot {
    const nowMs = performance.now();
    trimTimedValues(this.snapshotGapsMs, nowMs);
    trimTimedValues(this.playerCorrectionsM, nowMs);
    trimTimedValues(this.vehicleCorrectionsM, nowMs);
    trimTimedValues(this.dynamicCorrectionsM, nowMs);
    trimTimedValues(this.pendingInputs, nowMs);

    const lastSnapshotGapMs = this.snapshotGapsMs.length > 0
      ? this.snapshotGapsMs[this.snapshotGapsMs.length - 1].value
      : 0;
    const recentEvents = this.recentEvents
      .filter((event) => nowMs - event.atMs <= WINDOW_MS)
      .slice(-8)
      .map((event) => `${((nowMs - event.atMs) / 1000).toFixed(2)}s ago: ${event.line}`);

    return {
      lastSnapshotGapMs,
      snapshotGapP95Ms: p95(this.snapshotGapsMs.map((sample) => sample.value)),
      snapshotGapMaxMs: peakValue(this.snapshotGapsMs),
      lastSnapshotSource: this.lastSnapshotSource,
      staleSnapshotsDropped: this.staleSnapshotsDropped,
      reliableSnapshotsReceived: this.reliableSnapshotsReceived,
      datagramSnapshotsReceived: this.datagramSnapshotsReceived,
      localSnapshotsReceived: this.localSnapshotsReceived,
      directSnapshotsReceived: this.directSnapshotsReceived,
      playerCorrectionPeak5sM: peakValue(this.playerCorrectionsM),
      vehicleCorrectionPeak5sM: peakValue(this.vehicleCorrectionsM),
      dynamicCorrectionPeak5sM: peakValue(this.dynamicCorrectionsM),
      pendingInputsPeak5s: peakValue(this.pendingInputs),
      shotsFired: this.shotsFired,
      shotsPending: this.pendingShots.size,
      shotAuthoritativeMoves: this.shotAuthoritativeMoves,
      shotMismatches: this.shotMismatches,
      lastShotOutcome: this.lastShotOutcome,
      lastShotOutcomeAgeMs: this.lastShotOutcomeAtMs > 0 ? nowMs - this.lastShotOutcomeAtMs : -1,
      lastShotPredictedBodyId: this.lastShotTelemetry?.predictedDynamicBodyId ?? 0,
      lastShotProxyHitBodyId: this.lastShotTelemetry?.proxyHitBodyId ?? 0,
      lastShotProxyHitToi: this.lastShotTelemetry?.proxyHitToi ?? -1,
      lastShotBlockedByBlocker: this.lastShotTelemetry?.blockedByBlocker ?? false,
      lastShotLocalPredictedDeltaM: this.lastShotTelemetry?.localPredictedDeltaM ?? -1,
      lastShotDynamicSampleAgeMs: this.lastShotTelemetry?.dynamicSampleAgeMs ?? -1,
      lastShotPredictedBodyRecentInteraction: this.lastShotTelemetry?.predictedBodyRecentInteraction ?? false,
      lastShotBlockerDistance: this.lastShotTelemetry?.blockerDistance ?? -1,
      lastShotRenderedBodyId: this.lastShotTelemetry?.renderedBodyId ?? 0,
      lastShotRenderedBodyToi: this.lastShotTelemetry?.renderedBodyToi ?? -1,
      lastShotRenderProxyDeltaM: this.lastShotTelemetry?.renderProxyDeltaM ?? -1,
      lastShotRenderedBodyProxyPresent: this.lastShotTelemetry?.renderedBodyProxyPresent ?? false,
      lastShotRenderedBodyProxyToi: this.lastShotTelemetry?.renderedBodyProxyToi ?? -1,
      lastShotRenderedBodyProxyCenterDeltaM: this.lastShotTelemetry?.renderedBodyProxyCenterDeltaM ?? -1,
      lastShotNearestProxyBodyId: this.lastShotTelemetry?.nearestProxyBodyId ?? 0,
      lastShotNearestProxyBodyToi: this.lastShotTelemetry?.nearestProxyBodyToi ?? -1,
      lastShotNearestProxyBodyMissDistanceM: this.lastShotTelemetry?.nearestProxyBodyMissDistanceM ?? -1,
      lastShotNearestProxyBodyRadiusM: this.lastShotTelemetry?.nearestProxyBodyRadiusM ?? -1,
      lastShotNearestRenderedBodyId: this.lastShotTelemetry?.nearestRenderedBodyId ?? 0,
      lastShotNearestRenderedBodyToi: this.lastShotTelemetry?.nearestRenderedBodyToi ?? -1,
      lastShotNearestRenderedBodyMissDistanceM: this.lastShotTelemetry?.nearestRenderedBodyMissDistanceM ?? -1,
      lastShotNearestRenderedBodyRadiusM: this.lastShotTelemetry?.nearestRenderedBodyRadiusM ?? -1,
      lastShotServerResolution: this.lastShotServerResolution,
      lastShotServerDynamicBodyId: this.lastShotServerDynamicBodyId,
      lastShotServerDynamicHitToiM: this.lastShotServerDynamicHitToiM,
      lastShotServerDynamicImpulseMag: this.lastShotServerDynamicImpulseMag,
      recentEvents,
    };
  }

  private addEvent(atMs: number, line: string): void {
    this.recentEvents.push({ atMs, line });
    while (this.recentEvents.length > MAX_EVENTS) {
      this.recentEvents.shift();
    }
  }
}
