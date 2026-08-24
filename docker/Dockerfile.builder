# Toolchain image: CUDA, a built PhysX 5 SDK, and the Blast checkout.
#
# Split from the runtime image not because PhysX is expensive to compile -- most
# of what lands here is a ~350 MB packman download of the prebuilt
# libPhysXGpu_64.so plus a short clang build of ~17 MB of static libs -- but
# because it is cached across every deploy while the runtime image is rebuilt
# per commit. It changes only when the SDK, the Blast fork, or Rust moves.
#
# Build:
#   docker buildx build -f docker/Dockerfile.builder \
#     -t ghcr.io/glavin001/vibe-land-builder:cuda12.8-physx-ovphysx-5.5.1 .
#
# The paths below are the defaults compiled into physx-bridge/build.rs, so the
# game server build needs no extra configuration.

FROM nvidia/cuda:12.8.1-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential clang lld cmake ninja-build git curl ca-certificates \
      pkg-config python3 libssl-dev \
 && rm -rf /var/lib/apt/lists/*

# Pinned toolchain: a compiler bump should be a deliberate commit, not a
# surprise the next time this image is built.
ARG RUST_VERSION=1.90.0
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y \
      --default-toolchain ${RUST_VERSION} --profile minimal
ENV PATH=/root/.cargo/bin:$PATH

# PhysX 5. `ovphysx-0.5.10` is the tag the reference box was built from; the
# release preset produces the static libs plus libPhysXGpu_64.so that
# physx-bridge links against.
ARG PHYSX_REF=ovphysx-0.5.10
RUN git clone https://github.com/NVIDIA-Omniverse/PhysX.git /root/PhysX \
 && cd /root/PhysX \
 && git checkout ${PHYSX_REF} \
 && cd physx \
 && ./generate_projects.sh linux-clang \
 && cmake --build compiler/linux-clang-release --parallel "$(nproc)" \
 && cmake --install compiler/linux-clang-release 2>/dev/null || true \
 # Drop intermediates but keep install/ and the shipped .so -- they are what
 # the runtime image copies out.
 && find /root/PhysX/physx/compiler -name '*.o' -delete \
 && rm -rf /root/PhysX/.git

# NVIDIA Blast fork with the stress solver. The repository is public, so this
# clones anonymously -- no build secret, which is what kept this image from
# ever being built in CI.
ARG BLAST_REF=feature/physx-gpu-destruction
RUN git clone https://github.com/Glavin001/blast-stress-solver \
      /root/workspace/blast-stress-solver \
 && cd /root/workspace/blast-stress-solver \
 && git checkout ${BLAST_REF} \
 && rm -rf .git

ENV PHYSX_ROOT=/root/PhysX/physx/install/linux-clang/PhysX \
    BLAST_ROOT=/root/workspace/blast-stress-solver/blast \
    CUDA_HOME=/usr/local/cuda
# Every GPU generation the fleet is likely to be scheduled onto: A100 (sm_80),
# A10/3090 (sm_86), 4090 (sm_89), H100 (sm_90). build.rs turns this into one
# -gencode per entry plus a PTX fallback, so a newer card JITs rather than
# failing to launch the stress kernel.
ENV VIBE_CUDA_ARCH=sm_80,sm_86,sm_89,sm_90

# Fail the build here rather than three stages later with a confusing linker
# error. The .cu file is asserted too: without it the `cuda-stress` feature
# panics in build.rs, and the whole point of this image is that the GPU stress
# solver is available.
RUN test -f "$PHYSX_ROOT/include/PxPhysicsAPI.h" \
 && test -f "$PHYSX_ROOT/bin/linux.x86_64/release/libPhysXGpu_64.so" \
 && test -d "$BLAST_ROOT" \
 && test -f "$BLAST_ROOT/source/sdk/extensions/stressgpu/NvBlastExtStressGpu.cu" \
 && test -f "$CUDA_HOME/bin/nvcc" \
 && ls "$CUDA_HOME"/lib64/libcudart.so.* >/dev/null
