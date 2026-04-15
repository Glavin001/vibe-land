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
import { pathCorridor } from 'navcat/blocks';

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
import { BotCrowd, createBotCrowd, type BotHandle } from '../crowd/BotCrowd';
import type {
  BotIntent,
  BotMode,
  BotSelfState,
  ObservedPlayer,
  Vec3Tuple,
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
}

export interface PracticeBotStats {
  bots: number;
  behavior: PracticeBotBehaviorKind;
  maxSpeed: number;
  navTriangles: number;
  /** True while the runtime is actively ticking (session connected). */
  running: boolean;
}

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
}

interface PracticeBot {
  id: number;
  handle: BotHandle;
  brain: BotBrain;
  behaviorKind: PracticeBotBehaviorKind;
  seq: number;
  lastIntent: BotIntent;
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

  constructor(world: WorldDocument, options: PracticeBotRuntimeOptions = {}) {
    this.crowd = createBotCrowd(world, {
      maxAgentRadius: options.maxAgentRadius ?? 0.6,
    });
    this.behaviorKind = options.initialBehavior ?? DEFAULT_BEHAVIOR;
    this.maxSpeed = options.maxSpeed ?? DEFAULT_MAX_SPEED;
    this.tickHz = options.tickHz ?? DEFAULT_TICK_HZ;
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
    };
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
    this.crowd.removeBot(bot.handle);
    this.bots.delete(id);
    this.transport?.disconnectBot(id);
    return true;
  }

  /** Remove every bot. */
  clear(): void {
    for (const bot of this.bots.values()) {
      this.crowd.removeBot(bot.handle);
      this.transport?.disconnectBot(bot.id);
    }
    this.bots.clear();
    for (const agentId of this.vehicleObstacleAgents.values()) {
      this.crowd.removeObstacleAgent(agentId);
    }
    this.vehicleObstacleAgents.clear();
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
   */
  private syncVehicleObstacles(client: NetcodeClient): void {
    const seen = new Set<number>();
    for (const [vehicleId, state] of client.vehicles) {
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
    // (despawned or the session swapped worlds).
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
    // positions rather than the crowd's internal dead-reckoning.
    for (const bot of this.bots.values()) {
      const remote = client.remotePlayers.get(bot.id);
      if (remote) {
        this.crowd.syncBotPosition(bot.handle, remote.position);
      }
    }

    // Mirror live vehicles into the navcat crowd as stationary pseudo-
    // agents so real bots' separation / obstacle-avoidance routes around
    // them. Vehicles are dynamic (they move at runtime) and therefore
    // aren't baked into the static navmesh; without this step bots would
    // path straight through parked cars.
    this.syncVehicleObstacles(client);

    this.crowd.step(dt);

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

      bot.lastIntent = bot.brain.think(selfTemplate, observed);
      bot.seq = (bot.seq + 1) & 0xffff;
      const cmd = buildInputFromButtons(
        bot.seq,
        0,
        bot.lastIntent.buttons,
        bot.lastIntent.yaw,
        bot.lastIntent.pitch,
      );
      this.transport.sendBotInputs(bot.id, [cmd]);
    }
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
