/**
 * Runtime for load-test bots. Mirrors {@link ../practice/PracticeBotRuntime}
 * but is transport-agnostic: callers (typically `pages/LoadTest.tsx`) own
 * the WebTransport connection, network-impairment timers, and per-bot
 * snapshot decoding, and feed the runtime pre-decoded `BotSelfState` /
 * `ObservedPlayer` snapshots through `getInputs`. The runtime owns the
 * shared {@link BotCrowd}, the crowd tick, and each bot's {@link BotBrain}.
 *
 * Vehicles are intentionally not handled here yet — the practice vehicle
 * FSM lives in `PracticeBotRuntime` and is too coupled to the local
 * `PracticeBotHost` to lift verbatim. When load-test bots want vehicles,
 * the FSM should be extracted to a shared helper and reused. Setting
 * `personality.useVehicles = true` in this runtime currently has no effect.
 */
import { BotBrain } from '../agent/BotBrain';
import { makeBehaviorFromPersonality } from '../agent/behaviors';
import {
  resolvePersonality,
  type BotPersonality,
} from '../config/botPersonality';
import {
  BotCrowd,
  createBotCrowdFromSharedProfile,
  type BotHandle,
} from '../crowd/BotCrowd';
import { PRACTICE_BOT_SPRINT_SPEED } from '../practice/PracticeBotRuntime';
import type {
  BotIntent,
  BotSelfState,
  ObservedPlayer,
  Vec3Tuple,
} from '../types';
import { DEFAULT_WORLD_DOCUMENT, type WorldDocument } from '../../world/worldDocument';
import { resolveLoadTestWorld } from './worldLoader';

const DEFAULT_TICK_HZ = 30;
const DEFAULT_MAX_AGENT_RADIUS = 0.6;

/** Inputs the runtime pulls from the caller every tick. */
export interface LoadTestBotInputs {
  /** The bot's own decoded self state, or null if not yet ready (e.g. pre-welcome). */
  self: BotSelfState | null;
  /** Currently observed remote players (snapshot decoded by the caller). */
  remotePlayers: Iterable<ObservedPlayer>;
}

export interface AddLoadTestBotOptions {
  /** Stable id used by the caller to correlate bots; the runtime does not interpret it. */
  id: number;
  /** Initial spawn / anchor position (the brain will hold it when idle). */
  anchor: Vec3Tuple;
  /** Pulled every tick to feed the brain. */
  getInputs: () => LoadTestBotInputs;
  /** Invoked once per tick with the intent the brain emitted. */
  onIntent: (intent: BotIntent) => void;
}

export interface LoadTestBotHandle {
  readonly id: number;
  readonly brain: BotBrain;
  readonly crowdHandle: BotHandle;
}

export interface CreateLoadTestBotRuntimeOptions {
  /** Personality patch — merged on top of `DEFAULT_BOT_PERSONALITY`. */
  personality?: Partial<BotPersonality>;
  /** Crowd update / brain step rate (Hz). Defaults to 30. */
  tickHz?: number;
  /** Optional pre-resolved world. If omitted, the runtime calls {@link resolveLoadTestWorld}. */
  world?: WorldDocument;
  /** Match id for cache lookup in {@link resolveLoadTestWorld}. Ignored if `world` is supplied. */
  matchId?: string;
  /** Override `BotCrowd` agent radius (mostly for tests). */
  maxAgentRadius?: number;
}

interface InternalBot {
  id: number;
  brain: BotBrain;
  crowdHandle: BotHandle;
  anchor: Vec3Tuple;
  getInputs: () => LoadTestBotInputs;
  onIntent: (intent: BotIntent) => void;
}

const IDLE_SELF: BotSelfState = Object.freeze({
  position: [0, 0, 0],
  velocity: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  onGround: true,
  dead: false,
}) as BotSelfState;

const IDLE_INTENT: BotIntent = Object.freeze({
  buttons: 0,
  yaw: 0,
  pitch: 0,
  firePrimary: false,
  meleePrimary: false,
  mode: 'hold_anchor',
  targetPlayerId: null,
  vehicleAction: null,
  vehicleId: null,
}) as BotIntent;

export class LoadTestBotRuntime {
  readonly crowd: BotCrowd;
  readonly personality: BotPersonality;
  private readonly tickHz: number;
  private readonly bots = new Map<number, InternalBot>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = 0;
  private running = false;

  static async create(
    options: CreateLoadTestBotRuntimeOptions = {},
  ): Promise<LoadTestBotRuntime> {
    const world = options.world
      ?? (await resolveLoadTestWorld({ matchId: options.matchId }))
      ?? DEFAULT_WORLD_DOCUMENT;
    const crowd = await createBotCrowdFromSharedProfile(world, {
      maxAgentRadius: options.maxAgentRadius ?? DEFAULT_MAX_AGENT_RADIUS,
    });
    return new LoadTestBotRuntime(crowd, options);
  }

  private constructor(
    crowd: BotCrowd,
    options: CreateLoadTestBotRuntimeOptions,
  ) {
    this.crowd = crowd;
    this.personality = resolvePersonality(options.personality);
    this.tickHz = options.tickHz ?? DEFAULT_TICK_HZ;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTickMs = performance.now();
    this.tickHandle = setInterval(() => this.tick(), 1000 / this.tickHz);
  }

  stop(): void {
    this.running = false;
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  dispose(): void {
    this.stop();
    for (const bot of this.bots.values()) {
      this.crowd.removeBot(bot.crowdHandle);
    }
    this.bots.clear();
  }

  get count(): number {
    return this.bots.size;
  }

  addBot(options: AddLoadTestBotOptions): LoadTestBotHandle {
    if (this.bots.has(options.id)) {
      throw new Error(`LoadTestBotRuntime: bot id ${options.id} already registered`);
    }
    const crowdHandle = this.crowd.addBot(options.anchor);
    const agent = this.crowd.getAgent(crowdHandle.id);
    // The server moves the real player at ~6–8.5 m/s. Pinning the crowd
    // agent's maxSpeed to the server sprint cap keeps the navcat planner
    // from interpreting post-sync position updates as overshoots, which
    // would otherwise flip `desiredVelocity` backward and make the bot
    // wobble between two points.
    if (agent) agent.maxSpeed = PRACTICE_BOT_SPRINT_SPEED;
    const brain = new BotBrain(this.crowd, crowdHandle, makeBehaviorFromPersonality(this.personality), {
      anchor: options.anchor,
      jumpCooldownTicks: this.personality.jumpCooldownTicks,
      stuckTicksBeforeJump: this.personality.stuckTickThreshold,
      minMoveSpeed: this.personality.minMoveSpeedM,
      meleeDistanceM: this.personality.meleeDistanceM,
      aimJitterRad: this.personality.aimJitterRad,
      aimLeadSec: this.personality.aimLeadSec,
      firePrepTicks: this.personality.firePrepTicks,
      seed: options.id >>> 0,
    });
    const bot: InternalBot = {
      id: options.id,
      brain,
      crowdHandle,
      anchor: [options.anchor[0], options.anchor[1], options.anchor[2]],
      getInputs: options.getInputs,
      onIntent: options.onIntent,
    };
    this.bots.set(options.id, bot);
    return { id: options.id, brain, crowdHandle };
  }

  removeBot(id: number): boolean {
    const bot = this.bots.get(id);
    if (!bot) return false;
    this.crowd.removeBot(bot.crowdHandle);
    this.bots.delete(id);
    return true;
  }

  /**
   * Manually run one tick. Exposed for tests; the timer-driven path uses
   * {@link start} which calls this on its own schedule.
   */
  tickOnce(dtSec?: number): void {
    if (this.bots.size === 0) return;
    const nowMs = performance.now();
    const measuredDt = (nowMs - this.lastTickMs) / 1000;
    const dt = Math.min(0.25, Math.max(0.001, dtSec ?? measuredDt));
    this.lastTickMs = nowMs;
    this.runTick(dt);
  }

  private tick(): void {
    if (!this.running || this.bots.size === 0) return;
    const nowMs = performance.now();
    const dt = Math.min(0.25, Math.max(0.001, (nowMs - this.lastTickMs) / 1000));
    this.lastTickMs = nowMs;
    this.runTick(dt);
  }

  private runTick(dt: number): void {
    for (const bot of this.bots.values()) {
      const inputs = bot.getInputs();
      if (inputs.self) {
        this.crowd.syncBotPosition(bot.crowdHandle, inputs.self.position);
      }
    }
    this.crowd.step(dt);
    for (const bot of this.bots.values()) {
      const inputs = bot.getInputs();
      if (!inputs.self) {
        bot.onIntent(IDLE_INTENT);
        continue;
      }
      const remotePlayers = inputs.remotePlayers instanceof Array
        ? inputs.remotePlayers
        : Array.from(inputs.remotePlayers);
      const intent = bot.brain.think(inputs.self, remotePlayers);
      bot.onIntent(intent);
    }
  }
}

void IDLE_SELF;
