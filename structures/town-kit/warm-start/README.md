# Independent buildings and baked stress guesses

`out/bayline-proven-36.vlsp` selects the first 36 exact placements from the
67-building deployed town: 24 homes/bungalows and 12 shops. It preserves their
world positions, rotations, materials and numeric geometry records byte for byte.
Original street/paving geometry is the 37th independent structure. Counts are
84,774 chunks and 178,568 bonds; the cold file is 7,422,944 bytes with 17 templates.

The original town has 67 building placements and 33 distinct building geometry
templates, plus two ground templates. Paint variants can reuse geometry. Each
placement has independent physics; the loader never groups unrelated buildings
to fill a chunk budget. The body ID allocation supports 255 structures, retaining
65,536 chunks and 1,048,576 bonds per structure. Client/server builds must agree
on the new body ID allocation (eight structure bits, twenty body-serial bits).

## Actual qualification

The pinned original native audit completed all 67 exact building placements:
64 passed convergence plus 30 seconds of simulated intact physical rest. Workshops
55 and 57 remained unconverged with an awake office table. Workshop 64 eventually
converged, but too late to complete the 30-second observation within the 90-second
case limit. It also fails the gate. No missing observation is treated as success.

The selected 36-building assembled scene passed both cold and warm intact tests.
Cold first convergence was tick 62; warm first convergence was tick 58. The first
step was unconverged in both. These are shared-machine diagnostic measurements,
not a demonstrated startup speedup. Saved stress forces do not restore body poses
or remove the initial contact settling of loose furniture.

`out/reviews/proven-36-latest.json` points to the authoritative campaign. Its
`review.json` includes per-case results and exact scene/runtime/executable hashes.
The warm artifact is published to `out/bayline-proven-36.vlsw` only after bake,
fresh binary reload, 30-second intact observation and a targeted table-destruction
case all pass. The damage case must return to converged physical rest and must
not break bonds in another building. Broader destruction and whole-town traversal
qualification remain separate; this is not a claim that every original town-kit
acceptance gate is complete. The live `/city` scene is not changed by these tools.

The native/Rust entity-ID parity check passes across all 255 structure IDs and
serial boundaries. The SDK's complete 600-step frozen wall-penetration assertions
also pass: 199 broken bonds, 43 final clusters, exact golden topology identity,
and convergence on every step. The existing verifier only reads TWSTATE v2; the
private `verify-sdk-capture.py` adapter reads the v3 rendering-group field while
leaving every physical assertion and the golden unchanged.

Workshop follow-up candidates remain unpromoted. A 15 cm table shift passed
10/12 workshop placements but still failed 55 and 64. A 45 mm oak wearing layer
(with the same total 180 mm slab depth) passed 55 and 57 but still failed 64.
`review-workshop-floor.mjs` generates that candidate from private source copies,
without changing the production authoring files. These results do not retroactively
turn the three original failed assets into passing assets.

The final workshop-64 follow-up also failed: raising the diagnostic solve budget
to 32 caused 16 spontaneous bond breaks at tick 1. Combining the thicker wearing
layer and table shift at the normal 16 iterations left one body awake and the
stress solver unconverged at the 90-second limit. Neither candidate is promoted.
`review-workshop64.mjs` preserves these isolated experiments.

The optional SDK extension is committed at `cc31f0e1` in the sibling `physx-2`
repository. The runtime actually used for qualification is bound by its SHA-256
in `results.json`; the installed SDK runtime was not overwritten.

## Build, review and preview

Run from the repository root. Dependencies are cached privately inside the kit;
no shared application generation commands or SDK installation are required.

```sh
node structures/town-kit/warm-start/build-proven-town.mjs
cmake -S structures/town-kit/warm-start/sdk-runtime \
  -B structures/town-kit/out/warm-runtime \
  -DCMAKE_CUDA_COMPILER=/usr/local/cuda-12.8/bin/nvcc -DCMAKE_BUILD_TYPE=Release
cmake --build structures/town-kit/out/warm-runtime --target PhysXDestructionGpuRuntime -j2
CARGO_HOME="$PWD/structures/town-kit/out/cargo-home" \
CARGO_TARGET_DIR="$PWD/structures/town-kit/native/target" CUDA_HOME=/usr/local/cuda-12.8 \
  cargo build --offline --locked --release \
  --manifest-path structures/town-kit/warm-start/native/Cargo.toml
node structures/town-kit/warm-start/review-proven-town.mjs
node structures/town-kit/warm-start/preview-proven-town.mjs
node structures/town-kit/scripts/preview.mjs
```

Preview: `http://127.0.0.1:6174/?asset=bayline-proven-36`. The preview-export script
also stages matching recordings for the existing stability/furniture playback UI.
A resumed campaign accepts its **absolute** review directory as its first argument;
completed passing cases are reused only if input, executable and runtime hashes
still match. Interrupted cases get a new directory while their partial logs stay.
Do not rebuild a runtime library that a running review has loaded.

`audit.mjs` runs the original exact-placement audit and accepts an absolute audit
directory to resume completed cases. `review-workshop-contact.mjs` waits for the
kit GPU lock, then tests moving workshop office tables 15 cm off floor seams in
all twelve workshop placements. Candidate assets and recordings remain isolated;
it does not edit the deployed town or weaken any physical setting.

`test-bundle.mjs` checks deterministic JS/Rust f32 equality, placement binding,
partial coverage, mismatched settings and malformed-cache rejection. It uses the
independent `binary-review` executable. `review.mjs BUILDING_ID` supports a single
passing-building pilot; its output explicitly does not qualify the complete town.

## Deployment runtime selection

`vast-city.py` accepts `PHYSX_DESTRUCTION_RUNTIME_DIR` to select a private native
runtime alongside the installed SDK libraries. This directory persists with the
scene across bare redeploys. For the reviewed warm scene, stage the exact runtime
whose hash is recorded in `results.json`, then set this variable and
`VIBE_CITY_SCENE` to `out/bayline-proven-36.vlsw` when invoking the normal deployment
helper. Confirm the server logs `imported warm guesses` for 37 structures; a
runtime/settings mismatch is a cold fallback, not a successful warm deployment.

## VLSW v1 file contract

The container embeds the unchanged VLSP scene plus six little-endian f32 values
per expanded bond: angular xyz, linear xyz in physical units, in original native
creation order. Values use each exact placement's authored stress frame. They are
not blindly copied between rotations or differently normalized graphs.

64-byte prefix, UTF-8 descriptor padded with zeros to eight bytes, complete VLSP,
then the f32 array. Prefix u32 fields at offsets 4/8/12/16 are version (1),
descriptor bytes, VLSP bytes, and scalar count. Bytes 20–31 are zero. Bytes 32–63
are SHA-256 of all bytes after the prefix. Descriptor fields include the cold
scene SHA-256, loaded runtime SHA-256, SDK provenance hash, gravity, timestep,
tolerance, and each placement's node/bond counts, value offset and evidence hash.
Missing placement guesses must be explicit zero arrays with `baked:false`.

Readers reject malformed lengths, unsupported settings, changed scene hashes,
non-finite forces and mismatched placement ranges. The server uses one immutable
scene byte snapshot for manifest/material/cache loading. A runtime or settings
mismatch logs an explicit cold start. Import errors after compatibility checking
fail startup. Ordinary VLSP and JSON scenes still load without the extension.

The optional native C ABI is documented in
`physx-2/physx/include/PxDestructionWarmStart.h`. It adds functions, not virtual
methods. The bridge resolves them from the already-loaded runtime. Import is
allowed once before the first native stress step; no convergence flag or settled
certificate is imported. The next step checks actual loads and residuals normally.
Older SDKs continue supporting cold scenes. The private new library must be first
in `LD_LIBRARY_PATH` when loading a warm artifact with the matching runtime hash.
