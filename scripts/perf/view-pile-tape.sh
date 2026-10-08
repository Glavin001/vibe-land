#!/bin/bash
# Open a recorded pile tape (scripts/perf/record-pile-tape.sh) in /cityreplay
# without a game server or the GPU:
#
#   scripts/perf/view-pile-tape.sh <tapeDir>
#
# Serves the city manifest the recorder saved (manifest-<hash>.bin) on
# :$STUB_PORT in place of the server's /city-manifest route, runs this
# worktree's vite on :$CLIENT_PORT against it, and prints the replay URL. The
# tape is served by vite from disk (/@fs/...). Ctrl-C stops both.
set -u
WT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$(cd "${1:?tapeDir}" && pwd)
STUB_PORT=${STUB_PORT:-4521}; CLIENT_PORT=${CLIENT_PORT:-3523}
[ -f "$DIR/tape.vltape" ] || { echo "no $DIR/tape.vltape" >&2; exit 1; }
ls "$DIR"/manifest-*.bin >/dev/null 2>&1 || { echo "no manifest-*.bin in $DIR" >&2; exit 1; }

python3 - "$DIR" "$STUB_PORT" > "$DIR/view-stub.log" 2>&1 <<'EOF' &
import http.server, os, sys
root, port = sys.argv[1], int(sys.argv[2])
class Stub(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        if path.startswith('/city-manifest/'):
            f = os.path.join(root, 'manifest-' + os.path.basename(path) + '.bin')
            if os.path.isfile(f):
                body = open(f, 'rb').read()
                self.send_response(200)
                self.send_header('content-type', 'application/octet-stream')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        self.send_response(404); self.send_header('content-length', '0'); self.end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', port), Stub).serve_forever()
EOF
STUB=$!
(cd "$WT/client" && CLIENT_PORT=$CLIENT_PORT SERVER_PORT=$STUB_PORT SERVER_HOST=127.0.0.1 \
  VITE_CACHE_DIR=$WT/target/vite-cache-view \
  exec npx vite --config e2e/city-bench/vite.bench.config.ts --port "$CLIENT_PORT" --strictPort) \
  > "$DIR/view-vite.log" 2>&1 &
VITE=$!
trap 'kill $STUB $VITE 2>/dev/null; pkill -P $VITE 2>/dev/null' EXIT INT TERM
for _ in $(seq 1 90); do curl -s -m 2 "http://localhost:$CLIENT_PORT/" >/dev/null && break; sleep 1; done
echo "http://localhost:$CLIENT_PORT/cityreplay?src=/@fs$DIR/tape.vltape"
echo "drag to look, WASD/QE to fly (shift faster), space pause, arrows scrub, R rewind; Ctrl-C to stop"
wait $VITE
