#!/usr/bin/env bash
# Run a full, PLAYABLE /city for ONE authored structure, on its own ports.
#
# /structure?pack=NAME already exists and is instant, but it is a STATIC
# viewer: it reads the pack, builds geometry and renders it. Nothing moves and
# nothing can be shot. To actually play a single building you need the whole
# stack -- match server, WebTransport listener, and a page served over HTTPS --
# pointed at that one scene.
#
# This box maps twelve TCP ports, but only ONE of them is actually free:
# 10100 and 10200 are held by unrelated node services, 8384 by the recordings
# server, 6006 by the shared skyline city, and VAST_TCP_PORT_72299 is not a
# valid port number at all. So this runs ONE single-structure city and makes
# switching which building it shows cheap -- about twenty seconds -- rather
# than pretending to offer four at once.
#
#   scripts/run-structure-city.sh park-432     # switch to 432 Park
#   scripts/run-structure-city.sh --status
#   scripts/run-structure-city.sh --stop
#
# Always at https://<ip>:40613/city  (page 1111 -> 40613, transport 4439 ->
# 40613: the same external number for both, which is why this slot was chosen).
#
# NOT scripts/run-city-server.sh. That script's stop_server does
# `pgrep -x web-fps-server`, which matches every checkout's server on this box
# -- including the shared skyline city on 40610 and another checkout's server
# on 40666. Killing those to restart a single-building preview would be a
# genuinely bad afternoon, so this binary is hardlinked to a distinct name and
# matched by that name alone.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_IP="${VIBE_PUBLIC_IP:-209.121.195.117}"
CADDY="${CADDY_BIN:-/opt/instance-tools/bin/caddy}"

HTTP_PORT=4103
PAGE_PORT=1111
WT_PORT=4439
PAGE_EXT=40613
WT_EXT=40613

stop_slot() {
  pkill -f "web-fps-server-structure$" 2>/dev/null
  pkill -f "structure-city.Caddyfile" 2>/dev/null
  rm -f /tmp/structure-city.pack
}

case "${1:-}" in
  --stop)
    stop_slot; echo "stopped"; exit 0 ;;
  --status)
    if pgrep -f "web-fps-server-structure$" >/dev/null 2>&1; then
      echo "showing $(cat /tmp/structure-city.pack 2>/dev/null || echo '?')"
      echo "  https://${PUBLIC_IP}:${PAGE_EXT}/city"
    else
      echo "not running"
    fi
    exit 0 ;;
esac

STRUCTURE="${1:?usage: run-structure-city.sh <structure>}"

SCENE="$REPO_ROOT/destruction/assets/scenes/${STRUCTURE}.json"
if [ ! -f "$SCENE" ]; then
  echo "no such pack: $SCENE" >&2
  echo "available:" >&2
  ls "$REPO_ROOT/destruction/assets/scenes/" | sed 's/\.json$//' | sed 's/^/  /' >&2
  exit 1
fi

stop_slot >/dev/null
BIN="$REPO_ROOT/target/release/web-fps-server-structure"
ln -f "$REPO_ROOT/target/release/web-fps-server" "$BIN" || {
  echo "build first: cargo build --release -p web-fps-server --features cuda-stress" >&2
  exit 1
}

CADDYFILE="/tmp/structure-city.Caddyfile"
cat > "$CADDYFILE" <<CADDY
{
	admin off
	auto_https off
}
:${PAGE_PORT} {
	tls ${REPO_ROOT}/.certs/page-cert.pem ${REPO_ROOT}/.certs/page-key.pem

	handle /session-config* {
		reverse_proxy 127.0.0.1:${HTTP_PORT}
	}
	handle /healthz* {
		reverse_proxy 127.0.0.1:${HTTP_PORT}
	}
	handle /match-stats/* {
		reverse_proxy 127.0.0.1:${HTTP_PORT}
	}
	handle /city-manifest/* {
		reverse_proxy 127.0.0.1:${HTTP_PORT}
	}
	handle /city-reset/* {
		reverse_proxy 127.0.0.1:${HTTP_PORT}
	}
	handle /ws/* {
		reverse_proxy 127.0.0.1:${HTTP_PORT}
	}

	header Cross-Origin-Opener-Policy "same-origin"
	header Cross-Origin-Embedder-Policy "require-corp"

	handle {
		root * ${REPO_ROOT}/client/dist
		try_files {path} /index.html
		file_server
	}
}
CADDY

export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}${LD_LIBRARY_PATH:+:}/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:/usr/local/cuda/lib64"
export VIBE_PHYSICS_BACKEND=physx_gpu
export BIND_ADDR="127.0.0.1:${HTTP_PORT}"
export WT_BIND_ADDR="0.0.0.0:${WT_PORT}"
export WT_PUBLIC_URL="https://${PUBLIC_IP}:${WT_EXT}"
export WT_CERT_PEM="$REPO_ROOT/.certs/page-cert.pem"
export WT_KEY_PEM="$REPO_ROOT/.certs/page-key.pem"
export WT_STRICT_SNAPSHOT_DATAGRAMS=1
export SKIP_SPACETIMEDB_VERIFY=1
export VIBE_CITY_SCENE="${STRUCTURE}.json"
# One building, unrotated, at its authored height: the point is to look at THIS
# structure, not a grid of copies of it.
export VIBE_CITY_GRID=1
export VIBE_CITY_VARIED_HEIGHTS=0
export VIBE_CITY_FREEZE=0
export VIBE_CITY_STRESS_LIMIT_SCALE=1.0
export RUST_LOG="${RUST_LOG:-warn}"

echo "$STRUCTURE" > /tmp/structure-city.pack
LOG="/tmp/structure-city.log"
: > "$LOG"
nohup "$BIN" >> "$LOG" 2>&1 &
nohup "$CADDY" run --config "$CADDYFILE" >> "$LOG" 2>&1 &

for _ in $(seq 1 40); do
  sleep 1
  if curl -s --max-time 2 "http://127.0.0.1:${HTTP_PORT}/healthz" | grep -q '"status"'; then
    echo "now showing: ${STRUCTURE}"
    echo "  https://${PUBLIC_IP}:${PAGE_EXT}/city"
    exit 0
  fi
done
echo "${STRUCTURE} did not come up; see $LOG" >&2
tail -5 "$LOG" >&2
exit 1
