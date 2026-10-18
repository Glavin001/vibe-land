#!/bin/bash
# Run a command in an engine profile: scripts/fidelity/profile.sh runtime|high|high-ARM CMD...
# The one switch for "everything on" (high) or "what ships" (runtime); high-ARM
# is a named variant of high (scripts/fidelity/arms/ARM.env, select.sh).
# PROFILE_DEGRADE=1 drops capabilities the selected SDK lacks instead of failing.
set -e
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
profile=$1; shift
source "$here/select.sh" "$profile" || exit 2
if [ "${PROFILE_DEGRADE:-0}" = 1 ]; then source "$here/check.sh" --degrade; else "$here/check.sh"; fi
exec "$@"
