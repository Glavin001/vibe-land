import { pathCorridor } from 'navcat/blocks';
import { DEFAULT_QUERY_FILTER } from 'navcat';
import { createVehicleQueryFilter } from '../crowd/vehicleQueryFilter';
import { vehicleAgentStateToIntent } from '../agent/vehicleSteering';

import type { PracticeBotHost } from '../../net/localPracticeClient';
import { FLAG_DEAD, aimDirectionFromAngles } from '../../net/protocol';
import {
  FLAG_IN_VEHICLE,
  HITSCAN_MAX_DISTANCE_M,
  MELEE_COOLDOWN_MS,
  PLAYER_EYE_HEIGHT_M,
  RIFLE_FIRE_INTERVAL_MS,
  WEAPON_HITSCAN,
} from '../../net/sharedConstants';
import { buildInputFromButtons } from '../../scene/inputBuilder';
import type { SharedPlayerNavigationProfile } from '../../wasm/sharedPhysics';
import type { WorldDocument } from '../../world/worldDocument';
import { BotBrain } from '../agent/BotBrain';
import {
  harassNearest,
  holdAnchor,
  wander,
  type Behavior,
} from '../agent/behaviors';
import {
  BotCrowd,
  createBotCrowd,
  createBotCrowdFromSharedProfile,
  createVehicleBotCrowd,
  type BotHandle,
} from '../crowd/BotCrowd';
import type {
  BotIntent,
  BotMode,
  BotSelfState,
  ObservedPlayer,
  Vec3Tuple,
  VehicleProfile,
} from '../types';

export type LocalSelfAccessor = () => LocalSelfSnapshot | null;

export interface LocalSelfSnapshot {
  id: number;
  position: [number, number, number];
  dead: boolean;
}

export const PRACTICE_BOT_ID_BASE = 1_000_000;
export const MAX_PRACTICE_BOTS = 200;
export const PRACTICE_BOT_WALK_SPEED = 6.0;
export const PRACTICE_BOT_SPRINT_SPEED = 8.5;
export const PRACTICE_BOT_SPRINT_DISTANCE_M = 10.0;

export type PracticeBotBehaviorKind = 'harass' | 'wander' | 'hold';

export interface PracticeBotRuntimeOptions {
  maxAgentRadius?: number;
  snapHalfExtents?: Vec3Tuple;
  initialBehavior?: PracticeBotBehaviorKind;
  /** @deprecated Practice bots always use the shared human walk/sprint speeds. */
  maxSpeed?: number;
  tickHz?: number;
  navigationProfile?: SharedPlayerNavigationProfile;
  cellSize?: number;
  cellHeight?: number;
  tileSizeVoxels?: number;
  /** Whether bots are allowed to emit rifle fire. */
  enableShooting?: boolean;
  /** Whether bots start with vehicle mode enabled. */
  useVehicles?: boolean;
  /** Override the default vehicle profile used by the walk-vs-drive planner. */
  vehicleProfile?: VehicleProfile;
}

export interface PracticeBotRuntimeSyncOptions extends PracticeBotRuntimeOptions {
  navigationProfile: SharedPlayerNavigationProfile;
}

/**
 * Stock {@link VehicleProfile} for the default practice-mode vehicle (the
 * small Rapier raycast car). Values are intentionally conservative — tune
 * `turningRadius` and `cruiseSpeed` after playtesting.
 *
 * - `turningRadius`: at `VEHICLE_MAX_STEER_RAD = 0.5 rad` and a 1.8 m
 *   wheelbase, the kinematic lower bound is ≈ 1.8 / tan(0.5) ≈ 3.3 m. We
 *   bump to 5 m to account for the raycast-vehicle's drift and the fact
 *   that A* costs use centroids, not wheelbase geometry.
 * - `cruiseSpeed`: empirical — the chassis reaches ~14 m/s on a straight
 *   with the default engine force. 12 m/s leaves margin for the car
 *   actually *exiting* a corner.
 */
export const DEFAULT_VEHICLE_PROFILE: VehicleProfile = Object.freeze({
  turningRadius: 5,
  agentRadius: 1.3,
  agentHeight: 1.5,
  cruiseSpeed: 12,
  enterDistance: 2.5,
  enterExitOverheadSec: 1.5,
});

export interface PracticeBotStats {
  bots: number;
  behavior: PracticeBotBehaviorKind;
  maxSpeed: number;
  navTriangles: number;
  running: boolean;
  /** Whether the bot runtime currently allows ranged fire. */
  enableShooting: boolean;
  /** Whether the vehicle-aware planner is currently enabled. */
  useVehicles: boolean;
  /** Number of vehicle-sized tris in the lazy vehicle navmesh, 0 if unbuilt. */
  vehicleNavTriangles: number;
}

export interface PracticeBotNavDebugConfig {
  walkableRadius: number;
  walkableHeight: number;
  walkableClimb: number;
  walkableSlopeAngleDegrees: number;
  cellSize: number;
  cellHeight: number;
  tileSizeVoxels: number;
  snapHalfExtents: Vec3Tuple;
  mode: 'solo' | 'tiled';
}

export interface PracticeBotNavTuning {
  walkableClimb: number;
  walkableSlopeAngleDegrees: number;
  cellHeight: number;
}

type VehicleFsmStage =
  | 'on_foot'
  | 'walking_to_vehicle'
  | 'entering_vehicle'
  | 'driving'
  | 'exiting_vehicle';

export interface BotObstacleDebugInfo {
  kind: 'vehicle';
  sourceId: number;
  position: Vec3Tuple;
  radius: number;
  height: number;
}

export interface BotDebugInfo {
  id: number;
  position: Vec3Tuple;
  rawTarget: Vec3Tuple | null;
  target: Vec3Tuple | null;
  targetSnapDistanceM: number | null;
  lastMoveAccepted: boolean | null;
  ticksSinceReplan: number;
  pathPoints: Vec3Tuple[];
  desiredVelocity: Vec3Tuple;
  velocity: Vec3Tuple;
  behaviorKind: PracticeBotBehaviorKind;
  mode: BotMode;
  targetPlayerId: number | null;
  maxSpeed: number;
  firePrimary: boolean;
  /** Total FireCmd packets emitted by this bot since spawn. */
  shotsFired: number;
  /** Vehicle FSM stage — `'on_foot'` for walking bots. */
  vehicleStage: VehicleFsmStage;
  /** Vehicle id this bot is currently reserving / driving, or null. */
  reservedVehicleId: number | null;
}

export interface PracticeBotDetachOptions {
  preserveHostBots?: boolean;
}

export interface PracticeBotSnapshot {
  id: number;
  position: Vec3Tuple;
  anchor: Vec3Tuple;
}

export interface PracticeBotShotVisual {
  shooterId: number;
  origin: Vec3Tuple;
  end: Vec3Tuple;
  kind: 'miss' | 'world' | 'body';
}

interface PracticeBot {
  id: number;
  handle: BotHandle;
  brain: BotBrain;
  behaviorKind: PracticeBotBehaviorKind;
  seq: number;
  swingSeq: number;
  nextAllowedMeleeMs: number;
  lastIntent: BotIntent;
  /** Monotonic shot id used in outgoing FireCmd packets. */
  nextShotId: number;
  /** Wall-clock ms at which this bot is next allowed to emit a FireCmd. */
  nextFireMs: number;
  /** Running count of FireCmds emitted, surfaced in the debug overlay. */
  shotsFired: number;
  /**
   * Current vehicle FSM stage. Driven by `tickVehicleFsm`; `on_foot` is
   * the ground state whenever `useVehicles` is false.
   */
  vehicleStage: VehicleFsmStage;
  /** Vehicle id this bot has reserved, or null. */
  reservedVehicleId: number | null;
  /** Handle into the vehicle-sized crowd while `vehicleStage === 'driving'`. */
  vehicleHandle: BotHandle | null;
  /**
   * Last destination the brain asked for (foot-mode target). We cache it
   * so the vehicle FSM can continue the journey on the vehicle navmesh
   * after entering a car.
   */
  pendingDestination: Vec3Tuple | null;
  /** Tick count since the last FSM transition — used for timeouts. */
  fsmTicks: number;
}

const DEFAULT_BEHAVIOR: PracticeBotBehaviorKind = 'harass';
const DEFAULT_TICK_HZ = 60;
const VEHICLE_OBSTACLE_RADIUS = Math.hypot(0.9, 1.8) + 0.2;
const VEHICLE_OBSTACLE_HEIGHT = 1.2;

// ~1° of yaw/pitch jitter: enough to prevent reliable headshots, not enough
// to make the bot feel broken.
const DEFAULT_AIM_JITTER_RAD = 0.02;
// Lead moving targets by ~80 ms — matches the practice tick at 60 Hz and
// feels natural without being a wall-hack aimbot.
const DEFAULT_AIM_LEAD_SEC = 0.08;
// ~200 ms reaction delay at 60 Hz before the first shot lands.
const DEFAULT_FIRE_PREP_TICKS = 12;
// Engagement range for the harass behavior's fire intent. Rifle hitscan
// reaches farther than this but practice bots now hold to a shorter,
// fairer combat distance in foggy arenas.
const DEFAULT_HARASS_FIRE_RANGE_M = 20;
// Extra local-clock slack on top of the server's 100 ms cooldown, to avoid
// racing the server and getting shots silently dropped.
const LOCAL_FIRE_COOLDOWN_SLACK_MS = 8;

export class PracticeBotRuntime {
  readonly crowd: BotCrowd;
  private readonly bots = new Map<number, PracticeBot>();
  private readonly shotVisualListeners = new Set<(shot: PracticeBotShotVisual) => void>();
  private nextId = PRACTICE_BOT_ID_BASE;
  private behaviorKind: PracticeBotBehaviorKind;
  private maxSpeed: number;
  private readonly tickHz: number;
  private host: PracticeBotHost | null = null;
  private getSelf: LocalSelfAccessor | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = 0;
  private running = false;
  private readonly vehicleObstacleAgents = new Map<number, string>();
  private readonly world: WorldDocument;
  private readonly maxAgentRadius: number;
  /** Whether the walk-vs-drive planner is active. */
  private useVehicles: boolean;
  /** Whether bots may emit FireCmd packets. */
  private enableShooting: boolean;
  /** Static physical profile of the vehicle the bots would drive. */
  private readonly vehicleProfile: VehicleProfile;
  /**
   * Lazy second crowd built on the first call to `setUseVehicles(true)`.
   * The underlying navmesh has a larger walkable radius so narrow
   * passages that a player can squeeze through are excluded. Bots only
   * inhabit it while driving.
   */
  private vehicleCrowd: BotCrowd | null = null;
  /** navcat QueryFilter paired with the vehicle crowd. Built lazily alongside it. */
  private vehicleQueryFilter: ReturnType<typeof createVehicleQueryFilter> | null = null;
  /**
   * Position + timestamp cache used to estimate velocity of observed
   * players (specifically, the local player) between ticks. Bots use this
   * for aim-lead in steering. Keyed by observed player id.
   */
  private readonly observedVelocities = new Map<
    number,
    { position: Vec3Tuple; sampleMs: number; velocity: Vec3Tuple }
  >();
  /**
   * Reservation map — prevents two bots racing for the same car.
   * Key: vehicleId. Value: botId holding the reservation.
   */
  private readonly reservedVehicles = new Map<number, number>();

  static createSync(world: WorldDocument, options: PracticeBotRuntimeSyncOptions): PracticeBotRuntime {
    const crowd = createBotCrowd(world, {
      navigationProfile: options.navigationProfile,
      maxAgentRadius: options.maxAgentRadius ?? 0.6,
      snapHalfExtents: options.snapHalfExtents,
      cellSize: options.cellSize,
      cellHeight: options.cellHeight,
      tileSizeVoxels: options.tileSizeVoxels,
    });
    return new PracticeBotRuntime(world, crowd, options);
  }

  static async create(
    world: WorldDocument,
    options: PracticeBotRuntimeOptions = {},
  ): Promise<PracticeBotRuntime> {
    const crowd = options.navigationProfile
      ? createBotCrowd(world, {
          navigationProfile: options.navigationProfile,
          maxAgentRadius: options.maxAgentRadius ?? 0.6,
          snapHalfExtents: options.snapHalfExtents,
          cellSize: options.cellSize,
          cellHeight: options.cellHeight,
          tileSizeVoxels: options.tileSizeVoxels,
        })
      : await createBotCrowdFromSharedProfile(world, {
          maxAgentRadius: options.maxAgentRadius ?? 0.6,
          snapHalfExtents: options.snapHalfExtents,
          cellSize: options.cellSize,
          cellHeight: options.cellHeight,
          tileSizeVoxels: options.tileSizeVoxels,
        });
    return new PracticeBotRuntime(world, crowd, options);
  }

  private constructor(world: WorldDocument, crowd: BotCrowd, options: PracticeBotRuntimeOptions = {}) {
    this.world = world;
    this.maxAgentRadius = options.maxAgentRadius ?? 0.6;
    this.crowd = crowd;
    this.behaviorKind = options.initialBehavior ?? DEFAULT_BEHAVIOR;
    this.maxSpeed = PRACTICE_BOT_SPRINT_SPEED;
    this.tickHz = options.tickHz ?? DEFAULT_TICK_HZ;
    this.enableShooting = options.enableShooting ?? true;
    this.useVehicles = options.useVehicles ?? false;
    this.vehicleProfile = options.vehicleProfile ?? DEFAULT_VEHICLE_PROFILE;
  }

  attach(host: PracticeBotHost, getSelf: LocalSelfAccessor): void {
    if (this.host === host && this.getSelf === getSelf) return;
    this.detach({ preserveHostBots: true });
    this.host = host;
    this.getSelf = getSelf;
    for (const bot of this.bots.values()) {
      const alreadyConnected = this.host.remotePlayers.has(bot.id);
      if (!alreadyConnected) {
        this.host.connectBot(bot.id);
      }
      this.syncBotToAuthoritativeSpawn(bot, this.host, {
        preserveAnchor: alreadyConnected,
      });
      this.host.setBotMaxSpeed(bot.id, null);
    }
    this.running = true;
    this.lastTickMs = performance.now();
    this.tickHandle = setInterval(() => this.tick(), 1000 / this.tickHz);
  }

  detach(options: PracticeBotDetachOptions = {}): void {
    this.running = false;
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.host && !options.preserveHostBots) {
      for (const bot of this.bots.values()) {
        this.host.disconnectBot(bot.id);
      }
    }
    for (const agentId of this.vehicleObstacleAgents.values()) {
      this.crowd.removeObstacleAgent(agentId);
    }
    this.vehicleObstacleAgents.clear();
    for (const bot of this.bots.values()) {
      this.releaseBotVehicleResources(bot);
      bot.vehicleStage = 'on_foot';
      bot.pendingDestination = null;
      bot.fsmTicks = 0;
    }
    this.reservedVehicles.clear();
    this.host = null;
    this.getSelf = null;
  }

  get count(): number {
    return this.bots.size;
  }

  stats(): PracticeBotStats {
    return {
      bots: this.bots.size,
      behavior: this.behaviorKind,
      maxSpeed: this.maxSpeed,
      navTriangles: this.crowd.nav.geometry.triangleCount,
      running: this.running,
      enableShooting: this.enableShooting,
      useVehicles: this.useVehicles,
      vehicleNavTriangles: this.vehicleCrowd?.nav.geometry.triangleCount ?? 0,
    };
  }

  getNavDebugConfig(): PracticeBotNavDebugConfig {
    const { navigationProfile, buildConfig } = this.crowd.nav;
    return {
      walkableRadius: navigationProfile.walkableRadius,
      walkableHeight: navigationProfile.walkableHeight,
      walkableClimb: navigationProfile.walkableClimb,
      walkableSlopeAngleDegrees: navigationProfile.walkableSlopeAngleDegrees,
      cellSize: buildConfig.cellSize,
      cellHeight: buildConfig.cellHeight,
      tileSizeVoxels: buildConfig.tileSizeVoxels,
      snapHalfExtents: this.crowd.debugSnapHalfExtents,
      mode: buildConfig.mode,
    };
  }

  setUseVehicles(value: boolean): void {
    if (value === this.useVehicles) return;
    this.useVehicles = value;
    if (value) {
      this.ensureVehicleCrowd();
    } else {
      for (const bot of this.bots.values()) {
        this.resetBotToFoot(bot, /* sendExitPacket */ true);
      }
      this.reservedVehicles.clear();
    }
  }

  setEnableShooting(value: boolean): void {
    this.enableShooting = value;
  }

  private ensureVehicleCrowd(): BotCrowd {
    if (this.vehicleCrowd) return this.vehicleCrowd;
    this.vehicleCrowd = createVehicleBotCrowd(this.world, this.vehicleProfile);
    this.vehicleQueryFilter = createVehicleQueryFilter(this.vehicleProfile);
    return this.vehicleCrowd;
  }

  setBehavior(kind: PracticeBotBehaviorKind): void {
    if (kind === this.behaviorKind) return;
    this.behaviorKind = kind;
    for (const bot of this.bots.values()) {
      bot.brain.setBehavior(makeBehavior(kind));
      bot.behaviorKind = kind;
    }
  }

  setMaxSpeed(speed: number): void {
    void speed;
    this.maxSpeed = PRACTICE_BOT_SPRINT_SPEED;
    for (const bot of this.bots.values()) {
      const agent = this.crowd.getAgent(bot.handle.id);
      if (agent) agent.maxSpeed = PRACTICE_BOT_SPRINT_SPEED;
      this.host?.setBotMaxSpeed(bot.id, null);
    }
  }

  setBotCount(target: number): void {
    const clamped = Math.max(0, Math.min(MAX_PRACTICE_BOTS, Math.floor(target)));
    while (this.bots.size < clamped) {
      this.spawnBot();
    }
    if (this.bots.size > clamped) {
      const ids = Array.from(this.bots.keys());
      for (let i = clamped; i < ids.length; i += 1) {
        this.removeBot(ids[i]);
      }
    }
  }

  spawnBot(snapshot?: Partial<PracticeBotSnapshot>): number {
    const spawn = snapshot?.position ?? this.crowd.findRandomWalkable() ?? [0, 2, 0];
    const handle = this.crowd.addBot(spawn);
    const agent = this.crowd.getAgent(handle.id);
    if (agent) agent.maxSpeed = PRACTICE_BOT_SPRINT_SPEED;
    const id = snapshot?.id ?? this.nextId;
    this.nextId = Math.max(this.nextId, id + 1);
    const brain = new BotBrain(this.crowd, handle, makeBehavior(this.behaviorKind), {
      anchor: snapshot?.anchor ?? spawn,
      aimJitterRad: DEFAULT_AIM_JITTER_RAD,
      aimLeadSec: DEFAULT_AIM_LEAD_SEC,
      firePrepTicks: DEFAULT_FIRE_PREP_TICKS,
      seed: id >>> 0,
    });
    this.bots.set(id, {
      id,
      handle,
      brain,
      behaviorKind: this.behaviorKind,
      seq: 0,
      swingSeq: 0,
      nextAllowedMeleeMs: 0,
      lastIntent: makeIdleIntent(),
      nextShotId: 1,
      nextFireMs: 0,
      shotsFired: 0,
      vehicleStage: 'on_foot',
      reservedVehicleId: null,
      vehicleHandle: null,
      pendingDestination: null,
      fsmTicks: 0,
    });
    if (this.host) {
      const alreadyConnected = this.host.remotePlayers.has(id);
      if (!alreadyConnected) {
        this.host.connectBot(id);
      }
      this.syncBotToAuthoritativeSpawn(this.bots.get(id) ?? null, this.host, {
        preserveAnchor: alreadyConnected,
      });
      this.host.setBotMaxSpeed(id, null);
    }
    return id;
  }

  removeBot(id: number): boolean {
    const bot = this.bots.get(id);
    if (!bot) return false;
    this.releaseBotVehicleResources(bot);
    this.crowd.removeBot(bot.handle);
    this.bots.delete(id);
    this.host?.disconnectBot(id);
    return true;
  }

  clear(): void {
    for (const bot of this.bots.values()) {
      this.releaseBotVehicleResources(bot);
      this.crowd.removeBot(bot.handle);
      this.host?.disconnectBot(bot.id);
    }
    this.bots.clear();
    this.reservedVehicles.clear();
    for (const agentId of this.vehicleObstacleAgents.values()) {
      this.crowd.removeObstacleAgent(agentId);
    }
    this.vehicleObstacleAgents.clear();
  }

  onShotVisual(listener: (shot: PracticeBotShotVisual) => void): () => void {
    this.shotVisualListeners.add(listener);
    return () => {
      this.shotVisualListeners.delete(listener);
    };
  }

  captureBotSnapshots(): PracticeBotSnapshot[] {
    const snapshots: PracticeBotSnapshot[] = [];
    for (const bot of this.bots.values()) {
      const remote = this.host?.remotePlayers.get(bot.id);
      const agent = this.crowd.getAgent(bot.handle.id);
      if (!remote && !agent) continue;
      const position: Vec3Tuple = remote
        ? [remote.position[0], remote.position[1], remote.position[2]]
        : [agent!.position[0], agent!.position[1], agent!.position[2]];
      snapshots.push({
        id: bot.id,
        position,
        anchor: bot.brain.getAnchor(),
      });
    }
    snapshots.sort((a, b) => a.id - b.id);
    return snapshots;
  }

  restoreBotSnapshots(snapshots: readonly PracticeBotSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.spawnBot(snapshot);
    }
  }

  private syncBotToAuthoritativeSpawn(
    bot: PracticeBot | null,
    host: PracticeBotHost,
    options: { preserveAnchor?: boolean } = {},
  ): void {
    if (!bot) return;
    const remote = host.remotePlayers.get(bot.id);
    if (!remote) return;
    this.crowd.syncBotPosition(bot.handle, remote.position);
    if (!options.preserveAnchor) {
      bot.brain.setAnchor([remote.position[0], remote.position[1], remote.position[2]]);
    }
  }

  private releaseBotVehicleResources(bot: PracticeBot): void {
    if (bot.vehicleHandle && this.vehicleCrowd) {
      this.vehicleCrowd.removeBot(bot.vehicleHandle);
      bot.vehicleHandle = null;
    }
    if (bot.reservedVehicleId !== null) {
      const current = this.reservedVehicles.get(bot.reservedVehicleId);
      if (current === bot.id) {
        this.reservedVehicles.delete(bot.reservedVehicleId);
      }
      bot.reservedVehicleId = null;
    }
  }

  private resetBotToFoot(bot: PracticeBot, sendExitPacket: boolean): void {
    if (sendExitPacket && bot.vehicleStage === 'driving' && bot.reservedVehicleId !== null && this.host) {
      this.host.sendBotVehicleExit(bot.id, bot.reservedVehicleId);
    }
    this.releaseBotVehicleResources(bot);
    bot.vehicleStage = 'on_foot';
    bot.pendingDestination = null;
    bot.fsmTicks = 0;
  }

  getObstacleDebugInfos(): BotObstacleDebugInfo[] {
    if (!this.host) return [];
    const out: BotObstacleDebugInfo[] = [];
    for (const [vehicleId, agentId] of this.vehicleObstacleAgents) {
      const agent = this.crowd.getAgent(agentId);
      if (!agent) continue;
      out.push({
        kind: 'vehicle',
        sourceId: vehicleId,
        position: [agent.position[0], agent.position[1], agent.position[2]],
        radius: agent.radius,
        height: agent.height,
      });
    }
    return out;
  }

  private syncVehicleObstacles(host: PracticeBotHost): void {
    const seen = new Set<number>();
    const selfDriven = new Set<number>();
    for (const bot of this.bots.values()) {
      if (bot.vehicleStage === 'driving' && bot.reservedVehicleId !== null) {
        selfDriven.add(bot.reservedVehicleId);
      }
    }
    for (const [vehicleId, state] of host.vehicles) {
      if (selfDriven.has(vehicleId)) continue;
      seen.add(vehicleId);
      const position: Vec3Tuple = [
        state.position[0],
        state.position[1],
        state.position[2],
      ];
      const velocity: Vec3Tuple = [
        state.linearVelocity[0],
        state.linearVelocity[1],
        state.linearVelocity[2],
      ];
      let agentId = this.vehicleObstacleAgents.get(vehicleId);
      if (!agentId) {
        agentId = this.crowd.addObstacleAgent(
          position,
          VEHICLE_OBSTACLE_RADIUS,
          VEHICLE_OBSTACLE_HEIGHT,
        );
        this.vehicleObstacleAgents.set(vehicleId, agentId);
      }
      this.crowd.setObstacleAgentPose(agentId, position, velocity);
    }
    for (const [vehicleId, agentId] of this.vehicleObstacleAgents) {
      if (!seen.has(vehicleId)) {
        this.crowd.removeObstacleAgent(agentId);
        this.vehicleObstacleAgents.delete(vehicleId);
      }
    }
  }

  getBotDebugInfos(): BotDebugInfo[] {
    if (this.bots.size === 0) return [];
    const out: BotDebugInfo[] = [];
    for (const bot of this.bots.values()) {
      const agent = this.crowd.getAgent(bot.handle.id);
      if (!agent) continue;
      const remote = this.host?.remotePlayers.get(bot.id);
      const position: Vec3Tuple = remote
        ? [remote.position[0], remote.position[1], remote.position[2]]
        : [agent.position[0], agent.position[1], agent.position[2]];

      const corners = pathCorridor.findCorners(
        agent.corridor,
        this.crowd.navMesh,
        8,
      );
      const brainDebug = bot.brain.getDebugState();
      const pathPoints: Vec3Tuple[] = [];
      pathPoints.push([position[0], position[1], position[2]]);
      if (corners) {
        for (const corner of corners) {
          pathPoints.push([
            corner.position[0],
            corner.position[1],
            corner.position[2],
          ]);
        }
      }

      const snappedTarget = bot.handle.targetPosition
        ? [
            bot.handle.targetPosition[0],
            bot.handle.targetPosition[1],
            bot.handle.targetPosition[2],
          ] as Vec3Tuple
        : null;
      const rawTarget = brainDebug.rawTarget;
      const targetSnapDistanceM = rawTarget && snappedTarget
        ? Math.hypot(
            snappedTarget[0] - rawTarget[0],
            snappedTarget[1] - rawTarget[1],
            snappedTarget[2] - rawTarget[2],
          )
        : null;

      out.push({
        id: bot.id,
        position,
        rawTarget,
        target: snappedTarget,
        targetSnapDistanceM,
        lastMoveAccepted: brainDebug.lastMoveAccepted,
        ticksSinceReplan: brainDebug.ticksSinceReplan,
        pathPoints,
        desiredVelocity: [
          agent.desiredVelocity[0],
          agent.desiredVelocity[1],
          agent.desiredVelocity[2],
        ],
        velocity: [agent.velocity[0], agent.velocity[1], agent.velocity[2]],
        behaviorKind: bot.behaviorKind,
        mode: bot.lastIntent.mode,
        targetPlayerId: bot.lastIntent.targetPlayerId,
        maxSpeed: this.maxSpeed,
        firePrimary: bot.lastIntent.firePrimary,
        shotsFired: bot.shotsFired,
        vehicleStage: bot.vehicleStage,
        reservedVehicleId: bot.reservedVehicleId,
      });
    }
    return out;
  }

  private tick(): void {
    if (!this.running || !this.host) return;
    if (this.bots.size === 0) return;
    const nowMs = performance.now();
    const dt = Math.min(0.25, Math.max(0.001, (nowMs - this.lastTickMs) / 1000));
    this.lastTickMs = nowMs;

    const host = this.host;
    const localFlags = host.localPlayerFlags;
    const localHp = host.localPlayerHp;
    const selfSnapshot = this.getSelf?.() ?? null;
    const localIsDead = selfSnapshot?.dead ?? ((localFlags & FLAG_DEAD) !== 0 || localHp <= 0);
    const localIsInVehicle = (localFlags & FLAG_IN_VEHICLE) !== 0;
    const observed: ObservedPlayer[] = selfSnapshot
      ? [
          {
            id: selfSnapshot.id,
            position: [
              selfSnapshot.position[0],
              selfSnapshot.position[1],
              selfSnapshot.position[2],
            ],
            isDead: localIsDead,
            velocity: this.sampleObservedVelocity(
              selfSnapshot.id,
              selfSnapshot.position,
              nowMs,
            ),
            isInVehicle: localIsInVehicle,
          },
        ]
      : [];
    this.pruneObservedVelocities(selfSnapshot?.id ?? null);

    for (const bot of this.bots.values()) {
      const remote = host.remotePlayers.get(bot.id);
      if (remote) {
        this.crowd.syncBotPosition(bot.handle, remote.position);
      }
      if (
        bot.vehicleStage === 'driving'
        && bot.vehicleHandle
        && bot.reservedVehicleId !== null
        && this.vehicleCrowd
      ) {
        const veh = host.vehicles.get(bot.reservedVehicleId);
        if (veh) {
          this.vehicleCrowd.syncBotPosition(bot.vehicleHandle, [
            veh.position[0],
            veh.position[1],
            veh.position[2],
          ]);
        }
      }
    }

    this.syncVehicleObstacles(host);
    this.crowd.step(dt);
    if (this.vehicleCrowd) {
      this.vehicleCrowd.step(dt);
    }

    const selfTemplate: BotSelfState = {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      onGround: true,
      dead: false,
    };

    for (const bot of this.bots.values()) {
      const remote = host.remotePlayers.get(bot.id);
      if (!remote) continue;
      const agent = this.crowd.getAgent(bot.handle.id);
      selfTemplate.position[0] = remote.position[0];
      selfTemplate.position[1] = remote.position[1];
      selfTemplate.position[2] = remote.position[2];
      if (agent) {
        selfTemplate.velocity[0] = agent.velocity[0];
        selfTemplate.velocity[1] = agent.velocity[1];
        selfTemplate.velocity[2] = agent.velocity[2];
      } else {
        selfTemplate.velocity[0] = 0;
        selfTemplate.velocity[1] = 0;
        selfTemplate.velocity[2] = 0;
      }
      selfTemplate.yaw = remote.yaw;
      selfTemplate.pitch = remote.pitch;
      selfTemplate.onGround = true;
      selfTemplate.dead = remote.hp <= 0;

      // Foot brain always runs — it tells us the "natural" destination
      // the behavior wants right now. The vehicle FSM may override the
      // final intent (e.g. while driving we emit vehicle-steering bits
      // instead of the walking buttons the brain computed).
      const footIntent = bot.brain.think(selfTemplate, observed);
      bot.pendingDestination = bot.handle.targetPosition
        ? [
            bot.handle.targetPosition[0],
            bot.handle.targetPosition[1],
            bot.handle.targetPosition[2],
          ]
        : null;

      let intent = footIntent;
      if (this.useVehicles) {
        intent = this.tickVehicleFsm(bot, remote, footIntent) ?? footIntent;
      }
      bot.lastIntent = intent;
      bot.seq = (bot.seq + 1) & 0xffff;
      const cmd = buildInputFromButtons(
        bot.seq,
        0,
        intent.buttons,
        intent.yaw,
        intent.pitch,
      );
      host.sendBotInputs(bot.id, [cmd]);
      if (intent.meleePrimary && nowMs >= bot.nextAllowedMeleeMs) {
        bot.nextAllowedMeleeMs = nowMs + MELEE_COOLDOWN_MS;
        bot.swingSeq = (bot.swingSeq + 1) >>> 0;
        host.sendBotMelee(bot.id, {
          seq: bot.seq,
          swingId: bot.swingSeq,
          clientTimeUs: Math.round(performance.now() * 1000),
          yaw: intent.yaw,
          pitch: intent.pitch,
        });
      }
      if (intent.vehicleAction === 'enter' && intent.vehicleId != null) {
        host.sendBotVehicleEnter(bot.id, intent.vehicleId);
      } else if (intent.vehicleAction === 'exit' && intent.vehicleId != null) {
        host.sendBotVehicleExit(bot.id, intent.vehicleId);
      }

      this.maybeEmitFire(bot, intent, selfTemplate.dead, nowMs);
    }
  }

  /**
   * If the bot's brain wants to fire this tick, emit a `FireCmd` through
   * the host — provided the 100 ms rifle cooldown has elapsed, the bot is
   * alive + on foot, and the server can't already tell that the shot
   * would be blocked by static world geometry. Shots that would be
   * occluded are suppressed so we don't spam packets the server would
   * only resolve as `SHOT_RESOLUTION_BLOCKED_BY_WORLD`.
   */
  private maybeEmitFire(
    bot: PracticeBot,
    intent: BotIntent,
    isDead: boolean,
    nowMs: number,
  ): void {
    if (!this.enableShooting) return;
    if (!intent.firePrimary) return;
    if (isDead) return;
    if (bot.vehicleStage !== 'on_foot') return;
    if (nowMs < bot.nextFireMs) return;
    const host = this.host;
    if (!host) return;

    const remote = host.remotePlayers.get(bot.id);
    if (!remote) return;

    const dir = aimDirectionFromAngles(intent.yaw, intent.pitch);
    const origin: [number, number, number] = [
      remote.position[0],
      remote.position[1] + PLAYER_EYE_HEIGHT_M,
      remote.position[2],
    ];

    if (host.castSceneRay) {
      const targetDist = this.targetDistanceForFire(bot, origin);
      if (targetDist !== null) {
        const hit = host.castSceneRay(origin, dir, targetDist + 0.5);
        if (hit && hit.toi < targetDist - 0.25) {
          // World geometry between us and the target — don't waste a shot.
          return;
        }
      }
    }

    const shotId = bot.nextShotId;
    bot.nextShotId = (bot.nextShotId + 1) >>> 0 || 1;
    bot.nextFireMs = nowMs + RIFLE_FIRE_INTERVAL_MS + LOCAL_FIRE_COOLDOWN_SLACK_MS;
    bot.shotsFired += 1;

    host.sendBotFire(bot.id, {
      seq: bot.seq,
      shotId,
      weapon: WEAPON_HITSCAN,
      clientFireTimeUs: Math.floor(nowMs * 1000),
      clientInterpMs: 0,
      clientDynamicInterpMs: 0,
      dir,
    });
    this.emitShotVisual(bot, origin, dir);
  }

  private targetDistanceForFire(bot: PracticeBot, origin: Vec3Tuple): number | null {
    const targetId = bot.lastIntent.targetPlayerId;
    if (targetId === null) return null;
    const host = this.host;
    if (!host) return null;
    const target = host.remotePlayers.get(targetId);
    const position = target?.position
      ?? (this.observedVelocities.get(targetId)?.position ?? null);
    if (!position) return null;
    const dx = position[0] - origin[0];
    const dy = position[1] + PLAYER_EYE_HEIGHT_M * 0.5 - origin[1];
    const dz = position[2] - origin[2];
    return Math.hypot(dx, dy, dz);
  }

  private emitShotVisual(
    bot: PracticeBot,
    origin: Vec3Tuple,
    dir: Vec3Tuple,
  ): void {
    if (this.shotVisualListeners.size === 0) return;
    const targetDistance = this.targetDistanceForFire(bot, origin);
    const worldHit = this.host?.castSceneRay?.(origin, dir, HITSCAN_MAX_DISTANCE_M) ?? null;
    const hitDistance = worldHit?.toi ?? null;
    const distance = targetDistance != null
      ? Math.min(targetDistance, hitDistance ?? Number.POSITIVE_INFINITY, HITSCAN_MAX_DISTANCE_M)
      : Math.min(hitDistance ?? HITSCAN_MAX_DISTANCE_M, HITSCAN_MAX_DISTANCE_M);
    const kind: PracticeBotShotVisual['kind'] = targetDistance != null && (hitDistance == null || targetDistance <= hitDistance + 0.25)
      ? 'body'
      : hitDistance != null
        ? 'world'
        : 'miss';
    const end: Vec3Tuple = [
      origin[0] + dir[0] * distance,
      origin[1] + dir[1] * distance,
      origin[2] + dir[2] * distance,
    ];
    const shot: PracticeBotShotVisual = {
      shooterId: bot.id,
      origin: [origin[0], origin[1], origin[2]],
      end,
      kind,
    };
    for (const listener of this.shotVisualListeners) {
      listener(shot);
    }
  }

  private sampleObservedVelocity(
    id: number,
    position: [number, number, number],
    nowMs: number,
  ): Vec3Tuple | undefined {
    const previous = this.observedVelocities.get(id);
    if (!previous) {
      this.observedVelocities.set(id, {
        position: [position[0], position[1], position[2]],
        sampleMs: nowMs,
        velocity: [0, 0, 0],
      });
      return [0, 0, 0];
    }
    const dtMs = nowMs - previous.sampleMs;
    if (dtMs < 1) {
      return [previous.velocity[0], previous.velocity[1], previous.velocity[2]];
    }
    const dt = dtMs / 1000;
    // Low-pass to reject single-tick jitter while still reacting quickly.
    const alpha = 0.4;
    const instX = (position[0] - previous.position[0]) / dt;
    const instY = (position[1] - previous.position[1]) / dt;
    const instZ = (position[2] - previous.position[2]) / dt;
    const vel: Vec3Tuple = [
      previous.velocity[0] * (1 - alpha) + instX * alpha,
      previous.velocity[1] * (1 - alpha) + instY * alpha,
      previous.velocity[2] * (1 - alpha) + instZ * alpha,
    ];
    previous.position[0] = position[0];
    previous.position[1] = position[1];
    previous.position[2] = position[2];
    previous.sampleMs = nowMs;
    previous.velocity[0] = vel[0];
    previous.velocity[1] = vel[1];
    previous.velocity[2] = vel[2];
    return [vel[0], vel[1], vel[2]];
  }

  private pruneObservedVelocities(keepId: number | null): void {
    if (this.observedVelocities.size === 0) return;
    for (const id of [...this.observedVelocities.keys()]) {
      if (id !== keepId) this.observedVelocities.delete(id);
    }
  }

  /**
   * Drives the per-bot vehicle FSM for one tick. Returns a new intent
   * that should replace the walking intent produced by the brain, or
   * `null` to fall through to the brain's default.
   *
   * The FSM is stateful per bot but stateless across bots — each invocation
   * reads the bot's `vehicleStage`, does at most one transition, and
   * emits whatever intent the new stage produces.
   */
  private tickVehicleFsm(
    bot: PracticeBot,
    remote: { position: [number, number, number]; flags: number; yaw: number; pitch: number },
    footIntent: BotIntent,
  ): BotIntent | null {
    const host = this.host;
    if (!host) return null;
    bot.fsmTicks += 1;

    const botPosition: Vec3Tuple = [remote.position[0], remote.position[1], remote.position[2]];
    const isInVehicle = (remote.flags & FLAG_IN_VEHICLE) !== 0;

    switch (bot.vehicleStage) {
      case 'on_foot': {
        // Decide: should we switch to the vehicle route?
        const destination = bot.pendingDestination;
        if (!destination) return null;
        const planarDist = Math.hypot(
          destination[0] - botPosition[0],
          destination[2] - botPosition[2],
        );
        // Short trips: don't bother. The walk-vs-drive overhead is too
        // high, and bots clustering near a waypoint shouldn't scramble
        // for cars.
        if (planarDist < 15) return null;
        const plan = this.planVehicleRoute(bot, botPosition, destination);
        if (!plan) return null;
        // Reserve the chosen vehicle and transition to walking_to_vehicle.
        if (!this.tryReserveVehicle(plan.vehicleId, bot.id)) return null;
        bot.reservedVehicleId = plan.vehicleId;
        bot.vehicleStage = 'walking_to_vehicle';
        bot.fsmTicks = 0;
        // Override the brain's destination with the vehicle position so
        // the foot agent path-plans toward it on this tick.
        this.crowd.requestMoveTo(bot.handle, plan.vehiclePosition);
        return null;
      }

      case 'walking_to_vehicle': {
        const vehicleId = bot.reservedVehicleId;
        if (vehicleId === null) {
          bot.vehicleStage = 'on_foot';
          return null;
        }
        const veh = host.vehicles.get(vehicleId);
        if (!veh) {
          // Vehicle vanished — abandon and go back to walking.
          this.resetBotToFoot(bot, /* sendExitPacket */ false);
          return null;
        }
        // Another driver beat us to it (human or a bot we don't track).
        if (veh.driverId !== 0 && veh.driverId !== bot.id) {
          this.resetBotToFoot(bot, /* sendExitPacket */ false);
          return null;
        }
        // Keep steering toward the vehicle — the brain's normal moveTo
        // call doesn't know the vehicle is our real goal, so we retarget
        // the foot agent manually every tick.
        const vehiclePos: Vec3Tuple = [veh.position[0], veh.position[1], veh.position[2]];
        this.crowd.requestMoveTo(bot.handle, vehiclePos);
        const distance = Math.hypot(
          vehiclePos[0] - botPosition[0],
          vehiclePos[2] - botPosition[2],
        );
        if (distance <= this.vehicleProfile.enterDistance) {
          bot.vehicleStage = 'entering_vehicle';
          bot.fsmTicks = 0;
          // Emit the enter packet via the side-channel on the intent.
          return {
            ...footIntent,
            buttons: 0, // stop moving — animation takes over
            mode: 'entering_vehicle',
            vehicleAction: 'enter',
            vehicleId,
          };
        }
        // Timeout guard: we've been walking toward this vehicle for too
        // long (60s at 60 Hz). Give up.
        if (bot.fsmTicks > 60 * 60) {
          this.resetBotToFoot(bot, /* sendExitPacket */ false);
          return null;
        }
        return { ...footIntent, mode: 'walking_to_vehicle' };
      }

      case 'entering_vehicle': {
        const vehicleId = bot.reservedVehicleId;
        if (vehicleId === null) {
          bot.vehicleStage = 'on_foot';
          return null;
        }
        if (isInVehicle) {
          // Server confirmed the seat. Transition to driving.
          const crowd = this.ensureVehicleCrowd();
          const veh = host.vehicles.get(vehicleId);
          const spawn: Vec3Tuple = veh
            ? [veh.position[0], veh.position[1], veh.position[2]]
            : botPosition;
          // Spawn a vehicle-crowd agent for this bot and hand it the
          // vehicle filter (turn-aware cost).
          bot.vehicleHandle = crowd.addBot(spawn, {
            radius: this.vehicleProfile.agentRadius,
            height: this.vehicleProfile.agentHeight,
            maxSpeed: this.vehicleProfile.cruiseSpeed,
            queryFilter: this.vehicleQueryFilter ?? DEFAULT_QUERY_FILTER,
          });
          bot.vehicleStage = 'driving';
          bot.fsmTicks = 0;
          // Kick off the drive toward the pending destination.
          if (bot.pendingDestination) {
            crowd.requestMoveTo(bot.vehicleHandle, bot.pendingDestination);
          }
          return {
            ...footIntent,
            buttons: 0,
            mode: 'driving',
          };
        }
        // Wait a few ticks for the server to ack. If it never comes, bail.
        if (bot.fsmTicks > 120) {
          this.resetBotToFoot(bot, /* sendExitPacket */ false);
          return null;
        }
        return { ...footIntent, buttons: 0, mode: 'entering_vehicle' };
      }

      case 'driving': {
        const vehicleId = bot.reservedVehicleId;
        if (vehicleId === null || !bot.vehicleHandle || !this.vehicleCrowd) {
          this.resetBotToFoot(bot, /* sendExitPacket */ true);
          return null;
        }
        const veh = host.vehicles.get(vehicleId);
        if (!veh || veh.driverId !== bot.id) {
          // We were bumped out or the vehicle despawned.
          this.resetBotToFoot(bot, /* sendExitPacket */ false);
          return null;
        }
        // Re-ask for the destination every tick — cheap, and the foot
        // brain may have picked a moving target (e.g. harass).
        if (bot.pendingDestination) {
          this.vehicleCrowd.requestMoveTo(bot.vehicleHandle, bot.pendingDestination);
        }
        const vehicleAgent = this.vehicleCrowd.getAgent(bot.vehicleHandle.id);
        const chassisQuat: [number, number, number, number] = [
          veh.quaternion[0],
          veh.quaternion[1],
          veh.quaternion[2],
          veh.quaternion[3],
        ];
        const desired: Vec3Tuple = vehicleAgent
          ? [
              vehicleAgent.desiredVelocity[0],
              vehicleAgent.desiredVelocity[1],
              vehicleAgent.desiredVelocity[2],
            ]
          : [0, 0, 0];
        // Check for "arrived": within 2× enterDistance of the target.
        const destination = bot.pendingDestination;
        const arrived = destination
          ? Math.hypot(
              destination[0] - veh.position[0],
              destination[2] - veh.position[2],
            ) < Math.max(4, this.vehicleProfile.enterDistance * 2)
          : false;
        if (arrived) {
          bot.vehicleStage = 'exiting_vehicle';
          bot.fsmTicks = 0;
          return {
            ...footIntent,
            buttons: 0,
            mode: 'exiting_vehicle',
            vehicleAction: 'exit',
            vehicleId,
          };
        }
        // Timeout guard: if we've been trying to drive for 90 s and
        // haven't arrived, bail out — probably stuck.
        if (bot.fsmTicks > 60 * 90) {
          bot.vehicleStage = 'exiting_vehicle';
          bot.fsmTicks = 0;
          return {
            ...footIntent,
            buttons: 0,
            mode: 'exiting_vehicle',
            vehicleAction: 'exit',
            vehicleId,
          };
        }
        return vehicleAgentStateToIntent(desired, chassisQuat, {
          yaw: footIntent.yaw,
          pitch: footIntent.pitch,
          mode: 'driving',
          targetPlayerId: footIntent.targetPlayerId,
          vehicleId,
          firePrimary: false,
          vehicleAction: null,
        });
      }

      case 'exiting_vehicle': {
        if (!isInVehicle) {
          // Server confirmed the dismount. Clean up vehicle state.
          this.releaseBotVehicleResources(bot);
          bot.vehicleStage = 'on_foot';
          bot.fsmTicks = 0;
          return null;
        }
        if (bot.fsmTicks > 120) {
          // Stuck mid-dismount? Force-reset local state. The server will
          // eventually catch up via its own ack loop.
          this.releaseBotVehicleResources(bot);
          bot.vehicleStage = 'on_foot';
          bot.fsmTicks = 0;
          return null;
        }
        return { ...footIntent, buttons: 0, mode: 'exiting_vehicle' };
      }
    }
    return null;
  }

  /**
   * Picks the best vehicle for a walk-vs-drive comparison. Returns
   * `null` if walking is preferred (or no vehicle is tractable). Scans
   * every unreserved, undriven vehicle in `host.vehicles` and keeps
   * the one with the lowest estimated total travel time.
   */
  private planVehicleRoute(
    bot: PracticeBot,
    botPosition: Vec3Tuple,
    destination: Vec3Tuple,
  ): { vehicleId: number; vehiclePosition: Vec3Tuple } | null {
    if (!this.host) return null;
    // Walk baseline: foot path length / walkable speed. If the foot
    // path itself fails (destination unreachable on foot), we can't
    // compare at all.
    const walkLength = this.crowd.estimatePathLength(
      botPosition,
      destination,
      DEFAULT_QUERY_FILTER,
    );
    if (walkLength === null) return null;
    const walkTimeSec = this.estimateFootTravelTimeSec(walkLength);

    const vehicleCrowd = this.ensureVehicleCrowd();
    const vehicleFilter = this.vehicleQueryFilter ?? DEFAULT_QUERY_FILTER;
    const profile = this.vehicleProfile;

    let best: { vehicleId: number; vehiclePosition: Vec3Tuple; travelTime: number } | null = null;
    for (const [vehicleId, state] of this.host.vehicles) {
      // Skip vehicles already claimed by another bot or driven by anyone.
      if (this.reservedVehicles.has(vehicleId)) continue;
      if (state.driverId !== 0) continue;
      const vehiclePosition: Vec3Tuple = [
        state.position[0],
        state.position[1],
        state.position[2],
      ];
      // Leg 1: walk to the vehicle.
      const walkToLength = this.crowd.estimatePathLength(
        botPosition,
        vehiclePosition,
        DEFAULT_QUERY_FILTER,
      );
      if (walkToLength === null) continue;
      // Leg 2: drive from vehicle to destination on the vehicle navmesh.
      const driveLength = vehicleCrowd.estimatePathLength(
        vehiclePosition,
        destination,
        vehicleFilter,
      );
      if (driveLength === null) continue;
      const driveTime = this.estimateFootTravelTimeSec(walkToLength)
        + driveLength / profile.cruiseSpeed
        + profile.enterExitOverheadSec;
      if (!best || driveTime < best.travelTime) {
        best = { vehicleId, vehiclePosition, travelTime: driveTime };
      }
    }
    if (!best) return null;
    // Hysteresis — only switch to driving if it's **significantly** faster.
    // Otherwise the bot would thrash at the walk/drive boundary.
    if (best.travelTime > walkTimeSec * 0.75) return null;
    return { vehicleId: best.vehicleId, vehiclePosition: best.vehiclePosition };
  }

  private estimateFootTravelTimeSec(pathLengthM: number): number {
    const walkDistance = Math.min(pathLengthM, PRACTICE_BOT_SPRINT_DISTANCE_M);
    const sprintDistance = Math.max(0, pathLengthM - walkDistance);
    return (walkDistance / PRACTICE_BOT_WALK_SPEED) + (sprintDistance / PRACTICE_BOT_SPRINT_SPEED);
  }

  /**
   * Atomic reservation: only inserts if no other bot holds the slot.
   * Returns true on success.
   */
  private tryReserveVehicle(vehicleId: number, botId: number): boolean {
    const current = this.reservedVehicles.get(vehicleId);
    if (current !== undefined && current !== botId) return false;
    this.reservedVehicles.set(vehicleId, botId);
    return true;
  }
}

function makeIdleIntent(): BotIntent {
  return {
    buttons: 0,
    yaw: 0,
    pitch: 0,
    firePrimary: false,
    meleePrimary: false,
    mode: 'hold_anchor',
    targetPlayerId: null,
    vehicleAction: null,
    vehicleId: null,
  };
}

function makeBehavior(kind: PracticeBotBehaviorKind): Behavior {
  switch (kind) {
    case 'wander':
      return wander({ radiusM: 18 });
    case 'hold':
      return holdAnchor();
    case 'harass':
    default:
      // Practice mode deliberately uses plain harass behavior instead of the
      // arena-specific recovery wrapper, so bots do not leash back to center
      // or spawn by default while chasing the local player.
      return harassNearest({
        acquireDistanceM: 40,
        releaseDistanceM: 120,
        fireDistanceM: DEFAULT_HARASS_FIRE_RANGE_M,
        minFireDistanceM: 2,
      });
  }
}

void FLAG_DEAD;
