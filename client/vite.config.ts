import fs from 'fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../', '');
  const serverPort = env.SERVER_PORT || '4001';
  const serverHost = env.SERVER_HOST || 'localhost';
  const allowedHosts = env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(',') : [];

  // Enable HTTPS when cert paths are configured (required for WebTransport)
  const certPath = env.WT_CERT_PEM;
  const keyPath = env.WT_KEY_PEM;
  const httpsConfig = certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)
    ? { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }
    : undefined;

  return {
    plugins: [react()],
    envDir: '../',
    server: {
      port: Number(env.CLIENT_PORT) || 3001,
      host: '0.0.0.0',
      https: httpsConfig,
      allowedHosts,
      fs: {
        allow: ['..'],
      },
      proxy: {
        '/ws': {
          target: `http://${serverHost}:${serverPort}`,
          ws: true,
        },
        '/healthz': {
          target: `http://${serverHost}:${serverPort}`,
        },
        '/session-config': {
          target: `http://${serverHost}:${serverPort}`,
        },
      },
    },
    optimizeDeps: {
      exclude: ['vibe-land-shared'],
    },
    test: {
      // Only run unit tests inside src/ — keeps Playwright E2E specs (e2e/)
      // out of vitest. E2E tests run separately via `npm run e2e`.
      include: ['src/**/*.test.ts'],
      // WASM physics tests (e.g. sequence wrap-around) run 65k+ simulation
      // steps and need extra headroom on CI runners.
      testTimeout: 60_000,
    },
  };
});
