/**
 * Types for the E2E bridge snapshot (window.__VIBE_E2E__).
 *
 * Must stay in sync with the bridge installed in the client (src/e2eBridge.ts).
 * These are used on the Playwright side for type-safe assertions.
 */

export interface GameE2ESnapshot {
  // Identity
  route: string;
  mode: 'practice' | 'multiplayer';
  matchId: string;

  // Connection
  connected: boolean;
  statusText: string;
  playerId: number;
  transport: string;

  // Pointer lock
  pointerLocked: boolean;

  // Debug overlay
  debugOverlayVisible: boolean;

  // Local player
  position: [number, number, number];
  velocity: [number, number, number];
  hp: number;
  onGround: boolean;
  inVehicle: boolean;
  dead: boolean;

  // Camera
  cameraPosition: [number, number, number];
  cameraYaw: number;
  cameraPitch: number;

  // Vehicle
  drivenVehicleId: number | null;
  nearestVehicleId: number | null;

  // Remote players
  remotePlayers: Array<{
    id: number;
    position: [number, number, number];
  }>;

  // Shots
  shotsFired: number;
  lastShotOutcome: string;

  // Destructibles
  destructibles: {
    chunkCount: number;
    fractureEventsTotal: number;
    debugState: {
      impactSeq: number;
      impactProcessed: number;
      impactMaxImpulseNs: number;
      impactMaxSpeedMs: number;
      impactMaxSplashNodes: number;
      impactMaxBodyNodeCount: number;
      impactMaxSplashWeightSum: number;
      impactMaxEstimatedInjectedForceN: number;
      impactInstanceId: number;
      fractureSeq: number;
      fractureInstanceId: number;
      fractureInstanceBodyCount: number;
      fractures: number;
      splitEvents: number;
      newBodies: number;
      activeBodies: number;
      postFractureMaxBodySpeedMs: number;
      postFractureFastBodyCount: number;
      sameInstanceDynamicCollisionStarts: number;
      fixedCollisionStarts: number;
      dynamicMinBodyY: number;
      parentlessStaticCollisionStarts: number;
      dynamicMinBodyInstanceId: number;
      dynamicMinBodySpeedMs: number;
      dynamicMinBodyLinvelY: number;
      dynamicMinBodyHasSupport: boolean;
      dynamicMinBodyActiveContactPairs: number;
      dynamicMinBodySameInstanceFixedContactPairs: number;
      dynamicMinBodyParentlessStaticContactPairs: number;
      currentMaxBodySpeedMs: number;
      currentMaxBodySpeedInstanceId: number;
      dynamicMinBodyX: number;
      dynamicMinBodyZ: number;
      dynamicMinBodyMaxLocalOffsetM: number;
      dynamicMinBodyCcdEnabled: boolean;
      contactEventsSeenTotal: number;
      contactEventsMatchingTotal: number;
      contactEventsOtherDestructibleSkippedTotal: number;
      contactEventsBelowImpulseSkippedTotal: number;
      contactEventsMissingPartnerBodySkippedTotal: number;
      contactEventsBelowSpeedSkippedTotal: number;
      contactEventsMissingBodyOrNodeSkippedTotal: number;
      contactEventsAcceptedTotal: number;
      contactEventsMaxRawImpulseNs: number;
      contactEventsMaxPartnerSpeedMs: number;
      contactEventsCollisionGraceOverridesTotal: number;
      contactEventsCooldownSkippedTotal: number;
      contactEventsForceCappedTotal: number;
    };
    debugConfig: {
      contactSplashRadiusM: number;
      contactForceScale: number;
      minImpactImpulseNs: number;
      minImpactSpeedMs: number;
      collisionImpactGraceSecs: number;
      wallMaterialScale: number;
      towerMaterialScale: number;
      maxFracturesPerFrame: number;
      maxNewBodiesPerFrame: number;
      applyExcessForces: boolean;
      debrisCollisionMode: 'all' | 'noDebrisPairs' | 'debrisGroundOnly' | 'debrisNone';
      impactCooldownSecs: number;
      maxInjectedImpactForceN: number;
    };
    spatialMetrics: {
      overlapPairCount: number;
      significantOverlapPairCount: number;
      maxOverlapPenetrationM: number;
      nearCoincidentPairCount: number;
      minCenterDistanceM: number;
      lowestChunkBottomY: number;
      sampleOverlapPairs: Array<{
        destructibleId: number;
        leftChunkIndex: number;
        rightChunkIndex: number;
        penetrationM: number;
        centerDistanceM: number;
        leftCenter: [number, number, number];
        rightCenter: [number, number, number];
      }>;
    };
  };

  // Debug stats (full payload)
  debugStats: {
    fps: number;
    transport: string;
    pingMs: number;
    remotePlayers: number;
    playerId: number;
    position: [number, number, number];
    velocity: [number, number, number];
    hp: number;
    onGround: boolean;
    inVehicle: boolean;
    dead: boolean;
    shotsFired: number;
    lastShotOutcome: string;
    snapshotsPerSec: number;
  };
}

export interface VibeE2EBridge {
  version: number;
  snapshot(): GameE2ESnapshot;
}
