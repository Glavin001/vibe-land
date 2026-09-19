#!/usr/bin/env bash
#
# One unobstructed tower, knocked over, captured end to end.
#
#   scripts/netlab/tower-capture.sh [--out DIR] [--scene NAME] [-- <extra args>]
#
# Starts a private server on its own ports so a live deployment is untouched,
# waits for it, runs the browser capture, and stops the server again. A fresh
# process per capture is the reset: POST /city-reset rebuilds the tower and
# then the process dies a few seconds later.
#
# The scene is ONE building on an empty ground plane. Captures made on the
# downtown scene were useless for watching: the tower being felled stands
# behind three others and most of the collapse happens out of shot.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT=/tmp/tower
SCENE=high-rise-10f-local.json
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --scene) SCENE="$2"; shift 2 ;;
    --) shift; EXTRA=("$@"); break ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

API_PORT=4018; WEB_PORT=1112; WT_PORT=4434
# Only this checkout's own test server, matched on its exact binary path, so a
# deployed server sharing the box is never touched.
pkill -f "${ROOT}/target/release/web-fps-server" 2>/dev/null
sleep 2

mkdir -p "$OUT"
BIND_ADDR=127.0.0.1:${API_PORT} \
WEB_BIND_ADDR=0.0.0.0:${WEB_PORT} \
WT_BIND_ADDR=0.0.0.0:${WT_PORT} \
WT_PUBLIC_URL=https://127.0.0.1:${WT_PORT} \
WT_CERT_PEM="${ROOT}/.certs/vast-city/cert.pem" \
WT_KEY_PEM="${ROOT}/.certs/vast-city/key.pem" \
WT_STRICT_SNAPSHOT_DATAGRAMS=1 \
VIBE_WEB_DIR="${ROOT}/client/dist" \
VIBE_PHYSICS_BACKEND=physx_gpu \
VIBE_CITY_DESTRUCTION=native \
VIBE_CITY_GRID=1 \
VIBE_CITY_SCENE="${SCENE}" \
PHYSX_DESTRUCTION_SDK=/root/workspace/physx-2 \
CUDA_HOME=/usr/local/cuda-12.8 \
LD_LIBRARY_PATH=/usr/local/cuda-12.8/lib64:/root/workspace/physx-2/physx/bin/linux.x86_64/release \
nohup "${ROOT}/target/release/web-fps-server" > "${OUT}/server.log" 2>&1 &
SERVER=$!

for _ in $(seq 60); do
  if curl -sk --max-time 2 "http://127.0.0.1:${API_PORT}/healthz" | grep -q '"status":"ok"'; then break; fi
  sleep 1
done
if ! curl -sk --max-time 2 "http://127.0.0.1:${API_PORT}/healthz" | grep -q '"status":"ok"'; then
  echo "server did not come up; see ${OUT}/server.log" >&2
  tail -20 "${OUT}/server.log" >&2
  exit 1
fi
echo "tower server up on ${SCENE} (web ${WEB_PORT}, wt ${WT_PORT}, api ${API_PORT})"

node "${ROOT}/client/e2e/qa-tower-collapse.mjs" \
  --page "https://127.0.0.1:${WEB_PORT}" --wt-port "${WT_PORT}" \
  --api "http://127.0.0.1:${API_PORT}" --out "$OUT" "${EXTRA[@]}"
STATUS=$?

kill "$SERVER" 2>/dev/null
wait "$SERVER" 2>/dev/null
echo "tower server stopped"
exit $STATUS
