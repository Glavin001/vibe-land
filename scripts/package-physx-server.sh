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

# The CUDA driver stub, for contract checks on a machine with no GPU.
#
# The binary has libcuda.so.1 as a hard DT_NEEDED -- physx-bridge links the
# driver -- so without one it cannot start at all, whatever VIBE_PHYSICS_BACKEND
# says: the loader fails before any of our code runs. On a real host the NVIDIA
# container runtime injects the driver.
#
# This goes in lib-stubs/, NOT lib/, and lib-stubs/ is deliberately absent from
# the LD_LIBRARY_PATH run.sh sets. Nothing loads it unless something opts in by
# naming it explicitly, which only `smoke-image.sh --cpu` does. On the path it
# would shadow the real driver -- though not silently: every entry point returns
# an error and PhysX has no CPU fallback, so it would fail loudly rather than
# quietly serve degraded physics.
stub="${cuda_home}/lib64/stubs/libcuda.so"
if [[ -f "${stub}" ]]; then
  mkdir -p "${output_dir}/lib-stubs"
  cp "${stub}" "${output_dir}/lib-stubs/libcuda.so.1"
else
  echo "warning: no CUDA driver stub at ${stub}; GPU-less contract checks will not run" >&2
fi

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
vibe_land_commit=${VIBE_LAND_COMMIT:-unknown}
EOF

# What the native code in this bundle was actually compiled from. The toolchain
# image records it because it deletes the checkouts' .git directories, so this
# is the only place the answer survives to the runtime image -- and Blast is
# pinned by branch, which names a moving target rather than a commit.
if [[ -f /opt/toolchain/sources.txt ]]; then
  cat /opt/toolchain/sources.txt >>"${output_dir}/manifest.txt"
else
  echo "physx_commit=unknown" >>"${output_dir}/manifest.txt"
  echo "blast_commit=unknown" >>"${output_dir}/manifest.txt"
fi

tar -C "$(dirname "${output_dir}")" -czf "${output_dir}.tar.gz" "$(basename "${output_dir}")"
echo "Packaged ${output_dir}.tar.gz"
