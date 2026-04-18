#!/usr/bin/env bash
#
# Build the `vibe-land-shared` wasm module for the browser.
#
# Requires third_party/PhysX/blast/blast-stress-solver-rs to exist (the
# [patch.crates-io] override in Cargo.toml points there).  In CI
# vercel-build.sh clones it; locally it is already present.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SHARED_DIR="${REPO_ROOT}/shared"
OUT_DIR="${REPO_ROOT}/client/src/wasm/pkg"

cd "${SHARED_DIR}"

echo "[build-shared-wasm] building wasm (blast-stress-solver from local PhysX clone)"
exec wasm-pack build --target web --out-dir "${OUT_DIR}"
