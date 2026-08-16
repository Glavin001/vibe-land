# Toolchain image: CUDA, a built PhysX 5 SDK, and the Blast checkout.
#
# Split from the runtime image because building PhysX takes tens of minutes and
# changes only when the SDK or toolchain is bumped -- perhaps a few times a
# year. Rebuilding it per commit would dominate every deploy.
#
# Build (needs a token with read access to the private Blast repo):
#   echo "$BLAST_TOKEN" | docker buildx build -f docker/Dockerfile.builder \
#     --secret id=gh_token,src=/dev/stdin \
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

# NVIDIA Blast fork with the stress solver. Private, so the token arrives as a
# BuildKit secret: it is never written to a layer, unlike an ARG or ENV.
ARG BLAST_REF=main
RUN --mount=type=secret,id=gh_token \
    git clone "https://x-access-token:$(cat /run/secrets/gh_token)@github.com/Glavin001/blast-stress-solver" \
      /root/workspace/blast-stress-solver \
 && cd /root/workspace/blast-stress-solver \
 && git checkout ${BLAST_REF} \
 # Strip the credentialed remote so no token survives in the image's git config.
 && git remote set-url origin https://github.com/Glavin001/blast-stress-solver \
 && rm -rf .git

ENV PHYSX_ROOT=/root/PhysX/physx/install/linux-clang/PhysX \
    BLAST_ROOT=/root/workspace/blast-stress-solver/blast \
    VIBE_CUDA_ARCH=sm_89

# Fail the build here rather than three stages later with a confusing linker error.
RUN test -f "$PHYSX_ROOT/include/PxPhysicsAPI.h" \
 && test -f "$PHYSX_ROOT/bin/linux.x86_64/release/libPhysXGpu_64.so" \
 && test -d "$BLAST_ROOT"
