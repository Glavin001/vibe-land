#!/usr/bin/env bash
#
# Build the `vibe-land-shared` wasm module for the browser.
#
# Auto-detects whether the real NVIDIA Blast stress solver clone is
# available at `third_party/physx/.git`:
#
#   - If present: passes `--features destructibles` so the wasm
#     bundle gets the real destructible structures backend.
#   - If absent: builds the lean wasm bundle with the stub
#     destructibles backend — the JS destructibles API on
#     `WasmSimWorld` still exists but all calls are no-ops.
#
# See `docs/BLAST_INTEGRATION.md` for the full story.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SHARED_DIR="${REPO_ROOT}/shared"
OUT_DIR="${REPO_ROOT}/client/src/wasm/pkg"
PHYSX_GIT="${REPO_ROOT}/third_party/physx/.git"

cd "${SHARED_DIR}"

if [[ -e "${PHYSX_GIT}" ]]; then
  echo "[build-shared-wasm] real PhysX clone detected — building WITH destructibles feature"
  exec wasm-pack build --target web --out-dir "${OUT_DIR}" -- --features destructibles
else
  echo "[build-shared-wasm] no PhysX clone — building WITHOUT destructibles feature (stub backend)"
  exec wasm-pack build --target web --out-dir "${OUT_DIR}"
fi
