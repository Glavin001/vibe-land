#!/bin/bash
# The scenario matrix (docs/verification/SCENARIOS.md), repeated per arm, one
# case per process, each ending once its outcome is decided:
#   scripts/verify/scenario-repeats.sh [--arms high,high-static] [--repeats 3] [--jobs 2] [--cases a,b] [--rest] [--judge-only] [OUTDIR]
# Identical runs can end differently on the GPU, so each case runs --repeats
# times (at least 3) per arm. Every run is its own test-bed process on the
# shared GPU slot, behind the provenance check, with VIBE_TESTBED_EARLY_END=1,
# so each stays far under the 15-minute rule. --rest adds the houses at rest:
# acceptance.sh's rest trial and the veneer houses' qualification, a process each.
# Each repeat is judged on its own (scenarios.mjs judge); the table counts each
# check's PASS over the repeats, per arm.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
arms=high,high-static repeats=3 rest=0 judge_only=0 jobs=2 one_run=0 bin= out=$ROOT/target/verify/scenario-repeats
# Default: the meteors, the small balls and the truck into the house's corner
# (the cannonball and the truck into the house's middle are the impact work's; the truck into the corner is impact-arms.sh's).
cases=wm-veneer-meteor-0,wm-masonry-meteor-0,wm-brick-house-meteor-0,wm-stone-house-meteor-0,wm-veneer-roof-meteor-0,wm-stone-house-upper-meteor-0,meteor-framed-house,meteor,wm-veneer-ball100-0,wm-masonry-ball100-0,wm-brick-house-ball100-0,wm-stone-house-ball100-0,wm-veneer-ball1000-0,wm-masonry-ball1000-0,wm-brick-house-ball1000-0,ball100-truck,ball1000-truck
while [ $# -gt 0 ]; do
  case $1 in
    --jobs) jobs=$2; shift 2 ;;
    --one-out) out=$2; shift 2 ;;
    --one-bin) bin=$2; shift 2 ;;
    --one) one_run=1; one_args=("$2" "$3" "$4"); shift 4 ;;
    --arms) arms=$2; shift 2 ;;
    --repeats) repeats=$2; shift 2 ;;
    --cases) cases=$2; shift 2 ;;
    --rest) rest=1; shift ;;
    --judge-only) judge_only=1; shift ;;
    *) out=$1; shift ;;
  esac
done
[ "$one_run" = 1 ] || [ "$repeats" -ge 3 ] || echo "[repeats] warning: $repeats repeats; outcomes bifurcate, 3 is the least that says how often"
mkdir -p "$out"
GPU_RUN=$ROOT/scripts/perf/gpu-run.sh
# One arm's environment, in the caller's subshell: the profile, its SDK resolved
# to one revision, the provenance check, its packs and the scenario meta.
arm_env() {
  source "$ROOT/scripts/fidelity/select.sh" "$1" || return 2
  export PHYSX_ROOT=$(cd -P "$PHYSX_ROOT" && pwd)
  "$ROOT/scripts/fidelity/provenance.sh" high > "$out/$1/provenance.log" 2>&1 || { echo "[repeats] $1: provenance refused ($out/$1/provenance.log)"; return 1; }
  eval "$("$ROOT/scripts/fidelity/packs.sh" high)"
  export LAB=$lab TOWN=$town CARGO_TARGET_DIR=$ROOT/target/verify-server-$(basename "${PHYSX_ROOT%@*}")
  export VIBE_GPU_SHARED=1 VIBE_TESTBED_PROBE=1 VIBE_TESTBED_EARLY_END=1 PX_DESTRUCTION_ALLOW_UNCONVERGED=1 PX_DESTRUCTION_IMPACT_LOG=1
  export CUMETAL_CACHE_DIR=$ROOT/target/cumetal-cache-scenarios
}
# One run: a case (or the houses at rest) on one arm, one repeat.
one() {
  local arm=$1 c=$2 k=$3 d=$out/$1/r$3 label=rep-$1-$2-r$3 t0=$(date +%s)
  mkdir -p "$d"
  if [ "$c" = rest ]; then
    [ -f "$d/rest/acceptance.jsonl" ] && return 0
    VERIFY_TRIALS='rest$' VERIFY_LABEL=$label VIBE_TESTBED_EARLY_END=1 "$ROOT/scripts/verify/acceptance.sh" "$arm" "$d/rest" \
      --skip lab,town,wire,walk,node > "$d/rest.log" 2>&1
  else
    [ -f "$d/$c.json" ] && return 0
    (arm_env "$arm" && cd "$ROOT" && env VIBE_CITY_SCENE="$LAB" VIBE_TESTBED_META="$out/$arm/lab.meta.json" VIBE_TESTBED_CARS=monster \
      VIBE_TESTBED_TRIALS="$c\$" VIBE_TESTBED_SCENE=lab VIBE_TESTBED_LABEL="$label" "$GPU_RUN" "$label" "$ROOT/$bin" vehicle_testbed --ignored --nocapture --test-threads=1) \
      > "$d/$c.log" 2>&1 || echo "[repeats] $arm $c r$k: test bed exited non-zero ($d/$c.log)"
    cp "$ROOT/target/vehicle-testbed/$label.json" "$d/$c.json" 2>/dev/null || echo "[repeats] $arm $c r$k: no report"
  fi
  echo "[repeats] $arm $c r$k: $(( $(date +%s) - t0 )) s"
}
source "$ROOT/scripts/ops/gpu-workers.sh"
# A job holds a worker token (gpu-workers.sh: a second only while nobody else waits for the GPU).
if [ "$one_run" = 1 ]; then worker_take "$out"; one "${one_args[@]}"; s=$?; worker_give; exit $s; fi
if [ "$judge_only" = 0 ]; then
  for arm in ${arms//,/ }; do
    mkdir -p "$out/$arm"
    (arm_env "$arm" && node "$ROOT/scripts/verify/scenarios.mjs" meta lab --pack "$LAB" --base "${LAB%.json}.meta.json" --out "$out/$arm/lab.meta.json" > /dev/null) || exit 1
  done
  bin=$( (arm_env "${arms%%,*}" && cd "$ROOT" && cargo test --release -p web-fps-server --features native-destruction --lib --no-run 2>&1) \
    | sed -n 's/.*Executable unittests src\/lib.rs (\(.*\))/\1/p' | tail -1)
  [ -n "$bin" ] || { echo "[repeats] the test bed did not build"; exit 1; }
  export GPU_WORKERS_TOP=$$
  # --jobs workers (default 2), each run its own shared-slot GPU job (gpu-run.sh caps
  # the machine at 3); the jobs call this script back with --one.
  for k in $(seq 1 "$repeats"); do
    for c in ${cases//,/ }; do for arm in ${arms//,/ }; do echo "$arm $c $k"; done; done
    [ "$rest" = 1 ] && for arm in ${arms//,/ }; do echo "$arm rest $k"; done
  done | xargs -P "$jobs" -L 1 "$0" --one-out "$out" --one-bin "$bin" --one
fi
# Judge each repeat, then count each check's PASS over the repeats per arm.
for arm in ${arms//,/ }; do
  for d in "$out/$arm"/r*/; do
    reports=(); for f in "$d"*.json; do case $f in *scenarios.json) ;; *) reports+=("$f") ;; esac; done
    [ ${#reports[@]} -gt 0 ] || continue
    (arm_env "$arm" > /dev/null && node "$ROOT/scripts/verify/scenarios.mjs" judge "$arm" --lab "$LAB" --town "$TOWN" --out "$d/scenarios.json" "${reports[@]}" > "$d/verdict.txt" 2>&1)
  done
done
node - "$ROOT" "$out" "$cases" ${arms//,/ } <<'EOF' | tee "$out/repeats.txt"
const fs = require('fs'), path = require('path');
const [root, out, cases, ...arms] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(path.join(root, 'scripts/verify/scenarios.json'), 'utf8'));
const wanted = new Set(cases.split(','));
const scenarioCase = Object.fromEntries((data.scenarios ?? []).map((s) => [s.id, s.case]));
const tally = {};
for (const arm of arms) {
  const dir = path.join(out, arm);
  for (const r of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^r\d+$/.test(x)) : []) {
    const f = path.join(dir, r, 'scenarios.json');
    if (!fs.existsSync(f)) continue;
    for (const row of JSON.parse(fs.readFileSync(f, 'utf8')).rows) {
      if (!wanted.has(scenarioCase[row.scenario])) continue;
      const k = `${row.scenario}\t${row.check}`;
      const t = (tally[k] ??= {});
      const a = (t[arm] ??= { pass: 0, n: 0, measured: [] });
      a.n += 1; if (row.status === 'PASS') a.pass += 1; a.measured.push(String(row.measured).slice(0, 48));
    }
  }
}
const lines = [['scenario', 'check', ...arms.map((a) => `${a} PASS`), ...arms.map((a) => `${a} measured (per repeat)`)]];
for (const [k, t] of Object.entries(tally)) {
  const [s, c] = k.split('\t');
  lines.push([s, c.slice(0, 60), ...arms.map((a) => t[a] ? `${t[a].pass}/${t[a].n}` : '-'), ...arms.map((a) => t[a] ? t[a].measured.join(' | ') : '-')]);
}
const w = lines[0].map((_, i) => Math.min(90, Math.max(...lines.map((l) => String(l[i]).length))));
for (const l of lines) console.log(l.map((x, i) => String(x).slice(0, 90).padEnd(w[i])).join('  '));
EOF
