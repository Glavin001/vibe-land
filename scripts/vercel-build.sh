#!/usr/bin/env bash
#
# Vercel build entrypoint for vibe-land.
#
# The `blast-stress-solver` crate requires a local source override
# (patches/blast-stress-solver.patch applied to the upstream PhysX repo)
# because the published crates.io version has a wasm32 symbol conflict
# that prevents linking.  This script clones the upstream repo, applies
# the patch, and then runs the normal wasm + client build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

echo "[vercel-build] ========================================"
echo "[vercel-build] vibe-land Vercel build starting"
echo "[vercel-build] pwd=$(pwd)"
echo "[vercel-build] ========================================"

# ── 1. Rust toolchain ────────────────────────────────────────────────────────
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

# ── 3. Upstream PhysX clone (required by [patch.crates-io] in Cargo.toml) ───
#
# Cargo.toml overrides `blast-stress-solver` with a local path so that
# our wasm shim patch (patches/blast-stress-solver.patch) is included.
# The path must exist before `cargo metadata` / `wasm-pack build` runs.
#
# Upstream: https://github.com/Glavin001/PhysX  branch: feat/rapier-destruction
# Pinned to: 21145beafb125507fdaace89aef1b295a7bc6624
PHYSX_DIR="${REPO_ROOT}/third_party/PhysX"
PHYSX_UPSTREAM="https://github.com/Glavin001/PhysX"
PHYSX_BRANCH="feat/rapier-destruction"
PHYSX_COMMIT="21145beafb125507fdaace89aef1b295a7bc6624"
PATCH_FILE="${REPO_ROOT}/patches/blast-stress-solver.patch"

if [[ ! -d "${PHYSX_DIR}/.git" ]]; then
  echo "[vercel-build] cloning PhysX upstream (shallow, ${PHYSX_BRANCH})"
  git clone --depth=1 --branch "${PHYSX_BRANCH}" \
    "${PHYSX_UPSTREAM}" "${PHYSX_DIR}"
else
  echo "[vercel-build] PhysX clone already present, skipping clone"
fi

echo "[vercel-build] PhysX HEAD: $(git -C "${PHYSX_DIR}" rev-parse HEAD)"

if [[ -f "${PATCH_FILE}" ]]; then
  echo "[vercel-build] applying patches/blast-stress-solver.patch"
  # Apply idempotently: reverse-check first, skip if already applied.
  if git -C "${PHYSX_DIR}" apply --reverse --check "${PATCH_FILE}" 2>/dev/null; then
    echo "[vercel-build] patch already applied, skipping"
  else
    git -C "${PHYSX_DIR}" apply "${PATCH_FILE}"
    echo "[vercel-build] patch applied"
  fi
else
  echo "[vercel-build] WARNING: ${PATCH_FILE} not found, building unpatched" >&2
fi

# ── 4. Client install + build ───────────────────────────────────────────────
echo "[vercel-build] running client install"
npm --prefix client install

echo "[vercel-build] running client build (blast-stress-solver from local PhysX clone)"
npm --prefix client run build

# ── 5. Verify the built wasm actually has the Blast symbols ─────────────────
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
