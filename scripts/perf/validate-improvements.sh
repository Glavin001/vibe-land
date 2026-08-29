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
scenario="${SCENARIO:-bombard-short}"

# label : env that ENABLES it (arm A) : env that DISABLES it (arm B)
#
# Arm A states the ON value EXPLICITLY rather than relying on the default.
# BLAST_BOND_STRESS_GPU defaults OFF in this binary -- only the server launch
# script turns it on -- so an empty arm A silently compared the feature against
# itself, and the suite duly reported a significant winner between two
# identical configurations. Never let an arm depend on a default.
ARMS=(
  "gpu bond-stress walk:BLAST_BOND_STRESS_GPU=1:BLAST_BOND_STRESS_GPU=0"
  "cuda graph update (vs recapture):BLAST_GPU_GRAPH_UPDATE=1:BLAST_GPU_GRAPH_UPDATE=0"
  "stable graph:BLAST_GPU_STABLE_GRAPH=1:BLAST_GPU_STABLE_GRAPH=0"
  "parallel contact classify:VIBE_PHYSX_CONTACT_CLASSIFY=1:VIBE_PHYSX_CONTACT_CLASSIFY=0"
)

echo "# Improvement validation — scenario=$scenario reps=$reps"
echo "# A = optimisation ON (current default), B = OFF. Want: 'A faster'."
echo
for entry in "${ARMS[@]}"; do
  label="${entry%%:*}"; rest="${entry#*:}"
  on="${rest%%:*}"; off="${rest#*:}"
  echo "## $label   (A: $on   B: $off)"
  "$here/scene-suite.sh" ab --reps "$reps" --only "$scenario" --a "$on" --b "$off" 2>/dev/null \
    | grep -v '^$' || echo "  (run failed)"
  echo
done
