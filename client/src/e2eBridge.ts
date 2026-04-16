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
  };
}

export interface VibeE2EBridge {
  version: number;
  snapshot(): GameE2ESnapshot;
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
  drivenVehicleId: null as number | null,
  nearestVehicleId: null as number | null,
  remotePlayers: [] as Array<{ id: number; position: [number, number, number] }>,
  statsSnapshot: { ...DEFAULT_STATS } as DebugStats,
};

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
  drivenVehicleId: number | null;
  nearestVehicleId: number | null;
  remotePlayers: Array<{ id: number; position: [number, number, number] }>;
  stats: DebugStats;
}): void {
  refs.cameraPosition = state.cameraPosition;
  refs.cameraYaw = state.cameraYaw;
  refs.cameraPitch = state.cameraPitch;
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
    },
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
};

// Always install — not gated behind a flag
if (typeof window !== 'undefined') {
  window.__VIBE_E2E__ = bridge;
}
