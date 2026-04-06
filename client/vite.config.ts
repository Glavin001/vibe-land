import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/ws': {
        target: 'http://localhost:4001',
        ws: true,
      },
      '/healthz': {
        target: 'http://localhost:4001',
      },
    },
  },
});
