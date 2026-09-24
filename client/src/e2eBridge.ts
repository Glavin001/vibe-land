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
import { acquireCityDiagnostics } from './city/cityDiagnostics';
import { setCannonballEnabled, setShotMode, type ShotMode } from './city/shotMode';
import { meteorDrawn, meteorFlights } from './vfx/meteorFlights';
import {
  ambientOcclusionPreferred,
  cityTextureDetail,
  dprCapOverride,
  heroTilingEnabled,
  instanceShareThresholdSetting,
  qualityTier,
  setAmbientOcclusionEnabled,
  setDustFluid,
  setDustMode,
  setQualityTier,
  setShadowsEnabled,
  setInstanceShareThreshold,
  setHeroTilingEnabled,
  shadowsEnabled,
} from './app/renderQuality';
import { updateFogSettings } from './graphics/fogSettings';
import { setLookTuning } from './graphics/lookTuning';
import { pushDebugDustSource } from './vfx/dustDebug';

let dustBurstSerial = 1;
import { setCapturePose } from './scene/captureCamera';
import { cityTapeRecorder, saveCityTape } from './city/cityTape';
import { uploadTape } from './city/hotspotWatch';
import {
  formatPerfSweepMobile,
  runPerfSweep,
  runStormSweep,
  formatStormSweep,
  runReplaySweep,
  formatPerfSweep,
  type PerfSweepProfile,
  type PerfSweepReport,
} from './city/perfSweep';

/** Held while a spec has forced the diagnostic sweeps on. */
let diagnosticsHold: (() => void) | null = null;

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
  vehicles: Array<{
    id: number;
    driverId: number;
    position: [number, number, number];
    speedMs: number;
  }>;

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

/** Positions of what the world renderers drew; /cityreplay reports the same shape. */
export interface E2EDrawnWorld {
  /** The frame these were drawn in, on the tape clock while a tape records (else null). */
  tapeMs: number | null;
  /** That frame's performance.now(). */
  atMs: number;
  playerId: number;
  local: [number, number, number] | null;
  players: Array<{ id: number; position: [number, number, number] }>;
  vehicles: Array<{ id: number; driverId: number; position: [number, number, number] }>;
  bodies: Array<{ id: number; shapeType: number; position: [number, number, number] }>;
  meteors: Array<{ bodyId: number; source: string; position: [number, number, number] | null; tapeMs: number | null }>;
}

let drawnWorldSource: (() => Omit<E2EDrawnWorld, 'meteors' | 'tapeMs'>) | null = null;

/** GameWorld registers what its renderers drew; null on unmount. */
export function setE2EDrawnWorldSource(source: (() => Omit<E2EDrawnWorld, 'meteors' | 'tapeMs'>) | null): void {
  drawnWorldSource = source;
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
  /**
   * The playout buffer, and the network lateness it is sized against, both in
   * ticks. Sized correctly the first exceeds the second; when it does not, the
   * decoder is extrapolating past data it has not received, which is what the
   * pose-jump counters below then record.
   */
  sampleDelayTicks: number;
  arrivalLatenessTicks: number;
  arrivalLatenessPeakTicks: number;
  manifestHash: string;
  /**
   * Destruction dust: sources the client extracted from fracture messages,
   * parcels the policy spawned, parcels alive now, and what was thrown away
   * (per-tick cap, glass, queue overflow). `enabled` is the data side; how
   * they are drawn is a render setting.
   */
  dust: {
    enabled: boolean;
    sourcesTotal: number;
    parcelsEmitted: number;
    parcelsLive: number;
    parcelsDrawn: number;
    dropped: number;
    entries: number;
    impacts: number;
    waves: number;
  };
  /** False when the chunk mesh failed to build — the city is streaming but invisible. */
  rendered: boolean;
  /** Lowest chunk centroid, in metres. The city ground is a flat plane at y=0. */
  minChunkY: number;
  /** Chunks whose centroid has sunk below the ground plane. */
  chunksBelowGround: number;
  /** Coverage and time of this report's optional geometric diagnostics. */
  diagnosticSweep?: {
    performed: boolean;
    capturedAtUnixMs: number | null;
    capturedAtPerformanceMs: number | null;
    topologySeq: number;
    validChunkPoses: number;
    unresolvedChunkPoses: number;
    staleDrawProbeInstalled: boolean;
    drawnChunkPosesChecked: number;
  };
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
  /** Seq-aligned ledger-hash comparisons that ran (the desync detector). */
  hashChecks: number;
  /** Comparisons that found divergence. */
  hashMismatches: number;
  /** Targeted per-structure repairs applied instead of full bootstraps. */
  structureRepairs: number;
  /** Cumulative chunks orphaned by a retire, including transient windows. */
  orphanedByRetire: number;
  /** Streamed pose writes that moved a body further than the stream could
   * account for -- the artefact a player calls teleporting. */
  poseJumpsOver1m: number;
  poseJumpsOver4m: number;
  poseJumpsOver16m: number;
  poseJumpMaxM: number;
  /** The same, on the writer the renderer reads. See CityTopology. */
  presentedJumpsOver1m: number;
  presentedJumpsOver4m: number;
  presentedJumpMaxM: number;
  /// What the renderer actually drew: instances that moved further than the
  /// chunk's own recent speed explains. The measurement that counts.
  /**
   * Visibility, which is the only thing in this renderer that makes geometry
   * vanish: a chunk below -4 m for eight consecutive writes has its scale
   * zeroed. Both directions, because a chunk that flickers out and back is
   * indistinguishable from one that genuinely escaped if only hiding is
   * counted -- and a body whose pose is briefly wrong takes all of its chunks
   * under the line together, which is a building disappearing for a moment.
   */
  chunksHidden: number;
  chunksUnhidden: number;
  visibilityFlips: Record<string, number>;
  /**
   * Every remaining way a chunk that should be drawn is not: culled with its
   * cell, still in the shell or mid-transition out of it, deferred by the
   * distance stride, or never seated at all -- plus how often the drawn city
   * collapsed between one frame and the next.
   */
  visualAudit: Record<string, number>;
  /** The whole teleport population split by cause. */
  drawnTeleportBy: Record<string, number>;
  drawnTeleports: number;
  drawnTeleportWorstM: number;
  drawnTeleportMetres: number;
  reoffsets: number;
  reoffsetMetres: number;
  adoptionJumps: number;
  adoptionJumpMaxM: number;
  adoptionJumpMetres: number;
  adoptionJumpsFromMigration: number;
  adoptionJumpMetresFromMigration: number;
  presentedJumpChunks: number;
  presentedJumpWorstChunks: number;
  presentedJumpWorstChunksM: number;
  /** Which designed escape hatch produced those steps. See PresentationAnomalyKind. */
  correctionSnaps: number;
  clockRollbacks: number;
  implausibleJumps: number;
  presentationAnomalyMaxM: number;
  /** Streamed poses refused for being outside the world. Must be 0. */
  recordsOutsideWorld: number;
  renderClockReanchorsRefused: number;
  bootstrapPosesSeen: number;
  bootstrapPosesGone: number;
  bootstrapPosesGlided: number;
  bootstrapPosesSnapped: number;
  repairBodiesGlided: number;
  wakeSeeds: number;
  starvedReadmissions: number;
  settlesRestored: number;
  settlesLeftHard: number;
  promotionsSeen: number;
  promotionsSeeded: number;
  promotionsSeedSkippedReused: number;
  promotionsSeedSkippedNoBody: number;
  promotionsSeedSkippedNoDrawnPose: number;
  promotionsUnseeded: number;
  /**
   * Composition inputs for the lowest chunk below the counting threshold.
   * These are client ledger poses, which may be interpolated; they are not a
   * simultaneous sample of the server's physical shape pose.
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
    worldPosition: [number, number, number];
    bodyKey: number;
    bodyRotation: [number, number, number, number];
    localRotation: [number, number, number, number];
    settled: boolean;
    topologySeq: number;
    poseSourceTracking: boolean;
    poseSource: string | null;
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
  /**
   * Force the per-chunk diagnostic sweeps on for this session.
   *
   * They are gated on the panel being visible, because they cost 3.1 ms at
   * downtown's chunk count and a player never sees them. A spec that asserts on
   * `minChunkY`, `chunksBelowGround`, `deepest` or `staleDrawnChunks` has to
   * ask for them, or it reads whatever the last sweep left behind.
   */
  setDiagnostics(on: boolean): void;
  /**
   * Flip a render-quality knob from a harness.
   *
   * The panel's own buttons are the only other way in, and driving perf work
   * through DOM clicks means the panel has to be open and hittable -- which it
   * is not by default, and which puts a React re-render in the middle of a
   * measurement. This exists so a cost comparison can toggle one feature at a
   * time in ONE session with the camera parked, which is the only way the
   * numbers are comparable: a reload re-rolls the spawn point, and at this fog
   * density the difference between facing a wall and facing down a street
   * dwarfs anything being measured.
   */
  setRenderQuality(next: {
    shadows?: boolean;
    ao?: boolean;
    dust?: 'off' | 'sprites' | 'volumetric';
    dustFluid?: 'off' | 'fast' | 'balanced';
    tier?: 'fast' | 'pretty';
    shareThreshold?: number;
    heroTiling?: boolean;
  }): void;
  /**
   * Retune the perceptual lighting knobs live.
   *
   * `fogIntensity` scales the fog density the AOI radius derives (1 = ship
   * default, lower = see further); the rest go to `graphics/lookTuning`. All of
   * them apply without a reload, which is the point -- see that module for why
   * comparing them across rebuilds does not work.
   */
  setLook(next: {
    fogIntensity?: number;
    aoStrength?: number;
    aoRadius?: number;
    envIntensity?: number;
    dustDensity?: number;
    dustSize?: number;
    dustLifetime?: number;
    dustExtinction?: number;
    dustPhaseG?: number;
    dustSunBoost?: number;
    dustBudgetM?: number;
    dustFluidBricks?: number;
  }): void;
  /**
   * Park the camera at a fixed pose, or `null` to hand it back to the player.
   *
   * Camera only -- the player does not move, so streaming and hitscan carry on
   * from wherever they actually are. See `scene/captureCamera`.
   */
  /**
   * Choose the shot the next trigger pull fires.
   *
   * The cannonball is otherwise only reachable by clicking the overlay, which
   * a driver cannot do, so it would be the one weapon no automated run ever
   * exercised.
   */
  setCannonball(on: boolean): void;
  /** Choose any of the three shots by name; `setCannonball` covers two of them. */
  setShotMode(mode: ShotMode): void;
  /**
   * Spawn destruction dust directly, bypassing the wire: a burst of the
   * given magnitude at a world point. Lets the renderer be exercised and
   * measured without a server, a shot, or a building to break.
   */
  dustBurst(next: {
    x: number;
    y: number;
    z: number;
    magnitude?: number;
    /** 'fracture' | 'impact' */
    kind?: string;
    /** Face normal for a fracture; defaults to +Y. */
    normal?: [number, number, number];
  }): number;

  setCapturePose(next: {
    position: [number, number, number];
    lookAt: [number, number, number];
  } | null): void;
  /**
   * Every city structure's footing, height and size, from the client's own
   * decoded manifest -- the served manifest is binary, so a harness cannot
   * read it as JSON. Empty outside a city match.
   */
  /**
   * Meteors the server has announced and the client is drawing: which body,
   * how far along its arc, and whether the streamed body has taken over.
   * A driver fires a meteor and reads this to know the launch arrived.
   */
  meteors(): Array<{
    bodyId: number;
    shooterPlayerId: number;
    ageS: number;
    flightTimeS: number;
    streamed: boolean;
    start: [number, number, number];
    target: [number, number, number];
    /** What was drawn last frame and from which source, beside the arc and the raw snapshot. */
    drawn: { position: [number, number, number]; source: string; arc: [number, number, number] } | null;
    /** Latest raw snapshot position and velocity of the streamed body, or null. */
    raw: { position: [number, number, number]; velocity: [number, number, number] } | null;
    /** The interpolated body state the layer reads, or null. */
    rendered: [number, number, number] | null;
    interpDelayMs: number;
  }>;
  cityStructures(): Array<{
    structureId: number;
    position: [number, number, number];
    top: number;
    chunks: number;
  }>;
  /**
   * Run the per-feature cost sweep and hand back the report.
   *
   * The same one the panel's button downloads -- exposed here so a spec can
   * assert it still produces sane numbers, since a measurement harness that
   * has silently broken is worse than none.
   */
  runPerfSweep(profile?: PerfSweepProfile): Promise<unknown>;
  /** The storm sweep: fires meteors and prices features inside the impact window. */
  runStormSweep(rounds?: number, windowMs?: number): Promise<{ text: string; report: unknown }>;
  /** /cityreplay only: the same rows of the same tape, one configuration each. */
  runReplaySweep(windowMs?: number, window?: { fromMs: number; toMs: number }): Promise<{ text: string; report: unknown }>;
  /**
   * Record every inbound channel for `seconds`, save it as the last tape,
   * return its header (plus the server folder when `upload` sends it there).
   */
  recordTape(seconds: number, options?: { upload?: boolean }): Promise<unknown>;
  /** While a tape records: ms since it started, the clock the tape's times are on; else null. */
  tapeElapsedMs(): number | null;
  /**
   * What the game's entity renderers placed last frame -- dynamic bodies,
   * vehicles, other players -- plus the local player and the meteors, for
   * comparing a session with its replay.
   */
  drawnWorld(): E2EDrawnWorld | null;

  /** The phone-screen summary of a report, as an array of lines. */
  formatPerfSweepMobile(report: unknown): string[];

  /**
   * Every render setting the sweep can touch.
   *
   * Exists so a spec can prove the sweep RESTORES what it found: leaving a
   * device on a lower resolution would read as the sweep having improved
   * performance, which is the most misleading failure this tool has.
   */
  renderSettings(): Record<string, unknown>;
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
  vehicles: [] as Array<{ id: number; driverId: number; position: [number, number, number]; speedMs: number }>,
  remotePlayers: [] as Array<{ id: number; position: [number, number, number] }>,
  statsSnapshot: { ...DEFAULT_STATS } as DebugStats,
  city: null as CityE2EStats | null,
  cityStructures: [] as Array<{ structureId: number; position: [number, number, number]; top: number; chunks: number }>,
};

/** Called once the city manifest is known; cleared with null. */
export function updateCityStructuresE2E(structures: typeof refs.cityStructures | null): void {
  refs.cityStructures = structures ?? [];
}

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
  vehicles: Array<{ id: number; driverId: number; position: [number, number, number]; speedMs: number }>;
  remotePlayers: Array<{ id: number; position: [number, number, number] }>;
  stats: DebugStats;
}): void {
  refs.cameraPosition = state.cameraPosition;
  refs.cameraYaw = state.cameraYaw;
  refs.cameraPitch = state.cameraPitch;
  refs.movementTelemetry = state.movementTelemetry;
  refs.drivenVehicleId = state.drivenVehicleId;
  refs.nearestVehicleId = state.nearestVehicleId;
  refs.vehicles = state.vehicles;
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
    vehicles: refs.vehicles.map((v) => ({ ...v, position: [...v.position] as [number, number, number] })),
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
  setDiagnostics: (on: boolean) => {
    if (on) {
      if (!diagnosticsHold) diagnosticsHold = acquireCityDiagnostics();
    } else if (diagnosticsHold) {
      diagnosticsHold();
      diagnosticsHold = null;
    }
  },
  setRenderQuality: (next) => {
    if (next.shadows !== undefined) setShadowsEnabled(next.shadows);
    if (next.ao !== undefined) setAmbientOcclusionEnabled(next.ao);
    if (next.dust !== undefined) setDustMode(next.dust);
    if (next.dustFluid !== undefined) setDustFluid(next.dustFluid);
    if (next.tier !== undefined) setQualityTier(next.tier);
    if (next.shareThreshold !== undefined) setInstanceShareThreshold(next.shareThreshold);
    if (next.heroTiling !== undefined) setHeroTilingEnabled(next.heroTiling);
  },
  /// Choose the shot the next trigger pull fires. Exposed so a driver can
  /// exercise the cannonball, which is otherwise only reachable by clicking
  /// the overlay.
  setCannonball: (on: boolean) => setCannonballEnabled(on),
  setShotMode: (mode: ShotMode) => setShotMode(mode),
  setCapturePose: (next) => setCapturePose(next),
  meteors: () => {
    const now = performance.now();
    return meteorFlights(now).map((flight) => {
      const drawn = meteorDrawn(flight.bodyId);
      return {
        bodyId: flight.bodyId,
        shooterPlayerId: flight.shooterPlayerId,
        ageS: (now - flight.launchedAtLocalMs) / 1000,
        flightTimeS: flight.flightTimeS,
        streamed: flight.lastStreamedAtMs > 0,
        start: flight.start,
        target: flight.target,
        drawn: drawn ? { position: drawn.position, source: drawn.source, arc: drawn.arc } : null,
        raw: drawn?.raw ?? null,
        rendered: drawn?.rendered ?? null,
        interpDelayMs: drawn?.interpDelayMs ?? 0,
      };
    });
  },
  cityStructures: () => refs.cityStructures,
  dustBurst: (next) => {
    const normal = next.normal ?? [0, 1, 0];
    pushDebugDustSource({
      kind: next.kind === 'impact' ? 'impact' : 'fracture',
      structureId: 0xffff,
      simTick: dustBurstSerial++,
      ordinal: 0,
      x: next.x,
      y: next.y,
      z: next.z,
      nx: normal[0],
      ny: normal[1],
      nz: normal[2],
      vx: 0,
      vy: 0,
      vz: 0,
      magnitude: next.magnitude ?? 40,
      count: 1,
      material: 0,
      atMs: performance.now(),
    });
    return 1;
  },
  runPerfSweep: (profile?: PerfSweepProfile) => runPerfSweep(profile),
  runStormSweep: async (rounds?: number, windowMs?: number) => {
    const report = await runStormSweep(rounds, windowMs);
    return { text: formatStormSweep(report), report };
  },
  runReplaySweep: async (windowMs?: number, window_?: { fromMs: number; toMs: number }) => {
    const report = await runReplaySweep(windowMs, window_);
    return { text: formatPerfSweep(report), report };
  },
  recordTape: async (seconds: number, options?: { upload?: boolean }) => {
    const session = cityTapeRecorder.start('e2e');
    if (session === 0) return null;
    await new Promise((resolve) => window.setTimeout(resolve, seconds * 1000));
    const tape = cityTapeRecorder.stop(session);
    if (!tape) return null;
    await saveCityTape(`tape-${tape.header.capturedAt.replace(/[:.]/g, '-')}`, tape);
    if (!options?.upload) return tape.header;
    const upload = await uploadTape(tape.header.matchId, tape);
    return { ...tape.header, uploadFolder: upload.folder };
  },
  tapeElapsedMs: () => cityTapeRecorder.elapsedMs(),
  drawnWorld: () => {
    const drawn = drawnWorldSource?.();
    if (!drawn) return null;
    const now = performance.now();
    return {
      ...drawn,
      tapeMs: cityTapeRecorder.elapsedMs(drawn.atMs),
      meteors: meteorFlights(now).map((flight) => {
        const record = meteorDrawn(flight.bodyId);
        return {
          bodyId: flight.bodyId,
          source: record?.source ?? 'none',
          position: record?.position ?? null,
          tapeMs: record ? cityTapeRecorder.elapsedMs(record.atMs) : null,
        };
      }),
    };
  },
  formatPerfSweepMobile: (report: unknown) => formatPerfSweepMobile(report as PerfSweepReport),
  renderSettings: () => ({
    tier: qualityTier(),
    ao: ambientOcclusionPreferred(),
    shadows: shadowsEnabled(),
    cityTextures: cityTextureDetail(),
    dprCap: dprCapOverride(),
    shareThreshold: instanceShareThresholdSetting(),
    heroTiling: heroTilingEnabled(),
  }),
  setLook: (next) => {
    if (next.fogIntensity !== undefined) {
      const intensity = next.fogIntensity;
      updateFogSettings((draft) => ({ ...draft, intensity }));
    }
    setLookTuning(next);
  },
};

// Always install — not gated behind a flag
if (typeof window !== 'undefined') {
  window.__VIBE_E2E__ = bridge;
}
