import fs from 'fs';
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

  // Route the bare `import … from 'three'` specifier to the WebGPU entry
  // point. It re-exports the full three API and adds WebGPURenderer, so
  // all consumers (and @react-three/fiber, drei, etc.) share a single
  // THREE module graph — no duplicate-module hazard. The regex is anchored
  // so deep imports like `three/examples/jsm/loaders/GLTFLoader.js` pass
  // through unchanged (those don't exist under `three/webgpu/...`).
  // Skipped under vitest: the webgpu bundle references `self` at import
  // time which doesn't exist in Node; unit tests don't render, so the
  // plain three build is fine there.
  const isTestRun = process.env.VITEST !== undefined || mode === 'test';
  const threeAliases = isTestRun
    ? []
    : [{ find: /^three$/, replacement: 'three/webgpu' }];

  return {
    plugins: [tailwindcss(), react()],
    envDir: '../',
    resolve: {
      alias: threeAliases,
    },
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
      // WASM physics tests run thousands of simulation steps and need extra
      // headroom, especially on slow CI runners or with debug WASM builds.
      testTimeout: 120_000,
    },
  };
});
