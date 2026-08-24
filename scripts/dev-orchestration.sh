#!/usr/bin/env bash
# Run the whole orchestration stack locally: mock marketplace, control plane,
# and a real GPU game server on this box.
#
# The point is to exercise the actual control plane against the actual game
# server -- only the Vast marketplace is faked, and only because renting a real
# box for every test run is slow and costs money.
#
#   ./scripts/dev-orchestration.sh up      start everything, wait for READY
#   ./scripts/dev-orchestration.sh down    stop everything
#   ./scripts/dev-orchestration.sh status  show the fleet
#   ./scripts/dev-orchestration.sh logs    tail all three logs
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_PLANE_DIR="$REPO_ROOT/control-plane"
LOG_DIR="${VIBE_ORCH_LOG_DIR:-/tmp/vibe-orchestration}"
PID_DIR="$LOG_DIR/pids"

# Ports. The game server's internal ports are the ones the container declares;
# on this Vast box they are already mapped to public external ports.
MOCK_VAST_PORT="${MOCK_VAST_PORT:-5175}"
CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-9001}"
GAME_HTTP_PORT="${GAME_HTTP_PORT:-4001}"
GAME_UDP_PORT="${GAME_UDP_PORT:-4433}"

HEARTBEAT_TOKEN="${HEARTBEAT_TOKEN:-dev-heartbeat-token}"
ADMIN_TOKEN="${ADMIN_TOKEN:-dev-admin-token}"

# Vast injects the external mapping for each declared internal port, but only
# into the container's init environment -- an SSH or agent shell does not
# inherit it. Recover it from PID 1 so this script advertises the address a
# browser can actually reach, which is what the entrypoint does in production.
load_vast_env() {
  [[ -r /proc/1/environ ]] || return 0
  local line
  while IFS= read -r -d '' line; do
    case "$line" in
      VAST_UDP_PORT_*|VAST_TCP_PORT_*|PUBLIC_IPADDR=*)
        # Only fill gaps: a value already exported wins, so callers can override.
        local key="${line%%=*}"
        [[ -n "${!key:-}" ]] || export "$line"
        ;;
    esac
  done < /proc/1/environ
}
load_vast_env

udp_var="VAST_UDP_PORT_${GAME_UDP_PORT}"
EXTERNAL_UDP_PORT="${!udp_var:-$GAME_UDP_PORT}"
PUBLIC_IP="${PUBLIC_IPADDR:-127.0.0.1}"

mkdir -p "$LOG_DIR" "$PID_DIR"

# Each process gets its own session so the whole tree can be signalled. wrangler
# spawns workerd as a grandchild; killing only the direct child leaves workerd
# holding the port, and the next `up` then fails to bind.
start_process() {
  local name="$1"; shift
  local pidfile="$PID_DIR/$name.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "[orch] $name already running (pid $(cat "$pidfile"))"
    return
  fi
  echo "[orch] starting $name -> $LOG_DIR/$name.log"
  setsid "$@" >>"$LOG_DIR/$name.log" 2>&1 &
  echo $! >"$pidfile"
}

stop_process() {
  local name="$1"
  local pidfile="$PID_DIR/$name.pid"
  [[ -f "$pidfile" ]] || return 0
  local pid; pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    echo "[orch] stopping $name (pid $pid)"
    # Negative pid = the whole process group created by setsid.
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

wait_for_http() {
  local url="$1" label="$2" attempts="${3:-60}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      echo "[orch] $label is up"
      return 0
    fi
    sleep 1
  done
  echo "[orch] ERROR: $label never came up ($url)" >&2
  return 1
}

cmd_up() {
  if [[ ! -f "$CONTROL_PLANE_DIR/.dev.vars" ]]; then
    echo "[orch] writing $CONTROL_PLANE_DIR/.dev.vars"
    cat >"$CONTROL_PLANE_DIR/.dev.vars" <<EOF
VAST_API_KEY=dev-vast-key
HEARTBEAT_TOKEN=$HEARTBEAT_TOKEN
ADMIN_TOKEN=$ADMIN_TOKEN
VAST_API_BASE=http://127.0.0.1:$MOCK_VAST_PORT
CONTROL_PLANE_URL=http://127.0.0.1:$CONTROL_PLANE_PORT
EOF
  fi

  start_process mock-vast \
    node "$CONTROL_PLANE_DIR/mock-vast/server.mjs" --port "$MOCK_VAST_PORT" --local-box

  start_process control-plane \
    "$CONTROL_PLANE_DIR/node_modules/.bin/wrangler" dev \
      --config "$CONTROL_PLANE_DIR/wrangler.jsonc" \
      --port "$CONTROL_PLANE_PORT" --ip 0.0.0.0
  wait_for_http "http://127.0.0.1:$CONTROL_PLANE_PORT/healthz" "control plane" 90

  # Asking to play is what provisions a box: with an empty fleet this is the
  # request that makes the control plane go shopping.
  echo "[orch] requesting a server via /join"
  curl -fsS "http://127.0.0.1:$CONTROL_PLANE_PORT/join" | tee "$LOG_DIR/join-1.json"; echo

  echo "[orch] waiting for the fleet to rent a box..."
  local server_do_id=""
  for _ in $(seq 1 30); do
    server_do_id="$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
      "http://127.0.0.1:$CONTROL_PLANE_PORT/fleet" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=JSON.parse(s);const r=(f.servers||[]).find(x=>x.phase!=="DEAD");process.stdout.write(r?r.serverDoId:"")})')"
    [[ -n "$server_do_id" ]] && break
    sleep 1
  done
  if [[ -z "$server_do_id" ]]; then
    echo "[orch] ERROR: control plane never registered a server" >&2
    exit 1
  fi
  echo "[orch] fleet allocated server $server_do_id"

  # In production this env arrives from the control plane through the Vast
  # create-instance call, and the entrypoint resolves the port mapping. Here the
  # server runs natively, so the script plays the entrypoint's part.
  local binary="$REPO_ROOT/target/release/web-fps-server"
  if [[ ! -x "$binary" ]]; then
    echo "[orch] ERROR: $binary missing -- run:" >&2
    echo "  cargo build --release -p web-fps-server --features destruction" >&2
    exit 1
  fi

  start_process game-server env \
    CONTROL_PLANE_URL="http://127.0.0.1:$CONTROL_PLANE_PORT" \
    SERVER_DO_ID="$server_do_id" \
    HEARTBEAT_TOKEN="$HEARTBEAT_TOKEN" \
    HEARTBEAT_PUBLIC_IP="$PUBLIC_IP" \
    HEARTBEAT_UDP_PORT="$EXTERNAL_UDP_PORT" \
    MATCHES_PER_BOX=6 \
    BIND_ADDR="0.0.0.0:$GAME_HTTP_PORT" \
    WT_BIND_ADDR="0.0.0.0:$GAME_UDP_PORT" \
    WT_PUBLIC_URL="https://$PUBLIC_IP:$EXTERNAL_UDP_PORT" \
    WT_CERT_PEM="${WT_CERT_PEM:-$REPO_ROOT/.certs/orch-cert.pem}" \
    WT_KEY_PEM="${WT_KEY_PEM:-$REPO_ROOT/.certs/orch-key.pem}" \
    VIBE_PHYSICS_BACKEND="${VIBE_PHYSICS_BACKEND:-physx_gpu}" \
    WT_STRICT_SNAPSHOT_DATAGRAMS=1 \
    VIBE_CITY_SCENE="${VIBE_CITY_SCENE:-high-rise-3f-local.json}" \
    VIBE_CITY_GRID="${VIBE_CITY_GRID:-2}" \
    LD_LIBRARY_PATH="${PHYSX_ROOT:-/root/PhysX/physx/install/linux-clang/PhysX}/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}" \
    RUST_LOG="${RUST_LOG:-info}" \
    "$binary"

  wait_for_http "http://127.0.0.1:$GAME_HTTP_PORT/healthz" "game server" 120

  echo "[orch] waiting for the first heartbeat to promote it to READY..."
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$CONTROL_PLANE_PORT/join" | grep -q '"ready":true'; then
      echo "[orch] READY"
      cmd_status
      echo
      # `?controlPlane=/cp` goes through the dev server's proxy. The dev server
      # runs HTTPS when WebTransport certs are set, and an https page may not
      # fetch an http control plane -- the browser blocks it as mixed content.
      local client_port="${VAST_TCP_PORT_9000:-${CLIENT_PORT:-5555}}"
      if [[ "$PUBLIC_IP" == 127.* || "$PUBLIC_IP" == localhost ]]; then
        # Loopback is right for headless checks on this box and useless from any
        # other device: the address is handed to the browser verbatim, so a phone
        # would dial itself, fail, and land back on the join screen looking as if
        # the page had reloaded.
        echo "[orch] WARNING: advertising $PUBLIC_IP — reachable only from this machine."
        echo "[orch]          Re-run without PUBLIC_IPADDR set to serve real devices."
      fi
      echo "[orch] play at: https://$PUBLIC_IP:${client_port}/city?controlPlane=/cp"
      echo "[orch]   (plain-HTTP dev server? use ?controlPlane=http://127.0.0.1:$CONTROL_PLANE_PORT)"
      return 0
    fi
    sleep 2
  done
  echo "[orch] ERROR: server never reached READY -- see $LOG_DIR/game-server.log" >&2
  exit 1
}

cmd_down() {
  stop_process game-server
  stop_process control-plane
  stop_process mock-vast
  echo "[orch] stopped"
}

cmd_status() {
  echo "--- /join ---"
  curl -fsS "http://127.0.0.1:$CONTROL_PLANE_PORT/join" || true; echo
  echo "--- /fleet ---"
  curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
    "http://127.0.0.1:$CONTROL_PLANE_PORT/fleet" || true; echo
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  logs) tail -n 40 -f "$LOG_DIR"/*.log ;;
  *) echo "usage: $0 {up|down|status|logs}" >&2; exit 1 ;;
esac
