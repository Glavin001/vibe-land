#!/usr/bin/env bash
#
# Vercel build entrypoint for vibe-land.
#
# Vercel's default Amazon Linux 2023 build image doesn't ship:
#   (a) the `wasm32-unknown-unknown` rustc target,
#   (b) `wasm-pack`,
#   (c) a wasi C++ toolchain for compiling the Blast stress solver's
#       C++ sources for `wasm32-unknown-unknown`.
#
# This script installs everything needed:
#   1. Rust + wasm32 target
#   2. wasm-pack
#   3. wasi-sdk (clang + wasi-sysroot + libc++ for wasm32)
#
# NOTE: Step 4 (PhysX/Blast source clone) is no longer needed:
#   blast-stress-solver v0.1.1 is now sourced from crates.io directly.
#   The [patch.crates-io] override in Cargo.toml is commented out.
#
# See `docs/BLAST_INTEGRATION.md` for the full toolchain story.

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

# ── 3. wasi-sdk (clang + wasi-sysroot + libc++ for wasm32-wasi) ──────────────
WASI_SDK_ROOT="$(./scripts/install-wasi-sdk.sh)"
echo "[vercel-build] wasi-sdk at: ${WASI_SDK_ROOT}"

export BLAST_WASM_SYSROOT="${WASI_SDK_ROOT}/share/wasi-sysroot"

# wasi-sdk layout shifted around v23: older releases shipped libc++
# at `.../include/c++/v1/` + `.../lib/wasm32-wasi/`, newer releases
# split by triple.  Probe in priority order.
find_libcxx_include() {
  local sysroot="$1"
  local candidates=(
    "${sysroot}/include/c++/v1"
    "${sysroot}/include/wasm32-wasi/c++/v1"
    "${sysroot}/include/wasm32-wasip1/c++/v1"
    "${sysroot}/include/wasm32-wasi-threads/c++/v1"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -f "${c}/new" ]]; then
      echo "${c}"
      return 0
    fi
  done
  return 1
}

find_libcxx_lib() {
  local sysroot="$1"
  local candidates=(
    "${sysroot}/lib/wasm32-wasi"
    "${sysroot}/lib/wasm32-wasip1"
    "${sysroot}/lib/wasm32-wasi-threads"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -f "${c}/libc++.a" ]]; then
      echo "${c}"
      return 0
    fi
  done
  return 1
}

if ! BLAST_WASM_CXX_INCLUDE="$(find_libcxx_include "${BLAST_WASM_SYSROOT}")"; then
  echo "[vercel-build] FATAL: libc++ headers not found under ${BLAST_WASM_SYSROOT}" >&2
  find "${BLAST_WASM_SYSROOT}/include" -maxdepth 4 -name "new" 2>/dev/null | head -20 >&2 || true
  exit 1
fi
if ! BLAST_WASM_CXX_LIB_DIR="$(find_libcxx_lib "${BLAST_WASM_SYSROOT}")"; then
  echo "[vercel-build] FATAL: libc++.a not found under ${BLAST_WASM_SYSROOT}/lib" >&2
  find "${BLAST_WASM_SYSROOT}/lib" -maxdepth 3 -name "libc++.a" 2>/dev/null | head -20 >&2 || true
  exit 1
fi
export BLAST_WASM_CXX_INCLUDE
export BLAST_WASM_CXX_LIB_DIR
echo "[vercel-build] BLAST_WASM_CXX_INCLUDE=${BLAST_WASM_CXX_INCLUDE}"
echo "[vercel-build] BLAST_WASM_CXX_LIB_DIR=${BLAST_WASM_CXX_LIB_DIR}"

# Force the `cc` crate to use wasi-sdk's clang for the wasm32 target ONLY.
# Use target-triple-specific env vars so native host builds (e.g. cargo install
# wasm-bindgen-cli, which compiles `ring` for x86_64) continue to use the
# system compiler and don't fail with "assert.h file not found".
export CC_wasm32_unknown_unknown="${WASI_SDK_ROOT}/bin/clang"
export CXX_wasm32_unknown_unknown="${WASI_SDK_ROOT}/bin/clang++"
export AR_wasm32_unknown_unknown="${WASI_SDK_ROOT}/bin/llvm-ar"
export CC_wasm32_wasi="${WASI_SDK_ROOT}/bin/clang"
export CXX_wasm32_wasi="${WASI_SDK_ROOT}/bin/clang++"
export AR_wasm32_wasi="${WASI_SDK_ROOT}/bin/llvm-ar"
# Do NOT export generic CC/CXX/AR or prepend wasi-sdk to PATH — that would
# cause cargo-install of native crates (ring, wasm-bindgen-cli) to compile
# with the wasi clang which lacks native system headers.

# Validate env vars point at real paths.
for var in BLAST_WASM_SYSROOT BLAST_WASM_CXX_INCLUDE BLAST_WASM_CXX_LIB_DIR \
           CC_wasm32_unknown_unknown CXX_wasm32_unknown_unknown; do
  eval "val=\${$var}"
  if [[ ! -e "${val}" ]]; then
    echo "[vercel-build] WARNING: ${var}=${val} does not exist" >&2
  fi
done

# ── 4. PhysX/Blast source clone — skipped (not needed with crates.io v0.1.1) ─
# blast-stress-solver v0.1.1 is published on crates.io with the upstream fix
# already applied.  The [patch.crates-io] path override in Cargo.toml is
# commented out.  Re-enable setup-blast.sh only when iterating on the C++
# source locally.
#
# ./scripts/setup-blast.sh
#
# if [[ ! -f "${REPO_ROOT}/third_party/PhysX/blast/blast-stress-solver-rs/build.rs" ]]; then
#   echo "[vercel-build] FATAL: blast-stress-solver crate missing after setup-blast.sh" >&2
#   exit 1
# fi
# echo "[vercel-build] blast-stress-solver ready at third_party/PhysX/blast/blast-stress-solver-rs"

# ── 5. Client install + build ───────────────────────────────────────────────
echo "[vercel-build] running client install"
npm --prefix client install

echo "[vercel-build] running client build (compiles Blast C++ for wasm32)"
npm --prefix client run build

# ── 6. Verify the built wasm actually has the Blast symbols ─────────────────
WASM_FILE="${REPO_ROOT}/client/src/wasm/pkg/vibe_land_shared_bg.wasm"
if [[ ! -f "${WASM_FILE}" ]]; then
  echo "[vercel-build] FATAL: ${WASM_FILE} not produced" >&2
  exit 1
fi
WASM_SIZE=$(stat -c %s "${WASM_FILE}" 2>/dev/null || stat -f %z "${WASM_FILE}")
echo "[vercel-build] wasm size: ${WASM_SIZE} bytes"

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
