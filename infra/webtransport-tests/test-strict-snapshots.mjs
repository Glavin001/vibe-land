import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const clientDir = path.join(repoRoot, 'client');

const serverPort = process.env.STRICT_TEST_SERVER_PORT ?? '4301';
const wtPort = process.env.STRICT_TEST_WT_PORT ?? '4302';
const clientPort = process.env.STRICT_TEST_CLIENT_PORT ?? '3301';
const serverHost = process.env.STRICT_TEST_SERVER_HOST ?? '127.0.0.1';
const clientUrl = `http://${serverHost}:${clientPort}`;
const serverHttpOrigin = `http://${serverHost}:${serverPort}`;

function spawnManaged(name, command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });

  return child;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function terminate(child, signal = 'SIGINT') {
  if (!child || child.exitCode != null) {
    return;
  }
  child.kill(signal);
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  let server = null;
  let client = null;
  let benchmark = null;

  try {
    server = spawnManaged('server', 'cargo', ['run', '--release', '-p', 'web-fps-server'], {
      cwd: repoRoot,
      env: {
        BIND_ADDR: `${serverHost}:${serverPort}`,
        WT_BIND_ADDR: `${serverHost}:${wtPort}`,
        WT_HOST: serverHost,
        WT_STRICT_SNAPSHOT_DATAGRAMS: '1',
        VIBE_SERVER_RESPAWN_DELAY_MS: process.env.STRICT_TEST_RESPAWN_DELAY_MS ?? '0',
        RUST_LOG: process.env.RUST_LOG ?? 'info',
      },
    });

    await waitForHttp(`${serverHttpOrigin}/healthz`, 60_000);

    client = spawnManaged('client', 'npm', ['run', 'dev'], {
      cwd: clientDir,
      env: {
        SERVER_HOST: serverHost,
        SERVER_PORT: serverPort,
        CLIENT_PORT: clientPort,
      },
    });

    await waitForHttp(`${clientUrl}/loadtest?benchmark=1`, 90_000);

    benchmark = spawnManaged(
      'benchmark',
      'npm',
      [
        'run',
        'benchmark:strict',
        '--',
        '--client-url',
        clientUrl,
        '--server-host',
        `${serverHost}:${serverPort}`,
      ],
      {
        cwd: clientDir,
        env: {},
      },
    );

    const benchmarkExitCode = await new Promise((resolve, reject) => {
      benchmark.on('error', reject);
      benchmark.on('close', (code) => resolve(code ?? 1));
    });

    if (benchmarkExitCode !== 0) {
      throw new Error(`Strict snapshot benchmark failed with exit code ${benchmarkExitCode}`);
    }
  } finally {
    await terminate(benchmark);
    await terminate(client);
    await terminate(server);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
