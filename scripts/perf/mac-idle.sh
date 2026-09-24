#!/bin/bash
# Clean idle: fresh release server, one headless bot, no browser, no demolition.
#   scripts/perf/gpu-run.sh idle scripts/perf/mac-idle.sh <tag> [keepalive_us]
# keepalive_us overrides CUMETAL_GPU_KEEPALIVE_US (0 disables); output under
# target/perf-tools/idle-<tag>/.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TAG=${1:?tag}
OUT="$ROOT/target/perf-tools/idle-$TAG"; mkdir -p "$OUT"
[ -n "${2:-}" ] && export CUMETAL_GPU_KEEPALIVE_US=$2
cd "$ROOT"
(VIBE_PHYSICS_BACKEND=physx_gpu CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache" nohup ./target/release/web-fps-server > "$OUT/server.log" 2>&1 & echo $! > "$OUT/server.pid")
for i in $(seq 1 60); do curl -s -m 2 http://127.0.0.1:4001/healthz >/dev/null && break; sleep 2; done
# The city is built on first join; a warm-up bot absorbs that.
./target/debug/city-bots --api http://127.0.0.1:4001 --wt-port 4002 --bots 1 --duration 15 --out "$OUT/bots" > "$OUT/bots-warmup.log" 2>&1
node scripts/perf/tick-sampler.mjs "$OUT/ticks.jsonl" city-default > "$OUT/sampler.log" 2>&1 &
SAMPLER=$!
./target/debug/city-bots --api http://127.0.0.1:4001 --wt-port 4002 --bots 1 --duration 60 --out "$OUT/bots" > "$OUT/bots.log" 2>&1
kill $SAMPLER; kill "$(cat "$OUT/server.pid")"
python3 scripts/perf/tick_stats.py "$OUT/ticks.jsonl" --skip-fraction 0.15
