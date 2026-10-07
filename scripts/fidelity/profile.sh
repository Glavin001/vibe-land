#!/bin/bash
# Run a command in an engine profile: scripts/fidelity/profile.sh runtime|high CMD...
# The one switch for "everything on" (high) or "what ships" (runtime).
# PROFILE_DEGRADE=1 drops capabilities the selected SDK lacks instead of failing.
set -e
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
profile=$1; shift
case $profile in
  runtime) source "$here/runtime.env" ;;
  high) source "$here/high.env" ;;
  *) echo "usage: $0 runtime|high CMD..." >&2; exit 2 ;;
esac
if [ "${PROFILE_DEGRADE:-0}" = 1 ]; then source "$here/check.sh" --degrade; else "$here/check.sh"; fi
exec "$@"
