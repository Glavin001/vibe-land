import WebSocket from 'ws';
import { buildInputFromButtons } from '../src/scene/inputBuilder.js';
import {
  aimDirectionFromAngles,
  decodeServerPacket,
  encodeInputBundle,
  encodeFirePacket,
  encodePingPacket,
  netStateToMeters,
  WEAPON_HITSCAN,
  type PlayerStateMeters,
} from '../src/net/protocol.js';
import {
  createBotBrainState,
  disposeBotBrainState,
  stepBotBrain,
  type ObservedPlayer,
} from '../src/loadtest/brain.js';
import { PacketImpairment } from '../src/loadtest/networkModel.js';
import {
  SeededRandom,
  chooseWeightedProfile,
  type LoadTestScenario,
  type NetworkProfile,
} from '../src/loadtest/scenario.js';
import { createBotCrowd, type BotCrowd } from '../src/bots/index.js';
import { DEFAULT_WORLD_DOCUMENT } from '../src/world/worldDocument.js';
import type { WebSocketWorkerResult } from '../src/benchmark/contracts.js';

type BotMetrics = {
  inboundBytes: number;
  outboundBytes: number;
  snapshotsReceived: number;
  pingsReceived: number;
  shotsFired: number;
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
  shotId: number;
  tickHandle: ReturnType<typeof setInterval> | null;
  connectedAt: number;
  metrics: BotMetrics;
  localState: PlayerStateMeters | null;
  remotePlayers: Map<number, ObservedPlayer>;
  brainState: ReturnType<typeof createBotBrainState>;
  botCrowd: BotCrowd;
  inboundImpairment: PacketImpairment<Uint8Array>;
  outboundImpairment: PacketImpairment<Uint8Array>;
  currentTargetPlayerId: number | null;
};

function makeBotMetrics(): BotMetrics {
  return {
    inboundBytes: 0,
    outboundBytes: 0,
    snapshotsReceived: 0,
    pingsReceived: 0,
    shotsFired: 0,
    followTicks: 0,
    recoverTicks: 0,
    anchorTicks: 0,
    deadTicks: 0,
    targetSwitches: 0,
  };
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
    const packet = encodeFirePacket({
      seq: state.seq,
      shotId: state.shotId++ >>> 0,
      weapon: WEAPON_HITSCAN,
      clientFireTimeUs: Date.now() * 1000,
      clientInterpMs: 0,
      dir: aimDirectionFromAngles(intent.yaw, intent.pitch),
    });
    state.metrics.shotsFired += 1;
    state.metrics.outboundBytes += packet.length;
    state.ws.send(packet);
  }
}

function stopBot(state: BotState): void {
  if (state.tickHandle) {
    clearInterval(state.tickHandle);
    state.tickHandle = null;
  }
  disposeBotBrainState(state.brainState, state.botCrowd);
  state.inboundImpairment.dispose();
  state.outboundImpairment.dispose();
  state.ws?.close();
}

function spawnBot(
  id: number,
  serverHost: string,
  token: string,
  scenario: LoadTestScenario,
  profile: NetworkProfile,
  botCrowd: BotCrowd,
): Promise<BotState> {
  return new Promise((resolve, reject) => {
    const identity = `bench-ws-${id}`;
    const url = `ws://${serverHost}/ws/${scenario.matchId}?identity=${identity}&token=${token}`;

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
      shotId: 1,
      tickHandle: null,
      connectedAt: 0,
      metrics: makeBotMetrics(),
      localState: null,
      remotePlayers: new Map(),
      brainState: createBotBrainState(id - 1, scenario, { crowd: botCrowd }),
      botCrowd,
      inboundImpairment: new PacketImpairment(profile.downlink, scenario.seed + id * 17, (bytes) => {
        handlePacket(bytes);
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
        reject(new Error(`WS bot ${id}: connection timeout`));
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

    function handlePacket(bytes: Uint8Array): void {
      let packet;
      try {
        packet = decodeServerPacket(bytes);
      } catch {
        return;
      }

      switch (packet.type) {
        case 'welcome':
          state.playerId = packet.playerId;
          markConnected();
          break;
        case 'snapshot': {
          state.metrics.snapshotsReceived += 1;
          state.remotePlayers.clear();
          for (const playerState of packet.playerStates) {
            const meters = netStateToMeters(playerState);
            if (playerState.id === state.playerId) {
              state.localState = meters;
            } else {
              state.remotePlayers.set(playerState.id, { id: playerState.id, state: meters });
            }
          }
          if (!state.localState) {
            state.localState = null;
          }
          break;
        }
        case 'serverPing':
          state.metrics.pingsReceived += 1;
          state.outboundImpairment.enqueue(encodePingPacket(packet.value));
          break;
        default:
          break;
      }
    }
  });
}

function summarizeBots(bots: BotState[]) {
  return bots.reduce((acc, bot) => {
    acc.inboundBytes += bot.metrics.inboundBytes;
    acc.outboundBytes += bot.metrics.outboundBytes;
    acc.snapshotsReceived += bot.metrics.snapshotsReceived;
    acc.shotsFired += bot.metrics.shotsFired;
    acc.followTicks += bot.metrics.followTicks;
    acc.recoverTicks += bot.metrics.recoverTicks;
    acc.anchorTicks += bot.metrics.anchorTicks;
    acc.deadTicks += bot.metrics.deadTicks;
    acc.targetSwitches += bot.metrics.targetSwitches;
    acc.profiles[bot.profile.name] = (acc.profiles[bot.profile.name] ?? 0) + 1;
    return acc;
  }, {
    inboundBytes: 0,
    outboundBytes: 0,
    snapshotsReceived: 0,
    shotsFired: 0,
    followTicks: 0,
    recoverTicks: 0,
    anchorTicks: 0,
    deadTicks: 0,
    targetSwitches: 0,
    profiles: {} as Record<string, number>,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWebSocketWorker(options: {
  scenario: LoadTestScenario;
  serverHost: string;
  token: string;
  onStatus?: (line: string) => void;
}): Promise<WebSocketWorkerResult | null> {
  const { scenario, serverHost, token, onStatus } = options;
  const requestedBots = scenario.transportMix.websocket;
  if (requestedBots <= 0) {
    return null;
  }

  const startMs = Date.now();
  const startedAt = new Date().toISOString();
  const botCrowd = createBotCrowd(DEFAULT_WORLD_DOCUMENT, { maxAgentRadius: 0.6 });
  const crowdTickHz = 30;
  const crowdDt = 1 / crowdTickHz;
  const crowdInterval = setInterval(() => {
    botCrowd.step(crowdDt);
  }, 1000 / crowdTickHz);
  const rng = new SeededRandom(scenario.seed);
  const botPromises = Array.from({ length: requestedBots }, (_, index) => {
    const profile = chooseWeightedProfile(scenario, 'websocket', rng);
    const delayMs = scenario.rampUpS > 0
      ? Math.round((scenario.rampUpS * 1000 * index) / Math.max(1, requestedBots))
      : 0;
    return new Promise<BotState>((resolve, reject) => {
      setTimeout(() => {
        void spawnBot(index + 1, serverHost, token, scenario, profile, botCrowd).then(resolve, reject);
      }, delayMs);
    });
  });

  const settled = await Promise.allSettled(botPromises);
  const bots: BotState[] = [];
  const errors: string[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      bots.push(result.value);
    } else {
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }

  onStatus?.(`ws connected=${bots.length}/${requestedBots}`);

  if (scenario.durationS > 0) {
    const remainingMs = Math.max(0, scenario.durationS * 1000 - (Date.now() - startMs));
    await sleep(remainingMs);
  }

  for (const bot of bots) {
    stopBot(bot);
  }
  clearInterval(crowdInterval);

  const totals = summarizeBots(bots);
  return {
    kind: 'websocket',
    requestedBots,
    connectedBots: bots.filter((bot) => bot.connectedAt > 0).length,
    failedBots: errors.length,
    shotsFired: totals.shotsFired,
    snapshotsReceived: totals.snapshotsReceived,
    totalInboundBytes: totals.inboundBytes,
    totalOutboundBytes: totals.outboundBytes,
    startedAt,
    finishedAt: new Date().toISOString(),
    errors,
    followTicks: totals.followTicks,
    recoverTicks: totals.recoverTicks,
    anchorTicks: totals.anchorTicks,
    deadTicks: totals.deadTicks,
    targetSwitches: totals.targetSwitches,
    profiles: totals.profiles,
  };
}
