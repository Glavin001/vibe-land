# vibe-land PhysX bridge

This workspace crate owns the optional in-process C++ PhysX world. The default
build is a dependency-free Rust stub and reports `BridgeError::Unavailable`.
It never pretends that GPU physics is active.

```sh
cargo check -p vibe-land-physx-bridge
PHYSX_ROOT=/root/PhysX/physx/install/linux-clang/PhysX \
  cargo test -p vibe-land-physx-bridge --features gpu
```

The `gpu` build requires the PhysX headers, static core/extensions/cooking/CCT
libraries, and `libPhysXGpu_64.so`. `build.rs` embeds an rpath to the selected
PhysX release directory and links the CUDA driver. At runtime `World::new` requires a valid CUDA context,
creates a HelloGRB-style GPU scene, and dispatches a startup simulation frame.
Any failure is returned explicitly; there is no CPU PhysX fallback.

Rust sees only stable `u32` entity IDs, POD descriptors/results, and an opaque
`World`. All PhysX pointers and release ordering stay in C++.

## macOS (Apple Silicon, Metal)

The same features build on macOS against the PhysX fork's CuMetal package, which
runs PhysX's CUDA kernels on Metal. `build.rs` picks the platform from the target:
`.dylib` names, `libcumetal` in place of `libcuda`/`libcudart`, CuMetal's CUDA
headers, and `PX_CUMETAL=1`.

**The package.** The fork is `Glavin001/PhysX`, branch
`codex/cumetal-destruction`, checked out beside this repository
(`../PhysX`); it runs on CuMetal (`cuda-metal`, branch
`codex/physx-metal-integration`). Build the package there with
`tools/scripts/build-destruction-sdk.py`, as its `docs/destruction/BUILD.md`
describes ("macOS package for external consumers"). It installs to
`out/install/macos-cumetal/release`, which every build and harness on the
machine shares.

**Finding it.** `build.rs` resolves `<checkout>/../PhysX` by itself, so the main
checkout needs no variable. A worktree under `.claude/worktrees/` does: its
`../PhysX` does not exist and the build panics with "no PhysX destruction SDK".
Set `PHYSX_DESTRUCTION_SDK` to the PhysX checkout, or `PHYSX_ROOT` to the
install prefix itself:

```sh
export PHYSX_DESTRUCTION_SDK=/Users/glavin/Development/PhysX
# or: export PHYSX_ROOT=/Users/glavin/Development/PhysX/out/install/macos-cumetal/release
```

The binary links the package's dylibs (`libPhysXGpuActivity_64`,
`libcumetal`) through an rpath into that prefix, so it runs with no library
path set.

**After a package rebuild, rebuild every binary.** The bridge compiles against
the package's headers and static libraries and loads its dylibs at run time. A
package with a new `PX_DESTRUCTION_SCENE_VERSION` changes the stage's structs
(v18 appended `fragmentMaxDepenetrationVelocity` to
`PxDestructionStressDesc`), and a server or test binary built before it
crashes against the new dylibs. `cargo build` notices on its own: `build.rs`
reruns when the static libraries, the destruction header or the GPU runtime
change. What does not notice is a binary run without cargo: a
`--no-build` harness, `BENCH_BIN=<test binary>`, or a copy. `build.rs`
accepts scene versions 15 to 18 and fails the build on any other.

**Building and testing.** GPU work takes the machine-wide lock
(`scripts/perf/gpu-run.sh`, see [.claude/skills/run-locally](../.claude/skills/run-locally/SKILL.md)):

```sh
cargo build --release -p web-fps-server --features native-destruction
cargo test -p vibe-land-physx-bridge --features native-destruction --no-run   # build outside the lock
/Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh my-tests \
  cargo test -p vibe-land-physx-bridge --features native-destruction -- --test-threads=1
```

To play, use `scripts/perf/play-server.sh`, which builds into `target/play`,
takes the lock and starts the server with `VIBE_PHYSICS_BACKEND=physx_gpu`
(see the top-level README). By hand it is
`scripts/perf/gpu-run.sh <label> env VIBE_PHYSICS_BACKEND=physx_gpu <target dir>/release/web-fps-server`.

Only PhysX's native destruction stage runs there: `native-destruction` needs no
Blast checkout, and with `destruction` not compiled in, `/city` defaults to
`VIBE_CITY_DESTRUCTION=native`. Its GPU stress solver runs in FP32 (the
fork's `BLAST_STRESS_GPU_FP64` CMake option, off, restores FP64) at a
tolerance of 1e-3 (`VIBE_CITY_NATIVE_STRESS_TOLERANCE`). The Blast solver
(`destruction`, `cuda-stress`, `blast-core`) stays Linux-only.

**Metal pipelines.** Since PhysX 04ff3ac4 the package ships a Metal pipeline
archive beside `libcumetal.dylib` (`lib/cumetal-pipeline-archive`), so a
first run no longer compiles PhysX's kernels: with an empty
`CUMETAL_CACHE_DIR`, a release server built against b5b18ecb answered
`/healthz` in 0.5 s and a bot's first join (which builds the city) finished as
fast as with a warm cache (2026-09-25). A package without the archive compiles
the pipelines on first use, which takes tens of seconds. CuMetal's own cache
is `~/Library/Caches/io.cumetal/kernels`, or `CUMETAL_CACHE_DIR`; the repo's
harnesses all set
`CUMETAL_CACHE_DIR=/Users/glavin/Development/vibe-land/target/cumetal-cache`.
Still treat the first run on a new package as a warm-up and do not time it:
first-use costs and GPU clocks settle during it.

**GPU keep-alive.** On macOS the bridge sets `CUMETAL_GPU_KEEPALIVE_US=250`
before creating the CUDA context (`physx_bridge.cc`), unless the environment
already sets it. Between 60 Hz ticks the GPU otherwise drops into a
low-power state and each tick pays about a millisecond to wake it.
`CUMETAL_GPU_KEEPALIVE_US=0` turns it off.

What runs on Metal, and is tested there: the default `--features
native-destruction` tests, with `--test-threads=1` (`feature_coverage`,
`gpu_smoke`, `ground_contact`, `native_gameplay`, `reset_controller_cache`,
`velocity_fidelity`), and the ignored `heightfield_edge`, `rubble_rest`,
`stack_settling` and `gpu_load`. `feature_coverage` puts boxes, spheres and a
launched ball on a heightfield; walks the character controller up a
heightfield ramp; checks the car's suspension-limit constraint row on a hard
landing and drives it over terrain, debris and a crate; teleports bodies and
resets a car; and checks force-threshold contact reports across a 1,250-box
pile. Every test fails on any PhysX error. `native_gameplay` covers destruction
with box and convex-hull chunks; `reset_controller_cache` moves a player that
stood on a fragment after the city is cleared (the reset crash fixed in
1425a742). The PhysX fork's `native_feature_reference_test` compares the same
shapes and the vehicle rows against its CPU pipeline. Linux/NVIDIA runs the
same tests with its usual features. Checked on 2026-09-25 against package
b5b18ecb: the default suite passed (33 tests, 30 s in a debug build), and
`heightfield_edge` passed without reproducing its fault (see the
`native-destruction-faults` skill for why that proves less on Metal).

To play `/city` locally, run the client beside the server. Apple's clang has no
WebAssembly target, and the client's WASM build compiles `zstd`'s C sources, so
point `cc` at an LLVM that has one (Homebrew's `llvm@21` works; without it the
build stops at `zstd-sys` with "No available targets are compatible with
triple wasm32-unknown-unknown"):

```sh
cd client && CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm@21/bin/clang \
  AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm@21/bin/llvm-ar npm run dev
```

Then open `http://localhost:$CLIENT_PORT/city` in Chrome (WebTransport).
`CLIENT_PORT` comes from the repo's `.env`; with no `.env` vite falls back to
3001.
