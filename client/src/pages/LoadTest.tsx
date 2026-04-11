import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { buildInputFromButtons } from '../scene/inputBuilder';
import { stepBotBrain, createBotBrainState, type ObservedPlayer } from '../loadtest/brain';
import { PacketImpairment } from '../loadtest/networkModel';
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
import {
  netStateToMeters,
  type PlayerStateMeters,
  type ServerDatagramPacket,
  type ServerReliablePacket,
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
};

const PAGE_SCENARIO = normalizeScenario({
  ...DEFAULT_SCENARIO,
  name: 'webtransport-browser',
  matchId: 'loadtest-webtransport-browser',
  botCount: 20,
  transportMix: { websocket: 0, webtransport: 20 },
});

export function LoadTestPage() {
  const [scenarioText, setScenarioText] = useState(() => JSON.stringify(PAGE_SCENARIO, null, 2));
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('Idle');
  const [error, setError] = useState<string | null>(null);
  const [connectedBots, setConnectedBots] = useState(0);
  const [snapshotsReceived, setSnapshotsReceived] = useState(0);
  const [bottleneck, setBottleneck] = useState('waiting for /ws/stats');
  const botsRef = useRef<BrowserBot[]>([]);
  const statsSocketRef = useRef<WebSocket | null>(null);

  useEffect(() => () => {
    stopBots(botsRef.current);
    statsSocketRef.current?.close();
  }, []);

  async function start(): Promise<void> {
    setError(null);
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
      setRunning(true);
      setStatus('Connecting WebTransport bots...');
      connectStatsSocket(scenario.matchId);

      const rng = new SeededRandom(scenario.seed);
      const bots = await Promise.all(
        Array.from({ length: scenario.transportMix.webtransport }, async (_, index) => {
          const profile = chooseWeightedProfile(scenario, 'webtransport', rng);
          return spawnWebTransportBot(index + 1, scenario, profile);
        }),
      );
      botsRef.current = bots;
      setStatus(`Running ${bots.length} WebTransport bots`);
      updateCounters();
    } catch (err) {
      setRunning(false);
      throw err;
    }
  }

  function connectStatsSocket(matchId: string): void {
    statsSocketRef.current?.close();
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${window.location.host}/ws/stats`);
    statsSocketRef.current = socket;
    socket.onmessage = (event) => {
      try {
        const snapshot = JSON.parse(event.data as string) as GlobalStatsSnapshot;
        const match = snapshot.matches.find((candidate) => candidate.id === matchId);
        if (match) {
          setBottleneck(describeBottleneck(match));
        }
      } catch {
        // ignore parse errors
      }
    };
  }

  function updateCounters(): void {
    const bots = botsRef.current;
    setConnectedBots(bots.filter((bot) => bot.connected).length);
    setSnapshotsReceived(bots.reduce((sum, bot) => sum + bot.snapshotsReceived, 0));
  }

  async function stop(): Promise<void> {
    stopBots(botsRef.current);
    botsRef.current = [];
    statsSocketRef.current?.close();
    statsSocketRef.current = null;
    setRunning(false);
    setStatus('Stopped');
    updateCounters();
  }

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
        <button style={styles.button} disabled={!running} onClick={() => void stop()}>
          Stop
        </button>
        <button style={styles.button} onClick={() => setScenarioText(JSON.stringify(PAGE_SCENARIO, null, 2))}>
          Reset Scenario
        </button>
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
    } satisfies Partial<BrowserBot>);

    bot.tickHandle = window.setInterval(() => {
      if (!bot.connected || !bot.localState) {
        return;
      }
      bot.seq = (bot.seq + 1) & 0xffff;
      const intent = stepBotBrain(bot.brainState, scenario, bot.localState, Array.from(bot.remotePlayers.values()));
      bot.currentTargetPlayerId = intent.targetPlayerId;
      bot.outboundImpairment.enqueue(buildInputFromButtons(bot.seq, 0, intent.buttons, intent.yaw, 0));
    }, 1000 / scenario.inputHz);

    return bot;
  }

  function handlePacket(
    bot: BrowserBot,
    _scenario: LoadTestScenario,
    packet: ServerReliablePacket | ServerDatagramPacket,
  ): void {
    switch (packet.type) {
      case 'welcome':
        bot.playerId = packet.playerId;
        bot.connected = true;
        updateCounters();
        break;
      case 'snapshot':
        bot.snapshotsReceived += 1;
        bot.remotePlayers.clear();
        for (const playerState of packet.playerStates) {
          const meters = netStateToMeters(playerState);
          if (playerState.id === bot.playerId) {
            bot.localState = meters;
          } else {
            bot.remotePlayers.set(playerState.id, { id: playerState.id, state: meters });
          }
        }
        updateCounters();
        break;
      default:
        break;
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

const styles: Record<string, CSSProperties> = {
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
};
