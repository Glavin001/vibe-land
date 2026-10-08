# Select an engine profile, optionally with a named variant (an "arm"):
#   source scripts/fidelity/select.sh NAME
# NAME is runtime, high, or high-ARM: high.env, then scripts/fidelity/arms/ARM.env
# on top (only the flags the arm changes). VIBE_FIDELITY_ARM=ARM with NAME=high
# selects the same thing (an override for scripts that only pass "high").
# Sets fidelity_base (runtime|high: which SDK family, packs and provenance) and
# exports VIBE_FIDELITY_PROFILE (the full name, recorded in every report).
#
# The impact arms (docs/verification/README.md, "Impact arms"):
#   high-static   A: the static solve only (VIBE_IMPACT_CAPACITY=0)
#   high-step     B: static plus the linear impact step (VIBE_IMPACT_STEP=1)
#   high-oracle   C: the ADMM impact solve at its correctness budget (the reference)
_fidelity_here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
_fidelity_name=${1:?usage: source select.sh runtime|high|high-ARM}
case $_fidelity_name in
  runtime) source "$_fidelity_here/runtime.env"; fidelity_base=runtime; unset VIBE_FIDELITY_ARM ;;
  high|high-*)
    _fidelity_arm=${_fidelity_name#high}; _fidelity_arm=${_fidelity_arm#-}
    [ -z "$_fidelity_arm" ] && _fidelity_arm=${VIBE_FIDELITY_ARM:-}
    source "$_fidelity_here/high.env"; fidelity_base=high
    if [ -n "$_fidelity_arm" ]; then
      if [ ! -f "$_fidelity_here/arms/$_fidelity_arm.env" ]; then
        echo "[fidelity] no arm '$_fidelity_arm' (scripts/fidelity/arms: $(ls "$_fidelity_here/arms" | sed 's/\.env$//' | paste -sd' ' -))" >&2
        return 2 2>/dev/null || exit 2
      fi
      source "$_fidelity_here/arms/$_fidelity_arm.env"
      _fidelity_name=high-$_fidelity_arm
      export VIBE_FIDELITY_ARM=$_fidelity_arm
    else unset VIBE_FIDELITY_ARM; fi ;;
  *) echo "[fidelity] unknown profile '$_fidelity_name' (runtime, high, high-ARM)" >&2; return 2 2>/dev/null || exit 2 ;;
esac
export VIBE_FIDELITY_PROFILE=$_fidelity_name
