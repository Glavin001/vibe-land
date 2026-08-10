import { defineConfig } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from repo root (same as vite.config.ts)
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const CLIENT_PORT = Number(process.env.CLIENT_PORT) || 5555;
const SERVER_PORT = Number(process.env.SERVER_PORT) || 4001;
// The dev server switches to HTTPS whenever WT_CERT_PEM/WT_KEY_PEM are set
// (WebTransport needs a secure context), so the scheme is not fixed.
const BASE_URL = process.env.E2E_BASE_URL
  || (process.env.WT_CERT_PEM && process.env.WT_KEY_PEM
    ? `https://127.0.0.1:${CLIENT_PORT}`
    : `http://127.0.0.1:${CLIENT_PORT}`);
const CHROMIUM_EXECUTABLE_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

// Real GPU rendering. Without `--use-angle=vulkan` Chromium silently picks
// SwiftShader even on a machine with a discrete GPU, and every frame-time
// number then measures software rasterisation instead of the product: a city
// collapse read 133 ms/frame under SwiftShader and 16.7 ms on the same box
// through ANGLE/Vulkan. Hosts without a GPU still fall back automatically.
const GPU_ARGS = [
  '--enable-quic',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--ignore-certificate-errors',
  '--allow-insecure-localhost',
  '--use-gl=angle',
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
];

// Allow skipping webServer when servers are already running externally
const SKIP_WEB_SERVER = process.env.E2E_SKIP_WEB_SERVER === '1';

export default defineConfig({
  testDir: path.resolve(__dirname, 'specs'),
  outputDir: path.resolve(__dirname, 'test-results'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: path.resolve(__dirname, 'playwright-report') }]]
    : 'list',
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'on-first-retry',
    ignoreHTTPSErrors: true,
    // Use Chromium (Playwright's bundled Chrome) for WebTransport compat
    browserName: 'chromium',
    launchOptions: {
      ...(CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: CHROMIUM_EXECUTABLE_PATH }
        : {}),
      args: GPU_ARGS,
    },
  },
  projects: [
    {
      name: 'e2e',
      use: {
        browserName: 'chromium',
        ignoreHTTPSErrors: true,
        launchOptions: {
          ...(CHROMIUM_EXECUTABLE_PATH
            ? { executablePath: CHROMIUM_EXECUTABLE_PATH }
            : {}),
          args: GPU_ARGS,
        },
      },
    },
  ],
  ...(SKIP_WEB_SERVER
    ? {}
    : {
        webServer: [
          {
            command: `cd ${path.resolve(__dirname, '../../server')} && RUST_LOG=info cargo run`,
            port: SERVER_PORT,
            timeout: 180_000,
            reuseExistingServer: true,
            env: {
              RUST_LOG: 'info',
            },
          },
          {
            command: `cd ${path.resolve(__dirname, '..')} && npm run dev`,
            port: CLIENT_PORT,
            timeout: 60_000,
            reuseExistingServer: true,
          },
        ],
      }),
});
