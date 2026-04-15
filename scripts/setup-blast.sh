#!/usr/bin/env bash
#
# Clone (or update) the PhysX repo that hosts the in-development
# `blast-stress-solver` Rust crate, at the exact SHA pinned in
# scripts/blast-pinned-sha.txt, into third_party/physx.
#
# Idempotent: safe to re-run. The target directory is gitignored so it
# never lands in the vibe-land history. Invoked automatically by
# `make setup`.

set -euo pipefail

REPO_URL="https://github.com/Glavin001/PhysX.git"
BRANCH="claude/fix-wasm-build-UyQBU"

# Resolve repo root regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VENDOR_DIR="${REPO_ROOT}/third_party/physx"
PINNED_SHA_FILE="${REPO_ROOT}/scripts/blast-pinned-sha.txt"

if [[ ! -f "${PINNED_SHA_FILE}" ]]; then
  echo "[setup-blast] missing pinned SHA file at ${PINNED_SHA_FILE}" >&2
  exit 1
fi

PINNED_SHA="$(tr -d '[:space:]' < "${PINNED_SHA_FILE}")"
if [[ -z "${PINNED_SHA}" ]]; then
  echo "[setup-blast] pinned SHA file is empty" >&2
  exit 1
fi

mkdir -p "${REPO_ROOT}/third_party"

if [[ -d "${VENDOR_DIR}/.git" ]]; then
  CURRENT_SHA="$(git -C "${VENDOR_DIR}" rev-parse HEAD 2>/dev/null || echo "")"
  if [[ "${CURRENT_SHA}" == "${PINNED_SHA}" ]]; then
    echo "[setup-blast] already at pinned SHA ${PINNED_SHA}"
  else
    echo "[setup-blast] updating to pinned SHA ${PINNED_SHA}"
    git -C "${VENDOR_DIR}" fetch --depth 1 origin "${BRANCH}"
    git -C "${VENDOR_DIR}" fetch --depth 1 origin "${PINNED_SHA}" || true
    git -C "${VENDOR_DIR}" reset --hard "${PINNED_SHA}"
  fi
else
  echo "[setup-blast] cloning ${REPO_URL} branch=${BRANCH} into ${VENDOR_DIR}"
  git clone --branch "${BRANCH}" --single-branch --depth 1 \
    "${REPO_URL}" "${VENDOR_DIR}"
  CURRENT_SHA="$(git -C "${VENDOR_DIR}" rev-parse HEAD)"
  if [[ "${CURRENT_SHA}" != "${PINNED_SHA}" ]]; then
    echo "[setup-blast] head ${CURRENT_SHA} != pinned ${PINNED_SHA}, fetching pinned SHA"
    git -C "${VENDOR_DIR}" fetch --depth 1 origin "${PINNED_SHA}"
    git -C "${VENDOR_DIR}" reset --hard "${PINNED_SHA}"
  fi
fi

# Sanity-check: the crate we depend on must exist at the expected path.
CRATE_DIR="${VENDOR_DIR}/blast/blast-stress-solver-rs"
if [[ ! -f "${CRATE_DIR}/Cargo.toml" ]]; then
  echo "[setup-blast] expected crate missing at ${CRATE_DIR}" >&2
  exit 1
fi

echo "[setup-blast] ready: ${CRATE_DIR}"
