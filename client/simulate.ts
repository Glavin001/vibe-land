/**
 * Bot Simulation / Load Test
 *
 * Spawns N headless bot clients that connect to the game server via WebSocket
 * and send random movement inputs, useful for load testing and netcode validation.
 *
 * Usage:
 *   cd client
 *   npm run simulate              # 10 bots, 30 s
 *   npm run simulate -- 50        # 50 bots, 30 s
 *   npm run simulate -- 50 60     # 50 bots for 60 s
 *   npm run simulate -- 10 0      # 10 bots, run until Ctrl-C
 *
 * Requires a running game server at localhost:4001.
 * The server must have SKIP_SPACETIMEDB_VERIFY=1 set to accept bot tokens.
 */

import WebSocket from 'ws';
import {
  decodeServerPacket,
  encodeInputBundle,
  encodePingPacket,
  buildInputFrame,
  type InputFrame,
} from './src/net/protocol.js';
import {
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_SPRINT,
} from './src/net/sharedConstants.js';

// ── Configuration ────────────────────────────────────────────────────────────

// Bots connect directly to the game server, bypassing the Vite proxy.
// Reads SERVER_HOST and SERVER_PORT from env (compatible with .env config).
// Override example: SERVER_HOST=192.168.1.10 SERVER_PORT=4002 npm run simulate
const _serverHost = process.env.SERVER_HOST ?? 'localhost';
const _serverPort = process.env.SERVER_PORT ?? '4001';
const SERVER_HOST = `${_serverHost}:${_serverPort}`;
const MATCH_ID    = process.env.MATCH_ID    ?? 'default';
const TOKEN       = process.env.TOKEN       ?? 'mvp-token';

const NUM_BOTS         = parseInt(process.argv[2] ?? '10',  10);
const DURATION_S       = parseInt(process.argv[3] ?? '30',  10); // 0 = run forever
const INPUT_HZ         = 20;   // input send rate
const DIR_CHANGE_MIN   = 5;    // minimum ticks before changing direction
const DIR_CHANGE_MAX   = 25;   // maximum ticks before changing direction
const SPRINT_CHANCE    = 0.3;  // probability of holding sprint each tick

// ── Types ────────────────────────────────────────────────────────────────────

type Direction = 'forward' | 'back' | 'left' | 'right';

interface BotState {
  id: number;
  ws: WebSocket | null;
  connected: boolean;
  playerId: number;
  seq: number;
  direction: Direction;
  dirCountdown: number;
  yaw: number;
  tickHandle: ReturnType<typeof setInterval> | null;
  snapshotsReceived: number;
  pingsReceived: number;
  connectTime: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const DIRECTION_BUTTONS: Record<Direction, number> = {
  forward: BTN_FORWARD,
  back:    BTN_BACK,
  left:    BTN_LEFT,
  right:   BTN_RIGHT,
};

const DIRECTION_YAW: Record<Direction, number> = {
  forward: 0,
  back:    Math.PI,
  left:    Math.PI / 2,
  right:   -Math.PI / 2,
};

const DIRECTIONS: Direction[] = ['forward', 'back', 'left', 'right'];

function randomDir(): Direction {
  return DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
}

function randomDirCountdown(): number {
  return DIR_CHANGE_MIN + Math.floor(Math.random() * (DIR_CHANGE_MAX - DIR_CHANGE_MIN));
}

function buildBotFrame(state: BotState): InputFrame {
  let buttons = DIRECTION_BUTTONS[state.direction];
  if (Math.random() < SPRINT_CHANCE) buttons |= BTN_SPRINT;
  return buildInputFrame(state.seq, buttons, state.yaw, 0);
}

// ── Bot lifecycle ─────────────────────────────────────────────────────────────

function tickBot(state: BotState): void {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

  state.dirCountdown--;
  if (state.dirCountdown <= 0) {
    state.direction = randomDir();
    state.dirCountdown = randomDirCountdown();
    state.yaw = DIRECTION_YAW[state.direction] + (Math.random() - 0.5) * 0.5;
  }

  state.seq = (state.seq + 1) & 0xffff;
  const frame = buildBotFrame(state);
  const packet = encodeInputBundle([frame]);
  state.ws.send(packet);
}

function spawnBot(id: number): Promise<BotState> {
  return new Promise((resolve, reject) => {
    const identity = `bot-${id}`;
    const url = `ws://${SERVER_HOST}/ws/${MATCH_ID}?identity=${identity}&token=${TOKEN}`;

    const state: BotState = {
      id,
      ws: null,
      connected: false,
      playerId: 0,
      seq: 0,
      direction: randomDir(),
      dirCountdown: randomDirCountdown(),
      yaw: Math.random() * Math.PI * 2,
      tickHandle: null,
      snapshotsReceived: 0,
      pingsReceived: 0,
      connectTime: 0,
    };

    const timeout = setTimeout(() => {
      reject(new Error(`Bot ${id}: connection timeout`));
    }, 10_000);

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.on('open', () => {
      // Server sends welcome on connect; nothing to send yet.
    });

    ws.on('message', (data: ArrayBuffer | Buffer) => {
      const buf = data instanceof Buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;

      let packet;
      try {
        packet = decodeServerPacket(buf as ArrayBuffer);
      } catch {
        return; // ignore unknown packets
      }

      switch (packet.type) {
        case 'welcome':
          state.playerId = packet.playerId;
          state.connected = true;
          state.connectTime = Date.now();
          clearTimeout(timeout);

          state.tickHandle = setInterval(() => tickBot(state), 1000 / INPUT_HZ);
          resolve(state);
          break;

        case 'snapshot':
          state.snapshotsReceived++;
          break;

        case 'serverPing':
          // Respond with pong so server lag-comp history advances correctly.
          ws.send(encodePingPacket(packet.value));
          state.pingsReceived++;
          break;

        default:
          break;
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('close', () => {
      state.connected = false;
      if (state.tickHandle) {
        clearInterval(state.tickHandle);
        state.tickHandle = null;
      }
    });
  });
}

function stopBot(state: BotState): void {
  if (state.tickHandle) {
    clearInterval(state.tickHandle);
    state.tickHandle = null;
  }
  state.ws?.close();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const durationLabel = DURATION_S > 0 ? `${DURATION_S}s` : 'until Ctrl-C';
  console.log(`\n=== vibe-land bot simulation: ${NUM_BOTS} bots, ${durationLabel} ===\n`);
  console.log(`Server: ws://${SERVER_HOST}/ws/${MATCH_ID}`);
  console.log('Connecting...\n');

  const results = await Promise.allSettled(
    Array.from({ length: NUM_BOTS }, (_, i) => spawnBot(i + 1))
  );

  const bots: BotState[] = [];
  let failures = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      bots.push(r.value);
    } else {
      failures++;
      console.error('  Failed:', (r.reason as Error).message);
    }
  }

  console.log(`\n${bots.length}/${NUM_BOTS} bots connected and walking.\n`);

  if (bots.length === 0) {
    console.error('No bots connected. Is the server running?');
    process.exit(1);
  }

  // Periodic status line
  let lastSnapshotTotal = 0;
  let lastStatusTime = Date.now();

  const statusInterval = setInterval(() => {
    const now = Date.now();
    const elapsedS = (now - lastStatusTime) / 1000;
    lastStatusTime = now;

    const connected = bots.filter(b => b.connected).length;
    const totalSnapshots = bots.reduce((s, b) => s + b.snapshotsReceived, 0);
    const snapshotDelta = totalSnapshots - lastSnapshotTotal;
    lastSnapshotTotal = totalSnapshots;
    const snapsPerSecond = (snapshotDelta / elapsedS).toFixed(1);

    console.log(
      `  [Status] connected=${connected}/${bots.length}  ` +
      `snapshots/s=${snapsPerSecond} (${totalSnapshots} total)`
    );
  }, 2000);

  // Run for duration or until Ctrl-C
  const cleanup = () => {
    clearInterval(statusInterval);
    console.log('\nStopping all bots...');
    for (const bot of bots) stopBot(bot);

    const totalSnapshots = bots.reduce((s, b) => s + b.snapshotsReceived, 0);
    console.log(
      `\nSimulation complete.\n` +
      `  Bots connected:     ${bots.length}/${NUM_BOTS}\n` +
      `  Total snapshots:    ${totalSnapshots}\n` +
      `  Avg per bot:        ${(totalSnapshots / bots.length).toFixed(1)}\n`
    );
    process.exit(failures > 0 ? 1 : 0);
  };

  process.on('SIGINT',  cleanup);
  process.on('SIGTERM', cleanup);

  if (DURATION_S > 0) {
    setTimeout(cleanup, DURATION_S * 1000);
  }
}

main().catch((err: Error) => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
