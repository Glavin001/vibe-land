#!/bin/bash
# Record the meteor-felled 5x5 city and its aftermath as a paired session, to
# look at in /cityreplay and to analyse (scripts/perf/pile-motion.py):
#
#   scripts/perf/record-pile-tape.sh <outDir> [seconds] [meteors]
#
# Runs this worktree's vite (needs client/node_modules and client/src/wasm/pkg)
# on :$CLIENT_PORT and the server BIN on :$HTTP_PORT/:$WT_PORT, under the GPU
# lock, with production stage settings and VIBE_CITY_NATIVE_MOTION_TRACE=1.
# Extra server env passes through (e.g. VIBE_CITY_NATIVE_HIBERNATE=1).
set -u
WT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:?outDir}; SECONDS_=${2:-150}; METEORS=${3:-50}
HTTP_PORT=${HTTP_PORT:-4511}; WT_PORT=${WT_PORT:-4512}; CLIENT_PORT=${CLIENT_PORT:-3513}
BIN=${BIN:-$WT/target/hibernate/release/web-fps-server}
GPU_RUN=${GPU_RUN:-/Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh}
mkdir -p "$OUT/debug-reports"; OUT=$(cd "$OUT" && pwd)
(cd "$WT/client" && CLIENT_PORT=$CLIENT_PORT SERVER_PORT=$HTTP_PORT SERVER_HOST=127.0.0.1 \
  VITE_CACHE_DIR=$WT/target/vite-cache-pile \
  exec npx vite --config e2e/city-bench/vite.bench.config.ts --port "$CLIENT_PORT" --strictPort) \
  > "$OUT/vite.log" 2>&1 &
VITE=$!
trap 'kill $VITE 2>/dev/null; pkill -P $VITE 2>/dev/null' EXIT
for _ in $(seq 1 90); do curl -s -m 2 "http://localhost:$CLIENT_PORT/" >/dev/null && break; sleep 1; done
curl -s -m 180 "http://localhost:$CLIENT_PORT/city" >/dev/null || { echo "vite did not start; see $OUT/vite.log" >&2; exit 11; }

cat > "$OUT/session.sh" <<EOS
#!/bin/bash
cd "$WT"
env BIND_ADDR=127.0.0.1:$HTTP_PORT WT_BIND_ADDR=0.0.0.0:$WT_PORT WT_HOST=127.0.0.1 WEB_BIND_ADDR= \\
  SKIP_SPACETIMEDB_VERIFY=1 VIBE_DEBUG_REPORTS_DIR="$OUT/debug-reports" RUST_LOG=info \\
  VIBE_PHYSICS_BACKEND=physx_gpu VIBE_GARAGE_VEHICLE_DESTRUCTION=1 PX_DESTRUCTION_ALLOW_UNCONVERGED=1 \\
  VIBE_CITY_DESTRUCTIBLE_VEHICLES=1 VIBE_NATIVE_STRESS_FORCE_TOLERANCE=0.001 \\
  BLAST_STRESS_INCREMENTAL_MOTION=1 PX_DESTRUCTION_INCREMENTAL_TOPOLOGY=1 BLAST_STRESS_BALANCED_OPERATOR=1 \\
  CUMETAL_CACHE_DIR=/Users/glavin/Development/vibe-land/target/cumetal-cache-vehicles \\
  VIBE_CITY_SCENE=high-rise-10f-local.json VIBE_CITY_GRID=\${VIBE_CITY_GRID:-5} VIBE_CITY_VARIED_HEIGHTS=0 \\
  VIBE_METEOR_POOL=32 VIBE_CITY_NATIVE_MOTION_TRACE=1 \\
  "$BIN" > "$OUT/server.log" 2>&1 &
SERVER=\$!
trap 'kill \$SERVER 2>/dev/null; wait \$SERVER 2>/dev/null' EXIT
for i in \$(seq 1 150); do curl -s -m 2 http://127.0.0.1:$HTTP_PORT/healthz >/dev/null && break; sleep 2; done
cd "$WT/client"
CLIENT=http://localhost:$CLIENT_PORT API=http://127.0.0.1:$HTTP_PORT REPORTS_DIR="$OUT/debug-reports" \\
  node e2e/tape-replay/record-pile.mjs "$OUT" $SECONDS_ $METEORS 2>&1 | tee "$OUT/record.log"
EOS
chmod +x "$OUT/session.sh"
echo "waiting for the GPU lock (owner: $(cat /Users/glavin/Development/vibe-land/target/perf-tools/gpu.lock/owner 2>/dev/null || echo none))"
"$GPU_RUN" record-pile "$OUT/session.sh"
