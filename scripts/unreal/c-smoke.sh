#!/usr/bin/env bash
# Prove the client core's static library links and runs from plain C, using only the system
# libraries build-core.sh recorded, before Unreal is involved.
#
#   scripts/unreal/c-smoke.sh            (runs build-core.sh first)
#   VL_SKIP_BUILD=1 scripts/unreal/c-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
THIRD="$ROOT/unreal/VibeCity/Plugins/VibeLand/Source/ThirdParty/VibeClientCore"
[[ "${VL_SKIP_BUILD:-0}" == 1 ]] || "$ROOT/scripts/unreal/build-core.sh"

case "$(uname -s)" in
  Darwin) LIBDIR="$THIRD/lib/Mac/arm64"; CC_FLAGS=(-arch arm64 -mmacosx-version-min=14.0) ;;
  Linux) LIBDIR="$THIRD/lib/Linux/x86_64"; CC_FLAGS=() ;;
  *) echo "c-smoke: unsupported host" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/main.c" <<'EOF'
#include <stdio.h>
#include <string.h>
#include "vibe_client_core.h"

int main(void) {
    unsigned int abi = vl_abi_version();
    const char *info = vl_build_info();
    printf("abi=%u header_abi=%u info=%s\n", abi, (unsigned)VL_ABI_VERSION, info ? info : "(null)");
    if (abi != VL_ABI_VERSION) { fprintf(stderr, "ABI mismatch\n"); return 1; }
    if (!info || strncmp(info, "vibe-client-core ", 17) != 0) { fprintf(stderr, "bad build info\n"); return 1; }
    return 0;
}
EOF

# shellcheck disable=SC2046  # native-libs.txt is a space-separated linker argument list
cc "${CC_FLAGS[@]}" -I"$ROOT/client-core-ffi/include" "$WORK/main.c" "$LIBDIR/libvibe_client_core.a" \
  $(cat "$LIBDIR/native-libs.txt") -o "$WORK/smoke"
"$WORK/smoke"
echo "c-smoke: ok ($(wc -c < "$LIBDIR/libvibe_client_core.a" | tr -d ' ') bytes, libs: $(cat "$LIBDIR/native-libs.txt"))"
