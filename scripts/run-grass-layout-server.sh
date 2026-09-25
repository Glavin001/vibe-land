#!/usr/bin/env bash
# Content-only development service. Does not stop or reset a running city.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"
key_file="$repo_dir/.env.grass.local"
if [[ ! -f "$key_file" ]]; then
  (umask 077; printf 'VIBE_GRASS_EDIT_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$key_file")
fi
set -a
source "$key_file"
set +a
export GRASS_BIND_ADDR="${GRASS_BIND_ADDR:-127.0.0.1:4183}"
cargo build -p web-fps-server --bin grass-layout-server
exec "$repo_dir/target/debug/grass-layout-server"
