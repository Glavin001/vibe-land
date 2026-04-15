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
# Without (c) the build falls back to the stub destructibles backend,
# which is why `/practice` on Vercel preview deployments showed
# `instances=0 chunks=0` — `spawn_wall`/`spawn_tower` were no-ops.
#
# This script installs everything needed and runs the normal client
# build with the `destructibles` feature enabled so the final wasm
# bundle ships the real NVIDIA Blast stress solver.
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

# ── 3. wasi-sdk (clang + wasi-sysroot + libc++ for wasm32-wasi) ──────────────
WASI_SDK_ROOT="$(./scripts/install-wasi-sdk.sh)"
echo "[vercel-build] wasi-sdk at: ${WASI_SDK_ROOT}"

# Point `blast-stress-solver/build.rs` at the wasi-sdk layout so clang
# can find `<new>`, `libc++.a`, and the wasi api headers even though
# wasi-sdk lives outside the probed `/opt/wasi-sdk` / `/usr/lib/llvm-*`
# defaults.  See build.rs `probe_*` helpers.
export BLAST_WASM_SYSROOT="${WASI_SDK_ROOT}/share/wasi-sysroot"

# wasi-sdk layout shifted around v23: older releases shipped libc++
# at `.../include/c++/v1/` + `.../lib/wasm32-wasi/`, newer releases
# split by triple (`.../include/wasm32-wasi/c++/v1/`,
# `.../include/wasm32-wasip1/c++/v1/`, etc).  Probe in priority
# order and pick whichever actually exists so we're robust to a
# future `WASI_SDK_VERSION` bump.
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

# Force the `cc` crate to use wasi-sdk's clang for the wasm32 target.
# Without these env vars `cc` picks up the system clang (Amazon Linux's
# default clang is too old and/or has no wasm32 support configured).
export CC_wasm32_unknown_unknown="${WASI_SDK_ROOT}/bin/clang"
export CXX_wasm32_unknown_unknown="${WASI_SDK_ROOT}/bin/clang++"
export AR_wasm32_unknown_unknown="${WASI_SDK_ROOT}/bin/llvm-ar"

for var in BLAST_WASM_SYSROOT BLAST_WASM_CXX_INCLUDE BLAST_WASM_CXX_LIB_DIR \
           CC_wasm32_unknown_unknown CXX_wasm32_unknown_unknown AR_wasm32_unknown_unknown; do
  eval "val=\${$var}"
  if [[ ! -e "${val}" ]]; then
    echo "[vercel-build] WARNING: ${var}=${val} does not exist" >&2
  fi
done

# ── 4. Clone PhysX / Blast stress solver at the pinned SHA ──────────────────
./scripts/setup-blast.sh

# Sanity-check the real crate is in place (not the stub).
if [[ ! -f "${REPO_ROOT}/third_party/physx/blast/blast-stress-solver-rs/build.rs" ]]; then
  echo "[vercel-build] FATAL: real blast-stress-solver crate missing after setup-blast.sh" >&2
  exit 1
fi
echo "[vercel-build] blast-stress-solver crate ready at third_party/physx/blast/blast-stress-solver-rs"

# ── 5. Client install + build ───────────────────────────────────────────────
echo "[vercel-build] running client install"
npm --prefix client install

echo "[vercel-build] running client build (this compiles the Blast C++ backend for wasm32)"
npm --prefix client run build

# ── 6. Verify the built wasm actually has the Blast symbols ─────────────────
WASM_FILE="${REPO_ROOT}/client/src/wasm/pkg/vibe_land_shared_bg.wasm"
if [[ ! -f "${WASM_FILE}" ]]; then
  echo "[vercel-build] FATAL: ${WASM_FILE} not produced" >&2
  exit 1
fi
WASM_SIZE=$(stat -c %s "${WASM_FILE}" 2>/dev/null || stat -f %z "${WASM_FILE}")
echo "[vercel-build] wasm size: ${WASM_SIZE} bytes"

if strings "${WASM_FILE}" | grep -q "NvBlastExtStressSolver"; then
  echo "[vercel-build] ✓ wasm contains real Blast stress solver symbols"
else
  echo "[vercel-build] FATAL: wasm is missing Blast symbols — destructibles build degraded to stub" >&2
  exit 1
fi

echo "[vercel-build] ========================================"
echo "[vercel-build] build complete"
echo "[vercel-build] ========================================"
