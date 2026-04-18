import { pathCorridor } from 'navcat/blocks';

import type { PracticeBotHost } from '../../net/localPracticeClient';
import { FLAG_DEAD } from '../../net/protocol';
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
  type BotHandle,
} from '../crowd/BotCrowd';
import type {
  BotIntent,
  BotMode,
  BotSelfState,
  ObservedPlayer,
  Vec3Tuple,
} from '../types';

export type LocalSelfAccessor = () => LocalSelfSnapshot | null;

export interface LocalSelfSnapshot {
  id: number;
  position: [number, number, number];
  dead: boolean;
}

export const PRACTICE_BOT_ID_BASE = 1_000_000;

export type PracticeBotBehaviorKind = 'harass' | 'wander' | 'hold';

export interface PracticeBotRuntimeOptions {
  maxAgentRadius?: number;
  snapHalfExtents?: Vec3Tuple;
  initialBehavior?: PracticeBotBehaviorKind;
  maxSpeed?: number;
  tickHz?: number;
}

export interface PracticeBotRuntimeSyncOptions extends PracticeBotRuntimeOptions {
  navigationProfile: SharedPlayerNavigationProfile;
}

export interface PracticeBotStats {
  bots: number;
  behavior: PracticeBotBehaviorKind;
  maxSpeed: number;
  navTriangles: number;
  running: boolean;
}

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
const DEFAULT_MAX_SPEED = 3.0;
const DEFAULT_TICK_HZ = 60;
const VEHICLE_OBSTACLE_RADIUS = Math.hypot(0.9, 1.8) + 0.2;
const VEHICLE_OBSTACLE_HEIGHT = 1.2;

export class PracticeBotRuntime {
  readonly crowd: BotCrowd;
  private readonly bots = new Map<number, PracticeBot>();
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

  static createSync(world: WorldDocument, options: PracticeBotRuntimeSyncOptions): PracticeBotRuntime {
    const crowd = createBotCrowd(world, {
      navigationProfile: options.navigationProfile,
      maxAgentRadius: options.maxAgentRadius ?? 0.6,
      snapHalfExtents: options.snapHalfExtents,
    });
    return new PracticeBotRuntime(crowd, options);
  }

  static async create(
    world: WorldDocument,
    options: PracticeBotRuntimeOptions = {},
  ): Promise<PracticeBotRuntime> {
    const crowd = await createBotCrowdFromSharedProfile(world, {
      maxAgentRadius: options.maxAgentRadius ?? 0.6,
      snapHalfExtents: options.snapHalfExtents,
    });
    return new PracticeBotRuntime(crowd, options);
  }

  private constructor(crowd: BotCrowd, options: PracticeBotRuntimeOptions = {}) {
    this.crowd = crowd;
    this.behaviorKind = options.initialBehavior ?? DEFAULT_BEHAVIOR;
    this.maxSpeed = options.maxSpeed ?? DEFAULT_MAX_SPEED;
    this.tickHz = options.tickHz ?? DEFAULT_TICK_HZ;
  }

  attach(host: PracticeBotHost, getSelf: LocalSelfAccessor): void {
    if (this.host === host && this.getSelf === getSelf) return;
    this.detach();
    this.host = host;
    this.getSelf = getSelf;
    for (const bot of this.bots.values()) {
      this.host.connectBot(bot.id);
      this.syncBotToAuthoritativeSpawn(bot, this.host);
      this.host.setBotMaxSpeed(bot.id, this.maxSpeed);
    }
    this.running = true;
    this.lastTickMs = performance.now();
    this.tickHandle = setInterval(() => this.tick(), 1000 / this.tickHz);
  }

  detach(): void {
    this.running = false;
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.host) {
      for (const bot of this.bots.values()) {
        this.host.disconnectBot(bot.id);
      }
    }
    for (const agentId of this.vehicleObstacleAgents.values()) {
      this.crowd.removeObstacleAgent(agentId);
    }
    this.vehicleObstacleAgents.clear();
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
      const agent = this.crowd.getAgent(bot.handle.id);
      if (agent) agent.maxSpeed = clamped;
      this.host?.setBotMaxSpeed(bot.id, clamped);
    }
  }

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
    if (this.host) {
      this.host.connectBot(id);
      this.syncBotToAuthoritativeSpawn(this.bots.get(id) ?? null, this.host);
      this.host.setBotMaxSpeed(id, this.maxSpeed);
    }
    return id;
  }

  removeBot(id: number): boolean {
    const bot = this.bots.get(id);
    if (!bot) return false;
    this.crowd.removeBot(bot.handle);
    this.bots.delete(id);
    this.host?.disconnectBot(id);
    return true;
  }

  clear(): void {
    for (const bot of this.bots.values()) {
      this.crowd.removeBot(bot.handle);
      this.host?.disconnectBot(bot.id);
    }
    this.bots.clear();
    for (const agentId of this.vehicleObstacleAgents.values()) {
      this.crowd.removeObstacleAgent(agentId);
    }
    this.vehicleObstacleAgents.clear();
  }

  private syncBotToAuthoritativeSpawn(bot: PracticeBot | null, host: PracticeBotHost): void {
    if (!bot) return;
    const remote = host.remotePlayers.get(bot.id);
    if (!remote) return;
    this.crowd.syncBotPosition(bot.handle, remote.position);
    bot.brain.setAnchor([remote.position[0], remote.position[1], remote.position[2]]);
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
    for (const [vehicleId, state] of host.vehicles) {
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

    for (const bot of this.bots.values()) {
      const remote = host.remotePlayers.get(bot.id);
      if (remote) {
        this.crowd.syncBotPosition(bot.handle, remote.position);
      }
    }

    this.syncVehicleObstacles(host);
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

      bot.lastIntent = bot.brain.think(selfTemplate, observed);
      bot.seq = (bot.seq + 1) & 0xffff;
      const cmd = buildInputFromButtons(
        bot.seq,
        0,
        bot.lastIntent.buttons,
        bot.lastIntent.yaw,
        bot.lastIntent.pitch,
      );
      host.sendBotInputs(bot.id, [cmd]);
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

void FLAG_DEAD;
