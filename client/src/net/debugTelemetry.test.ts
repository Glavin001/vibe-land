import { describe, expect, it, vi, afterEach } from 'vitest';
import { NetDebugTelemetry } from './debugTelemetry';
import type { DynamicBodyStateMeters } from './protocol';

function makeBody(id: number, x: number): DynamicBodyStateMeters {
  return {
    id,
    shapeType: 1,
    position: [x, 0, 0],
    quaternion: [0, 0, 0, 1],
    halfExtents: [0.5, 0, 0],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  };
}

describe('NetDebugTelemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records shot mismatch when authoritative body never moves', () => {
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

    const telemetry = new NetDebugTelemetry();
    telemetry.observeLocalShotFired(1, {
      predictedDynamicBodyId: 7,
      baselineBodyPosition: [0, 0, 0],
      interpDelayMs: 66,
      dynamicInterpDelayMs: 5,
      blockerDistance: null,
      proxyHitBodyId: 7,
      proxyHitToi: 4,
      blockedByBlocker: false,
      localPredictedDeltaM: 0.32,
      dynamicSampleAgeMs: 24,
      predictedBodyRecentInteraction: false,
      renderedBodyId: 7,
      renderedBodyToi: 4,
      renderProxyDeltaM: 0,
      renderedBodyProxyPresent: true,
      renderedBodyProxyToi: 4,
      renderedBodyProxyCenterDeltaM: 0,
      nearestProxyBodyId: 7,
      nearestProxyBodyToi: 4,
      nearestProxyBodyMissDistanceM: 0,
      nearestProxyBodyRadiusM: 0.5,
      nearestRenderedBodyId: 7,
      nearestRenderedBodyToi: 4,
      nearestRenderedBodyMissDistanceM: 0,
      nearestRenderedBodyRadiusM: 0.5,
    });

    const bodies = new Map<number, DynamicBodyStateMeters>();
    bodies.set(7, makeBody(7, 0));

    nowMs += 1600;
    telemetry.observeAuthoritativeDynamicBodies(bodies);

    const snapshot = telemetry.snapshot();
    expect(snapshot.shotMismatches).toBe(1);
    expect(snapshot.lastShotOutcome).toContain('mismatch');
  });

  it('records authoritative move when shot body displacement arrives', () => {
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

    const telemetry = new NetDebugTelemetry();
    telemetry.observeLocalShotFired(2, {
      predictedDynamicBodyId: 9,
      baselineBodyPosition: [0, 0, 0],
      interpDelayMs: 66,
      dynamicInterpDelayMs: 5,
      blockerDistance: null,
      proxyHitBodyId: 9,
      proxyHitToi: 4,
      blockedByBlocker: false,
      localPredictedDeltaM: 0.21,
      dynamicSampleAgeMs: 18,
      predictedBodyRecentInteraction: false,
      renderedBodyId: 9,
      renderedBodyToi: 4,
      renderProxyDeltaM: 0,
      renderedBodyProxyPresent: true,
      renderedBodyProxyToi: 4,
      renderedBodyProxyCenterDeltaM: 0,
      nearestProxyBodyId: 9,
      nearestProxyBodyToi: 4,
      nearestProxyBodyMissDistanceM: 0,
      nearestProxyBodyRadiusM: 0.5,
      nearestRenderedBodyId: 9,
      nearestRenderedBodyToi: 4,
      nearestRenderedBodyMissDistanceM: 0,
      nearestRenderedBodyRadiusM: 0.5,
    });

    const bodies = new Map<number, DynamicBodyStateMeters>();
    bodies.set(9, makeBody(9, 0.2));
    telemetry.observeAuthoritativeDynamicBodies(bodies);

    const snapshot = telemetry.snapshot();
    expect(snapshot.shotAuthoritativeMoves).toBe(1);
    expect(snapshot.lastShotOutcome).toContain('moved body 9');
  });

  it('records server-side shot diagnostics from shot results', () => {
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

    const telemetry = new NetDebugTelemetry();
    telemetry.observeShotResult(4, false, 0, 0, 2, 11, 842, 650);

    const snapshot = telemetry.snapshot();
    expect(snapshot.lastShotServerResolution).toBe(2);
    expect(snapshot.lastShotServerDynamicBodyId).toBe(11);
    expect(snapshot.lastShotServerDynamicHitToiM).toBeCloseTo(8.42);
    expect(snapshot.lastShotServerDynamicImpulseMag).toBeCloseTo(6.5);
  });

  it('counts stale snapshots and recent events', () => {
    let nowMs = 500;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

    const telemetry = new NetDebugTelemetry();
    telemetry.observeDroppedSnapshot('wt-datagram', 10, 12);

    const snapshot = telemetry.snapshot();
    expect(snapshot.staleSnapshotsDropped).toBe(1);
    expect(snapshot.recentEvents.some((line) => line.includes('dropped stale snapshot'))).toBe(true);
  });

  it('retains detailed shot diagnostics long enough for delayed debug dumps', () => {
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

    const telemetry = new NetDebugTelemetry();
    telemetry.observeLocalShotFired(3, {
      predictedDynamicBodyId: 12,
      baselineBodyPosition: [1, 0, 0],
      interpDelayMs: 66,
      dynamicInterpDelayMs: 5,
      blockerDistance: 3.5,
      proxyHitBodyId: 12,
      proxyHitToi: 4.2,
      blockedByBlocker: true,
      localPredictedDeltaM: null,
      dynamicSampleAgeMs: 33,
      predictedBodyRecentInteraction: true,
      renderedBodyId: 12,
      renderedBodyToi: 4.0,
      renderProxyDeltaM: 0.18,
      renderedBodyProxyPresent: true,
      renderedBodyProxyToi: 4.15,
      renderedBodyProxyCenterDeltaM: 0.18,
      nearestProxyBodyId: 12,
      nearestProxyBodyToi: 4.15,
      nearestProxyBodyMissDistanceM: 0.18,
      nearestProxyBodyRadiusM: 0.5,
      nearestRenderedBodyId: 12,
      nearestRenderedBodyToi: 4.0,
      nearestRenderedBodyMissDistanceM: 0.12,
      nearestRenderedBodyRadiusM: 0.5,
    });

    nowMs += 10_000;
    const snapshot = telemetry.snapshot();
    expect(snapshot.lastShotPredictedBodyId).toBe(12);
    expect(snapshot.lastShotProxyHitBodyId).toBe(12);
    expect(snapshot.lastShotBlockedByBlocker).toBe(true);
    expect(snapshot.lastShotLocalPredictedDeltaM).toBe(-1);
    expect(snapshot.lastShotDynamicSampleAgeMs).toBeCloseTo(33);
    expect(snapshot.lastShotPredictedBodyRecentInteraction).toBe(true);
    expect(snapshot.lastShotRenderProxyDeltaM).toBeCloseTo(0.18);
    expect(snapshot.lastShotRenderedBodyProxyPresent).toBe(true);
    expect(snapshot.lastShotRenderedBodyProxyToi).toBeCloseTo(4.15);
    expect(snapshot.lastShotRenderedBodyProxyCenterDeltaM).toBeCloseTo(0.18);
    expect(snapshot.lastShotNearestProxyBodyId).toBe(12);
    expect(snapshot.lastShotNearestProxyBodyToi).toBeCloseTo(4.15);
    expect(snapshot.lastShotNearestProxyBodyMissDistanceM).toBeCloseTo(0.18);
    expect(snapshot.lastShotNearestRenderedBodyId).toBe(12);
    expect(snapshot.lastShotNearestRenderedBodyToi).toBeCloseTo(4.0);
    expect(snapshot.lastShotServerResolution).toBe(0);
    expect(snapshot.recentEvents.some((line) => line.includes('shot 3 fired'))).toBe(true);
  });
});
