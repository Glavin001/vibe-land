#!/usr/bin/env bash
# Prove a built image would survive contact with a real Vast host.
#
# Runs the same assertions as scripts/smoke-entrypoint.sh, but through the
# container: the extra thing under test here is the image itself -- that the
# runtime layer carries every shared library the binary needs, and that the
# NVIDIA runtime injects a usable driver.
#
#   ./scripts/smoke-image.sh ghcr.io/glavin001/vibe-land-server:sha-abc123
set -euo pipefail

IMAGE="${1:?usage: smoke-image.sh <image[:tag]>}"
NAME="vibe-smoke-$$"
HTTP_PORT="${SMOKE_HTTP_PORT:-4011}"
UDP_PORT="${SMOKE_UDP_PORT:-4433}"
EXTERNAL_UDP_PORT="${SMOKE_EXTERNAL_UDP_PORT:-40687}"
PUBLIC_IP="${SMOKE_PUBLIC_IP:-203.0.113.77}"

pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*" >&2; docker logs "$NAME" 2>&1 | tail -30; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "[smoke] 1. exits rather than serving an unreachable address"
# No VAST_UDP_PORT_*: the container must refuse instead of advertising a port
# nobody outside can reach.
set +e
docker run --rm --name "${NAME}-noport" -e "PUBLIC_IPADDR=$PUBLIC_IP" "$IMAGE" >/dev/null 2>&1
code=$?
set -e
[[ $code -ne 0 ]] || fail "container started without a UDP mapping"
pass "exited $code without a port mapping"

echo "[smoke] 2. starts on a GPU host"
docker run -d --name "$NAME" --gpus all \
  -p "$HTTP_PORT:4001" -p "$EXTERNAL_UDP_PORT:$UDP_PORT/udp" \
  -e "PUBLIC_IPADDR=$PUBLIC_IP" \
  -e "VAST_UDP_PORT_${UDP_PORT}=$EXTERNAL_UDP_PORT" \
  -e MATCHES_PER_BOX=4 \
  "$IMAGE" >/dev/null

for _ in $(seq 1 120); do
  curl -fsS --max-time 2 "http://127.0.0.1:$HTTP_PORT/healthz" >/dev/null 2>&1 && break
  docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -q true \
    || fail "container exited during boot"
  sleep 1
done

health="$(curl -fsS --max-time 3 "http://127.0.0.1:$HTTP_PORT/healthz" || true)"
[[ -n "$health" ]] || fail "never became healthy"
pass "healthz: $health"

echo "$health" | grep -q '"physics_backend":"physx_gpu"' \
  || fail "GPU physics not active -- driver injection or CUDA is broken"
pass "PhysX GPU validated inside the container"

echo "[smoke] 3. advertises the external endpoint"
session="$(curl -fsS --max-time 3 "http://127.0.0.1:$HTTP_PORT/session-config?match_id=smoke")"
echo "$session" | grep -q "https://$PUBLIC_IP:$EXTERNAL_UDP_PORT/game" \
  || fail "wrong advertised endpoint: $session"
pass "advertises https://$PUBLIC_IP:$EXTERNAL_UDP_PORT/game"

echo "$session" | grep -qE '"server_certificate_hash_hex":"[a-f0-9]{64}"' \
  || fail "no usable certificate hash published"
pass "published a 64-hex certificate hash for pinning"

echo "[smoke] 4. reports the driver it was given"
docker exec "$NAME" nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null \
  | head -1 | sed 's/^/  gpu: /' || echo "  (nvidia-smi unavailable; compute still validated above)"

echo
echo "[smoke] PASS -- $IMAGE is fit to deploy"
