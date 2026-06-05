import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Connect } from 'vite';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

function localPublishedWorldsMiddleware(repoRoot: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url;
    if (!url?.startsWith('/published/') || !url.endsWith('.world.json')) {
      next();
      return;
    }
    const name = path.basename(url, '.world.json');
    if (!/^[0-9a-f-]+$/i.test(name)) {
      next();
      return;
    }
    const filePath = path.join(repoRoot, 'worlds', `${name}.world.json`);
    if (!fs.existsSync(filePath)) {
      next();
      return;
    }
    try {
      const body = fs.readFileSync(filePath);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(body);
    } catch {
      next();
    }
  };
}

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

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  return {
    plugins: [
      tailwindcss(),
      react(),
      {
        name: 'local-published-worlds',
        configureServer(server) {
          server.middlewares.use(localPublishedWorldsMiddleware(repoRoot));
        },
      },
    ],
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
      // WASM physics tests run thousands of simulation steps and need extra
      // headroom, especially on slow CI runners or with debug WASM builds.
      testTimeout: 120_000,
    },
  };
});
