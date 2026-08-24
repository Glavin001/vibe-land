#!/usr/bin/env bash
# Package the GPU game server into a self-contained bundle.
#
# The bundle is what the runtime image copies in: the binary, every shared
# library the host will not provide, the destruction scenes, and a run.sh that
# points the loader at them. The one library deliberately *not* bundled is
# libcuda.so.1 -- that is the driver, it comes from the host through the NVIDIA
# container runtime, and a copy here would shadow it.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
physx_root="${PHYSX_ROOT:-/root/PhysX/physx/install/linux-clang/PhysX}"
cuda_home="${CUDA_HOME:-${CUDA_PATH:-/usr/local/cuda}}"
output_dir="${1:-${repo_root}/dist/physx-server}"
physx_lib_dir="${physx_root}/bin/linux.x86_64/release"
target_dir="${CARGO_TARGET_DIR:-${repo_root}/target}"
cargo_bin="${CARGO:-cargo}"
if [[ "${target_dir}" != /* ]]; then
  target_dir="${repo_root}/${target_dir}"
fi

cd "${repo_root}"
# cuda-stress, not destruction. Without it NVBLAST_ENABLE_CUDA_STRESS is
# undefined, the CUDA stress path is compiled out, and the solver silently runs
# on the CPU -- which cannot afford to converge. Measured on the dense
# downtown: CPU broke 7,024 bonds where the GPU broke 3,283 on the same
# scenario. The extra breakage is solver residual, not physics.
"${cargo_bin}" build --locked --release -p web-fps-server --features cuda-stress

rm -rf "${output_dir}"
mkdir -p "${output_dir}/bin" "${output_dir}/lib" "${output_dir}/assets/scenes"
cp "${target_dir}/release/web-fps-server" "${output_dir}/bin/"
cp "${physx_lib_dir}/libPhysXGpu_64.so" "${output_dir}/lib/"
cp "${repo_root}"/destruction/assets/scenes/*.json "${output_dir}/assets/scenes/"

# The CUDA runtime. build.rs rpaths the toolkit's lib64 for the local build,
# but that directory does not exist on the runtime image's plain Ubuntu base,
# so the versioned soname has to travel with the binary.
shopt -s nullglob
cudart=("${cuda_home}"/lib64/libcudart.so.*)
shopt -u nullglob
if (( ${#cudart[@]} == 0 )); then
  echo "no libcudart under ${cuda_home}/lib64 -- the cuda-stress build needs it at runtime" >&2
  exit 1
fi
cp -P "${cudart[@]}" "${output_dir}/lib/"

cat >"${output_dir}/run.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="${root}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
# Overridable so the image can be booted for a contract check on a machine with
# no GPU (VIBE_PHYSICS_BACKEND=rapier); the default is the reason it exists.
export VIBE_PHYSICS_BACKEND="${VIBE_PHYSICS_BACKEND:-physx_gpu}"
export WT_STRICT_SNAPSHOT_DATAGRAMS="${WT_STRICT_SNAPSHOT_DATAGRAMS:-1}"
export VIBE_DESTRUCTION_ASSET_DIR="${VIBE_DESTRUCTION_ASSET_DIR:-${root}/assets/scenes}"
exec "${root}/bin/web-fps-server" "$@"
EOF
chmod +x "${output_dir}/run.sh"

cat >"${output_dir}/manifest.txt" <<EOF
physics_backend=physx_gpu
destruction=true
stress_solver=gpu
gpu_required=true
sim_hz=60
snapshot_hz=60
strict_snapshot_datagrams=true
physx_root=${physx_root}
cuda_arch=${VIBE_CUDA_ARCH:-sm_89}
EOF

tar -C "$(dirname "${output_dir}")" -czf "${output_dir}.tar.gz" "$(basename "${output_dir}")"
echo "Packaged ${output_dir}.tar.gz"
