/**
 * E2E Testing Bridge — window.__VIBE_E2E__
 *
 * Always-on, read-only, versioned introspection bridge for Playwright E2E tests.
 * Exposes a snapshot() method that returns a fully-serializable GameE2ESnapshot.
 *
 * RULES:
 * - Read-only: no mutating commands (move, shoot, teleport, etc.)
 * - Always-on: available on both /practice and /play, before and after join
 * - Versioned: bridge.version is bumped on breaking schema changes
 */

import type { DebugStats } from './ui/DebugOverlay';
import { DEFAULT_STATS } from './ui/DebugOverlay';
import { renderStats } from './city/renderStats';

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

  // Debug stats (subset for assertions)
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

  // Destructible city (null outside city-* matches)
  city: CityE2EStats | null;
}

export interface CityE2EStats {
  wireVersion: number;
  chunksTotal: number;
  chunksAwake: number;
  chunksSettled: number;
  brokenBonds: number;
  liveIslands: number;
  topoSeqGaps: number;
  datagramsReceived: number;
  bytesPerSecond: number;
  manifestHash: string;
  /** False when the chunk mesh failed to build — the city is streaming but invisible. */
  rendered: boolean;
  /** Lowest chunk centroid, in metres. The city ground is a flat plane at y=0. */
  minChunkY: number;
  /** Chunks whose centroid has sunk below the ground plane. */
  chunksBelowGround: number;
  /**
   * Milliseconds this layer spent recomposing chunk transforms, p95.
   *
   * Distinct from `frame p95`, which is a requestAnimationFrame delta and so
   * is quantised by vsync -- a 17 ms frame and a 33 ms frame both report 33 ms
   * at 30 fps, which makes real improvements invisible. This measures only the
   * work this layer does, so it can be optimised against.
   */
  chunkUpdateP95Ms: number;
  /** Chunks whose owning body vanished from the ledger. Must be 0. */
  orphanedChunks: number;
  /**
   * Chunks DRAWN somewhere other than where the ledger says they are.
   *
   * The only counter that can see a mis-composed chunk: triangle counts, draw
   * calls, awake bodies and topology gaps are all unchanged when geometry is
   * merely in the wrong place. Requires the netlab recorder to be running,
   * which owns the per-slot last-drawn positions; 0 when it is not.
   */
  staleDrawnChunks: number;
  /// Ledger rebuilds this session, and settles refused for a frame mismatch.
  bootstraps: number;
  settleRejects: number;
  valveApplies: number;
  valveTicksAhead: number;
  /** Cumulative chunks orphaned by a retire, including transient windows. */
  orphanedByRetire: number;
  /**
   * Provenance of the lowest chunk, when it is genuinely sunk.
   *
   * Counting sunk chunks says a fault exists; this says which one and what it
   * was composed from, so the body pose and the local offset can be told
   * apart without guessing which of the two is wrong.
   */
  deepest?: {
    slot: number;
    structure: number;
    node: number;
    worldY: number;
    islandSerial: number | null;
    bodyPos: [number, number, number] | null;
    bodyMembers: number;
    localOffset: [number, number, number];
  } | null;
}

export interface VibeE2EBridge {
  version: number;
  snapshot(): GameE2ESnapshot;
  /**
   * Last frame's CPU breakdown (see city/renderStats).
   *
   * Separate from `snapshot()` so a harness can poll it every frame without
   * paying for the whole snapshot, and so perf work can be measured from a
   * script instead of read off a screenshot.
   */
  frameProfile(): Record<string, number>;
}

// ---------------------------------------------------------------------------
// Mutable refs — set by the App/GameWorld components each frame
// ---------------------------------------------------------------------------

const refs = {
  route: '',
  mode: 'practice' as 'practice' | 'multiplayer',
  matchId: '',
  connected: false,
  statusText: '',
  playerId: 0,
  debugOverlayVisible: false,
  cameraPosition: [0, 0, 0] as [number, number, number],
  cameraYaw: 0,
  cameraPitch: 0,
  movementTelemetry: {
    renderedPosition: [0, 0, 0],
    authoritativePosition: [0, 0, 0],
    presentationOffset: [0, 0, 0],
    authoritativeVelocity: [0, 0, 0],
    frameDeltaMs: 0,
  } as GameE2ESnapshot['movementTelemetry'],
  drivenVehicleId: null as number | null,
  nearestVehicleId: null as number | null,
  remotePlayers: [] as Array<{ id: number; position: [number, number, number] }>,
  statsSnapshot: { ...DEFAULT_STATS } as DebugStats,
  city: null as CityE2EStats | null,
};

/** Update destructible-city stats. Called by CityChunksLayer (throttled). */
export function updateCityE2E(stats: CityE2EStats | null): void {
  refs.city = stats;
}

/** Update bridge refs. Called by App component on state changes. */
export function updateE2EBridgeAppState(state: {
  route: string;
  mode: 'practice' | 'multiplayer';
  matchId: string;
  connected: boolean;
  statusText: string;
  playerId: number;
  debugOverlayVisible: boolean;
}): void {
  refs.route = state.route;
  refs.mode = state.mode;
  refs.matchId = state.matchId;
  refs.connected = state.connected;
  refs.statusText = state.statusText;
  refs.playerId = state.playerId;
  refs.debugOverlayVisible = state.debugOverlayVisible;
}

/** Update bridge refs from the game frame loop. Called each render frame. */
export function updateE2EBridgeFrameState(state: {
  cameraPosition: [number, number, number];
  cameraYaw: number;
  cameraPitch: number;
  movementTelemetry: GameE2ESnapshot['movementTelemetry'];
  drivenVehicleId: number | null;
  nearestVehicleId: number | null;
  remotePlayers: Array<{ id: number; position: [number, number, number] }>;
  stats: DebugStats;
}): void {
  refs.cameraPosition = state.cameraPosition;
  refs.cameraYaw = state.cameraYaw;
  refs.cameraPitch = state.cameraPitch;
  refs.movementTelemetry = state.movementTelemetry;
  refs.drivenVehicleId = state.drivenVehicleId;
  refs.nearestVehicleId = state.nearestVehicleId;
  refs.remotePlayers = state.remotePlayers;
  refs.statsSnapshot = state.stats;
}

function buildSnapshot(): GameE2ESnapshot {
  const s = refs.statsSnapshot;
  return {
    route: refs.route,
    mode: refs.mode,
    matchId: refs.matchId,
    connected: refs.connected,
    statusText: refs.statusText,
    playerId: refs.playerId,
    transport: s.transport,
    pointerLocked: document.pointerLockElement != null,
    debugOverlayVisible: refs.debugOverlayVisible,
    position: [...s.position],
    velocity: [...s.velocity],
    hp: s.hp,
    onGround: s.onGround,
    inVehicle: s.inVehicle,
    dead: s.dead,
    cameraPosition: [...refs.cameraPosition],
    cameraYaw: refs.cameraYaw,
    cameraPitch: refs.cameraPitch,
    movementTelemetry: {
      renderedPosition: [...refs.movementTelemetry.renderedPosition],
      authoritativePosition: [...refs.movementTelemetry.authoritativePosition],
      presentationOffset: [...refs.movementTelemetry.presentationOffset],
      authoritativeVelocity: [...refs.movementTelemetry.authoritativeVelocity],
      frameDeltaMs: refs.movementTelemetry.frameDeltaMs,
    },
    drivenVehicleId: refs.drivenVehicleId,
    nearestVehicleId: refs.nearestVehicleId,
    remotePlayers: refs.remotePlayers.map((rp) => ({
      id: rp.id,
      position: [...rp.position] as [number, number, number],
    })),
    shotsFired: s.shotsFired,
    lastShotOutcome: s.lastShotOutcome,
    debugStats: {
      fps: s.fps,
      transport: s.transport,
      pingMs: s.pingMs,
      remotePlayers: s.remotePlayers,
      playerId: s.playerId,
      position: [...s.position],
      velocity: [...s.velocity],
      hp: s.hp,
      onGround: s.onGround,
      inVehicle: s.inVehicle,
      dead: s.dead,
      shotsFired: s.shotsFired,
      lastShotOutcome: s.lastShotOutcome,
      snapshotsPerSec: s.snapshotsPerSec,
      serverTick: s.serverTick,
      datagramSnapshotsReceived: s.datagramSnapshotsReceived,
      reliableSnapshotsReceived: s.reliableSnapshotsReceived,
      lastSnapshotGapMs: s.lastSnapshotGapMs,
      interpolationDelayMs: s.interpolationDelayMs,
      jitterMs: s.jitterMs,
      snapshotGapP95Ms: s.snapshotGapP95Ms,
      snapshotGapMaxMs: s.snapshotGapMaxMs,
      playerCorrectionMagnitude: s.playerCorrectionMagnitude,
      playerCorrectionPeak5sM: s.playerCorrectionPeak5sM,
    },
    city: refs.city ? { ...refs.city } : null,
  };
}

// ---------------------------------------------------------------------------
// Install the bridge on window — runs once at module load
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __VIBE_E2E__?: VibeE2EBridge;
  }
}

const bridge: VibeE2EBridge = {
  version: 1,
  snapshot: buildSnapshot,
  frameProfile: () => ({ ...renderStats }),
};

// Always install — not gated behind a flag
if (typeof window !== 'undefined') {
  window.__VIBE_E2E__ = bridge;
}
