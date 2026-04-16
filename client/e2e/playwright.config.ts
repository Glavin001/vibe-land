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
const BASE_URL = `http://localhost:${CLIENT_PORT}`;

// Allow skipping webServer when servers are already running externally
const SKIP_WEB_SERVER = process.env.E2E_SKIP_WEB_SERVER === '1';

export default defineConfig({
  testDir: path.resolve(__dirname, 'specs'),
  outputDir: path.resolve(__dirname, 'test-results'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
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
    // Use Chromium (Playwright's bundled Chrome) for WebTransport compat
    browserName: 'chromium',
    launchOptions: {
      args: [
        '--enable-quic',
        '--no-sandbox',
        // Use GPU when available for full-speed WebGL rendering.
        // CI environments without a GPU will fall back to swiftshader automatically.
        '--use-gl=angle',
      ],
    },
  },
  projects: [
    {
      name: 'e2e',
      use: {
        browserName: 'chromium',
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
