// Playwright harness adapted from Kinema's playwright.config.ts (MIT).
// See CREDITS.md at the repo root.

import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.CLIENT_PORT) || 3001;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
  testMatch: ['*.ts'],
  timeout: 120_000,
  workers: 2,
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  use: {
    baseURL: BASE_URL,
    headless: true,
    viewport: { width: 1920, height: 1080 },
    // Allow WebGL content to render under headless Chromium via SwiftShader
    // on CI; locally this lets WebGL pages render predictably.
    launchOptions: {
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-gpu-rasterization',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
