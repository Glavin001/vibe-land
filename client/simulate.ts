/**
 * Scenario-driven WebSocket load test runner.
 *
 * Backward-compatible usage:
 *   npm run simulate
 *   npm run simulate -- 50
 *   npm run simulate -- 50 60
 *
 * Structured usage:
 *   npm run simulate -- --scenario ./scenario.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { buildInputFromButtons } from './src/scene/inputBuilder.js';
import {
  aimDirectionFromAngles,
  decodeServerPacket,
  encodeFirePacket,
  encodeInputBundle,
  encodePingPacket,
  netStateToMeters,
  type PlayerStateMeters,
  WEAPON_HITSCAN,
} from './src/net/protocol.js';
import { stepBotBrain, createBotBrainState, type ObservedPlayer } from './src/loadtest/brain.js';
import { PacketImpairment } from './src/loadtest/networkModel.js';
import {
  DEFAULT_SCENARIO,
  SeededRandom,
  chooseWeightedProfile,
  createScenarioFromLegacyArgs,
  normalizeScenario,
  parseScenarioJson,
  type LoadTestScenario,
  type NetworkProfile,
} from './src/loadtest/scenario.js';
import {
  describeBottleneck,
  type GlobalStatsSnapshot,
  type MatchStatsSnapshot,
} from './src/loadtest/serverStats.js';

const _serverHost = process.env.SERVER_HOST ?? 'localhost';
const _serverPort = process.env.SERVER_PORT ?? '4001';
const SERVER_HOST = `${_serverHost}:${_serverPort}`;
const TOKEN = process.env.TOKEN ?? 'mvp-token';

type BotMetrics = {
  inboundBytes: number;
  outboundBytes: number;
  snapshotsReceived: number;
  pingsReceived: number;
  followTicks: number;
  recoverTicks: number;
  anchorTicks: number;
  deadTicks: number;
  targetSwitches: number;
};

type BotState = {
  id: number;
  identity: string;
  profile: NetworkProfile;
  ws: WebSocket | null;
  connected: boolean;
  playerId: number;
  seq: number;
  tickHandle: ReturnType<typeof setInterval> | null;
  connectStartedAt: number;
  connectedAt: number;
  latestServerTick: number;
  metrics: BotMetrics;
  localState: PlayerStateMeters | null;
  remotePlayers: Map<number, ObservedPlayer>;
  brainState: ReturnType<typeof createBotBrainState>;
  inboundImpairment: PacketImpairment<Uint8Array>;
  outboundImpairment: PacketImpairment<Uint8Array>;
  currentTargetPlayerId: number | null;
};

class StatsMonitor {
  latest: GlobalStatsSnapshot | null = null;
  private socket: WebSocket | null = null;

  constructor(private readonly url: string) {}

  connect(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on('message', (data) => {
      const text = typeof data === 'string'
        ? data
        : data instanceof Buffer
          ? data.toString('utf8')
          : '';
      if (!text) {
        return;
      }
      try {
        this.latest = JSON.parse(text) as GlobalStatsSnapshot;
      } catch {
        // ignore malformed stats snapshots
      }
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  match(matchId: string): MatchStatsSnapshot | null {
    return this.latest?.matches.find((match) => match.id === matchId) ?? null;
  }
}

async function parseScenarioFromArgs(): Promise<LoadTestScenario> {
  const args = process.argv.slice(2);
  const scenarioFlagIndex = args.findIndex((arg) => arg === '--scenario');
  const matchIdFlagIndex = args.findIndex((arg) => arg === '--match-id');
  const matchIdOverride = args[matchIdFlagIndex + 1]?.trim() || process.env.LOADTEST_MATCH_ID?.trim() || null;
  if (scenarioFlagIndex >= 0) {
    const value = args[scenarioFlagIndex + 1];
    if (!value) {
      throw new Error('missing value after --scenario');
    }
    if (value.trim().startsWith('{')) {
      const scenario = parseScenarioJson(value);
      return matchIdOverride ? normalizeScenario({ ...scenario, matchId: matchIdOverride }) : scenario;
    }
    const fullPath = path.resolve(process.cwd(), value);
    const scenario = parseScenarioJson(await readFile(fullPath, 'utf8'));
    return matchIdOverride ? normalizeScenario({ ...scenario, matchId: matchIdOverride }) : scenario;
  }

  if (process.env.LOADTEST_SCENARIO_JSON) {
    const scenario = parseScenarioJson(process.env.LOADTEST_SCENARIO_JSON);
    return matchIdOverride ? normalizeScenario({ ...scenario, matchId: matchIdOverride }) : scenario;
  }

  const positionalArgs = args.filter((arg, index) =>
    !(arg === '--match-id' || index === matchIdFlagIndex + 1),
  );
  const botCount = Number.parseInt(positionalArgs[0] ?? `${DEFAULT_SCENARIO.botCount}`, 10);
  const durationS = Number.parseInt(positionalArgs[1] ?? `${DEFAULT_SCENARIO.durationS}`, 10);
  const scenario = createScenarioFromLegacyArgs(botCount, durationS);
  return matchIdOverride ? normalizeScenario({ ...scenario, matchId: matchIdOverride }) : scenario;
}

function makeBotMetrics(): BotMetrics {
  return {
    inboundBytes: 0,
    outboundBytes: 0,
    snapshotsReceived: 0,
    pingsReceived: 0,
    followTicks: 0,
    recoverTicks: 0,
    anchorTicks: 0,
    deadTicks: 0,
    targetSwitches: 0,
  };
}

function spawnBot(
  id: number,
  scenario: LoadTestScenario,
  profile: NetworkProfile,
  statsMonitor: StatsMonitor,
): Promise<BotState> {
  return new Promise((resolve, reject) => {
    const identity = `bot-${id}`;
    const url = `ws://${SERVER_HOST}/ws/${scenario.matchId}?identity=${identity}&token=${TOKEN}`;

    let settled = false;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    const state: BotState = {
      id,
      identity,
      profile,
      ws,
      connected: false,
      playerId: 0,
      seq: 0,
      tickHandle: null,
      connectStartedAt: Date.now(),
      connectedAt: 0,
      latestServerTick: 0,
      metrics: makeBotMetrics(),
      localState: null,
      remotePlayers: new Map(),
      brainState: createBotBrainState(id - 1, scenario),
      inboundImpairment: new PacketImpairment(profile.downlink, scenario.seed + id * 17, (bytes) => {
        handlePacket(state, scenario, statsMonitor, bytes);
      }),
      outboundImpairment: new PacketImpairment(profile.uplink, scenario.seed + id * 31, (packet) => {
        if (state.ws?.readyState === WebSocket.OPEN) {
          state.metrics.outboundBytes += packet.length;
          state.ws.send(packet);
        }
      }),
      currentTargetPlayerId: null,
    };

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Bot ${id}: connection timeout`));
      }
    }, 10_000);

    ws.on('message', (data: ArrayBuffer | Buffer) => {
      const bytes = data instanceof Buffer
        ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
        : new Uint8Array(data);
      state.metrics.inboundBytes += bytes.length;
      state.inboundImpairment.enqueue(bytes);
    });

    ws.on('error', (error: Error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    ws.on('close', () => {
      state.connected = false;
      if (state.tickHandle) {
        clearInterval(state.tickHandle);
        state.tickHandle = null;
      }
      state.inboundImpairment.dispose();
      state.outboundImpairment.dispose();
    });

    ws.on('open', () => {
      // welcome packet will start the bot loop
    });

    function markConnected(): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      state.connected = true;
      state.connectedAt = Date.now();
      state.tickHandle = setInterval(() => tickBot(state, scenario), 1000 / scenario.inputHz);
      resolve(state);
    }

    function handlePacket(
      bot: BotState,
      activeScenario: LoadTestScenario,
      _monitor: StatsMonitor,
      bytes: Uint8Array,
    ): void {
      let packet;
      try {
        packet = decodeServerPacket(bytes);
      } catch {
        return;
      }

      switch (packet.type) {
        case 'welcome':
          bot.playerId = packet.playerId;
          markConnected();
          break;
        case 'snapshot': {
          bot.metrics.snapshotsReceived += 1;
          bot.latestServerTick = packet.serverTick;
          bot.remotePlayers.clear();
          for (const playerState of packet.playerStates) {
            const meters = netStateToMeters(playerState);
            if (playerState.id === bot.playerId) {
              bot.localState = meters;
            } else {
              bot.remotePlayers.set(playerState.id, { id: playerState.id, state: meters });
            }
          }
          if (!bot.localState) {
            bot.localState = null;
          }
          break;
        }
        case 'serverPing':
          bot.metrics.pingsReceived += 1;
          bot.outboundImpairment.enqueue(encodePingPacket(packet.value));
          break;
        default:
          break;
      }
    }
  });
}

function tickBot(state: BotState, scenario: LoadTestScenario): void {
  if (!state.connected || !state.localState) {
    return;
  }

  state.seq = (state.seq + 1) & 0xffff;
  const remotePlayers = Array.from(state.remotePlayers.values());
  const intent = stepBotBrain(state.brainState, scenario, state.localState, remotePlayers);

  if (intent.targetPlayerId !== state.currentTargetPlayerId) {
    state.metrics.targetSwitches += 1;
    state.currentTargetPlayerId = intent.targetPlayerId;
  }

  switch (intent.mode) {
    case 'follow_target':
      state.metrics.followTicks += 1;
      break;
    case 'recover_center':
      state.metrics.recoverTicks += 1;
      break;
    case 'hold_anchor':
    case 'acquire_target':
      state.metrics.anchorTicks += 1;
      break;
    case 'dead':
      state.metrics.deadTicks += 1;
      break;
  }

  const frame = buildInputFromButtons(state.seq, 0, intent.buttons, intent.yaw, intent.pitch);
  state.outboundImpairment.enqueue(encodeInputBundle([frame]));
  if (intent.firePrimary && state.ws?.readyState === WebSocket.OPEN) {
    const firePacket = encodeFirePacket({
      seq: state.seq,
      shotId: ((state.id << 20) | state.seq) >>> 0,
      weapon: WEAPON_HITSCAN,
      clientFireTimeUs: Date.now() * 1000,
      clientInterpMs: 100,
      clientDynamicInterpMs: 16,
      dir: aimDirectionFromAngles(intent.yaw, intent.pitch),
    });
    state.metrics.outboundBytes += firePacket.length;
    state.ws.send(firePacket);
  }
}

function stopBot(state: BotState): void {
  if (state.tickHandle) {
    clearInterval(state.tickHandle);
    state.tickHandle = null;
  }
  state.inboundImpairment.dispose();
  state.outboundImpairment.dispose();
  state.ws?.close();
}

function summarizeBots(bots: BotState[]) {
  const total = bots.reduce((acc, bot) => {
    acc.inboundBytes += bot.metrics.inboundBytes;
    acc.outboundBytes += bot.metrics.outboundBytes;
    acc.snapshotsReceived += bot.metrics.snapshotsReceived;
    acc.followTicks += bot.metrics.followTicks;
    acc.recoverTicks += bot.metrics.recoverTicks;
    acc.anchorTicks += bot.metrics.anchorTicks;
    acc.deadTicks += bot.metrics.deadTicks;
    acc.targetSwitches += bot.metrics.targetSwitches;
    return acc;
  }, {
    inboundBytes: 0,
    outboundBytes: 0,
    snapshotsReceived: 0,
    followTicks: 0,
    recoverTicks: 0,
    anchorTicks: 0,
    deadTicks: 0,
    targetSwitches: 0,
  });

  const profiles = Object.fromEntries(
    Array.from(
      bots.reduce((map, bot) => {
        map.set(bot.profile.name, (map.get(bot.profile.name) ?? 0) + 1);
        return map;
      }, new Map<string, number>()),
    ),
  );

  return { ...total, profiles };
}

async function writeSummary(
  scenario: LoadTestScenario,
  bots: BotState[],
  statsMonitor: StatsMonitor,
): Promise<string> {
  const now = new Date();
  const resultsDir = path.resolve(process.cwd(), 'loadtest-results');
  await mkdir(resultsDir, { recursive: true });
  const outputPath = path.join(
    resultsDir,
    `${now.toISOString().replace(/[:.]/g, '-')}-${scenario.name}.json`,
  );
  const botSummary = summarizeBots(bots);
  const matchStats = statsMonitor.match(scenario.matchId);
  const payload = {
    generatedAt: now.toISOString(),
    server: SERVER_HOST,
    scenario,
    localSummary: {
      connectedBots: bots.filter((bot) => bot.connectedAt > 0).length,
      botSummary,
    },
    serverSummary: matchStats,
    bottleneck: matchStats ? describeBottleneck(matchStats) : 'no live server stats captured',
  };
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return outputPath;
}

async function main(): Promise<void> {
  const scenario = normalizeScenario(await parseScenarioFromArgs());
  const wsBotCount = scenario.transportMix.websocket;
  const durationLabel = scenario.durationS > 0 ? `${scenario.durationS}s` : 'until Ctrl-C';
  console.log(`\n=== vibe-land load test: ${scenario.name} ===\n`);
  console.log(`Server: ws://${SERVER_HOST}/ws/${scenario.matchId}`);
  console.log(`Scenario: ${scenario.botCount} bots total, ${wsBotCount} websocket bots here, ${scenario.transportMix.webtransport} webtransport bots expected elsewhere`);
  console.log(`Duration: ${durationLabel}  Ramp-up: ${scenario.rampUpS}s  Spawn pattern: ${scenario.spawnPattern}\n`);

  const statsMonitor = new StatsMonitor(`ws://${SERVER_HOST}/ws/stats`);
  statsMonitor.connect();

  const rng = new SeededRandom(scenario.seed);
  const botPromises = Array.from({ length: wsBotCount }, (_, index) => {
    const profile = chooseWeightedProfile(scenario, 'websocket', rng);
    const delayMs = scenario.rampUpS > 0 ? Math.round((scenario.rampUpS * 1000 * index) / Math.max(1, wsBotCount)) : 0;
    return new Promise<BotState>((resolve, reject) => {
      setTimeout(() => {
        void spawnBot(index + 1, scenario, profile, statsMonitor).then(resolve, reject);
      }, delayMs);
    });
  });

  const results = await Promise.allSettled(botPromises);
  const bots: BotState[] = [];
  let failures = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      bots.push(result.value);
    } else {
      failures += 1;
      console.error('  Failed:', result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }

  console.log(`\n${bots.length}/${wsBotCount} websocket bots connected.\n`);
  if (bots.length === 0) {
    statsMonitor.close();
    throw new Error('No websocket bots connected. Is the server running?');
  }

  let lastSnapshotTotal = 0;
  let lastInboundBytes = 0;
  let lastOutboundBytes = 0;
  let lastStatusAt = Date.now();

  const statusInterval = setInterval(() => {
    const now = Date.now();
    const elapsedS = (now - lastStatusAt) / 1000;
    lastStatusAt = now;

    const connected = bots.filter((bot) => bot.connected).length;
    const totalSnapshots = bots.reduce((sum, bot) => sum + bot.metrics.snapshotsReceived, 0);
    const totalInbound = bots.reduce((sum, bot) => sum + bot.metrics.inboundBytes, 0);
    const totalOutbound = bots.reduce((sum, bot) => sum + bot.metrics.outboundBytes, 0);

    const snapshotsPerSec = ((totalSnapshots - lastSnapshotTotal) / elapsedS).toFixed(1);
    const inboundKbps = (((totalInbound - lastInboundBytes) * 8) / 1024 / elapsedS).toFixed(1);
    const outboundKbps = (((totalOutbound - lastOutboundBytes) * 8) / 1024 / elapsedS).toFixed(1);
    lastSnapshotTotal = totalSnapshots;
    lastInboundBytes = totalInbound;
    lastOutboundBytes = totalOutbound;

    const matchStats = statsMonitor.match(scenario.matchId);
    const bottleneck = matchStats ? describeBottleneck(matchStats) : 'waiting for /ws/stats';
    console.log(
      `  [Status] connected=${connected}/${bots.length} snapshots/s=${snapshotsPerSec} in=${inboundKbps} kbps out=${outboundKbps} kbps  bottleneck=${bottleneck}`,
    );
  }, 2000);

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    clearInterval(statusInterval);
    console.log('\nStopping all websocket bots...');
    for (const bot of bots) {
      stopBot(bot);
    }
    statsMonitor.close();

    const outputPath = await writeSummary(scenario, bots, statsMonitor);
    const botSummary = summarizeBots(bots);
    console.log(
      `\nSimulation complete.\n`
      + `  Bots connected:      ${bots.length}/${wsBotCount}\n`
      + `  Total snapshots:     ${botSummary.snapshotsReceived}\n`
      + `  Total inbound bytes: ${botSummary.inboundBytes}\n`
      + `  Total outbound bytes:${botSummary.outboundBytes}\n`
      + `  Follow ticks:        ${botSummary.followTicks}\n`
      + `  Recover ticks:       ${botSummary.recoverTicks}\n`
      + `  Summary file:        ${outputPath}\n`,
    );
    process.exit(failures > 0 ? 1 : 0);
  };

  process.on('SIGINT', () => { void cleanup(); });
  process.on('SIGTERM', () => { void cleanup(); });

  if (scenario.durationS > 0) {
    setTimeout(() => { void cleanup(); }, scenario.durationS * 1000);
  }
}

main().catch((error: Error) => {
  console.error('Simulation failed:', error);
  process.exit(1);
});
