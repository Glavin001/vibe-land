import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../', '');
  const serverPort = env.SERVER_PORT || '4001';
  const serverHost = env.SERVER_HOST || 'localhost';
  const allowedHosts = env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(',') : [];

  return {
    plugins: [react()],
    envDir: '../',
    server: {
      port: Number(env.CLIENT_PORT) || 3001,
      host: '0.0.0.0',
      allowedHosts,
      proxy: {
        '/ws': {
          target: `http://${serverHost}:${serverPort}`,
          ws: true,
        },
        '/healthz': {
          target: `http://${serverHost}:${serverPort}`,
        },
      },
    },
    optimizeDeps: {
      exclude: ['vibe-land-shared'],
    },
  };
});
