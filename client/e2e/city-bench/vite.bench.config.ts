// The client's own vite config with a private dependency cache, for the city
// benchmark's dev server (scripts/perf/city-bench.sh). A worktree's
// node_modules may be a link to another checkout's, and two dev servers
// optimising dependencies into one node_modules/.vite would invalidate each
// other's pages mid-run.
import { defineConfig, mergeConfig, type ConfigEnv } from 'vite';
import base from '../../vite.config';

export default defineConfig((env: ConfigEnv) => mergeConfig(
  (base as (env: ConfigEnv) => Record<string, unknown>)(env),
  process.env.VITE_CACHE_DIR ? { cacheDir: process.env.VITE_CACHE_DIR } : {},
));
