#!/usr/bin/env bash
# Exercise the container entrypoint without a container.
#
# Docker cannot run on every box we develop on (a Vast instance is itself a
# container, with no privileges to nest another), but the entrypoint is where
# the risky logic lives: port discovery, certificate shape, and the address the
# server advertises. All of that is testable natively, and all of it is what
# breaks a fleet in ways unit tests cannot see.
#
#   ./scripts/smoke-entrypoint.sh [bundle-dir]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="${1:-/tmp/physx-server-smoke}"
HTTP_PORT="${SMOKE_HTTP_PORT:-4009}"
UDP_PORT="${SMOKE_UDP_PORT:-4439}"
EXTERNAL_UDP_PORT="${SMOKE_EXTERNAL_UDP_PORT:-40613}"
STANDALONE_HTTP_PORT="${SMOKE_STANDALONE_HTTP_PORT:-4010}"
STANDALONE_UDP_PORT="${SMOKE_STANDALONE_UDP_PORT:-4440}"
PUBLIC_IP="${SMOKE_PUBLIC_IP:-203.0.113.77}"
LOG="/tmp/vibe-entrypoint-smoke.log"

pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }

cleanup() {
  [[ -n "${server_pid:-}" ]] && kill -TERM "-$server_pid" 2>/dev/null || true
  [[ -n "${standalone_pid:-}" ]] && kill -TERM "-$standalone_pid" 2>/dev/null || true
  return 0
}
trap cleanup EXIT

if [[ ! -d "$BUNDLE" ]]; then
  echo "[smoke] packaging bundle into $BUNDLE"
  bash "$REPO_ROOT/scripts/package-physx-server.sh" "$BUNDLE" >/dev/null
fi

echo "[smoke] 1. on Vast, refuses to start without a UDP port mapping"
# VAST_CONTAINERLABEL stands in for the family of variables a real instance
# gets: it is how the entrypoint tells "the mapping is missing" (fatal, the box
# can never serve players) from "there is no mapping to look for" (standalone).
set +e
SERVER_ROOT="$BUNDLE" PUBLIC_IPADDR="$PUBLIC_IP" WT_BIND_ADDR="0.0.0.0:$UDP_PORT" \
  VAST_CONTAINERLABEL="C.smoke" \
  bash "$REPO_ROOT/docker/entrypoint.sh" >/dev/null 2>&1
code=$?
set -e
[[ $code -eq 78 ]] || fail "expected exit 78 without a port mapping, got $code"
pass "exits $code so the control plane replaces the host"

echo "[smoke] 2. off Vast, publishes the container port instead of refusing"
# The plain `docker run -p 4433:4433/udp` case. Nothing maps the port, so the
# advertised port must be the container's own -- and the server must actually
# come up, since this is the path a user following the README takes.
rm -f "$LOG"
setsid env \
  SERVER_ROOT="$BUNDLE" \
  CERT_DIR="/tmp/vibe-entrypoint-certs-standalone" \
  PUBLIC_IPADDR="$PUBLIC_IP" \
  BIND_ADDR="127.0.0.1:$STANDALONE_HTTP_PORT" \
  WT_BIND_ADDR="0.0.0.0:$STANDALONE_UDP_PORT" \
  MATCHES_PER_BOX=1 \
  RUST_LOG=info \
  bash "$REPO_ROOT/docker/entrypoint.sh" >"$LOG" 2>&1 &
standalone_pid=$!

for _ in $(seq 1 90); do
  curl -fsS --max-time 2 "http://127.0.0.1:$STANDALONE_HTTP_PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 3 "http://127.0.0.1:$STANDALONE_HTTP_PORT/healthz" >/dev/null 2>&1 \
  || { tail -25 "$LOG"; fail "standalone server never became healthy"; }

standalone_session="$(curl -fsS --max-time 3 \
  "http://127.0.0.1:$STANDALONE_HTTP_PORT/session-config?match_id=smoke")"
echo "$standalone_session" | grep -q "https://$PUBLIC_IP:$STANDALONE_UDP_PORT/game" \
  || fail "standalone advertised the wrong endpoint: $standalone_session"
pass "advertises https://$PUBLIC_IP:$STANDALONE_UDP_PORT/game with no orchestrator"

kill -TERM "-$standalone_pid" 2>/dev/null || true
standalone_pid=""

echo "[smoke] 3. boots with a Vast-style environment"
rm -f "$LOG"
setsid env \
  SERVER_ROOT="$BUNDLE" \
  CERT_DIR="/tmp/vibe-entrypoint-certs" \
  PUBLIC_IPADDR="$PUBLIC_IP" \
  "VAST_UDP_PORT_${UDP_PORT}=$EXTERNAL_UDP_PORT" \
  BIND_ADDR="127.0.0.1:$HTTP_PORT" \
  WT_BIND_ADDR="0.0.0.0:$UDP_PORT" \
  MATCHES_PER_BOX=4 \
  RUST_LOG=info \
  bash "$REPO_ROOT/docker/entrypoint.sh" >"$LOG" 2>&1 &
server_pid=$!

for _ in $(seq 1 90); do
  curl -fsS --max-time 2 "http://127.0.0.1:$HTTP_PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
health="$(curl -fsS --max-time 3 "http://127.0.0.1:$HTTP_PORT/healthz" || true)"
[[ -n "$health" ]] || { tail -25 "$LOG"; fail "server never became healthy"; }
pass "healthz responded: $health"

echo "$health" | grep -q '"physics_backend":"physx_gpu"' \
  || fail "expected the physx_gpu backend, got: $health"
pass "running the GPU physics backend"

echo "[smoke] 4. certificate matches what browsers will accept"
cert="/tmp/vibe-entrypoint-certs/cert.pem"
[[ -f "$cert" ]] || fail "entrypoint did not mint a certificate"
openssl x509 -in "$cert" -noout -text | grep -q "id-ecPublicKey" \
  || fail "certificate is not ECDSA (RSA is rejected by serverCertificateHashes)"
pass "ECDSA key"
openssl x509 -in "$cert" -noout -text | grep -q "prime256v1" \
  || fail "certificate is not on the P-256 curve"
pass "P-256 curve"
openssl x509 -in "$cert" -noout -text | grep -q "IP Address:$PUBLIC_IP" \
  || fail "certificate SAN does not cover the public IP"
pass "SAN covers IP:$PUBLIC_IP"

not_after="$(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2)"
days_left=$(( ( $(date -d "$not_after" +%s) - $(date +%s) ) / 86400 ))
[[ $days_left -lt 14 ]] || fail "certificate lives ${days_left}d; browsers reject anything over 14"
pass "expires in ${days_left}d (under the 14-day limit)"

echo "[smoke] 5. advertises the externally reachable address"
session="$(curl -fsS --max-time 3 "http://127.0.0.1:$HTTP_PORT/session-config?match_id=smoke")"
echo "$session" | grep -q "https://$PUBLIC_IP:$EXTERNAL_UDP_PORT/game" \
  || fail "advertised the wrong endpoint: $session"
pass "advertises https://$PUBLIC_IP:$EXTERNAL_UDP_PORT/game (not the container port $UDP_PORT)"

served_hash="$(echo "$session" | sed -n 's/.*"server_certificate_hash_hex":"\([a-f0-9]*\)".*/\1/p')"
cert_hash="$(openssl x509 -in "$cert" -outform der | openssl dgst -sha256 -hex | awk '{print $2}')"
[[ "$served_hash" == "$cert_hash" ]] \
  || fail "published hash $served_hash does not match the served certificate $cert_hash"
pass "published hash matches the certificate on the wire"

echo
echo "[smoke] PASS -- the container contract holds"
