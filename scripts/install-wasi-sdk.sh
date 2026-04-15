#!/usr/bin/env bash
#
# Install a pinned `wasi-sdk` tarball so the `blast-stress-solver`
# crate's `build.rs` can compile the Blast C++ backend against a
# wasi-sysroot + libc++ for `wasm32-unknown-unknown`.
#
# This script exists for CI environments (notably Vercel, which runs
# Amazon Linux 2023) that don't ship `libc++-*-dev-wasm32` through
# apt/dnf.  Local Ubuntu/Debian devs can instead just install
# `libc++-18-dev-wasm32` and skip this step — the Blast `build.rs`
# will auto-probe `/usr/lib/llvm-18/...` with no env vars.
#
# Idempotent: if the expected clang++ binary already exists at the
# install path, the script is a no-op.
#
# Env vars (optional overrides):
#   WASI_SDK_VERSION  — e.g. "22.0" (default).  Must match a release
#                       tag on github.com/WebAssembly/wasi-sdk.
#                       The default is pinned to the last release
#                       that keeps libc++ headers at the shared
#                       `share/wasi-sysroot/include/c++/v1` layout —
#                       `scripts/vercel-build.sh` falls back to
#                       probing the per-triple layout used by v23+.
#   WASI_SDK_DIR      — parent directory (default: $HOME/.cache/wasi-sdk).
#                       The extracted tree lands at
#                       `${WASI_SDK_DIR}/wasi-sdk-${WASI_SDK_VERSION}`.
#
# Prints the final install path on stdout on success so callers can
# capture it with `$(./scripts/install-wasi-sdk.sh)`.

set -euo pipefail

: "${WASI_SDK_VERSION:=22.0}"
: "${WASI_SDK_DIR:="${HOME}/.cache/wasi-sdk"}"

INSTALL_DIR="${WASI_SDK_DIR}/wasi-sdk-${WASI_SDK_VERSION}"

if [[ -x "${INSTALL_DIR}/bin/clang++" ]]; then
  echo "[install-wasi-sdk] wasi-sdk ${WASI_SDK_VERSION} already present at ${INSTALL_DIR}" >&2
  echo "${INSTALL_DIR}"
  exit 0
fi

MAJOR="${WASI_SDK_VERSION%%.*}"
TAG="wasi-sdk-${MAJOR}"

# Release tarball naming changed around v22 — newer releases ship an
# explicit arch suffix, older ones don't.  Try both and use whichever
# succeeds.
CANDIDATE_TARBALLS=(
  "wasi-sdk-${WASI_SDK_VERSION}-x86_64-linux.tar.gz"
  "wasi-sdk-${WASI_SDK_VERSION}-linux.tar.gz"
)

mkdir -p "${WASI_SDK_DIR}"
cd "${WASI_SDK_DIR}"

DOWNLOADED=""
for TARBALL in "${CANDIDATE_TARBALLS[@]}"; do
  URL="https://github.com/WebAssembly/wasi-sdk/releases/download/${TAG}/${TARBALL}"
  echo "[install-wasi-sdk] trying ${URL}" >&2
  if curl -fL --retry 4 --retry-delay 2 -o "${TARBALL}" "${URL}"; then
    DOWNLOADED="${TARBALL}"
    break
  fi
  rm -f "${TARBALL}"
done

if [[ -z "${DOWNLOADED}" ]]; then
  echo "[install-wasi-sdk] FATAL: could not download wasi-sdk ${WASI_SDK_VERSION}" >&2
  echo "[install-wasi-sdk]   tried: ${CANDIDATE_TARBALLS[*]}" >&2
  exit 1
fi

echo "[install-wasi-sdk] extracting ${DOWNLOADED}" >&2
tar -xzf "${DOWNLOADED}"
rm -f "${DOWNLOADED}"

# Some tarballs extract to `wasi-sdk-${VERSION}-x86_64-linux/` instead
# of the bare `wasi-sdk-${VERSION}/` we expect.  Normalise if needed.
if [[ ! -d "${INSTALL_DIR}" ]]; then
  for d in "wasi-sdk-${WASI_SDK_VERSION}-x86_64-linux" "wasi-sdk-${WASI_SDK_VERSION}-linux"; do
    if [[ -d "${d}" ]]; then
      mv "${d}" "${INSTALL_DIR}"
      break
    fi
  done
fi

if [[ ! -x "${INSTALL_DIR}/bin/clang++" ]]; then
  echo "[install-wasi-sdk] FATAL: expected ${INSTALL_DIR}/bin/clang++ not found after extract" >&2
  ls -la "${WASI_SDK_DIR}" >&2 || true
  exit 1
fi

echo "[install-wasi-sdk] ready: ${INSTALL_DIR}" >&2
echo "${INSTALL_DIR}"
