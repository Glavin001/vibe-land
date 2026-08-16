import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Tests run inside the real Workers runtime (workerd) via Miniflare, so the
// Durable Object, its SQLite storage, and alarms behave exactly as deployed.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Every value the tests depend on is pinned here. Miniflare also reads
        // `.dev.vars`, so without this a local tweak for manual testing (a
        // longer idle timeout, say) silently changes what the suite asserts.
        bindings: {
          VAST_API_KEY: 'test-key',
          HEARTBEAT_TOKEN: 'test-heartbeat',
          ADMIN_TOKEN: 'test-admin',
          CONTROL_PLANE_URL: 'https://cp.test',
          VAST_API_BASE: 'https://vast.test',
          SERVER_IMAGE: 'ghcr.io/test/vibe-land-server:test',
          MATCHES_PER_BOX: '6',
          MAX_PLAYERS_PER_MATCH: '16',
          IDLE_SHUTDOWN_MIN: '10',
          MAX_INSTANCE_UPTIME_H: '6',
          MAX_INSTANCE_SPEND_USD: '5',
          BOOT_TIMEOUT_MIN: '7',
          HEARTBEAT_TIMEOUT_SEC: '90',
          MAX_PROVISION_ATTEMPTS: '5',
          INSTANCE_DISK_GB: '30',
        },
      },
    }),
  ],
});
