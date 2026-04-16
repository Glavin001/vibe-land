import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { resolveRequestedMatchId } from '../app/matchId';
import { resolveMultiplayerBackend } from '../app/runtimeConfig';
import { buildInputFromButtons } from '../scene/inputBuilder';
import { stepBotBrain, createBotBrainState, type ObservedPlayer } from '../loadtest/brain';
import { PacketImpairment } from '../loadtest/networkModel';
import type { BenchmarkPageState, WebTransportWorkerResult } from '../benchmark/contracts';
import {
  DEFAULT_SCENARIO,
  SeededRandom,
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
  tickHandle: number | null;
  localState: PlayerStateMeters | null;
  remotePlayers: Map<number, ObservedPlayer>;
  brainState: ReturnType<typeof createBotBrainState>;
  currentTargetPlayerId: number | null;
  inboundImpairment: PacketImpairment<ServerReliablePacket | ServerDatagramPacket>;
  outboundImpairment: PacketImpairment<ReturnType<typeof buildInputFromButtons>>;
  snapshotsReceived: number;
  shotsFired: number;
  shotId: number;
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
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>vibe-land / loadtest</h1>
          <div style={styles.subtitle}>Browser WebTransport runner with the same scenario + bot brain model as the Node websocket runner.</div>
        </div>
        <div style={styles.summary}>
          <div>{running ? 'RUNNING' : 'IDLE'}</div>
          <div>{`Connected: ${connectedBots}`}</div>
          <div>{`Snapshots: ${snapshotsReceived}`}</div>
        </div>
      </div>

      <div style={styles.toolbar}>
        <button style={styles.button} disabled={running} onClick={() => void start().catch((err: Error) => setError(err.message))}>
          Start
        </button>
        <button style={styles.button} disabled={!running} onClick={() => void stop('manual')}>
          Stop
        </button>
        <button style={styles.button} onClick={() => setScenarioText(launchConfigRef.current.defaultScenarioText)}>
          Reset Scenario
        </button>
      </div>

      <div style={styles.presetPanel}>
        <div style={styles.presetHeader}>
          <div style={styles.presetTitle}>Presets</div>
          <div style={styles.presetMeta}>
            {activePreset ? `Active: ${activePreset.label}` : 'Active: Custom'}
          </div>
        </div>
        <div style={styles.presetRow}>
          {presets.map((preset) => {
            const isActive = preset.id === activePresetId;
            return (
              <button
                key={preset.id}
                style={styles.presetButton(isActive)}
                disabled={running}
                onClick={() => setScenarioText(scenarioTextFromScenario(preset.scenario(launchConfigRef.current.requestedMatchId)))}
                title={preset.description}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <div style={styles.presetDescription}>
          {activePreset?.description ?? 'Custom scenario JSON. Edit freely or re-apply a preset.'}
        </div>
      </div>

      <div style={styles.statusLine}>{status}</div>
      <div style={styles.statusLine}>{`Bottleneck: ${bottleneck}`}</div>
      {error && <div style={styles.error}>{error}</div>}

      <textarea
        style={styles.textarea}
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
        if (bot.tickHandle !== null) {
          window.clearInterval(bot.tickHandle);
          bot.tickHandle = null;
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
      tickHandle: null,
      localState: null,
      remotePlayers: new Map<number, ObservedPlayer>(),
      brainState: createBotBrainState(id - 1, scenario),
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
    } satisfies Partial<BrowserBot>);

    bot.tickHandle = window.setInterval(() => {
      if (!bot.connected || !bot.localState) {
        return;
      }
      bot.seq = (bot.seq + 1) & 0xffff;
      const intent = stepBotBrain(bot.brainState, scenario, bot.localState, Array.from(bot.remotePlayers.values()));
      bot.currentTargetPlayerId = intent.targetPlayerId;
      bot.outboundImpairment.enqueue(buildInputFromButtons(bot.seq, 0, intent.buttons, intent.yaw, intent.pitch));
      if (intent.firePrimary) {
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
    }, 1000 / scenario.inputHz);

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
    if (bot.tickHandle !== null) {
      window.clearInterval(bot.tickHandle);
      bot.tickHandle = null;
    }
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

const styles = {
  page: {
    minHeight: '100vh',
    background: '#0a0e18',
    color: '#eaf1ff',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: 24,
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 24,
    marginBottom: 16,
  },
  title: {
    margin: 0,
    fontSize: 28,
    fontWeight: 700,
  },
  subtitle: {
    marginTop: 8,
    color: '#9ab0d1',
    maxWidth: 720,
  },
  summary: {
    textAlign: 'right',
    color: '#b8ffda',
  },
  toolbar: {
    display: 'flex',
    gap: 12,
    marginBottom: 12,
  },
  presetPanel: {
    marginBottom: 14,
    padding: 12,
    background: '#0d1524',
    border: '1px solid #263a59',
    borderRadius: 8,
  },
  presetHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 10,
    alignItems: 'baseline',
    flexWrap: 'wrap',
  },
  presetTitle: {
    color: '#b8ffda',
    fontWeight: 700,
  },
  presetMeta: {
    color: '#9ab0d1',
    fontSize: 12,
  },
  presetRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  presetButton: (active: boolean): CSSProperties => ({
    background: active ? '#21406a' : '#162236',
    color: active ? '#ffffff' : '#cfe4ff',
    border: `1px solid ${active ? '#79b6ff' : '#38537c'}`,
    borderRadius: 999,
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: active ? 700 : 500,
  }),
  presetDescription: {
    color: '#9ab0d1',
    fontSize: 12,
  },
  button: {
    background: '#162236',
    color: '#ffffff',
    border: '1px solid #38537c',
    borderRadius: 6,
    padding: '10px 14px',
    cursor: 'pointer',
  },
  statusLine: {
    marginBottom: 8,
    color: '#d8e3f8',
  },
  error: {
    marginBottom: 12,
    color: '#ff8f8f',
  },
  textarea: {
    width: '100%',
    minHeight: '70vh',
    background: '#0f1625',
    color: '#dff6ff',
    border: '1px solid #263a59',
    borderRadius: 8,
    padding: 16,
    boxSizing: 'border-box',
  },
} satisfies Record<string, CSSProperties | ((active: boolean) => CSSProperties)>;
