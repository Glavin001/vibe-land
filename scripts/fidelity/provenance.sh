#!/bin/bash
# Is this profile's SDK and pack set what it claims to be?
#   scripts/fidelity/provenance.sh runtime|high
# For high (and for runtime, reported only):
# - the SDK (PHYSX_ROOT/sdk-artifacts.json) must be built clean (source_dirty false)
#   and from its checkout's current head: an install whose source_revision is
#   behind HEAD with changes under physx/ or blast/ is stale;
# - the packs (scripts/fidelity/packs.sh) must be newer than every authoring
#   source (structures/**/*.mjs, destruction/assets/scenes); stale high packs are
#   rebuilt (scripts/fidelity/build-packs.sh high, seconds).
# Exit 1 (high) when the SDK is stale or dirty, unless VERIFY_ALLOW_STALE_SDK=1
# (then it says so, and VIBE_PROVENANCE records it).
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
profile=${1:?usage: provenance.sh runtime|high}
art="$PHYSX_ROOT/sdk-artifacts.json"
problems=()
if [ -f "$art" ]; then
  read -r rev dirty prefix < <(python3 -c "import json;d=json.load(open('$art'));print(d.get('source_revision',''), d.get('source_dirty'), d.get('install_prefix',''))")
  [ "$dirty" = True ] && problems+=("SDK built from a dirty tree ($art)")
  checkout=${prefix%/out/install/*}
  if [ -d "$checkout/.git" ] || [ -f "$checkout/.git" ]; then
    head=$(git -C "$checkout" rev-parse HEAD 2>/dev/null)
    if [ -n "$head" ] && [ "$head" != "$rev" ] && ! git -C "$checkout" diff --quiet "$rev" "$head" -- physx blast 2>/dev/null; then
      problems+=("SDK built at ${rev:0:9}, its checkout ($checkout, $(git -C "$checkout" branch --show-current)) is at ${head:0:9} with physx/blast changes since")
    fi
  fi
  echo "[provenance] SDK $(basename "$PHYSX_ROOT"): ${rev:0:9}, dirty=$dirty"
else
  problems+=("no sdk-artifacts.json in $PHYSX_ROOT")
fi
# Packs.
eval "$("$ROOT/scripts/fidelity/packs.sh" "$profile")"
src_time=$(find "$ROOT/structures" "$ROOT/destruction/assets/scenes" \( -path '*/out' -o -path '*/node_modules' -o -path '*/scripts' -o -path '*/tests' \) -prune -o \( -name '*.mjs' -o -name '*.json' \) -type f -print0 2>/dev/null | xargs -0 stat -f %m | sort -n | tail -1)
for pack in "$lab" "$veneer/veneer-house.json" "$town"; do
  [ -f "$pack" ] || { problems+=("missing pack $pack"); continue; }
  if [ "$(stat -f %m "$pack")" -lt "$src_time" ]; then
    if [ "$profile" = high ]; then
      echo "[provenance] $pack is older than its authoring sources: rebuilding the high packs"
      "$ROOT/scripts/fidelity/build-packs.sh" high > /dev/null && continue
    fi
    problems+=("pack $(basename "$pack") is older than its authoring sources")
  fi
done
if [ ${#problems[@]} -eq 0 ]; then echo "[provenance] $profile: SDK and packs current"; export VIBE_PROVENANCE=current; exit 0; fi
for p in "${problems[@]}"; do echo "[provenance] $profile: $p"; done
if [ "$profile" = high ] && [ "${VERIFY_ALLOW_STALE_SDK:-0}" != 1 ]; then
  echo "[provenance] refusing to run the high-fidelity profile (VERIFY_ALLOW_STALE_SDK=1 runs it anyway, recorded)"; exit 1
fi
exit 0
