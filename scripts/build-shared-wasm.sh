#!/usr/bin/env bash
#
# Build the `vibe-land-shared` wasm module for the browser.
#
# Uses the published `blast-stress-solver` crate by default. Uncomment the
# workspace [patch.crates-io] override in Cargo.toml if you need to iterate on
# a local PhysX checkout instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SHARED_DIR="${REPO_ROOT}/shared"
OUT_DIR="${REPO_ROOT}/client/src/wasm/pkg"

cd "${SHARED_DIR}"

echo "[build-shared-wasm] building shared wasm package"
exec wasm-pack build --target web --out-dir "${OUT_DIR}"
