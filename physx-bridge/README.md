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
headers, and `PX_CUMETAL=1`. It finds `../PhysX/out/install/macos-cumetal/release`
without any variable; `PHYSX_DESTRUCTION_SDK` or `PHYSX_ROOT` still override it.
Build that package once in the PhysX checkout (see its
`docs/destruction/BUILD.md`, "macOS package for external consumers"), then:

```sh
cargo test -p vibe-land-physx-bridge --features native-destruction --test native_gameplay
cargo build --release -p web-fps-server --features native-destruction
VIBE_PHYSICS_BACKEND=physx_gpu ./target/release/web-fps-server
```

Only PhysX's native destruction stage runs there: `native-destruction` needs no
Blast checkout, and with `destruction` not compiled in, `/city` defaults to
`VIBE_CITY_DESTRUCTION=native`. The Blast solver (`destruction`, `cuda-stress`,
`blast-core`) stays Linux-only. The first run compiles Metal pipelines, which
takes tens of seconds; they are cached in `~/Library/Caches/io.cumetal` (or
`CUMETAL_CACHE_DIR`).

What runs on Metal, and is tested there: the default `--features
native-destruction` tests, with `--test-threads=1` (`feature_coverage`,
`gpu_smoke`, `native_gameplay`), and the ignored `heightfield_edge`,
`stack_settling` and `gpu_load`. `feature_coverage` puts boxes, spheres and a
launched ball on a heightfield; walks the character controller up a
heightfield ramp; checks the car's suspension-limit constraint row on a hard
landing and drives it over terrain, debris and a crate; teleports bodies and
resets a car; and checks force-threshold contact reports across a 1,250-box
pile. Every test fails on any PhysX error. `native_gameplay` covers destruction
with box and convex-hull chunks. The PhysX fork's `native_feature_reference_test`
compares the same shapes and the vehicle rows against its CPU pipeline.
Linux/NVIDIA runs the same tests with its usual features.

To play `/city` locally, run the client beside the server. Apple's clang has no
WebAssembly target, and the client's WASM build compiles `zstd`'s C sources, so
point `cc` at an LLVM that has one (Homebrew's works):

```sh
cd client && CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm@21/bin/clang \
  AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm@21/bin/llvm-ar npm run dev
```

Then open `http://localhost:$CLIENT_PORT/city` in Chrome (WebTransport).
