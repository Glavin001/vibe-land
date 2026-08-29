#!/usr/bin/env bash
# Automated performance suite for the fractured downtown scene.
#
# Scenarios cover the two regimes that cost differently: a city sitting still
# (scene load + idle, where the win is that untouched structures cost nothing)
# and a city being taken apart at several rates (where the solver, the contact
# drain and the fracture path all scale with damage, not with wall time).
#
# Two modes:
#   report            one run per scenario, prints a markdown table
#   ab --a E --b E    interleaved paired A/B with a sign test
#
# The A/B mode interleaves A,B,A,B rather than running all of A then all of B.
# On this shared box a co-tenant arriving halfway through a batch reads as a
# regression; interleaving makes drift hit both arms and paired differencing
# removes most of what is left. Taking more samples does not fix that -- it
# averages the contamination in.
#
# Usage:
#   scripts/perf/scene-suite.sh report
#   scripts/perf/scene-suite.sh ab --reps 6 --a "" --b "BLAST_BOND_STRESS_GPU=0"
#   scripts/perf/scene-suite.sh ab --reps 6 --only idle --a "" --b "..."
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
bin="$root/target/release/record-city-trace"
out="${SUITE_OUT:-/tmp/scene-suite}"
scene="${SUITE_SCENE:-fractured-downtown.json}"

# name : grid : seconds : shots : shot-interval-ticks
#
# `idle` is the control and the most valuable single scenario: with no shots
# the sim is BIT-DETERMINISTIC run to run (measured), so its comparison is
# exact rather than statistical. Every bombard rate below it is chaotic and
# must be judged on medians plus the work check.
SCENARIOS=(
  "idle:2:10:0:0"
  "bombard-slow:2:20:12:30"
  "bombard-med:2:20:28:14"
  "bombard-fast:2:20:56:6"
)

[ -x "$bin" ] || { echo "missing $bin -- build with:
  cargo build --release -p web-fps-server --bin record-city-trace --features destruction,cuda-stress" >&2; exit 1; }

run_one() { # $1=scenario spec  $2=env string  $3=output csv
  local spec="$1" envs="$2" csv="$3"
  IFS=: read -r name grid secs shots interval <<< "$spec"
  local extra=()
  [ "$interval" != "0" ] && extra+=(--shot-interval-ticks "$interval")
  # Fixed shot plan: adaptive aim re-picks targets from live geometry, so two
  # arms would be aimed differently and would not be comparable.
  # shellcheck disable=SC2086
  env $envs \
    VIBE_TRACE_ADAPTIVE_AIM=0 \
    VIBE_CITY_SCENE="$scene" \
    "$bin" --grid "$grid" --seconds "$secs" --shots "$shots" \
      --output "$out/trace.tmp" --metrics-out "$csv" "${extra[@]}" \
      >"${csv%.csv}.log" 2>&1
}

mode="${1:-report}"; shift || true
mkdir -p "$out"

case "$mode" in
report)
  args=()
  for spec in "${SCENARIOS[@]}"; do
    name="${spec%%:*}"
    echo "running $name ..." >&2
    run_one "$spec" "" "$out/$name.csv"
    args+=("$name=$out/$name.csv")
  done
  echo
  echo "## fractured-downtown suite — $(cd "$root" && git rev-parse --short HEAD)"
  echo
  python3 "$here/scene-suite.py" report "${args[@]}"
  ;;
ab)
  reps=5; arm_a=""; arm_b=""; only=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --reps) reps="$2"; shift 2 ;;
      --a) arm_a="$2"; shift 2 ;;
      --b) arm_b="$2"; shift 2 ;;
      --only) only="$2"; shift 2 ;;
      *) echo "unknown arg $1" >&2; exit 2 ;;
    esac
  done
  for spec in "${SCENARIOS[@]}"; do
    name="${spec%%:*}"
    [ -n "$only" ] && [ "$name" != "$only" ] && continue
    echo
    echo "=== $name : A=[${arm_a:-baseline}] vs B=[${arm_b:-baseline}] , $reps pairs ==="
    a_files=(); b_files=()
    for i in $(seq 1 "$reps"); do
      run_one "$spec" "$arm_a" "$out/${name}_a$i.csv"; a_files+=("$out/${name}_a$i.csv")
      run_one "$spec" "$arm_b" "$out/${name}_b$i.csv"; b_files+=("$out/${name}_b$i.csv")
      printf '.' >&2
    done
    echo >&2
    python3 "$here/scene-suite.py" ab "${a_files[@]}" -- "${b_files[@]}"
  done
  ;;
*) echo "usage: scene-suite.sh report | ab --a ENV --b ENV [--reps N] [--only NAME]" >&2; exit 2 ;;
esac
