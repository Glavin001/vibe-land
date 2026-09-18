#!/usr/bin/env bash
# Drive a QA scenario against the real native-destruction city.
#
# Wraps the cargo incantation so a scenario is the only thing you have to
# think about. The runner uses production's own entry points -- the same
# player tick, shot routing and arena step the server runs -- so a pass here
# means the thing works, not that a test harness agrees with itself.
#
#   scripts/qa.sh scenarios/impact.qa            # run a script file
#   scripts/qa.sh -e 'look 0 0; probe; report'   # inline, ';' separates lines
#
# Environment worth knowing:
#   VIBE_CITY_SCENE   default fractured-downtown.json
#   VIBE_CITY_GRID    default 1
#   PHYSX_DESTRUCTION_SDK  default the converge SDK
#
# Commands (see server/src/city_qa.rs):
#   walk <ticks> <forward> <strafe>   move, -1..1 each
#   look <yaw> <pitch>                absolute radians
#   aim <structure> <node>            face a chunk by identity
#   verify-aim <structure> <node>     fail unless a ray reaches THAT chunk
#   probe                             name whichever chunk the aim reaches
#   fire rifle|ball
#   wait <ticks>
#   expect-detached <structure> <node>
#   expect-bonds <n>
#   report
set -euo pipefail
cd "$(dirname "$0")/.."

export PHYSX_DESTRUCTION_SDK="${PHYSX_DESTRUCTION_SDK:-/root/workspace/physx-2/out/sdk-converge}"
export CUDA_HOME="${CUDA_HOME:-/usr/local/cuda-12.8}"
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:$PHYSX_DESTRUCTION_SDK/bin/linux.x86_64/release${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export VIBE_CITY_SCENE="${VIBE_CITY_SCENE:-fractured-downtown.json}"
export VIBE_CITY_GRID="${VIBE_CITY_GRID:-1}"
export VIBE_PHYSX_PROFILE="${VIBE_PHYSX_PROFILE:-1}"

if [ "${1:-}" = "-e" ]; then
  [ $# -ge 2 ] || { echo "qa.sh -e needs a scenario" >&2; exit 2; }
  export VIBE_QA_STEPS="$2"
  unset VIBE_QA_SCRIPT || true
elif [ -n "${1:-}" ]; then
  [ -f "$1" ] || { echo "no such scenario: $1" >&2; exit 2; }
  export VIBE_QA_SCRIPT="$(realpath "$1")"
  unset VIBE_QA_STEPS || true
else
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

# The GPU is single-tenant here: a live server sharing it inflates every
# number by roughly 2.5x, which has produced wrong conclusions before.
if pgrep -f '[w]eb-fps-server-' >/dev/null 2>&1; then
  echo "warning: a city server is running and will share the GPU; timings will be inflated" >&2
fi

exec cargo test --release -p web-fps-server \
  --features cuda-stress,blast-core,native-destruction \
  -- --ignored --nocapture --test-threads=1 qa_scenario
