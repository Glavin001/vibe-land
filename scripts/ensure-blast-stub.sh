#!/usr/bin/env bash
#
# Ensure a valid `blast-stress-solver` Cargo.toml exists at
# `third_party/physx/blast/blast-stress-solver-rs/` so that
# `cargo metadata` for the `vibe-land-shared` crate can resolve the
# optional `blast-stress-solver` path dependency.
#
# Cargo resolves all target-gated and optional path dependencies
# during metadata resolution regardless of whether the feature/cfg
# that enables them is active.  That means *every* `cargo check`,
# `cargo metadata`, or `wasm-pack build` needs a valid Cargo.toml at
# the blast-stress-solver path, even when the `destructibles`
# feature is off and we're never going to compile the real crate.
#
# On dev boxes `scripts/setup-blast.sh` solves that by cloning the
# real `Glavin001/PhysX` tree at the pinned SHA.  Fresh CI
# environments (e.g. Vercel preview) can't run that script because
# they lack the wasi C++ toolchain.  For those environments we drop
# a tiny placeholder crate (see `stubs/blast-stress-solver-rs/`)
# into place; it has no real symbols, and `vibe-land-shared` only
# references anything from `blast-stress-solver` when the
# `destructibles` feature is explicitly enabled — which no CI
# environment should do unless it also ran `setup-blast.sh`.
#
# Idempotent: if the target Cargo.toml already exists (stub or
# real), this script is a no-op.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TARGET_DIR="${REPO_ROOT}/third_party/physx/blast/blast-stress-solver-rs"
STUB_DIR="${REPO_ROOT}/stubs/blast-stress-solver-rs"

if [[ -f "${TARGET_DIR}/Cargo.toml" ]]; then
  echo "[ensure-blast-stub] ${TARGET_DIR}/Cargo.toml already exists — no-op"
  exit 0
fi

if [[ ! -f "${STUB_DIR}/Cargo.toml" ]]; then
  echo "[ensure-blast-stub] missing stub source at ${STUB_DIR}" >&2
  exit 1
fi

echo "[ensure-blast-stub] installing stub into ${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"
cp -R "${STUB_DIR}/." "${TARGET_DIR}/"
