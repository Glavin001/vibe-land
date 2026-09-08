#!/usr/bin/env bash
# Launch only this checkout; never stop another process or reuse occupied ports.
set -euo pipefail
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SDK=${PHYSX_DESTRUCTION_SDK:-/root/workspace/physx-2}
RUN=${VIBE_EMBEDDED_RUN_DIR:-/tmp/vibe-embedded-city}
BIN=${VIBE_EMBEDDED_BINARY:-$SDK/out/vibe-native/release/web-fps-server}
mkdir -p "$RUN"
[[ -x "$BIN" && -f "$REPO/client/dist/index.html" ]] || { echo 'Build the embedded server and client first.' >&2; exit 1; }
# Read only the public network configuration; never dump process environment.
eval "$(python3 - <<'PY'
import os,shlex
entries=dict(item.split('=',1) for item in open('/proc/1/environ','rb').read().decode().split('\0') if '=' in item)
for var,key in [('PUBLIC_IP','PUBLIC_IPADDR'),('PUBLIC_PAGE_PORT','VAST_TCP_PORT_8384'),('PUBLIC_WT_PORT','VAST_UDP_PORT_4435')]:
 value=entries[key]
 print(f'{var}={shlex.quote(value)}')
PY
)"
python3 - <<'PY'
import socket
for kind,host,port in [(socket.SOCK_STREAM,'0.0.0.0',8384),(socket.SOCK_STREAM,'127.0.0.1',4005),(socket.SOCK_DGRAM,'0.0.0.0',4435)]:
 s=socket.socket(socket.AF_INET,kind);s.bind((host,port));s.close()
PY
if [[ ! -f "$RUN/cert.pem" ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 13 \
    -subj "/CN=$PUBLIC_IP" -addext "subjectAltName=IP:$PUBLIC_IP,IP:127.0.0.1,DNS:localhost" \
    -keyout "$RUN/key.pem" -out "$RUN/cert.pem" > "$RUN/cert-generation.log" 2>&1
  chmod 600 "$RUN/key.pem"
fi
openssl x509 -in "$RUN/cert.pem" -checkend 3600 -noout
cd "$REPO"
export BIND_ADDR=127.0.0.1:4005 WEB_BIND_ADDR=0.0.0.0:8384 WT_BIND_ADDR=0.0.0.0:4435
export WT_PUBLIC_URL="https://$PUBLIC_IP:$PUBLIC_WT_PORT" WT_HOST="$PUBLIC_IP"
export WT_CERT_PEM="$RUN/cert.pem" WT_KEY_PEM="$RUN/key.pem" VIBE_WEB_DIR="$REPO/client/dist"
export VIBE_PHYSICS_BACKEND=physx_gpu VIBE_PHYSX_DIRECT_GPU=0 VIBE_CITY_FREEZE=0
export VIBE_CITY_SYNTHETIC=0 VIBE_CITY_BLAST_CORE=0 VIBE_CITY_RESIM_PASSES=1
export VIBE_CITY_SCENE=${VIBE_CITY_SCENE:-fractured-downtown.json}
export VIBE_CITY_GRID=${VIBE_CITY_GRID:-1} VIBE_CITY_VARIED_HEIGHTS=0
export VIBE_CITY_SOLVER_ITERATIONS=${VIBE_CITY_SOLVER_ITERATIONS:-8192}
export LD_LIBRARY_PATH="$SDK/physx/bin/linux.x86_64/release:/usr/local/cuda/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export RUST_LOG=${RUST_LOG:-info}
setsid "$BIN" > "$RUN/server.log" 2>&1 < /dev/null &
echo "$!" > "$RUN/server.pid"
curl --insecure --silent --show-error --fail --retry-connrefused --retry 10 --retry-delay 1 \
    https://127.0.0.1:8384/healthz > "$RUN/health.json"
python3 - "$RUN/health.json" <<'PYCODE'
import json,sys
health=json.load(open(sys.argv[1]))
assert health['destruction_backend']=='physx_embedded_cuda', 'Wrong server binary: embedded backend required'
PYCODE
printf 'https://%s:%s/city?portal=true&match=city-default\n' "$PUBLIC_IP" "$PUBLIC_PAGE_PORT" | tee "$RUN/public-url.txt"
printf 'PID %s; log %s/server.log\n' "$(cat "$RUN/server.pid")" "$RUN"
