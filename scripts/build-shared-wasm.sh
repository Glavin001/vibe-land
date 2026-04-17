#!/usr/bin/env bash
#
# Build the `vibe-land-shared` wasm module for the browser.
#
# The `blast-stress-solver` crate is published on crates.io with
# prebuilt wasm32 static libraries, so no local PhysX clone or C++
# toolchain is required.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SHARED_DIR="${REPO_ROOT}/shared"
OUT_DIR="${REPO_ROOT}/client/src/wasm/pkg"

cd "${SHARED_DIR}"

echo "[build-shared-wasm] building wasm (blast-stress-solver from crates.io)"
exec wasm-pack build --target web --out-dir "${OUT_DIR}"
