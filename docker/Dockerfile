# The game server image that runs on rented GPU boxes.
#
# Two stages: compile against the prebuilt toolchain image, then copy just the
# artifacts onto a plain Ubuntu base. Image pull time is the dominant term in
# cold start -- a player is waiting through it -- so the CUDA toolkit, the PhysX
# sources, and the Rust toolchain must not travel to production. The result is
# ~400 MB instead of ~15 GB.
#
# Build:  scripts/build-image.sh
# Run:    scripts/smoke-image.sh <tag>

ARG BUILDER_IMAGE=ghcr.io/glavin001/vibe-land-builder:cuda12.8-physx-ovphysx-5.5.1
# Global scope on purpose: `COPY --from=` rejects a variable, but `FROM` accepts
# one, so the choice of bundle source is made by the indirection stage below.
ARG BUNDLE_STAGE=build

FROM ${BUILDER_IMAGE} AS build
# Which GPUs the CUDA stress kernel gets native code for. This is a decision
# about what the fleet may be scheduled onto, not a property of the toolchain,
# so it lives here rather than in the builder image.
#
# The floor is Volta (sm_70). Below that there is no cubin and PTX cannot help:
# PTX only ever JITs *forward*, so a compute_70 image cannot run on sm_61. The
# ceiling is Blackwell -- sm_100 (B200) and sm_120 (RTX 50xx), both of which
# CUDA 12.8 introduced. build.rs also emits PTX for the highest entry, so a card
# newer than anything listed still JITs rather than failing to launch.
#
# Concretely this covers: V100/T4/RTX 20xx (sm_70/75), A100 (80), A10/A40/RTX
# 30xx (86), L4/L40/RTX 40xx (89), H100 (90), B200 (100), RTX 50xx (120).
ARG VIBE_CUDA_ARCH=sm_70,sm_75,sm_80,sm_86,sm_89,sm_90,sm_100,sm_120
ENV VIBE_CUDA_ARCH=${VIBE_CUDA_ARCH}
# .dockerignore excludes .git, so the build cannot read its own commit; it is
# passed in and lands in the bundle manifest next to the PhysX and Blast
# commits the toolchain image recorded. All three answer "what is in this
# image", which was previously not answerable from the image at all.
ARG VIBE_LAND_COMMIT=unknown
ENV VIBE_LAND_COMMIT=${VIBE_LAND_COMMIT}
WORKDIR /src
COPY . .
# The CUDA driver library is not present on a build machine with no GPU. The
# stubs directory satisfies the linker; at runtime the real driver arrives from
# the host through Vast's NVIDIA container runtime. The stubs must never reach
# the runtime image or they would shadow it.
RUN RUSTFLAGS="-L /usr/local/cuda/lib64/stubs" \
    bash scripts/package-physx-server.sh /out

# Alternative bundle source: one already built on the host by
# scripts/package-physx-server.sh. Lets a developer with a working PhysX
# toolchain build and smoke-test the real runtime image without pulling the
# multi-gigabyte CUDA builder. Selected by `scripts/build-image.sh --prebuilt`;
# BuildKit skips the stage above entirely when it is not referenced.
FROM scratch AS prebuilt
COPY dist/physx-server/ /out/

# The web client, built into the image so a box someone rents is playable on its
# own. Node rather than the toolchain image because this stage needs npm; the
# wasm-pack installer fetches a prebuilt binary, which is far quicker than
# `cargo install`.
FROM node:22-bookworm AS web
# clang, because the client's wasm pulls in zstd -- a C library built through
# cc-rs. gcc cannot target wasm32, so cc-rs reaches for clang specifically and
# fails with `failed to find tool "clang"` without it. This is what breaks the
# Vercel build of the same bundle.
RUN apt-get update && apt-get install -y --no-install-recommends clang \
 && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
      --target wasm32-unknown-unknown
ENV PATH=/root/.cargo/bin:$PATH
RUN curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
WORKDIR /src
COPY . .
# `build` runs gen:constants, wasm-pack and vite in turn -- the same sequence
# ci.yml uses, so the bundle here matches the deployed one.
RUN cd client && npm ci --no-audit --no-fund && npm run build

# Resolves to whichever of the two stages above was selected. BuildKit builds
# only the one this points at and skips the other entirely.
FROM ${BUNDLE_STAGE} AS bundle

FROM ubuntu:24.04
ARG VIBE_LAND_COMMIT=unknown
LABEL org.opencontainers.image.source=https://github.com/Glavin001/vibe-land \
      org.opencontainers.image.revision=${VIBE_LAND_COMMIT}
ENV DEBIAN_FRONTEND=noninteractive
# iproute2 is only for the entrypoint's last-resort local-address lookup when
# a standalone host has no route to an IP echo service.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl openssl libstdc++6 libssl3t64 iproute2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/vibe-land
COPY --from=bundle /out/ ./
COPY --from=web /src/client/dist/ /opt/vibe-land/web/
COPY docker/entrypoint.sh /opt/vibe-land/entrypoint.sh
RUN chmod +x /opt/vibe-land/entrypoint.sh /opt/vibe-land/run.sh

# Ask Vast's container runtime for the GPU and the driver libraries. `compute`
# covers CUDA; `utility` brings nvidia-smi along for debugging a sick box.
ENV NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    BIND_ADDR=0.0.0.0:4001 \
    WT_BIND_ADDR=0.0.0.0:4433 \
    WEB_BIND_ADDR=0.0.0.0:4443 \
    MATCHES_PER_BOX=6

# Declared here and published at instance creation. Vast maps each to a random
# external port; the entrypoint reads the mapping back out of the environment.
EXPOSE 4001/tcp 4443/tcp 4433/udp

# Generous start period: PhysX validates its CUDA scene before binding, and a
# cold GPU context takes a few seconds.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:4001/healthz || exit 1

ENTRYPOINT ["/opt/vibe-land/entrypoint.sh"]
