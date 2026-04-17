#!/usr/bin/env bash
#
# Vercel build entrypoint for vibe-land.
#
# The `blast-stress-solver` crate is published on crates.io with
# prebuilt wasm32 static libraries, so no wasi C++ toolchain or local
# PhysX clone is required.  This script just ensures the Rust/wasm
# toolchain is present and runs the normal client build with the
# `destructibles` feature enabled.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

echo "[vercel-build] ========================================"
echo "[vercel-build] vibe-land Vercel build starting"
echo "[vercel-build] pwd=$(pwd)"
echo "[vercel-build] ========================================"

# ── 1. Rust toolchain ────────────────────────────────────────────────────────
# Vercel's build image includes rustup on recent images; install it if
# it's missing so we don't break on older images.
if ! command -v rustup >/dev/null 2>&1; then
  echo "[vercel-build] installing rustup (not present on PATH)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal
  export PATH="${HOME}/.cargo/bin:${PATH}"
fi

rustup target add wasm32-unknown-unknown
echo "[vercel-build] rustc: $(rustc --version)"

# ── 2. wasm-pack ─────────────────────────────────────────────────────────────
if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "[vercel-build] installing wasm-pack"
  cargo install wasm-pack --locked
fi
echo "[vercel-build] wasm-pack: $(wasm-pack --version)"

# ── 3. Client install + build ───────────────────────────────────────────────
echo "[vercel-build] running client install"
npm --prefix client install

echo "[vercel-build] running client build (blast-stress-solver from crates.io, prebuilt wasm32)"
npm --prefix client run build

# ── 4. Verify the built wasm actually has the Blast symbols ─────────────────
WASM_FILE="${REPO_ROOT}/client/src/wasm/pkg/vibe_land_shared_bg.wasm"
if [[ ! -f "${WASM_FILE}" ]]; then
  echo "[vercel-build] FATAL: ${WASM_FILE} not produced" >&2
  exit 1
fi
WASM_SIZE=$(stat -c %s "${WASM_FILE}" 2>/dev/null || stat -f %z "${WASM_FILE}")
echo "[vercel-build] wasm size: ${WASM_SIZE} bytes"

# wasm-opt strips most C++ mangled symbol names, but the panic/
# assertion strings that the Blast C++ backend embeds survive because
# they're data.  We probe for `ExtStressSolver` plus the rust-side
# crate name as a belt-and-braces check.
#
# NOTE: `grep -q` exits on first match, which closes the pipe; under
# `set -euo pipefail` that makes `strings` trip SIGPIPE and fails the
# whole pipeline.  Materialise the strings dump once to avoid it.
WASM_STRINGS_DUMP="$(mktemp)"
strings "${WASM_FILE}" > "${WASM_STRINGS_DUMP}"
BLAST_SYMS_OK=1
grep -q "ExtStressSolver" "${WASM_STRINGS_DUMP}" || BLAST_SYMS_OK=0
grep -q "blast_stress_solver" "${WASM_STRINGS_DUMP}" || BLAST_SYMS_OK=0
rm -f "${WASM_STRINGS_DUMP}"
if [[ "${BLAST_SYMS_OK}" == "1" ]]; then
  echo "[vercel-build] ✓ wasm contains real Blast stress solver symbols"
else
  echo "[vercel-build] FATAL: wasm is missing Blast symbols — destructibles build degraded to stub" >&2
  exit 1
fi

echo "[vercel-build] ========================================"
echo "[vercel-build] build complete"
echo "[vercel-build] ========================================"
