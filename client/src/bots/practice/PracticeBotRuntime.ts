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

interface PracticeBot {
  id: number;
  handle: BotHandle;
  brain: BotBrain;
  behaviorKind: PracticeBotBehaviorKind;
  seq: number;
  lastIntent: BotIntent;
}

const DEFAULT_BEHAVIOR: PracticeBotBehaviorKind = 'harass';
const DEFAULT_MAX_SPEED = 5.5;
const DEFAULT_TICK_HZ = 60;

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
    // Re-spawn any already-tracked bots against the new session.
    for (const bot of this.bots.values()) {
      this.transport.connectBot(bot.id);
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
      const agent = this.crowd.getAgent(bot.handle.id);
      if (agent) agent.maxSpeed = clamped;
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
    this.transport?.connectBot(id);
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
