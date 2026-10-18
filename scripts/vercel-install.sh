#!/usr/bin/env bash
# Vercel install step: get a wasm-capable C compiler, then install the client.
#
# WHY THIS EXISTS
#
# `client/package.json`'s `build:wasm` runs wasm-pack twice. The second package,
# research/destruction-codec, depends on `zstd = "=0.13.3"`, and zstd-sys
# compiles C for wasm32 through cc-rs. gcc cannot target wasm32, so cc-rs
# reaches for clang *specifically*:
#
#   error occurred in cc-rs: failed to find tool "clang": No such file or
#   directory (os error 2)
#   error: failed to run custom build command for `zstd-sys v2.0.16+zstd.1.5.7`
#
# GitHub's ubuntu runners ship clang, which is why ci.yml never had to ask for
# it and this only ever broke on Vercel. docker/Dockerfile installs it
# explicitly in its web stage for the same reason.
#
# WHAT THIS IS NOT
#
# Not a PhysX or GPU problem. The first wasm-pack call -- vibe-land-shared, the
# Rapier client -- builds fine on Vercel today; the log shows it finishing and
# writing client/src/wasm/pkg. Only the debris codec fails.
#
# WHY NOT JUST DROP ZSTD ON THIS BUILD
#
# `--no-default-features` is already passed and does nothing here: zstd is an
# unconditional dependency, not a feature. Making it optional would not help
# either -- research/destruction-codec/src/wasm.rs:88 `push_payload` decodes
# compression==1 with a prepared zstd dictionary, so a zstd-less wasm cannot
# decode the live debris stream at all. And swapping in a pure-Rust zstd would
# move wire bytes, which the pinned `=0.13.3` and the byte tripwires exist to
# hold still.
set -euo pipefail

if command -v clang >/dev/null 2>&1; then
  echo "[vercel-install] clang already present: $(clang --version | head -1)"
else
  echo "[vercel-install] installing clang for the wasm32 zstd-sys build"
  # Vercel's build image is Amazon Linux; dnf on current images, yum on older.
  # Deliberately NOT swallowed with `|| true`: without clang the build fails
  # several minutes later with a confusing cc-rs error, and failing here says
  # what actually went wrong.
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y clang
  elif command -v yum >/dev/null 2>&1; then
    yum install -y clang
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y --no-install-recommends clang
  else
    echo "[vercel-install] no dnf/yum/apt-get available; cannot install clang." >&2
    exit 1
  fi
  clang --version | head -1
fi

npm --prefix client install
