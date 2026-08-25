---
name: server-image
description: Build, publish and verify the GPU game server Docker image, including the CUDA/PhysX/Blast toolchain image it compiles against. Use when changing docker/, the packaging script, or the CI image workflows, when an image build fails, or when you need to prove which source commits a published tag was built from.
---

# Building and publishing the server image

Two images, deliberately split:

| Image | Contents | Rebuilt |
| --- | --- | --- |
| `vibe-land-builder` | CUDA 12.8 + built PhysX 5 SDK + Blast checkout + Rust + Node 22/wasm-pack + `vibe-clone` | only when `docker/Dockerfile.builder` or `docker/vibe-clone` changes |
| `vibe-land-server` | the game server, client bundle, scenes — on plain Ubuntu | every commit |

The split exists because the toolchain (~19 GB) is cached across deploys while
the runtime image (~657 MB) is rebuilt per commit. Image pull time is the
dominant term in cold start, and a player waits through it.

The builder feeds **both** compiling stages of `docker/Dockerfile` — `build` for
the server and `web` for the client — and doubles as the rented dev box (see the
`vastai-deploy` skill). That is why it carries Node: a third image existed for
the dev case and was deleted, because it was this one plus four `RUN` lines.

**The builder caches to a registry, not `type=gha`.** GitHub's Actions cache is
capped at 10 GB per repo and this image is roughly twice that, so a gha cache
evicts itself. It uses `type=registry,ref=...:buildcache,mode=max` on GHCR
instead. Keep the expensive layers (PhysX, ~15 min) above anything you add —
everything appended after them is then free to change.

## CI is the normal path

| Workflow | Trigger | Publishes |
| --- | --- | --- |
| `.github/workflows/builder-image.yml` | `docker/Dockerfile.builder` changes, or dispatch | `vibe-land-builder:cuda12.8-physx-ovphysx-5.5.1` |
| `.github/workflows/server-image.yml` | any push (branches-ignore main), dispatch, or `workflow_call` | `vibe-land-server:sha-<12>` |
| `.github/workflows/deploy.yml` | push to `main` | calls `server-image.yml`, then the Worker |

`deploy.yml` calls `server-image.yml` through `workflow_call`, so **what deploys
is exactly what a branch exercised** — there is one definition of the build.

A branch push publishes `sha-<12>` and runs a `verify` job. `latest` moves only
on `main`; prefer a `sha-` tag so a rollback is unambiguous.

## Building locally

Requires Docker with BuildKit. **A Vast instance cannot do this** — it is itself
a container without nesting privileges.

```bash
./scripts/build-image.sh                 # tag from the current commit
./scripts/build-image.sh v0.2.0 --push
./scripts/build-image.sh --prebuilt      # use dist/physx-server from the host
```

`--prebuilt` selects a bundle already built by
`scripts/package-physx-server.sh`, so a developer with a working PhysX
toolchain can test the runtime image without pulling the multi-gigabyte
builder.

## Verifying an image

```bash
./scripts/smoke-image.sh <tag>          # on a GPU host
./scripts/smoke-image.sh --cpu <tag>    # what CI runs; drops the two GPU assertions
./scripts/smoke-entrypoint.sh           # entrypoint contract only, no Docker needed
```

The smoke suite asserts, in order:

1. bundle complete — binary, `libPhysXGpu_64.so`, `libcudart`, six scenes, entrypoint
2. every shared library resolves (except `libcuda.so.1`, host-injected)
3. Vast without a port mapping → **exits 78**
4. starts, serves `/healthz`
   - **4b.** unreachable advertised endpoint in fatal mode → **exits 78 and says why**
5. advertises the external endpoint + a 64-hex certificate hash
6. serves the client over TLS at `/city`, `/session-config` same-origin

`--cpu` exists so CI and a GPU host run the *same* script rather than two
divergent ones.

## Proving what a tag was built from

The `sha-` tag names the vibe-land commit only. The native code comes from the
toolchain image, and **`BLAST_REF` is a branch** — a moving target — so two
builds of the same toolchain tag can contain different Blast code.

```bash
docker run --rm --entrypoint cat \
  ghcr.io/glavin001/vibe-land-server:<tag> /opt/vibe-land/manifest.txt
```

```
physics_backend=physx_gpu
stress_solver=gpu
cuda_arch=sm_70,sm_75,sm_80,sm_86,sm_89,sm_90,sm_100,sm_120
vibe_land_commit=<40 hex>
physx_ref=ovphysx-0.5.10      physx_commit=<40 hex>
blast_ref=feature/physx-gpu-destruction   blast_commit=<40 hex>
```

`unknown` for the physx/blast commits means the image was built against a
toolchain published before commit stamping — rebuild `builder-image`, then the
server image.

The vibe-land commit is also an OCI label:

```bash
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' <tag>
```

## Things that have broken this build before

Each of these cost real time; none is obvious from the error.

- **`COPY --from=` rejects a variable.** BuildKit expands variables in `FROM`
  but not in `COPY --from`. Use a global-scope `ARG` plus an indirection stage.
- **`a && b || true` binds `|| true` to the whole chain.** A failed clone,
  configure and build all went green. Keep `|| true` on its own layer.
- **`generate_projects.sh` exits 0 even when its cmake configure failed.**
  Assert the generated `Makefile` exists rather than trusting the exit status.
- **PhysX snippets need a GL/GLX stack.** They are OpenGL demos; we build the
  SDK, so `PX_BUILDSNIPPETS` is turned off in the preset.
- **GHCR repository names must be lowercase.** `github.repository_owner` is
  `Glavin001`; fold it before interpolating into a tag.
- **`libcuda.so.1` is a hard `DT_NEEDED`** on the binary, so the loader kills
  the process before `VIBE_PHYSICS_BACKEND` is read. The CUDA stub lives in
  `lib-stubs/`, deliberately **off** `LD_LIBRARY_PATH`.
- **`libcudart` must travel in the bundle.** Its rpath is the CUDA toolkit's
  `lib64`, which does not exist on the runtime image's Ubuntu base.
- **Never bundle `libcuda.so.1`** — that is the driver, injected by the NVIDIA
  container runtime, and a copy would shadow it.
- **The client wasm needs `clang`.** `zstd` builds through `cc-rs`, gcc cannot
  target wasm32, and `node:22-bookworm` does not ship clang. The `web` stage is
  now `FROM ${BUILDER_IMAGE}`, which has clang — but if it is ever moved back to
  a Node base, clang has to come with it.
- **The client compiles under the builder's pinned Rust 1.90.0**, not rustup
  stable. `shared` and `research/destruction-codec` are workspace members the
  server build already compiles at that version, so this is expected to be
  inert — but a wasm crate that needs a newer rustc would fail here first.
- **`.dockerignore` must not exclude `worlds/`** — `shared/src/world_document.rs`
  `include_str!`s it at compile time.
- **rustls panics rather than erroring** when no process-level `CryptoProvider`
  is installed. `cargo check` cannot see it; only running the container can.
- `scripts/package-physx-server.sh` must build **`--features cuda-stress`**, not
  `destruction`. The latter compiles out `NVBLAST_ENABLE_CUDA_STRESS` and
  silently runs the CPU stress solver.

## GPU architecture coverage

`VIBE_CUDA_ARCH` lives in `docker/Dockerfile`, not the toolchain image — which
GPUs the fleet may land on is a property of the deployment, so widening it costs
one server build rather than a toolchain rebuild.

Default `sm_70,sm_75,sm_80,sm_86,sm_89,sm_90,sm_100,sm_120` (Volta → Blackwell),
plus PTX at the highest entry. **PTX only ever JITs forward**, so a card below
`sm_70` cannot run this image at all. Pascal and Maxwell are deliberately out.
