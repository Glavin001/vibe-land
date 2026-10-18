#!/bin/bash
# Fresh release server + the Mac demo play tests (terrain, city, city destroy),
# recording every server tick. Needs the client dev server on :3003.
#   scripts/perf/gpu-run.sh playtest scripts/perf/mac-playtest.sh <tag>
# Output: target/perf-tools/playtest-<tag>/ (ticks.jsonl, fps-*.json, logs).
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TAG=${1:?tag}
OUT="$ROOT/target/perf-tools/playtest-$TAG"; mkdir -p "$OUT"
cd "$ROOT"
(VIBE_PHYSICS_BACKEND=physx_gpu CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache" nohup ./target/release/web-fps-server > "$OUT/server.log" 2>&1 & echo $! > "$OUT/server.pid")
for i in $(seq 1 60); do curl -s -m 2 http://127.0.0.1:4001/healthz >/dev/null && break; sleep 2; done
node scripts/perf/tick-sampler.mjs "$OUT/ticks.jsonl" default city-default > "$OUT/sampler.log" 2>&1 &
SAMPLER=$!
cd client
FPS_OUT="$OUT/fps-trail.json" node e2e/mac-demo/trail.mjs "" > "$OUT/trail.log" 2>&1
FPS_OUT="$OUT/fps-city.json" node e2e/mac-demo/city.mjs "" all > "$OUT/city.log" 2>&1
FPS_OUT="$OUT/fps-city2.json" node e2e/mac-demo/city.mjs "" destroy > "$OUT/city2.log" 2>&1
sleep 3; kill $SAMPLER; kill "$(cat "$OUT/server.pid")"
wc -l < "$OUT/ticks.jsonl"
