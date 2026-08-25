/**
 * Stand up (or attach to) the vibe-land stack for a netlab run.
 *
 * Modes:
 *  - attach: URLs given, nothing spawned. For measuring an already-running
 *    stack (dev-orchestration.sh, a remote box, ...).
 *  - dev: spawn `cargo run --release` (server) + `npx vite` (client), the same
 *    pair the e2e webServer config uses, and wait for readiness.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_DIR = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(CLIENT_DIR, '..');

export interface StackConfig {
  mode: 'attach' | 'dev';
  clientUrl: string;
  serverHttpUrl: string;
  /** UDP port the WebTransport endpoint listens on (netem filters target it). */
  wtUdpPort: number;
}

export interface RunningStack extends StackConfig {
  /** PID of the spawned game server, when netlab started it (null in attach mode). */
  serverPid: number | null;
  shutdown(): Promise<void>;
}

function envPort(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Dedicated netlab ports. The dev box often has a real stack on 4001/4002/5555
// (sometimes serving actual players); netlab spawns its own copy next to it so
// a measurement run can never disturb — or accidentally measure — that one.
// The isolated server also advertises 127.0.0.1 in /session-config, whereas an
// orchestrated server advertises its external Vast address, which QUIC cannot
// hairpin back to from inside the box (verified: idle-timeout, silent WS fallback).
const NETLAB_SERVER_PORT = 4051;
const NETLAB_WT_PORT = 4052;
const NETLAB_CLIENT_PORT = 5599;

export function defaultStackConfig(mode: 'attach' | 'dev'): StackConfig {
  if (mode === 'dev') {
    return {
      mode,
      clientUrl: `http://127.0.0.1:${envPort('NETLAB_CLIENT_PORT', NETLAB_CLIENT_PORT)}`,
      serverHttpUrl: `http://127.0.0.1:${envPort('NETLAB_SERVER_PORT', NETLAB_SERVER_PORT)}`,
      wtUdpPort: envPort('NETLAB_WT_PORT', NETLAB_WT_PORT),
    };
  }
  const clientPort = envPort('CLIENT_PORT', 5555);
  const serverPort = envPort('SERVER_PORT', 4001);
  const clientScheme =
    process.env.WT_CERT_PEM && process.env.WT_KEY_PEM ? 'https' : 'http';
  return {
    mode,
    clientUrl: `${clientScheme}://127.0.0.1:${clientPort}`,
    serverHttpUrl: `http://127.0.0.1:${serverPort}`,
    wtUdpPort: envPort('WT_UDP_PORT', 4002),
  };
}

async function waitForHttp(url: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok || res.status === 404) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label}: not ready after ${timeoutMs}ms (${String(lastError)})`);
}

function spawnLogged(
  command: string,
  args: string[],
  cwd: string,
  logPath: string,
  extraEnv: Record<string, string | undefined> = {},
): ChildProcess {
  const log = fs.openSync(logPath, 'w');
  // `undefined` in extraEnv removes the variable entirely — some consumers
  // (the Rust server's WT_CERT_PEM handling) treat empty-string as "set".
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', log, log],
    env,
    detached: true,
  });
  child.unref();
  return child;
}

async function killProcessGroup(child: ChildProcess | null): Promise<void> {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  await new Promise((r) => setTimeout(r, 2000));
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

export async function startStack(
  config: StackConfig,
  logDir: string,
  scenarioServerEnv: Record<string, string> = {},
): Promise<RunningStack> {
  if (config.mode === 'attach') {
    await waitForHttp(`${config.serverHttpUrl}/healthz`, 15_000, 'attach: game server');
    return { ...config, serverPid: null, shutdown: async () => {} };
  }

  fs.mkdirSync(logDir, { recursive: true });
  const serverPort = new URL(config.serverHttpUrl).port;
  const clientPort = new URL(config.clientUrl).port;

  // Refuse to run against someone else's stack. A spawn whose bind fails dies
  // quietly, and the readiness probe below then succeeds against whatever was
  // already listening -- so the run silently measures a stale binary and
  // reports it as a result. That happened: six hours of server-side numbers
  // came from a process started before the code under test existed.
  for (const [label, url] of [
    ['game server', config.serverHttpUrl],
    ['vite', config.clientUrl],
  ] as const) {
    const reachable = await fetch(url, { signal: AbortSignal.timeout(1500) })
      .then(() => true)
      .catch(() => false);
    if (reachable) {
      throw new Error(
        `${label} port already in use (${url}). A previous netlab stack is still running, ` +
          `and reusing it would measure that build instead of this one. ` +
          `Stop it first: fuser -k ${new URL(url).port}/tcp`,
      );
    }
  }
  console.log(
    `[netlab] starting isolated stack (server :${serverPort}, wt udp :${config.wtUdpPort}, vite :${clientPort})...`,
  );

  // Prefer netlab's own isolated build: the shared target/ dir is rebuilt by
  // other sessions with varying feature sets, and a measurement run must not
  // race that or silently pick up a featureless binary.
  const isolated = path.join(REPO_ROOT, 'target-netlab', 'release', 'web-fps-server');
  const shared = path.join(REPO_ROOT, 'target', 'release', 'web-fps-server');
  const prebuilt = fs.existsSync(isolated) ? isolated : shared;
  const usePrebuilt = fs.existsSync(prebuilt);
  const serverEnv: Record<string, string | undefined> = {
    RUST_LOG: process.env.RUST_LOG ?? 'info',
    BIND_ADDR: `127.0.0.1:${serverPort}`,
    WT_BIND_ADDR: `0.0.0.0:${config.wtUdpPort}`,
    WT_HOST: '127.0.0.1',
    // Local self-signed identity + pinned hash; never the external Vast URL.
    WT_PUBLIC_URL: undefined,
    WT_CERT_PEM: undefined,
    WT_KEY_PEM: undefined,
    CONTROL_PLANE_URL: undefined,
    // Rapier by default so the isolated stack runs anywhere; export
    // NETLAB_PHYSICS_BACKEND=physx_gpu (with PHYSX_ROOT/LD_LIBRARY_PATH set)
    // to measure the thin-authoritative path instead.
    VIBE_PHYSICS_BACKEND: process.env.NETLAB_PHYSICS_BACKEND ?? 'rapier',
    ...scenarioServerEnv,
  };
  // PhysX GPU needs its shared libraries on the loader path; without this the
  // server exits at startup rather than falling back, which reads as "the
  // stack never came up" instead of "PhysX is missing".
  if (serverEnv.VIBE_PHYSICS_BACKEND === 'physx_gpu') {
    const physxRoot =
      process.env.PHYSX_ROOT ?? '/root/PhysX/physx/install/linux-clang/PhysX';
    const physxLib = path.join(physxRoot, 'bin', 'linux.x86_64', 'release');
    serverEnv.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
      ? `${physxLib}:${process.env.LD_LIBRARY_PATH}`
      : physxLib;
  }
  const server = usePrebuilt
    ? spawnLogged(prebuilt, [], REPO_ROOT, path.join(logDir, 'server.log'), serverEnv)
    : spawnLogged(
        'cargo',
        ['run', '--release'],
        path.join(REPO_ROOT, 'server'),
        path.join(logDir, 'server.log'),
        serverEnv,
      );
  const client = spawnLogged(
    'npx',
    ['vite', '--host', '127.0.0.1', '--port', clientPort, '--strictPort'],
    CLIENT_DIR,
    path.join(logDir, 'vite.log'),
    {
      SERVER_PORT: serverPort,
      SERVER_HOST: '127.0.0.1',
      CLIENT_PORT: clientPort,
      WT_CERT_PEM: undefined,
      WT_KEY_PEM: undefined,
    },
  );

  const shutdown = async (): Promise<void> => {
    await Promise.all([killProcessGroup(server), killProcessGroup(client)]);
  };

  try {
    await waitForHttp(`${config.serverHttpUrl}/healthz`, 240_000, 'dev: game server');
    await waitForHttp(config.clientUrl, 90_000, 'dev: vite');
  } catch (err) {
    await shutdown();
    throw err;
  }
  return { ...config, serverPid: server.pid ?? null, shutdown };
}

/** Fetch /match-stats for build stamps and final server-side counters. */
export async function fetchMatchStats(
  serverHttpUrl: string,
  matchId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${serverHttpUrl}/match-stats/${encodeURIComponent(matchId)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
