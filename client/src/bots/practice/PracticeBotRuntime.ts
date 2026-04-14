/**
 * PracticeBotRuntime — spawns and ticks bots entirely client-side for
 * /practice (single-player) mode.
 *
 * Unlike the loadtest runners, practice bots do **not** connect to a server
 * or pass through any WASM physics. Their motion is simulated purely by a
 * shared {@link BotCrowd} (navcat crowd) and then projected as synthetic
 * "remote players" into the {@link GameWorld} render loop, so they appear
 * alongside the local human as regular capsule meshes.
 *
 * The public surface intentionally mimics the shape of a
 * {@link RemotePlayer} map so that {@link GameWorld} can iterate it with the
 * same loops it already uses for network-driven remotes.
 */

import type { WorldDocument } from '../../world/worldDocument';
import type { RemotePlayer } from '../../scene/useGameConnection';
import { BotBrain } from '../agent/BotBrain';
import {
  harassNearest,
  holdAnchor,
  moveTo,
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

/** Starting id for practice bots. Chosen to sit well above any real player id. */
const PRACTICE_BOT_ID_BASE = 1_000_000;

/** Behaviors exposed to the practice UI. */
export type PracticeBotBehaviorKind = 'harass' | 'wander' | 'hold';

export interface PracticeBotRuntimeOptions {
  /**
   * Max radius of any bot added to the crowd. Must be >= the largest bot
   * radius; leaving it at the default covers the stock `harassNearest`
   * bots.
   */
  maxAgentRadius?: number;
  /** Behavior to use for freshly spawned bots (defaults to `'harass'`). */
  initialBehavior?: PracticeBotBehaviorKind;
  /** Max speed (m/s) each bot's crowd agent will travel. */
  maxSpeed?: number;
}

export interface PracticeBotStats {
  bots: number;
  behavior: PracticeBotBehaviorKind;
  maxSpeed: number;
  navTriangles: number;
}

interface PracticeBot {
  id: number;
  handle: BotHandle;
  brain: BotBrain;
  behaviorKind: PracticeBotBehaviorKind;
  /** Mirrors the RemotePlayer shape GameWorld renders. */
  render: RemotePlayer;
  /** Last intent from the brain (for stats / debug). */
  lastIntent: BotIntent;
}

const DEFAULT_BEHAVIOR: PracticeBotBehaviorKind = 'harass';
const DEFAULT_MAX_SPEED = 5.5;

/**
 * Runtime for practice-mode bots. Owns a single shared navcat crowd and one
 * {@link BotBrain} per bot. Call {@link update} once per render frame from
 * GameWorld.
 */
export class PracticeBotRuntime {
  readonly crowd: BotCrowd;
  /**
   * Map of bot-id → {@link RemotePlayer}, structurally identical to the real
   * `state.remotePlayers` map that GameWorld iterates. Safe to expose as a
   * live reference — GameWorld reads it every frame.
   */
  readonly remotePlayers: Map<number, RemotePlayer> = new Map();

  private readonly bots = new Map<number, PracticeBot>();
  private nextId = PRACTICE_BOT_ID_BASE;
  private behaviorKind: PracticeBotBehaviorKind;
  private maxSpeed: number;

  constructor(world: WorldDocument, options: PracticeBotRuntimeOptions = {}) {
    this.crowd = createBotCrowd(world, {
      maxAgentRadius: options.maxAgentRadius ?? 0.6,
    });
    this.behaviorKind = options.initialBehavior ?? DEFAULT_BEHAVIOR;
    this.maxSpeed = options.maxSpeed ?? DEFAULT_MAX_SPEED;
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
    };
  }

  /** Set the behavior used for newly added bots and reapply it to existing ones. */
  setBehavior(kind: PracticeBotBehaviorKind): void {
    if (kind === this.behaviorKind) return;
    this.behaviorKind = kind;
    for (const bot of this.bots.values()) {
      bot.brain.setBehavior(makeBehavior(kind));
      bot.behaviorKind = kind;
    }
  }

  /** Set the max move speed for all (current and future) bots. */
  setMaxSpeed(speed: number): void {
    const clamped = Math.max(0.5, Math.min(12, speed));
    this.maxSpeed = clamped;
    for (const bot of this.bots.values()) {
      const agent = this.crowd.getAgent(bot.handle.id);
      if (agent) agent.maxSpeed = clamped;
    }
  }

  /**
   * Ensures exactly `target` bots are active. Bots are spawned at randomly
   * sampled walkable points near `spawnNear` (falling back to the world
   * origin if sampling fails). Extra bots are removed from the tail.
   */
  setBotCount(target: number, spawnNear?: Vec3Tuple): void {
    const clamped = Math.max(0, Math.min(32, Math.floor(target)));
    while (this.bots.size < clamped) {
      this.spawnBot(spawnNear);
    }
    if (this.bots.size > clamped) {
      const ids = Array.from(this.bots.keys());
      for (let i = clamped; i < ids.length; i += 1) {
        this.removeBot(ids[i]);
      }
    }
  }

  /** Spawn a single bot. Returns its id. */
  spawnBot(spawnNear?: Vec3Tuple): number {
    const spawn = this.chooseSpawnPoint(spawnNear);
    const handle = this.crowd.addBot(spawn);
    const agent = this.crowd.getAgent(handle.id);
    if (agent) agent.maxSpeed = this.maxSpeed;
    const id = this.nextId;
    this.nextId += 1;
    const brain = new BotBrain(this.crowd, handle, makeBehavior(this.behaviorKind), {
      anchor: spawn,
    });
    const render: RemotePlayer = {
      id,
      position: [spawn[0], spawn[1], spawn[2]],
      yaw: 0,
      pitch: 0,
      hp: 100,
    };
    this.bots.set(id, {
      id,
      handle,
      brain,
      behaviorKind: this.behaviorKind,
      render,
      lastIntent: {
        buttons: 0,
        yaw: 0,
        pitch: 0,
        firePrimary: false,
        mode: 'hold_anchor',
        targetPlayerId: null,
      },
    });
    this.remotePlayers.set(id, render);
    return id;
  }

  /** Remove a single bot by id. */
  removeBot(id: number): boolean {
    const bot = this.bots.get(id);
    if (!bot) return false;
    this.crowd.removeBot(bot.handle);
    this.bots.delete(id);
    this.remotePlayers.delete(id);
    return true;
  }

  /** Remove every bot. */
  clear(): void {
    for (const bot of this.bots.values()) {
      this.crowd.removeBot(bot.handle);
    }
    this.bots.clear();
    this.remotePlayers.clear();
  }

  /**
   * Advances the crowd by `dt` and updates every bot's render state.
   *
   * @param dt           Delta since last update (seconds). Clamped internally.
   * @param localPlayer  Current self state of the human player — used as the
   *                     target for `harass` behavior and as observed-player
   *                     input for every bot's brain.
   */
  update(dt: number, localPlayer: LocalPlayerInput | null): void {
    if (this.bots.size === 0) return;
    const clampedDt = Math.max(0.001, Math.min(0.1, dt));
    this.crowd.step(clampedDt);

    const observed: ObservedPlayer[] = localPlayer
      ? [
          {
            id: localPlayer.id,
            position: [...localPlayer.position],
            isDead: localPlayer.dead,
          },
        ]
      : [];

    const selfTemplate: BotSelfState = {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      onGround: true,
      dead: false,
    };

    for (const bot of this.bots.values()) {
      const agent = this.crowd.getAgent(bot.handle.id);
      if (!agent) continue;
      selfTemplate.position[0] = agent.position[0];
      selfTemplate.position[1] = agent.position[1];
      selfTemplate.position[2] = agent.position[2];
      selfTemplate.velocity[0] = agent.velocity[0];
      selfTemplate.velocity[1] = agent.velocity[1];
      selfTemplate.velocity[2] = agent.velocity[2];
      selfTemplate.yaw = bot.render.yaw;
      selfTemplate.pitch = bot.render.pitch;
      selfTemplate.onGround = true;
      selfTemplate.dead = false;
      bot.lastIntent = bot.brain.think(selfTemplate, observed);
      // Use the agent position (authoritative from crowd) as the bot's
      // rendered position, not self.position (which was the previous tick's
      // position).
      bot.render.position[0] = agent.position[0];
      bot.render.position[1] = agent.position[1];
      bot.render.position[2] = agent.position[2];
      bot.render.yaw = bot.lastIntent.yaw;
      bot.render.pitch = bot.lastIntent.pitch;
    }
  }

  private chooseSpawnPoint(spawnNear?: Vec3Tuple): Vec3Tuple {
    if (spawnNear) {
      const snap = this.crowd.findNearestWalkable(spawnNear);
      if (snap) {
        return [snap.position[0] + jitter(), snap.position[1], snap.position[2] + jitter()];
      }
    }
    const random = this.crowd.findRandomWalkable();
    if (random) return random;
    return [0, 2, 0];
  }
}

export interface LocalPlayerInput {
  id: number;
  position: Vec3Tuple;
  dead: boolean;
}

function jitter(): number {
  return (Math.random() - 0.5) * 2;
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
        acquireDistanceM: 60,
        recoveryDistanceM: 80,
        fireDistanceM: 0,
      });
  }
}

// Convenience factories for callers that want a single-shot behavior.
export { moveTo, harassNearest, wander, holdAnchor };
