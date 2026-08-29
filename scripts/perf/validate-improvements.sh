#!/usr/bin/env bash
# Verify each recent optimisation is actually a win, one flag at a time.
#
# Arm A is always the current default (the optimisation ON); arm B turns it
# OFF. So "A faster" is the result we want, and "no call" means the change
# cannot be shown to help in that scenario -- which is a real finding, not a
# failure of the harness. An optimisation that only bites under load will
# legitimately say "no call" at idle.
#
# Runs strictly SEQUENTIALLY. Two suite jobs at once contend on the GPU and
# contaminate each other; paired interleaving cancels drift, not self-inflicted
# load.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
reps="${REPS:-6}"
scenario="${SCENARIO:-bombard-med}"

# label : env that DISABLES the optimisation
ARMS=(
  "gpu bond-stress walk:BLAST_BOND_STRESS_GPU=0"
  "cuda graph update (vs recapture):BLAST_GPU_GRAPH_UPDATE=0"
  "stable graph:BLAST_GPU_STABLE_GRAPH=0"
  "parallel contact classify:VIBE_PHYSX_CONTACT_CLASSIFY=0"
)

echo "# Improvement validation — scenario=$scenario reps=$reps"
echo "# A = optimisation ON (current default), B = OFF. Want: 'A faster'."
echo
for entry in "${ARMS[@]}"; do
  label="${entry%%:*}"; off="${entry#*:}"
  echo "## $label   (B sets $off)"
  "$here/scene-suite.sh" ab --reps "$reps" --only "$scenario" --a "" --b "$off" 2>/dev/null \
    | grep -v '^$' || echo "  (run failed)"
  echo
done
