/**
 * PracticeBotRuntime — spawns bots as **real players** inside the
 * `LocalPreviewSession` WASM world and drives them with navcat.
 *
 * Pipeline per tick:
 *   1. Read each bot's authoritative position from the NetcodeClient's
 *      `remotePlayers` map (which is populated by snapshots emitted from
 *      the WASM session — bots are regular players there).
 *   2. `syncBotPosition` that into the shared navcat {@link BotCrowd}.
 *   3. `crowd.step(dt)` advances pathfinding + obstacle avoidance for every
 *      bot in one pass.
 *   4. For each bot, run its {@link BotBrain} which turns `agent.desiredVelocity`
 *      into a {@link BotIntent} (buttons + yaw + pitch).
 *   5. Encode the intent as an {@link InputCmd} and hand it to
 *      {@link LocalPreviewTransport.sendBotInputs}, which routes it into the
 *      WASM session's per-bot `PlayerRuntime`. The KCC then integrates the
 *      bot's capsule like any other player — collisions, step height,
 *      gravity, everything.
 *
 * Because bots are real players, they appear in snapshots like any remote
 * and GameWorld renders them with its existing remote-player code path.
 * Hit detection is handled by the session's multi-player hitscan.
 */

import type { NetcodeClient } from '../../net/netcodeClient';
import type { LocalPreviewTransport } from '../../net/localPreviewTransport';
import type { WorldDocument } from '../../world/worldDocument';
import { buildInputFromButtons } from '../../scene/inputBuilder';
import { FLAG_DEAD } from '../../net/protocol';
import { FLAG_IN_VEHICLE } from '../../net/sharedConstants';
import { pathCorridor } from 'navcat/blocks';
import { DEFAULT_QUERY_FILTER } from 'navcat';
import { createVehicleQueryFilter } from '../crowd/vehicleQueryFilter';
import { vehicleAgentStateToIntent } from '../agent/vehicleSteering';

/**
 * Accessor for the local (human) player's authoritative state. The
 * runtime calls this every tick so bot brains know who to chase. Return
 * `null` if the local player state isn't available yet (pre-welcome).
 */
export type LocalSelfAccessor = () => LocalSelfSnapshot | null;

export interface LocalSelfSnapshot {
  id: number;
  position: [number, number, number];
  dead: boolean;
}
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

/** Starting id for practice bots. Kept well above any realistic player id. */
export const PRACTICE_BOT_ID_BASE = 1_000_000;

/** Behaviors exposed by the practice UI. */
export type PracticeBotBehaviorKind = 'harass' | 'wander' | 'hold';

export interface PracticeBotRuntimeOptions {
  /**
   * Largest agent radius the crowd will accept. Defaults to 0.6 — covers
   * the stock harass bots comfortably.
   */
  maxAgentRadius?: number;
  /** Behavior used for newly spawned bots. */
  initialBehavior?: PracticeBotBehaviorKind;
  /** Max speed (m/s) applied to every bot's navcat agent. */
  maxSpeed?: number;
  /** Frequency at which we tick bot logic + push inputs (Hz). */
  tickHz?: number;
  /** Whether bots start with vehicle mode enabled. */
  useVehicles?: boolean;
  /** Override the default vehicle profile used by the walk-vs-drive planner. */
  vehicleProfile?: VehicleProfile;
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
  /** True while the runtime is actively ticking (session connected). */
  running: boolean;
  /** Whether the vehicle-aware planner is currently enabled. */
  useVehicles: boolean;
  /** Number of vehicle-sized tris in the lazy vehicle navmesh, 0 if unbuilt. */
  vehicleNavTriangles: number;
}

/**
 * Per-bot vehicle FSM stage. Mirrors {@link BotMode} but lives in the
 * runtime because the decision involves cross-bot resources (vehicle
 * reservations, two crowds) that a `Behavior` shouldn't see.
 */
type VehicleFsmStage =
  | 'on_foot'
  | 'walking_to_vehicle'
  | 'entering_vehicle'
  | 'driving'
  | 'exiting_vehicle';

/**
 * Snapshot of an obstacle (currently: vehicle) that the bot crowd
 * treats as a navmesh-level avoider. Returned from
 * {@link PracticeBotRuntime.getObstacleDebugInfos} so the debug overlay
 * can draw footprints at the positions the bots are actually steering
 * around.
 */
export interface BotObstacleDebugInfo {
  kind: 'vehicle';
  /** Source id — vehicle id in `client.vehicles`. */
  sourceId: number;
  position: Vec3Tuple;
  radius: number;
  height: number;
}

/**
 * Snapshot of one bot's planning state, surfaced for the in-scene debug
 * overlay. Pure data — no THREE / R3F dependencies so the renderer can
 * decide how to visualize each piece.
 */
export interface BotDebugInfo {
  id: number;
  /** World-space position (server-authoritative if attached). */
  position: Vec3Tuple;
  /** The destination this bot is currently routing toward, if any. */
  target: Vec3Tuple | null;
  /** Funnel-algorithm steering corners from `position` to `target`. */
  pathPoints: Vec3Tuple[];
  /** Crowd's planned velocity for this tick. */
  desiredVelocity: Vec3Tuple;
  /** KCC-driven actual velocity from the last sync. */
  velocity: Vec3Tuple;
  /** Behavior label from the practice UI dropdown. */
  behaviorKind: PracticeBotBehaviorKind;
  /** Decision mode emitted by the brain on the last tick. */
  mode: BotMode;
  /** Currently targeted remote player, if any. */
  targetPlayerId: number | null;
  /** Configured max speed override (m/s). */
  maxSpeed: number;
  /** Whether the brain wanted to fire on the last tick. */
  firePrimary: boolean;
  /** Vehicle FSM stage — `'on_foot'` for walking bots. */
  vehicleStage: VehicleFsmStage;
  /** Vehicle id this bot is currently reserving / driving, or null. */
  reservedVehicleId: number | null;
}

interface PracticeBot {
  id: number;
  handle: BotHandle;
  brain: BotBrain;
  behaviorKind: PracticeBotBehaviorKind;
  seq: number;
  lastIntent: BotIntent;
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
// Default at a brisk jog. The KCC's human walk speed is 6.0 m/s and
// sprint is 8.5 m/s; 3.0 m/s feels like a slow bot you can actually look
// at, and the slider goes up from there. See the speed override flow in
// `shared/src/simulation.rs::update_player_motion`.
const DEFAULT_MAX_SPEED = 3.0;
const DEFAULT_TICK_HZ = 60;
// Vehicle chassis half-extents from `shared/src/movement.rs`
// (`VEHICLE_CHASSIS_HALF_EXTENTS`). The circumscribed XZ radius is the
// diagonal, which is what we use when registering the vehicle as a
// navcat pseudo-agent. Slight padding (+0.2m) gives the bot a small
// berth so it doesn't scrape the bodywork.
const VEHICLE_OBSTACLE_RADIUS = Math.hypot(0.9, 1.8) + 0.2;
const VEHICLE_OBSTACLE_HEIGHT = 1.2;

/**
 * Runtime for practice-mode bots that spawns them as full players in the
 * local WASM session and pilots them via navcat.
 */
export class PracticeBotRuntime {
  readonly crowd: BotCrowd;
  private readonly bots = new Map<number, PracticeBot>();
  private nextId = PRACTICE_BOT_ID_BASE;
  private behaviorKind: PracticeBotBehaviorKind;
  private maxSpeed: number;
  private readonly tickHz: number;
  private client: NetcodeClient | null = null;
  private transport: LocalPreviewTransport | null = null;
  private getSelf: LocalSelfAccessor | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = 0;
  private running = false;
  /**
   * Map of vehicleId → navcat agentId for stationary "pseudo-agents"
   * that represent live vehicles to the crowd planner. Each tick we
   * mirror `client.vehicles` into this map so bots steer around vehicles
   * without them being baked into the static navmesh.
   */
  private readonly vehicleObstacleAgents = new Map<number, string>();
  private readonly world: WorldDocument;
  private readonly maxAgentRadius: number;
  /** Whether the walk-vs-drive planner is active. */
  private useVehicles: boolean;
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
   * Reservation map — prevents two bots racing for the same car.
   * Key: vehicleId. Value: botId holding the reservation.
   */
  private readonly reservedVehicles = new Map<number, number>();

  constructor(world: WorldDocument, options: PracticeBotRuntimeOptions = {}) {
    this.world = world;
    this.maxAgentRadius = options.maxAgentRadius ?? 0.6;
    this.crowd = createBotCrowd(world, {
      maxAgentRadius: this.maxAgentRadius,
    });
    this.behaviorKind = options.initialBehavior ?? DEFAULT_BEHAVIOR;
    this.maxSpeed = options.maxSpeed ?? DEFAULT_MAX_SPEED;
    this.tickHz = options.tickHz ?? DEFAULT_TICK_HZ;
    this.useVehicles = options.useVehicles ?? false;
    this.vehicleProfile = options.vehicleProfile ?? DEFAULT_VEHICLE_PROFILE;
  }

  /**
   * Attach the runtime to a live {@link NetcodeClient}. The runtime will
   * push bot inputs through the client's {@link LocalPreviewTransport} and
   * read bot positions from `client.remotePlayers`. `getSelf` must return
   * the human's current position — typically read from the connection
   * state updated in `onLocalSnapshot`.
   *
   * Call {@link detach} when the session tears down.
   */
  attach(client: NetcodeClient, getSelf: LocalSelfAccessor): void {
    if (this.client === client && this.getSelf === getSelf) return;
    this.detach();
    this.client = client;
    this.getSelf = getSelf;
    const transport = client.getLocalPreviewTransport();
    if (!transport) {
      // Not a practice session — nothing to do. Bots won't spawn.
      return;
    }
    this.transport = transport;
    // Re-spawn any already-tracked bots against the new session and
    // re-apply the current max-speed override so the KCC uses it.
    for (const bot of this.bots.values()) {
      this.transport.connectBot(bot.id);
      this.transport.setBotMaxSpeed(bot.id, this.maxSpeed);
    }
    this.running = true;
    this.lastTickMs = performance.now();
    this.tickHandle = setInterval(() => this.tick(), 1000 / this.tickHz);
  }

  /** Detach from the current session and stop ticking. */
  detach(): void {
    this.running = false;
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.transport) {
      for (const bot of this.bots.values()) {
        this.transport.disconnectBot(bot.id);
      }
    }
    // Drop vehicle pseudo-agents — they're tied to the session whose
    // `client.vehicles` map just went away.
    for (const agentId of this.vehicleObstacleAgents.values()) {
      this.crowd.removeObstacleAgent(agentId);
    }
    this.vehicleObstacleAgents.clear();
    // Snap every bot back to on-foot mode and drop reservations — the
    // WASM session is disappearing, so sending exit packets would be
    // routed into a void. We just release local state.
    for (const bot of this.bots.values()) {
      this.releaseBotVehicleResources(bot);
      bot.vehicleStage = 'on_foot';
      bot.pendingDestination = null;
      bot.fsmTicks = 0;
    }
    this.reservedVehicles.clear();
    this.transport = null;
    this.client = null;
    this.getSelf = null;
  }

  /** Number of active bots. */
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
      useVehicles: this.useVehicles,
      vehicleNavTriangles: this.vehicleCrowd?.nav.geometry.triangleCount ?? 0,
    };
  }

  /**
   * Enable or disable the walk-vs-drive planner. On first enable, builds
   * the second (vehicle-sized) navmesh + crowd lazily; on disable, cleanly
   * resets every bot back to `on_foot` and drops all vehicle reservations.
   */
  setUseVehicles(value: boolean): void {
    if (value === this.useVehicles) return;
    this.useVehicles = value;
    if (value) {
      this.ensureVehicleCrowd();
    } else {
      // Unwind every bot's FSM to a clean on-foot state.
      for (const bot of this.bots.values()) {
        this.resetBotToFoot(bot, /* sendExitPacket */ true);
      }
      this.reservedVehicles.clear();
    }
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
    const clamped = Math.max(0.5, Math.min(12, speed));
    this.maxSpeed = clamped;
    for (const bot of this.bots.values()) {
      // Keep navcat's crowd planner in sync so desiredVelocity never
      // exceeds the KCC cap (avoids oscillation where the crowd asks for
      // faster-than-attainable motion and the agent looks stuttery).
      const agent = this.crowd.getAgent(bot.handle.id);
      if (agent) agent.maxSpeed = clamped;
      // Real source of truth for how fast the bot moves on the server:
      // the per-player override inside LocalPreviewSession.
      this.transport?.setBotMaxSpeed(bot.id, clamped);
    }
  }

  /**
   * Ensures exactly `target` bots are alive. New bots are spawned at
   * random walkable points; extras are removed from the tail.
   */
  setBotCount(target: number): void {
    const clamped = Math.max(0, Math.min(32, Math.floor(target)));
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

  /** Spawn a single bot. Returns its id. */
  spawnBot(): number {
    const spawn = this.crowd.findRandomWalkable() ?? [0, 2, 0];
    const handle = this.crowd.addBot(spawn);
    const agent = this.crowd.getAgent(handle.id);
    if (agent) agent.maxSpeed = this.maxSpeed;
    const id = this.nextId;
    this.nextId += 1;
    const brain = new BotBrain(this.crowd, handle, makeBehavior(this.behaviorKind), {
      anchor: spawn,
    });
    this.bots.set(id, {
      id,
      handle,
      brain,
      behaviorKind: this.behaviorKind,
      seq: 0,
      lastIntent: makeIdleIntent(),
      vehicleStage: 'on_foot',
      reservedVehicleId: null,
      vehicleHandle: null,
      pendingDestination: null,
      fsmTicks: 0,
    });
    if (this.transport) {
      this.transport.connectBot(id);
      // Push the current max-speed override so the bot's KCC moves at
      // whatever speed the user has on the slider right now.
      this.transport.setBotMaxSpeed(id, this.maxSpeed);
    }
    return id;
  }

  /** Remove a single bot by id. */
  removeBot(id: number): boolean {
    const bot = this.bots.get(id);
    if (!bot) return false;
    this.releaseBotVehicleResources(bot);
    this.crowd.removeBot(bot.handle);
    this.bots.delete(id);
    this.transport?.disconnectBot(id);
    return true;
  }

  /** Remove every bot. */
  clear(): void {
    for (const bot of this.bots.values()) {
      this.releaseBotVehicleResources(bot);
      this.crowd.removeBot(bot.handle);
      this.transport?.disconnectBot(bot.id);
    }
    this.bots.clear();
    this.reservedVehicles.clear();
    for (const agentId of this.vehicleObstacleAgents.values()) {
      this.crowd.removeObstacleAgent(agentId);
    }
    this.vehicleObstacleAgents.clear();
  }

  /** Drop a bot's vehicle-crowd handle and release its reservation, if any. */
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

  /**
   * Forcibly reset a bot's FSM to `on_foot`. If the bot is currently
   * seated, we optionally push an exit packet so the server releases its
   * vehicle slot. Used on `setUseVehicles(false)` and on bot removal.
   */
  private resetBotToFoot(bot: PracticeBot, sendExitPacket: boolean): void {
    if (sendExitPacket && bot.vehicleStage === 'driving' && bot.reservedVehicleId !== null && this.transport) {
      this.transport.sendBotVehicleExit(bot.id, bot.reservedVehicleId);
    }
    this.releaseBotVehicleResources(bot);
    bot.vehicleStage = 'on_foot';
    bot.pendingDestination = null;
    bot.fsmTicks = 0;
  }

  /**
   * Returns one {@link BotObstacleDebugInfo} per live vehicle pseudo-
   * agent, for the in-scene debug overlay. Cheap enough to call every
   * render frame.
   */
  getObstacleDebugInfos(): BotObstacleDebugInfo[] {
    if (!this.client) return [];
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

  /**
   * Mirror `client.vehicles` into the crowd as stationary pseudo-agents so
   * bots see them as obstacles. Call this at the top of every `tick()`
   * just before `crowd.step`.
   *
   * A vehicle currently being driven by one of **our** bots is skipped —
   * otherwise the bot's own chassis would register as an obstacle in the
   * foot crowd and distort the walk-vs-drive cost comparison for peer
   * bots. Vehicles driven by **other** bots (and the human) still appear
   * as obstacles so bots route around them on foot.
   */
  private syncVehicleObstacles(client: NetcodeClient): void {
    const seen = new Set<number>();
    // Build the "self-driven" set once per tick — cheap for <=32 bots.
    const selfDriven = new Set<number>();
    for (const bot of this.bots.values()) {
      if (bot.vehicleStage === 'driving' && bot.reservedVehicleId !== null) {
        selfDriven.add(bot.reservedVehicleId);
      }
    }
    for (const [vehicleId, state] of client.vehicles) {
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
    // Drop pseudo-agents for vehicles that have since disappeared
    // (despawned or the session swapped worlds) **or** that we just
    // claimed as a self-driven car this frame.
    for (const [vehicleId, agentId] of this.vehicleObstacleAgents) {
      if (!seen.has(vehicleId)) {
        this.crowd.removeObstacleAgent(agentId);
        this.vehicleObstacleAgents.delete(vehicleId);
      }
    }
  }

  /**
   * Per-bot diagnostics for the in-scene debug overlay. Reads navcat's
   * crowd state (corridor, target, desired velocity) and combines it with
   * the latest brain decision label so callers can render "what is this
   * bot thinking" in the world.
   *
   * Returns an empty array if the runtime is unattached or has no bots.
   * Cheap enough to call every render frame.
   */
  getBotDebugInfos(): BotDebugInfo[] {
    if (this.bots.size === 0) return [];
    const out: BotDebugInfo[] = [];
    for (const bot of this.bots.values()) {
      const agent = this.crowd.getAgent(bot.handle.id);
      if (!agent) continue;
      // Prefer the snapshot-driven server position if the runtime is
      // attached (more accurate than the crowd's internal sim, since
      // the crowd is just a planner here). Fall back to agent.position.
      const remote = this.client?.remotePlayers.get(bot.id);
      const position: Vec3Tuple = remote
        ? [remote.position[0], remote.position[1], remote.position[2]]
        : [agent.position[0], agent.position[1], agent.position[2]];

      // Steering corners: navcat's path-corridor exposes a string-pulled
      // straight path (the funnel-algorithm corners the agent is aiming
      // at). Each corner is a world-space point along the bot's planned
      // route to its target.
      const corners = pathCorridor.findCorners(
        agent.corridor,
        this.crowd.navMesh,
        8,
      );
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

      out.push({
        id: bot.id,
        position,
        target: bot.handle.targetPosition
          ? [
              bot.handle.targetPosition[0],
              bot.handle.targetPosition[1],
              bot.handle.targetPosition[2],
            ]
          : null,
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
        vehicleStage: bot.vehicleStage,
        reservedVehicleId: bot.reservedVehicleId,
      });
    }
    return out;
  }

  /** Internal tick — runs every `1 / tickHz` seconds when attached. */
  private tick(): void {
    if (!this.running || !this.client || !this.transport) return;
    if (this.bots.size === 0) return;
    const nowMs = performance.now();
    const dt = Math.min(0.25, Math.max(0.001, (nowMs - this.lastTickMs) / 1000));
    this.lastTickMs = nowMs;

    const client = this.client;
    const localFlags = client.localPlayerFlags;
    const localHp = client.localPlayerHp;
    const selfSnapshot = this.getSelf?.() ?? null;
    const localIsDead = selfSnapshot?.dead ?? ((localFlags & FLAG_DEAD) !== 0 || localHp <= 0);
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
          },
        ]
      : [];

    // Sync every bot's authoritative position from the latest snapshot
    // *before* stepping the crowd, so navmesh planning uses real physics
    // positions rather than the crowd's internal dead-reckoning. For
    // bots currently driving, sync their vehicle-crowd agent to the
    // vehicle's chassis position instead.
    for (const bot of this.bots.values()) {
      const remote = client.remotePlayers.get(bot.id);
      if (remote) {
        this.crowd.syncBotPosition(bot.handle, remote.position);
      }
      if (
        bot.vehicleStage === 'driving'
        && bot.vehicleHandle
        && bot.reservedVehicleId !== null
        && this.vehicleCrowd
      ) {
        const veh = client.vehicles.get(bot.reservedVehicleId);
        if (veh) {
          this.vehicleCrowd.syncBotPosition(bot.vehicleHandle, [
            veh.position[0],
            veh.position[1],
            veh.position[2],
          ]);
        }
      }
    }

    // Mirror live vehicles into the navcat crowd as stationary pseudo-
    // agents so real bots' separation / obstacle-avoidance routes around
    // them. Vehicles are dynamic (they move at runtime) and therefore
    // aren't baked into the static navmesh; without this step bots would
    // path straight through parked cars.
    this.syncVehicleObstacles(client);

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
      const remote = client.remotePlayers.get(bot.id);
      if (!remote) {
        // Bot has no snapshot yet (just spawned) — skip this frame.
        continue;
      }
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
      this.transport.sendBotInputs(bot.id, [cmd]);
      // Side-channel: if the FSM asked us to send a vehicle enter/exit
      // packet this tick, route it through the bot-specific transport
      // shim. These are **in addition to** the input bundle above —
      // handle_bot_packet dispatches on packet type, not a single stream.
      if (intent.vehicleAction === 'enter' && intent.vehicleId != null) {
        this.transport.sendBotVehicleEnter(bot.id, intent.vehicleId);
      } else if (intent.vehicleAction === 'exit' && intent.vehicleId != null) {
        this.transport.sendBotVehicleExit(bot.id, intent.vehicleId);
      }
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
    const transport = this.transport;
    const client = this.client;
    if (!transport || !client) return null;
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
        const veh = client.vehicles.get(vehicleId);
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
          const veh = client.vehicles.get(vehicleId);
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
        const veh = client.vehicles.get(vehicleId);
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
   * every unreserved, undriven vehicle in `client.vehicles` and keeps
   * the one with the lowest estimated total travel time.
   */
  private planVehicleRoute(
    bot: PracticeBot,
    botPosition: Vec3Tuple,
    destination: Vec3Tuple,
  ): { vehicleId: number; vehiclePosition: Vec3Tuple } | null {
    const client = this.client;
    if (!client) return null;
    // Walk baseline: foot path length / walkable speed. If the foot
    // path itself fails (destination unreachable on foot), we can't
    // compare at all.
    const walkLength = this.crowd.estimatePathLength(
      botPosition,
      destination,
      DEFAULT_QUERY_FILTER,
    );
    if (walkLength === null) return null;
    const walkSpeed = Math.max(1, this.maxSpeed);
    const walkTimeSec = walkLength / walkSpeed;

    const vehicleCrowd = this.ensureVehicleCrowd();
    const vehicleFilter = this.vehicleQueryFilter ?? DEFAULT_QUERY_FILTER;
    const profile = this.vehicleProfile;

    let best: { vehicleId: number; vehiclePosition: Vec3Tuple; travelTime: number } | null = null;
    for (const [vehicleId, state] of client.vehicles) {
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
      const driveTime = walkToLength / walkSpeed
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
      return harassNearest({
        acquireDistanceM: 80,
        recoveryDistanceM: 120,
        fireDistanceM: 0,
      });
  }
}

// Keep FLAG_DEAD referenced so TS doesn't flag the import.
void FLAG_DEAD;
