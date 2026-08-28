import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
    plugins: [tailwindcss(), react()],
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
        '/city-manifest': {
          target: `http://${serverHost}:${serverPort}`,
        },
        '/match-stats': {
          target: `http://${serverHost}:${serverPort}`,
        },
        // Every server route needs an entry here or the dev server answers it
        // with the SPA fallback -- a 200 full of HTML, which reads as a
        // successful request right up until something tries to use the body.
        '/city-reset': {
          target: `http://${serverHost}:${serverPort}`,
        },
        // Local control plane (`wrangler dev`), proxied so the page can reach
        // it same-origin. The dev server runs HTTPS whenever WebTransport certs
        // are configured, and a browser blocks an https page from fetching an
        // http control plane as mixed content. In production both are HTTPS and
        // no proxy is involved.
        '/cp': {
          target: `http://127.0.0.1:${env.CONTROL_PLANE_PORT || 9001}`,
          rewrite: (path: string) => path.replace(/^\/cp/, ''),
        },
      },
    },
    define: {
      // Absolute path to the authored ScenePacks, for the /structure viewer.
      // `server.fs.allow: ['..']` above already lets vite serve them through
      // /@fs, so the viewer reads them in place instead of duplicating several
      // megabytes of JSON into public/.
      __SCENES_DIR__: JSON.stringify(
        path.resolve(process.cwd(), '../destruction/assets/scenes'),
      ),
      // Build stamp so a stale page is visible in a screenshot. The client is
      // hot-reloaded independently of the server, so "which code is running"
      // has two answers and both need to be on screen.
      __CLIENT_BUILD__: JSON.stringify(
        new Date().toISOString().slice(11, 19),
      ),
    },
    optimizeDeps: {
      exclude: ['vibe-land-shared'],
    },
    test: {
      // Unit tests inside src/ plus the netlab analyzer (Node-only, so it
      // lives outside src/ and is never bundled). Keeps Playwright E2E specs
      // (e2e/) out of vitest — those run separately via `npm run e2e`.
      include: ['src/**/*.test.ts', 'netlab/**/*.test.ts'],
      // WASM physics tests run thousands of simulation steps and need extra
      // headroom, especially on slow CI runners or with debug WASM builds.
      testTimeout: 120_000,
    },
  };
});
