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
# `set -e` and a separate install line, because `a && b || true` binds the
# `|| true` to the whole preceding chain -- which is how a failed cmake
# configure previously produced a green layer and an empty build tree.
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN git clone https://github.com/NVIDIA-Omniverse/PhysX.git /root/PhysX \
 && cd /root/PhysX \
 && git checkout ${PHYSX_REF} \
 # Recorded now, because .git is deleted two layers down and a tag is not a
 # commit -- a moved tag would otherwise be invisible in the finished image.
 && mkdir -p /opt/toolchain \
 && echo "physx_ref=${PHYSX_REF}" > /opt/toolchain/sources.txt \
 && echo "physx_commit=$(git rev-parse HEAD)" >> /opt/toolchain/sources.txt \
 && cd physx \
 # The snippets are OpenGL demos. They want a GL/GLX dev stack this image has
 # no use for, and without one cmake configure fails outright -- while
 # generate_projects.sh still exits 0, so the failure only surfaces much later.
 # We build the SDK, not the demos.
 && sed -i 's/\("PX_BUILDSNIPPETS" *value=\)"True"/\1"False"/' \
      buildtools/presets/public/linux-clang.xml \
 && grep -q 'PX_BUILDSNIPPETS" value="False"' buildtools/presets/public/linux-clang.xml \
 && ./generate_projects.sh linux-clang \
 # generate_projects.sh swallows a cmake configure error, so check its output
 # exists rather than trusting its exit status.
 && test -f compiler/linux-clang-release/Makefile \
 && cmake --build compiler/linux-clang-release --parallel "$(nproc)"
# Separate layer so its `|| true` cannot swallow the build above. Some presets
# have no install target and stage the tree during the build instead; the
# assertion at the end of this file is what actually decides.
RUN cmake --install /root/PhysX/physx/compiler/linux-clang-release 2>/dev/null || true
# Drop intermediates but keep install/ and the shipped .so -- they are what the
# runtime image copies out.
RUN find /root/PhysX/physx/compiler -name '*.o' -delete \
 && rm -rf /root/PhysX/.git

# NVIDIA Blast fork with the stress solver. The repository is public, so this
# clones anonymously -- no build secret, which is what kept this image from
# ever being built in CI.
ARG BLAST_REF=feature/physx-gpu-destruction
RUN git clone https://github.com/Glavin001/blast-stress-solver \
      /root/workspace/blast-stress-solver \
 && cd /root/workspace/blast-stress-solver \
 && git checkout ${BLAST_REF} \
 # BLAST_REF is a branch, so it names a moving target. The commit is the only
 # thing that says what this image actually contains -- and `rm -rf .git` below
 # is what previously made that unanswerable after the fact.
 && echo "blast_ref=${BLAST_REF}" >> /opt/toolchain/sources.txt \
 && echo "blast_commit=$(git rev-parse HEAD)" >> /opt/toolchain/sources.txt \
 && rm -rf .git \
 && cat /opt/toolchain/sources.txt

ENV PHYSX_ROOT=/root/PhysX/physx/install/linux-clang/PhysX \
    BLAST_ROOT=/root/workspace/blast-stress-solver/blast \
    CUDA_HOME=/usr/local/cuda
# Default for builds that run directly in this image (a dev box compiling by
# hand). The server image overrides it -- see docker/Dockerfile, which owns the
# decision about which GPUs the fleet may land on.
ENV VIBE_CUDA_ARCH=sm_70,sm_75,sm_80,sm_86,sm_89,sm_90,sm_100,sm_120

# Fail the build here rather than three stages later with a confusing linker
# error. The .cu file is asserted too: without it the `cuda-stress` feature
# panics in build.rs, and the whole point of this image is that the GPU stress
# solver is available.
RUN test -f "$PHYSX_ROOT/include/PxPhysicsAPI.h" \
 && test -f "$PHYSX_ROOT/bin/linux.x86_64/release/libPhysXGpu_64.so" \
 && test -d "$BLAST_ROOT" \
 && test -f "$BLAST_ROOT/source/sdk/extensions/stressgpu/NvBlastExtStressGpu.cu" \
 && test -f "$CUDA_HOME/bin/nvcc" \
 && ls "$CUDA_HOME"/lib64/libcudart.so.* >/dev/null \
 && grep -q '^blast_commit=[0-9a-f]\{40\}$' /opt/toolchain/sources.txt \
 && grep -q '^physx_commit=[0-9a-f]\{40\}$' /opt/toolchain/sources.txt
