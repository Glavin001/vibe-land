#!/usr/bin/env bash
#
# A/B the city pose wires on one identical collapse.
#
# v3 shipped and broke visibly where v2 did not, and the only way that was ever
# established was running the same spec on both and comparing numbers. This
# makes that a command instead of an afternoon: it restarts the server on each
# wire, drives the same scripted collapse, and prints the two results side by
# side.
#
# The gate for putting v3 back on live is simple: every column must be at least
# as good as v2's.
#
# Usage:
#   scripts/city-wire-ab.sh            # v2 then v3, one run each
#   RUNS=3 scripts/city-wire-ab.sh     # three runs per wire (variance is real)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNS="${RUNS:-1}"
BASE_URL="${E2E_BASE_URL:-https://127.0.0.1:6006}"
STATS_URL="${STATS_URL:-http://127.0.0.1:4003}"
OUT="${OUT:-/tmp/city-wire-ab.jsonl}"
: > "$OUT"

start_server() {
  local wire="$1"
  echo "--- restarting server on wire v${wire}" >&2
  if [[ "$wire" == "3" ]]; then
    SKIP_SPACETIMEDB_VERIFY=1 VIBE_CITY_WIRE=3 VIBE_CITY_STRESS_LIMIT_SCALE=0.6 \
      VIBE_CITY_POSE_CENSUS=1 VIBE_PHYSX_PROFILE_FETCH=1 \
      bash "$REPO_ROOT/scripts/run-city-server.sh" --release >/dev/null 2>&1
  else
    SKIP_SPACETIMEDB_VERIFY=1 VIBE_CITY_STRESS_LIMIT_SCALE=0.6 \
      VIBE_CITY_POSE_CENSUS=1 VIBE_PHYSX_PROFILE_FETCH=1 \
      bash "$REPO_ROOT/scripts/run-city-server.sh" --release >/dev/null 2>&1
  fi
  until curl -sf "$STATS_URL/healthz" >/dev/null 2>&1; do sleep 2; done
  # The wire is chosen per match at creation, so the match must be built after
  # the restart -- confirm what the server actually ended up speaking.
  sleep 3
}

run_wire() {
  local wire="$1"
  start_server "$wire"
  for ((i = 1; i <= RUNS; i++)); do
    curl -sk -o /dev/null -X POST "$BASE_URL/city-reset/city-default" || true
    sleep 7
    ( cd "$REPO_ROOT/client" && \
      xvfb-run -a --server-args="-screen 0 1600x1000x24" \
      env E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL="$BASE_URL" \
      npx playwright test --config e2e/playwright.config.ts city-fracture-continuity --headed 2>&1 \
    ) | grep -oE '\[cont-json\] .*' | sed 's/\[cont-json\] //' >> "$OUT" || true
  done
}

run_wire 2
run_wire 3

python3 - "$OUT" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
if not rows:
    print('no results -- did the spec run?'); sys.exit(1)
keys = ['bonds', 'worstJumpM', 'worstDrawnM', 'framesDrawnOff', 'framesJumping',
        'belowWorld', 'hidden', 'unplaced', 'orphans', 'orphanedByRetire',
        'bootstraps', 'settleRejects', 'topoGaps']
by = {}
for r in rows:
    by.setdefault(r['wire'], []).append(r)
print(f"{'metric':>16} " + ' '.join(f'{"wire "+str(w):>12}' for w in sorted(by)))
for k in keys:
    cells = []
    for w in sorted(by):
        vals = [r.get(k, 0) for r in by[w]]
        worst = max(vals)
        cells.append(f'{worst:>12}')
    print(f'{k:>16} ' + ' '.join(cells))
print()
print('worst-of-runs per wire. v3 must be <= v2 on every row before it goes live.')
PY
