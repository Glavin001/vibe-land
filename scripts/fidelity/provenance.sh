#!/bin/bash
# Is this profile's SDK and pack set what it claims to be?
#   scripts/fidelity/provenance.sh runtime|high
# For high (and for runtime, reported only):
# - (high) the SDK's source revision must contain the current head of every PhysX
#   feature branch in scripts/fidelity/branches.tsv, and this checkout every
#   vibe-land one that changes the bridge or server build; it names each missing one;
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
  # Its CuMetal (scripts/perf/rebuild-garage-sdk.sh records it): the compiler
  # that produced the GPU code must be clean and current with its checkout's
  # compiler/ and runtime/, or a fix made there is missing from the run.
  if [ -f "$PHYSX_ROOT/cumetal-revision" ]; then
    read -r cm_rev cm_state cm_root < "$PHYSX_ROOT/cumetal-revision"
    [ "$cm_state" = clean ] || problems+=("SDK's CuMetal built from a dirty compiler/runtime ($cm_root)")
    cm_head=$(git -C "$cm_root" rev-parse HEAD 2>/dev/null)
    if [ -n "$cm_head" ] && [ "$cm_head" != "$cm_rev" ] && ! git -C "$cm_root" diff --quiet "$cm_rev" "$cm_head" -- compiler runtime 2>/dev/null; then
      problems+=("SDK's CuMetal is ${cm_rev:0:9}, its checkout ($cm_root) is at ${cm_head:0:9} with compiler/runtime changes since")
    fi
    echo "[provenance] CuMetal ${cm_rev:0:9} ($cm_state, $cm_root)"
  else
    echo "[provenance] note: no cumetal-revision in $PHYSX_ROOT (installed before it was recorded)"
  fi
else
  problems+=("no sdk-artifacts.json in $PHYSX_ROOT")
fi
# The feature branches the high profile depends on (scripts/fidelity/branches.tsv).
# PhysX: the SDK's source revision must contain each branch's current head (a
# merged integration branch can itself lag them). vibe-land: this checkout must
# contain each branch's changes to what the bridge and server build from
# (physx-bridge/, server/, shared/, destruction/src); a branch whose lead is only
# scripts or docs is reported, not refused.
if [ "$profile" = high ]; then
  physx_git=${checkout:-}
  [ -n "$physx_git" ] && git -C "$physx_git" rev-parse --git-dir > /dev/null 2>&1 || physx_git=${PHYSX_SOURCE:-/Users/glavin/Development/PhysX}
  resolve() { # git-dir branch -> commit (local branch, else origin/)
    git -C "$1" rev-parse --verify -q "$2^{commit}" 2>/dev/null || git -C "$1" rev-parse --verify -q "origin/$2^{commit}" 2>/dev/null
  }
  while IFS=$'\t' read -r repo branches what; do
    case $repo in ''|'#'*) continue ;; esac
    ok=0 found=0 detail=()
    for b in ${branches//|/ }; do
      if [ "$repo" = physx ]; then
        head=$(resolve "$physx_git" "$b") || { detail+=("$b: no such branch in $physx_git"); continue; }
        found=1
        if [ -n "${rev:-}" ] && git -C "$physx_git" merge-base --is-ancestor "$head" "$rev" 2>/dev/null; then ok=1; break; fi
        detail+=("$b (head ${head:0:9}, $(git -C "$physx_git" rev-list --count "${rev:-$head}..$head" 2>/dev/null) commits) is not in the SDK's revision ${rev:0:9}")
      else
        head=$(resolve "$ROOT" "$b") || { detail+=("$b: no such branch in vibe-land"); continue; }
        found=1
        if git -C "$ROOT" merge-base --is-ancestor "$head" HEAD; then ok=1; break; fi
        if git -C "$ROOT" diff --quiet HEAD..."$head" -- physx-bridge server shared destruction/src; then
          echo "[provenance] note: vibe-land $b (head ${head:0:9}) is not merged here; its changes are outside the bridge and server build ($what)"
          ok=2; break
        fi
        detail+=("vibe-land $b (head ${head:0:9}) changes the bridge/server build and is not in this checkout ($(git -C "$ROOT" diff --name-only HEAD..."$head" -- physx-bridge server shared destruction/src | head -3 | paste -sd, -))")
      fi
    done
    if [ "$ok" = 1 ]; then echo "[provenance] contains $repo ${branches}"
    elif [ "$ok" = 0 ]; then problems+=("missing $repo branch: ${detail[*]} -- $what"); fi
  done < "$ROOT/scripts/fidelity/branches.tsv"
  # The bridge's build: a test binary older than the SDK install links the old
  # SDK until cargo rebuilds it (the bridge reruns on the SDK's libraries).
  bins=$(ls -t "$ROOT/target/verify-server-$(basename "$PHYSX_ROOT")"/release/deps/web_fps_server-* 2>/dev/null | grep -v '\.d$' | head -1)
  if [ -n "$bins" ] && [ -f "$art" ] && [ "$bins" -ot "$art" ]; then
    echo "[provenance] note: the server test binary ($(basename "$bins")) predates the SDK install; the run's cargo build relinks it"
  fi
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
