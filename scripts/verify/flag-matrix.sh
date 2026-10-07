#!/bin/bash
# Flag-interaction matrix at rest: every pack the suite builds, qualified at rest
# (each structure alone, bonds broken counted from tick 0, the settle included) in
#   runtime                     runtime flags, runtime SDK, runtime packs
#   runtime-on-high-packs       runtime flags on the high packs (is it the pack?)
#   high                        every flag
#   high-no-<FLAG>              every flag but one, for each runtime flag
# Feature interactions fail where no single flag does (crush x section bending,
# impact capacity x sections on 2026-10-07): any bond broken at rest is a FAIL.
#
#   scripts/verify/flag-matrix.sh [OUTDIR]
# Writes OUTDIR/flag-matrix.jsonl (one row per arm and structure) and prints the
# table. Each arm runs through scripts/perf/qualify_structures.py (which takes a
# GPU slot through gpu-run.sh), one at a time. About 20 minutes.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
out=${1:-$ROOT/target/verify/flag-matrix}
mkdir -p "$out"; out=$(cd "$out" && pwd)
: > "$out/flag-matrix.jsonl"
export VIBE_GPU_SHARED=1 PX_DESTRUCTION_ALLOW_UNCONVERGED=1
# The flags that act at run time (pack-build flags -- crush packs, real
# capacities, centroid hulls -- are covered by the runtime-on-high-packs arm).
FLAGS=(VIBE_SECTION_BENDING VIBE_SECTION_ROTATION VIBE_BOND_TRUE_STIFFNESS VIBE_BOND_CONTACT_LENGTH
       VIBE_IMPACT_CAPACITY VIBE_NATIVE_CRUSH VIBE_NATIVE_UNCAPPED_SPIN VIBE_NATIVE_STRESS_FORCE_TOLERANCE
       VIBE_STRENGTH_SHORT_TERM VIBE_CRUSH_CONSERVE_MASS)

arm() { # arm NAME PROFILE PACKSET [FLAG-TO-DROP]
  local name=$1 profile=$2 packs=$3 drop=${4:-}
  (
    source "$ROOT/scripts/fidelity/$([ "$profile" = high ] && echo high || echo runtime).env"
    if [ -n "$drop" ]; then
      unset "$drop"
      # Rotation implies bending in the bridge: dropping bending drops both.
      [ "$drop" = VIBE_SECTION_BENDING ] && unset VIBE_SECTION_ROTATION
    fi
    eval "$("$ROOT/scripts/fidelity/packs.sh" "$packs")"
    export QUALIFY_TARGET_DIR=$ROOT/target/verify-server-$(basename "$PHYSX_ROOT")
    python3 "$ROOT/scripts/perf/qualify_structures.py" "$lab" "$veneer/veneer-house.json" "$veneer/veneer-bungalow.json" \
      --json "$out/$name.json" > "$out/$name.log" 2>&1
    python3 - "$out/$name.json" "$name" "$out/flag-matrix.jsonl" <<'PY'
import json, sys
path, name, rows = sys.argv[1:]
try:
    res = json.load(open(path))
except Exception as e:
    res = [{'structure': '(run)', 'verdict': 'ERROR', 'broken_pct': None, 'detail': str(e)}]
with open(rows, 'a') as f:
    for r in res:
        if r['verdict'] == 'FREE':
            continue
        f.write(json.dumps({'arm': name, 'structure': r['structure'], 'verdict': r['verdict'], 'broken_pct': r['broken_pct'], 'unconverged_pct': r.get('unconverged_pct'), 'detail': r.get('detail', '')[:160]}) + '\n')
PY
  )
  echo "[flag-matrix] $name: $(python3 -c "
import json
rs=[json.loads(l) for l in open('$out/flag-matrix.jsonl') if json.loads(l)['arm']=='$name']
bad=[r for r in rs if r['broken_pct'] is None or r['broken_pct']>0]
print(f'{len(bad)} of {len(rs)} structures broke at rest' + (': ' + ', '.join(f\"{r['structure']} {r['verdict'] if r['broken_pct'] is None else '%.2f%%'%r['broken_pct']}\" for r in bad[:6]) if bad else ''))")"
}

arm runtime runtime runtime
arm runtime-on-high-packs runtime high
(source "$ROOT/scripts/fidelity/high.env"; "$ROOT/scripts/fidelity/provenance.sh" high) > "$out/provenance-high.log" 2>&1 \
  || echo "[flag-matrix] high SDK provenance: $(grep -m1 'SDK built\|dirty' "$out/provenance-high.log") (run with VERIFY_ALLOW_STALE_SDK=1 to measure it anyway)"
if (source "$ROOT/scripts/fidelity/high.env"; "$ROOT/scripts/fidelity/provenance.sh" high) > /dev/null 2>&1; then
  arm high high high
  for f in "${FLAGS[@]}"; do arm "high-no-${f#VIBE_}" high high "$f"; done
fi
echo "[flag-matrix] rows in $out/flag-matrix.jsonl"
