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

FROM ${BUILDER_IMAGE} AS build
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

FROM ubuntu:24.04
ARG BUNDLE_STAGE=build
ENV DEBIAN_FRONTEND=noninteractive
# iproute2 is only for the entrypoint's last-resort local-address lookup when
# a standalone host has no route to an IP echo service.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl openssl libstdc++6 libssl3t64 iproute2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/vibe-land
COPY --from=${BUNDLE_STAGE} /out/ ./
COPY docker/entrypoint.sh /opt/vibe-land/entrypoint.sh
RUN chmod +x /opt/vibe-land/entrypoint.sh /opt/vibe-land/run.sh

# Ask Vast's container runtime for the GPU and the driver libraries. `compute`
# covers CUDA; `utility` brings nvidia-smi along for debugging a sick box.
ENV NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    BIND_ADDR=0.0.0.0:4001 \
    WT_BIND_ADDR=0.0.0.0:4433 \
    MATCHES_PER_BOX=6

# Declared here and published at instance creation. Vast maps each to a random
# external port; the entrypoint reads the mapping back out of the environment.
EXPOSE 4001/tcp 4433/udp

# Generous start period: PhysX validates its CUDA scene before binding, and a
# cold GPU context takes a few seconds.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:4001/healthz || exit 1

ENTRYPOINT ["/opt/vibe-land/entrypoint.sh"]
