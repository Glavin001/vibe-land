#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
physx_root="${PHYSX_ROOT:-/root/PhysX/physx/install/linux-clang/PhysX}"
output_dir="${1:-${repo_root}/dist/physx-server}"
physx_lib_dir="${physx_root}/bin/linux.x86_64/release"
target_dir="${CARGO_TARGET_DIR:-${repo_root}/target}"
cargo_bin="${CARGO:-cargo}"
if [[ "${target_dir}" != /* ]]; then
  target_dir="${repo_root}/${target_dir}"
fi

cd "${repo_root}"
"${cargo_bin}" build --locked --release -p web-fps-server --features destruction

rm -rf "${output_dir}"
mkdir -p "${output_dir}/bin" "${output_dir}/lib" "${output_dir}/assets/scenes"
cp "${target_dir}/release/web-fps-server" "${output_dir}/bin/"
cp "${physx_lib_dir}/libPhysXGpu_64.so" "${output_dir}/lib/"
cp "${repo_root}"/destruction/assets/scenes/*.json "${output_dir}/assets/scenes/"

cat >"${output_dir}/run.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="${root}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
export VIBE_PHYSICS_BACKEND=physx_gpu
export WT_STRICT_SNAPSHOT_DATAGRAMS=1
export VIBE_DESTRUCTION_ASSET_DIR="${root}/assets/scenes"
exec "${root}/bin/web-fps-server" "$@"
EOF
chmod +x "${output_dir}/run.sh"

cat >"${output_dir}/manifest.txt" <<EOF
physics_backend=physx_gpu
destruction=true
gpu_required=true
sim_hz=60
snapshot_hz=60
strict_snapshot_datagrams=true
physx_root=${physx_root}
EOF

tar -C "$(dirname "${output_dir}")" -czf "${output_dir}.tar.gz" "$(basename "${output_dir}")"
echo "Packaged ${output_dir}.tar.gz"
