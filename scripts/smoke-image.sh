#!/usr/bin/env bash
# Prove a built image would survive contact with a real host.
#
# Runs the same assertions as scripts/smoke-entrypoint.sh, but through the
# container: the extra thing under test here is the image itself -- that the
# runtime layer carries every shared library the binary needs, that the bundle
# is complete, and that the NVIDIA runtime injects a usable driver.
#
#   ./scripts/smoke-image.sh ghcr.io/glavin001/vibe-land-server:sha-abc123
#   ./scripts/smoke-image.sh --cpu <image>   # no GPU on this host (CI)
#
# --cpu drops the two assertions that need a real device -- the GPU physics
# backend and nvidia-smi -- and boots the same container on the CPU backend
# instead. Everything else is identical, so CI and a GPU host run one script.
set -euo pipefail

CPU_ONLY=""
IMAGE=""
for arg in "$@"; do
  case "$arg" in
    --cpu) CPU_ONLY=1 ;;
    *) IMAGE="$arg" ;;
  esac
done
: "${IMAGE:?usage: smoke-image.sh [--cpu] <image[:tag]>}"

NAME="vibe-smoke-$$"
HTTP_PORT="${SMOKE_HTTP_PORT:-4011}"
UDP_PORT="${SMOKE_UDP_PORT:-4433}"
EXTERNAL_UDP_PORT="${SMOKE_EXTERNAL_UDP_PORT:-40687}"
PUBLIC_IP="${SMOKE_PUBLIC_IP:-203.0.113.77}"

pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*" >&2; docker logs "$NAME" 2>&1 | tail -30 || true; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [[ -n "$CPU_ONLY" ]]; then echo "[smoke] --cpu: GPU assertions skipped"; fi

echo "[smoke] 1. the bundle is complete"
missing="$(docker run --rm --entrypoint /bin/bash "$IMAGE" -c '
  set -u
  for f in bin/web-fps-server run.sh entrypoint.sh manifest.txt \
           lib/libPhysXGpu_64.so; do
    [[ -e "/opt/vibe-land/$f" ]] || echo "$f"
  done
  ls /opt/vibe-land/lib/libcudart.so.* >/dev/null 2>&1 || echo "lib/libcudart.so.*"
  ls /opt/vibe-land/assets/scenes/*.json >/dev/null 2>&1 || echo "assets/scenes/*.json"
')"
[[ -z "$missing" ]] || fail "image is missing: $missing"
pass "binary, PhysX GPU library, CUDA runtime, scenes and entrypoint all present"

echo "[smoke] 2. every shared library resolves"
# libcuda.so.1 is the driver. It is deliberately absent from the image and
# injected by the NVIDIA container runtime at start, so it is the one name
# allowed to be unresolved here.
unresolved="$(docker run --rm --entrypoint /bin/bash "$IMAGE" -c '
  LD_LIBRARY_PATH=/opt/vibe-land/lib ldd /opt/vibe-land/bin/web-fps-server 2>&1 \
    | grep "not found" || true
' | grep -v 'libcuda\.so\.1' || true)"
[[ -z "$unresolved" ]] || fail "unresolved libraries in the runtime layer: $unresolved"
pass "no missing libraries beyond the host-injected driver"

echo "[smoke] 3. exits rather than serving an unreachable address on Vast"
# A Vast-shaped environment with no UDP mapping: the container must refuse
# instead of advertising a port nobody outside can reach.
set +e
docker run --rm --name "${NAME}-noport" \
  -e "PUBLIC_IPADDR=$PUBLIC_IP" -e "VAST_CONTAINERLABEL=C.smoke" \
  "$IMAGE" >/dev/null 2>&1
code=$?
set -e
[[ $code -eq 78 ]] || fail "expected exit 78 without a port mapping, got $code"
pass "exited $code without a port mapping"

echo "[smoke] 4. starts"
gpu_args=(--gpus all)
backend_env=()
if [[ -n "$CPU_ONLY" ]]; then
  gpu_args=()
  backend_env=(-e VIBE_PHYSICS_BACKEND=rapier)
fi
docker run -d --name "$NAME" "${gpu_args[@]}" "${backend_env[@]}" \
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

if [[ -z "$CPU_ONLY" ]]; then
  echo "$health" | grep -q '"physics_backend":"physx_gpu"' \
    || fail "GPU physics not active -- driver injection or CUDA is broken"
  pass "PhysX GPU validated inside the container"
fi

echo "[smoke] 5. advertises the external endpoint"
session="$(curl -fsS --max-time 3 "http://127.0.0.1:$HTTP_PORT/session-config?match_id=smoke")"
echo "$session" | grep -q "https://$PUBLIC_IP:$EXTERNAL_UDP_PORT/game" \
  || fail "wrong advertised endpoint: $session"
pass "advertises https://$PUBLIC_IP:$EXTERNAL_UDP_PORT/game"

echo "$session" | grep -qE '"server_certificate_hash_hex":"[a-f0-9]{64}"' \
  || fail "no usable certificate hash published"
pass "published a 64-hex certificate hash for pinning"

if [[ -z "$CPU_ONLY" ]]; then
  echo "[smoke] 6. reports the driver it was given"
  docker exec "$NAME" nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null \
    | head -1 | sed 's/^/  gpu: /' || echo "  (nvidia-smi unavailable; compute still validated above)"
fi

echo
if [[ -n "$CPU_ONLY" ]]; then
  echo "[smoke] PASS -- $IMAGE is well-formed; run without --cpu on a GPU host to clear it for deploy"
else
  echo "[smoke] PASS -- $IMAGE is fit to deploy"
fi
