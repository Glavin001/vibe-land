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

  // Thin-authoritative movement diagnostics
  movementTelemetry: {
    renderedPosition: [number, number, number];
    authoritativePosition: [number, number, number];
    presentationOffset: [number, number, number];
    authoritativeVelocity: [number, number, number];
    frameDeltaMs: number;
  };

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
    serverTick: number;
    datagramSnapshotsReceived: number;
    reliableSnapshotsReceived: number;
    lastSnapshotGapMs: number;
    interpolationDelayMs: number;
    jitterMs: number;
    snapshotGapP95Ms: number;
    snapshotGapMaxMs: number;
    playerCorrectionMagnitude: number;
    playerCorrectionPeak5sM: number;
  };
}

export interface VibeE2EBridge {
  version: number;
  snapshot(): GameE2ESnapshot;
}
