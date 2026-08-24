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
