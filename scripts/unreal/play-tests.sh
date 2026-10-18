#!/usr/bin/env bash
# The Unreal client's automation tests against a live vibe-land server, each in its own game
# process (a fresh player: a car left driven would leak into the next), all on one match whose city
# is reset before each test (a fresh city without a new match: every match keeps a GPU-simulated
# city alive, and many starve the server).
#
#   scripts/unreal/play-tests.sh [--api http://127.0.0.1:4001] [--match citypp-fork] [--only Name,...] [--shots DIR]
#
# Needs a server with citypp matches: the PhysX city server (scripts/perf/garage-vehicle-server.sh)
# for every test; the synthetic server (VIBE_CITY_SYNTHETIC=1) has no colliders, cars or meteors.
# Builds first (scripts/unreal/build-editor.sh). Exit status: the number of failed tests.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API="http://127.0.0.1:4001"
ONLY=""
SHOTS=""
MATCH="citypp-fork"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) API="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --match) MATCH="$2"; shift 2 ;;
    --shots) SHOTS="$2"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "play-tests: unknown argument $1" >&2; exit 2 ;;
  esac
done

TESTS=(VibeCity.Cursor VibeCity.Play.WalkAndShoot VibeCity.Play.AimAndReset VibeCity.Play.CannonAndMeteor
  VibeCity.Play.AerialAndMelee VibeCity.Play.Drive VibeCity.Play.WreckCar VibeCity.Render.CityAndEffects
  VibeCity.Render.WeatherAndGrass VibeCity.Render.Species VibeCity.Render.Materials VibeCity.Settings VibeCity.Play.Hud VibeCity.Render.Ragdoll VibeCity.Render.ImportedCity VibeCity.Render.Dust VibeCity.Gamepad)
if [[ -n "$ONLY" ]]; then
  IFS=',' read -r -a TESTS <<< "$ONLY"
fi

UE_ROOT="${UE_ROOT:-/Users/Shared/Epic Games/UE_5.8}"
EDITOR="$UE_ROOT/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor"
LOGS="$ROOT/target/unreal-tests/$MATCH" # per match: sessions running this side by side keep apart
mkdir -p "$LOGS"
curl -fs -m 5 "$API/healthz" > /dev/null || { echo "play-tests: no server at $API" >&2; exit 2; }
"$ROOT/scripts/unreal/build-editor.sh" > "$LOGS/build.log" 2>&1 || { echo "play-tests: build failed; see $LOGS/build.log" >&2; exit 2; }

failed=0
for test in "${TESTS[@]}"; do
  name="${test##*.}"
  curl -fs -m 5 -X POST "$API/city-reset/$MATCH" > /dev/null || true
  log="$LOGS/$name.log"
  args=(-game -windowed -ResX=1280 -ResY=720 "-VibeApi=$API" "-VibeMatch=$MATCH"
    -VibeFreshSettings "-ExecCmds=Automation RunTests $test; Quit" "-TestExit=Automation Test Queue Empty" "-abslog=$log")
  [[ -n "$SHOTS" ]] && args+=("-VibeShotDir=$SHOTS")
  # VIBE_UE_ARGS: more game arguments, word-split (e.g. -dpcvars=... to try renderer settings).
  [[ -n "${VIBE_UE_ARGS:-}" ]] && read -r -a extra <<< "$VIBE_UE_ARGS" && args+=("${extra[@]}")
  # The tests that time the server's input handling run with standard lighting: on one machine the
  # server's PhysX shares the GPU with the game, and Lumen with virtual shadows slows its tick (141
  # instead of 174 ticks over the same 180 input frames), which they would read as the server's.
  case "$name" in
    WalkAndShoot|AerialAndMelee) args+=("-dpcvars=r.DynamicGlobalIlluminationMethod=0,r.ReflectionMethod=2,r.Shadow.Virtual.Enable=0" -VibeNoVolumetrics) ;;
  esac
  for attempt in 1 2 3; do
    rm -f "$log" # read only this launch's log
    "$EDITOR" "$ROOT/unreal/VibeCity/VibeCity.uproject" "${args[@]}" > /dev/null 2>&1 &
    pid=$!
    # A test that hangs is stopped after five minutes; a game that finds a module "incompatible"
    # (seen right after a build, while another build of the project is linking) waits on a
    # rebuild dialog, so it is stopped at once and launched again.
    for _ in $(seq 1 100); do
      kill -0 "$pid" 2>/dev/null || break
      grep -q "Incompatible or missing module" "$log" 2>/dev/null && break
      sleep 3
    done
    # SIGTERM starts Unreal's graceful exit, which can hang (and keep the GPU): SIGKILL after 20 s.
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null
    grep -q "Incompatible or missing module" "$log" 2>/dev/null || break
    echo "      ($test: a module was not loadable; launching again in 60 s)"
    sleep 60
  done
  if grep -q "Result={Success}" "$log" 2>/dev/null; then
    echo "pass  $test"
  else
    failed=$((failed + 1))
    echo "FAIL  $test  ($log)"
    grep -E "LogAutomationController: Error: " "$log" 2>/dev/null | grep -v "Test Completed" | sed 's/.*Error: /        /' | head -5
  fi
done
echo "play-tests: $(( ${#TESTS[@]} - failed )) passed, $failed failed"
exit "$failed"
