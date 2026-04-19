import { useEffect, useRef, useState } from 'react';
import { resolveRequestedMatchId } from '../app/matchId';
import { resolveMultiplayerBackend } from '../app/runtimeConfig';
import { buildInputFromButtons } from '../scene/inputBuilder';
import {
  LoadTestBotRuntime,
  type LoadTestBotHandle,
} from '../bots';
import type { BotIntent, ObservedPlayer, Vec3Tuple } from '../bots/types';
import { PacketImpairment } from '../loadtest/networkModel';
import { personalityFromScenario, playerStateToBotSelf } from '../loadtest/personalityFromScenario';
import type { BenchmarkPageState, WebTransportWorkerResult } from '../benchmark/contracts';
import {
  DEFAULT_SCENARIO,
  SeededRandom,
  anchorForBot,
  chooseWeightedProfile,
  normalizeScenario,
  parseScenarioJson,
  type LoadTestScenario,
  type NetworkProfile,
} from '../loadtest/scenario';
import { describeBottleneck, type GlobalStatsSnapshot } from '../loadtest/serverStats';
import { applyBotSnapshotState } from '../loadtest/botSnapshot';
import {
  aimDirectionFromAngles,
  type PlayerStateMeters,
  type ServerDatagramPacket,
  type ServerReliablePacket,
  WEAPON_HITSCAN,
} from '../net/protocol';
import { WebTransportGameClient } from '../net/webTransportClient';

type BrowserBot = {
  id: number;
  profile: NetworkProfile;
  client: WebTransportGameClient;
  connected: boolean;
  playerId: number;
  seq: number;
  /**
   * Handle returned by {@link LoadTestBotRuntime.addBot}. The runtime owns
   * the per-bot {@link BotBrain} and ticks it on a shared schedule.
   */
  brainHandle: LoadTestBotHandle | null;
  localState: PlayerStateMeters | null;
  remotePlayers: Map<number, ObservedPlayer>;
  currentTargetPlayerId: number | null;
  inboundImpairment: PacketImpairment<ServerReliablePacket | ServerDatagramPacket>;
  outboundImpairment: PacketImpairment<ReturnType<typeof buildInputFromButtons>>;
  snapshotsReceived: number;
  shotsFired: number;
  shotId: number;
  /** Counts down each tick; only fires when zero. */
  fireCooldownTicks: number;
};

type ScenarioPreset = {
  id: string;
  label: string;
  description: string;
  scenario: (matchId: string) => LoadTestScenario;
};

function buildLanProfile() {
  return {
    name: 'lan',
    weight: 1,
    transport: 'any' as const,
    uplink: { latencyMs: 6, jitterMs: 2, packetLossRate: 0 },
    downlink: { latencyMs: 6, jitterMs: 2, packetLossRate: 0 },
  };
}

function buildMixedProfiles() {
  return [
    buildLanProfile(),
    {
      name: 'wifi',
      weight: 0.55,
      transport: 'any' as const,
      uplink: { latencyMs: 28, jitterMs: 10, packetLossRate: 0.01 },
      downlink: { latencyMs: 28, jitterMs: 10, packetLossRate: 0.01 },
    },
    {
      name: 'cellular',
      weight: 0.3,
      transport: 'any' as const,
      uplink: { latencyMs: 85, jitterMs: 32, packetLossRate: 0.025 },
      downlink: { latencyMs: 85, jitterMs: 32, packetLossRate: 0.025 },
    },
  ];
}

function createScenario(matchId: string, overrides: Partial<LoadTestScenario>): LoadTestScenario {
  return normalizeScenario({
    ...DEFAULT_SCENARIO,
    matchId,
    behavior: {
      ...DEFAULT_SCENARIO.behavior,
      fireMode: 'nearest_target_or_center',
      fireCooldownTicks: 12,
    },
    durationS: 0,
    rampUpS: 5,
    botCount: 10,
    inputHz: 15,
    transportMix: { websocket: 0, webtransport: 10 },
    spawnPattern: 'clustered',
    networkProfiles: [buildLanProfile()],
    ...overrides,
  });
}

function createPageScenario(matchId: string): LoadTestScenario {
  return createScenario(matchId, {
    name: 'arena-shared-debug-10',
  });
}

function createScenarioPresets(matchId: string): ScenarioPreset[] {
  return [
    {
      id: 'debug-10',
      label: 'Debug 10',
      description: 'Current default: 10 WT bots, 15 Hz input, LAN.',
      scenario: () => createPageScenario(matchId),
    },
    {
      id: 'real-10',
      label: 'Realistic 10',
      description: '10 WT bots at 60 Hz to match real player input cadence.',
      scenario: () => createScenario(matchId, {
        name: 'arena-realistic-10',
        botCount: 10,
        inputHz: 60,
        transportMix: { websocket: 0, webtransport: 10 },
        networkProfiles: [buildLanProfile()],
      }),
    },
    {
      id: 'scale-20',
      label: 'Scale 20',
      description: '20 WT bots at 60 Hz for server and packet fanout scaling.',
      scenario: () => createScenario(matchId, {
        name: 'arena-scale-20',
        botCount: 20,
        rampUpS: 6,
        inputHz: 60,
        transportMix: { websocket: 0, webtransport: 20 },
        networkProfiles: [buildLanProfile()],
      }),
    },
    {
      id: 'stress-32',
      label: 'Stress 32',
      description: '32 WT bots at 60 Hz on LAN to push CPU and outbound snapshot volume.',
      scenario: () => createScenario(matchId, {
        name: 'arena-stress-32',
        botCount: 32,
        rampUpS: 8,
        inputHz: 60,
        transportMix: { websocket: 0, webtransport: 32 },
        networkProfiles: [buildLanProfile()],
        behavior: {
          ...DEFAULT_SCENARIO.behavior,
          fireMode: 'nearest_target_or_center',
          fireCooldownTicks: 8,
        },
      }),
    },
    {
      id: 'mixed-network-24',
      label: 'Mixed Net 24',
      description: '24 WT bots at 60 Hz with LAN, wifi, and cellular impairments.',
      scenario: () => createScenario(matchId, {
        name: 'arena-mixed-network-24',
        botCount: 24,
        rampUpS: 8,
        inputHz: 60,
        transportMix: { websocket: 0, webtransport: 24 },
        networkProfiles: buildMixedProfiles(),
        behavior: {
          ...DEFAULT_SCENARIO.behavior,
          fireMode: 'nearest_target_or_center',
          fireCooldownTicks: 10,
        },
      }),
    },
  ];
}

function scenarioTextFromScenario(scenario: LoadTestScenario): string {
  return JSON.stringify(normalizeScenario(scenario), null, 2);
}

declare global {
  interface Window {
    __VIBE_BENCHMARK_STATE__?: BenchmarkPageState;
    __VIBE_BENCHMARK_RESULT__?: WebTransportWorkerResult | null;
    __VIBE_GET_BENCHMARK_RESULT__?: (() => WebTransportWorkerResult | null) | null;
  }
}

function readBenchmarkLaunch() {
  const params = new URLSearchParams(window.location.search);
  const benchmark = params.get('benchmark') === '1';
  const autoStart = params.get('autostart') === '1';
  const scenarioParam = params.get('scenario');
  const requestedMatchId = resolveRequestedMatchId(window.location.search, 'arena');
  let scenarioText: string | null = null;
  if (scenarioParam) {
    try {
      scenarioText = JSON.stringify(parseScenarioJson(scenarioParam), null, 2);
    } catch {
      scenarioText = null;
    }
  }
  return {
    benchmark,
    autoStart,
    requestedMatchId,
    scenarioText,
    defaultScenarioText: scenarioTextFromScenario(createPageScenario(requestedMatchId)),
  };
}

export function LoadTestPage() {
  const multiplayerBackend = resolveMultiplayerBackend();
  const launchConfigRef = useRef(readBenchmarkLaunch());
  const autoStartTriggeredRef = useRef(false);
  const completionTimerRef = useRef<number | null>(null);
  const benchmarkErrorsRef = useRef<string[]>([]);
  const runStartedAtRef = useRef<string | null>(null);
  const peakConnectedBotsRef = useRef(0);
  const latestBottleneckRef = useRef('waiting for server stats');
  const [scenarioText, setScenarioText] = useState(() =>
    launchConfigRef.current.scenarioText ?? launchConfigRef.current.defaultScenarioText,
  );
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('Idle');
  const [error, setError] = useState<string | null>(null);
  const [connectedBots, setConnectedBots] = useState(0);
  const [snapshotsReceived, setSnapshotsReceived] = useState(0);
  const [bottleneck, setBottleneck] = useState('waiting for server stats');
  const botsRef = useRef<BrowserBot[]>([]);
  const runtimeRef = useRef<LoadTestBotRuntime | null>(null);
  const statsSocketRef = useRef<WebSocket | null>(null);
  const presets = createScenarioPresets(launchConfigRef.current.requestedMatchId);
  const activePresetId = detectActivePreset(scenarioText, presets);
  const activePreset = presets.find((preset) => preset.id === activePresetId) ?? null;

  useEffect(() => {
    latestBottleneckRef.current = bottleneck;
  }, [bottleneck]);

  useEffect(() => {
    if (!launchConfigRef.current.autoStart || autoStartTriggeredRef.current) {
      return;
    }
    autoStartTriggeredRef.current = true;
    window.setTimeout(() => {
      void start().catch((err: Error) => {
        const message = err.message;
        benchmarkErrorsRef.current.push(message);
        setError(message);
      });
    }, 0);
  }, []);

  useEffect(() => {
    publishBenchmarkState({
      mode: error ? 'failed' : running ? 'running' : window.__VIBE_BENCHMARK_RESULT__ ? 'completed' : 'idle',
      status,
      connectedBots,
      requestedBots: botsRef.current.length,
      snapshotsReceived,
      bottleneck,
      error,
      result: window.__VIBE_BENCHMARK_RESULT__ ?? null,
    });
  }, [bottleneck, connectedBots, error, running, snapshotsReceived, status]);

  useEffect(() => () => {
    if (completionTimerRef.current !== null) {
      window.clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    }
    stopBots(botsRef.current);
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
    statsSocketRef.current?.close();
  }, []);

  function buildBenchmarkResult(completedScenario?: LoadTestScenario): WebTransportWorkerResult {
    const scenario = completedScenario ?? tryParseScenario(scenarioText) ?? parseScenarioJson(launchConfigRef.current.defaultScenarioText);
    return {
      kind: 'webtransport',
      scenario,
      requestedBots: scenario.transportMix.webtransport,
      connectedBots: peakConnectedBotsRef.current,
      failedBots: Math.max(0, scenario.transportMix.webtransport - botsRef.current.length) + benchmarkErrorsRef.current.length,
      shotsFired: botsRef.current.reduce((sum, bot) => sum + bot.shotsFired, 0),
      snapshotsReceived: botsRef.current.reduce((sum, bot) => sum + bot.snapshotsReceived, 0),
      totalInboundBytes: 0,
      totalOutboundBytes: 0,
      startedAt: runStartedAtRef.current ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      errors: [...benchmarkErrorsRef.current],
      bottleneck: latestBottleneckRef.current,
    };
  }

  async function start(): Promise<void> {
    setError(null);
    window.__VIBE_BENCHMARK_RESULT__ = null;
    benchmarkErrorsRef.current = [];
    try {
      const scenario = parseScenarioJson(scenarioText);
      if (scenario.transportMix.webtransport <= 0) {
        throw new Error('Scenario must request at least one WebTransport bot for this page.');
      }
      if (!('WebTransport' in window)) {
        throw new Error('This browser does not support WebTransport.');
      }

      stopBots(botsRef.current);
      botsRef.current = [];
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
      runStartedAtRef.current = new Date().toISOString();
      peakConnectedBotsRef.current = 0;
      latestBottleneckRef.current = 'waiting for server stats';
      if (completionTimerRef.current !== null) {
        window.clearTimeout(completionTimerRef.current);
        completionTimerRef.current = null;
      }
      if (scenario.durationS > 0) {
        completionTimerRef.current = window.setTimeout(() => {
          void stop('completed', scenario);
        }, scenario.durationS * 1000);
      }
      setRunning(true);
      setStatus('Connecting WebTransport bots...');
      publishBenchmarkState({
        mode: 'running',
        status: 'Connecting WebTransport bots...',
        connectedBots: 0,
        requestedBots: scenario.transportMix.webtransport,
        snapshotsReceived: 0,
        bottleneck,
        error: null,
        result: null,
      });
      connectStatsSocket(scenario.matchId);

      const runtime = await LoadTestBotRuntime.create({
        personality: personalityFromScenario(scenario),
        tickHz: scenario.inputHz,
        matchId: scenario.matchId,
      });
      runtime.start();
      runtimeRef.current = runtime;

      const rng = new SeededRandom(scenario.seed);
      const results = await Promise.allSettled(
        Array.from({ length: scenario.transportMix.webtransport }, async (_, index) => {
          const profile = chooseWeightedProfile(scenario, 'webtransport', rng);
          const delayMs = scenario.rampUpS > 0
            ? Math.round((scenario.rampUpS * 1000 * index) / Math.max(1, scenario.transportMix.webtransport))
            : 0;
          await new Promise((resolve) => window.setTimeout(resolve, delayMs));
          return spawnWebTransportBot(index + 1, scenario, profile);
        }),
      );
      const bots: BrowserBot[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          bots.push(result.value);
        } else {
          benchmarkErrorsRef.current.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
        }
      }
      botsRef.current = bots;
      setStatus(`Running ${bots.length} WebTransport bots`);
      publishBenchmarkState({
        mode: 'running',
        status: `Running ${bots.length} WebTransport bots`,
        connectedBots: bots.filter((bot) => bot.connected).length,
        requestedBots: scenario.transportMix.webtransport,
        snapshotsReceived: bots.reduce((sum, bot) => sum + bot.snapshotsReceived, 0),
        bottleneck,
        error: null,
        result: null,
      });
      updateCounters();
      if (bots.length === 0) {
        throw new Error('No WebTransport bots connected.');
      }
    } catch (err) {
      setRunning(false);
      const message = err instanceof Error ? err.message : String(err);
      benchmarkErrorsRef.current.push(message);
      publishBenchmarkState({
        mode: 'failed',
        status: 'Failed',
        connectedBots,
        requestedBots: botsRef.current.length,
        snapshotsReceived,
        bottleneck,
        error: message,
        result: null,
      });
      throw err instanceof Error ? err : new Error(message);
    }
  }

  function connectStatsSocket(matchId: string): void {
    statsSocketRef.current?.close();
    const socket = new WebSocket(multiplayerBackend.statsWebSocketUrl);
    statsSocketRef.current = socket;
    socket.onmessage = (event) => {
      try {
        const snapshot = JSON.parse(event.data as string) as GlobalStatsSnapshot;
        const match = snapshot.matches.find((candidate) => candidate.id === matchId);
        if (match) {
          setBottleneck(describeBottleneck(match, snapshot.sim_hz));
        }
      } catch {
        // ignore parse errors
      }
    };
  }

  function updateCounters(): void {
    const bots = botsRef.current;
    const connected = bots.filter((bot) => bot.connected).length;
    peakConnectedBotsRef.current = Math.max(peakConnectedBotsRef.current, connected);
    setConnectedBots(connected);
    setSnapshotsReceived(bots.reduce((sum, bot) => sum + bot.snapshotsReceived, 0));
  }

  async function stop(reason: 'completed' | 'manual' = 'manual', completedScenario?: LoadTestScenario): Promise<void> {
    if (completionTimerRef.current !== null) {
      window.clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    }
    const result = buildBenchmarkResult(completedScenario);
    stopBots(botsRef.current);
    botsRef.current = [];
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
    statsSocketRef.current?.close();
    statsSocketRef.current = null;
    setRunning(false);
    setStatus(reason === 'completed' ? 'Completed' : 'Stopped');
    updateCounters();
    window.__VIBE_BENCHMARK_RESULT__ = result;
    runStartedAtRef.current = null;
    publishBenchmarkState({
      mode: reason === 'completed' ? 'completed' : 'idle',
      status: reason === 'completed' ? 'Completed' : 'Stopped',
      connectedBots: result.connectedBots,
      requestedBots: result.requestedBots,
      snapshotsReceived: result.snapshotsReceived,
      bottleneck,
      error,
      result,
    });
  }

  useEffect(() => {
    window.__VIBE_GET_BENCHMARK_RESULT__ = () => buildBenchmarkResult();
    return () => {
      window.__VIBE_GET_BENCHMARK_RESULT__ = null;
    };
  }, [scenarioText]);

  return (
    <div className="min-h-screen bg-[#0a0e18] text-[#eaf1ff] font-mono p-6 box-border">

      {/* Header */}
      <div className="flex justify-between gap-6 mb-4 flex-wrap">
        <div>
          <h1 className="m-0 text-2xl font-bold text-white/90">vibe-land / loadtest</h1>
          <div className="mt-2 text-[#9ab0d1] max-w-[720px] text-sm leading-relaxed">
            Browser-based load tester — simulates concurrent players with configurable scenarios and network profiles.
          </div>
        </div>
        <div className="text-right text-[#b8ffda] text-sm leading-relaxed">
          <div className="font-bold">{running ? 'RUNNING' : 'IDLE'}</div>
          <div>{`Connected: ${connectedBots}`}</div>
          <div>{`Snapshots: ${snapshotsReceived}`}</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex gap-3 mb-3 flex-wrap">
        <button
          className="bg-[#162236] text-white border border-[#38537c] rounded-md px-3.5 py-2 cursor-pointer text-sm hover:bg-[#1c2e47] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          disabled={running}
          onClick={() => void start().catch((err: Error) => setError(err.message))}
        >
          Start
        </button>
        <button
          className="bg-[#162236] text-white border border-[#38537c] rounded-md px-3.5 py-2 cursor-pointer text-sm hover:bg-[#1c2e47] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          disabled={!running}
          onClick={() => void stop('manual')}
        >
          Stop
        </button>
        <button
          className="bg-[#162236] text-white border border-[#38537c] rounded-md px-3.5 py-2 cursor-pointer text-sm hover:bg-[#1c2e47] transition-colors"
          onClick={() => setScenarioText(launchConfigRef.current.defaultScenarioText)}
        >
          Reset Scenario
        </button>
      </div>

      {/* Preset panel */}
      <div className="mb-3.5 p-3 bg-[#0d1524] border border-[#263a59] rounded-lg">
        <div className="flex justify-between gap-3 mb-2.5 items-baseline flex-wrap">
          <div className="text-[#b8ffda] font-bold text-sm">Presets</div>
          <div className="text-[#9ab0d1] text-xs">
            {activePreset ? `Active: ${activePreset.label}` : 'Active: Custom'}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mb-2">
          {presets.map((preset) => {
            const isActive = preset.id === activePresetId;
            return (
              <button
                key={preset.id}
                className={[
                  'rounded-full px-3 py-1.5 cursor-pointer text-xs border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                  isActive
                    ? 'bg-[#21406a] text-white border-[#79b6ff] font-bold'
                    : 'bg-[#162236] text-[#cfe4ff] border-[#38537c] font-medium hover:bg-[#1c2e47]',
                ].join(' ')}
                disabled={running}
                onClick={() => setScenarioText(scenarioTextFromScenario(preset.scenario(launchConfigRef.current.requestedMatchId)))}
                title={preset.description}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <div className="text-[#9ab0d1] text-xs">
          {activePreset?.description ?? 'Custom scenario JSON. Edit freely or re-apply a preset.'}
        </div>
      </div>

      {/* Status lines */}
      <div className="mb-2 text-[#d8e3f8] text-sm">{status}</div>
      <div className="mb-2 text-[#d8e3f8] text-sm">{`Bottleneck: ${bottleneck}`}</div>
      {error && <div className="mb-3 text-[#ff8f8f] text-sm">{error}</div>}

      {/* Scenario editor */}
      <textarea
        className="w-full min-h-[70vh] bg-[#0f1625] text-[#dff6ff] border border-[#263a59] rounded-lg p-4 box-border font-mono text-sm leading-relaxed resize-y focus:outline-none focus:border-[#3a5a8a]"
        value={scenarioText}
        onChange={(event) => setScenarioText(event.target.value)}
        spellCheck={false}
      />

    </div>
  );

  async function spawnWebTransportBot(
    id: number,
    scenario: LoadTestScenario,
    profile: NetworkProfile,
  ): Promise<BrowserBot> {
    const bot = {} as BrowserBot;
    const inboundImpairment = new PacketImpairment<ServerReliablePacket | ServerDatagramPacket>(
      profile.downlink,
      scenario.seed + id * 41,
      (packet) => handlePacket(bot, scenario, packet),
    );

    const client = await WebTransportGameClient.connect({
      matchId: scenario.matchId,
      sessionConfigEndpoint: multiplayerBackend.sessionConfigEndpoint,
      onReliablePacket: (packet) => inboundImpairment.enqueue(packet),
      onDatagramPacket: (packet) => inboundImpairment.enqueue(packet),
      onClose: () => {
        bot.connected = false;
        if (bot.brainHandle && runtimeRef.current) {
          runtimeRef.current.removeBot(bot.brainHandle.id);
          bot.brainHandle = null;
        }
        updateCounters();
      },
    });

    Object.assign(bot, {
      id,
      profile,
      client,
      connected: false,
      playerId: 0,
      seq: 0,
      shotId: 1,
      brainHandle: null,
      localState: null,
      remotePlayers: new Map<number, ObservedPlayer>(),
      currentTargetPlayerId: null,
      inboundImpairment,
      outboundImpairment: new PacketImpairment(
        profile.uplink,
        scenario.seed + id * 59,
        (frame: ReturnType<typeof buildInputFromButtons>) => {
          client.sendInputBundle([frame]);
        },
      ),
      snapshotsReceived: 0,
      shotsFired: 0,
      fireCooldownTicks: 0,
    } satisfies Partial<BrowserBot>);

    const runtime = runtimeRef.current;
    if (runtime) {
      const anchor2d = anchorForBot(id - 1, scenario);
      const anchor: Vec3Tuple = [anchor2d[0], 1.0, anchor2d[1]];
      bot.brainHandle = runtime.addBot({
        id,
        anchor,
        getInputs: () => ({
          self: playerStateToBotSelf(bot.localState),
          remotePlayers: bot.remotePlayers.values(),
        }),
        onIntent: (intent: BotIntent) => {
          if (!bot.connected || !bot.localState) {
            bot.fireCooldownTicks = Math.max(0, bot.fireCooldownTicks - 1);
            return;
          }
          bot.seq = (bot.seq + 1) & 0xffff;
          bot.currentTargetPlayerId = intent.targetPlayerId;
          bot.outboundImpairment.enqueue(
            buildInputFromButtons(bot.seq, 0, intent.buttons, intent.yaw, intent.pitch),
          );
          if (intent.firePrimary && bot.fireCooldownTicks <= 0) {
            bot.fireCooldownTicks = scenario.behavior.fireCooldownTicks;
            bot.shotsFired += 1;
            client.sendFire({
              seq: bot.seq,
              shotId: bot.shotId++ >>> 0,
              weapon: WEAPON_HITSCAN,
              clientFireTimeUs: Date.now() * 1000,
              clientInterpMs: client.sessionConfig.interpolation_delay_ms,
              clientDynamicInterpMs: Math.min(client.sessionConfig.interpolation_delay_ms, 16),
              dir: aimDirectionFromAngles(intent.yaw, intent.pitch),
            });
          }
          bot.fireCooldownTicks = Math.max(0, bot.fireCooldownTicks - 1);
        },
      });
    }

    return bot;
  }

  function handlePacket(
    bot: BrowserBot,
    _scenario: LoadTestScenario,
    packet: ServerReliablePacket | ServerDatagramPacket,
  ): void {
    if (packet.type === 'welcome') {
      bot.playerId = packet.playerId;
      bot.connected = true;
      updateCounters();
      return;
    }

    if (applyBotSnapshotState(bot, packet)) {
      bot.snapshotsReceived += 1;
      updateCounters();
    }
  }
}

function stopBots(bots: BrowserBot[]): void {
  for (const bot of bots) {
    bot.brainHandle = null;
    bot.inboundImpairment.dispose();
    bot.outboundImpairment.dispose();
    bot.client.close();
    bot.connected = false;
  }
}

function tryParseScenario(json: string): LoadTestScenario | null {
  try {
    return parseScenarioJson(json);
  } catch {
    return null;
  }
}

function detectActivePreset(
  scenarioText: string,
  presets: ScenarioPreset[],
): string | null {
  const parsed = tryParseScenario(scenarioText);
  if (!parsed) {
    return null;
  }
  const normalizedText = JSON.stringify(normalizeScenario(parsed));
  for (const preset of presets) {
    if (JSON.stringify(normalizeScenario(preset.scenario(parsed.matchId))) === normalizedText) {
      return preset.id;
    }
  }
  return null;
}

function publishBenchmarkState(state: BenchmarkPageState): void {
  window.__VIBE_BENCHMARK_STATE__ = state;
}
