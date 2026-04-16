# Blast Stress Solver Integration

Vibe-land's practice mode ships two breakable structures — a wall and a
tower — powered by the NVIDIA Blast stress solver. This doc explains
how that dependency is wired in and how to maintain it.

## Summary

- **What**: `blast-stress-solver` is a Rust crate published on
  [crates.io](https://crates.io/crates/blast-stress-solver) that wraps
  the NVIDIA Blast C++ stress solver with a Rapier3D integration layer.
  The crate ships prebuilt static libraries for `wasm32-unknown-unknown`
  so no local C++ toolchain or PhysX clone is required.
- **Where it runs**: only inside the browser wasm bundle
  (`client/src/wasm/pkg/vibe_land_shared_bg.wasm`). Native
  `cargo check` / `cargo build -p web-fps-server` never touches the
  Blast C++ sources.
- **What it adds**: a `DestructibleRegistry` living on
  `WasmSimWorld` that owns one Blast `DestructibleSet` per world
  instance, drives fractures from impact-driven contact forces via
  Rapier's `ChannelEventCollector`, and streams per-chunk transforms
  to the client every frame through `getDestructibleChunkTransforms`.

## Crate wiring

`shared/Cargo.toml` declares the dep as **optional** under the wasm32
block so it's only compiled for the browser target *and* only when
the `destructibles` Cargo feature is enabled:

```toml
[features]
destructibles = ["dep:blast-stress-solver"]

[target.'cfg(target_arch = "wasm32")'.dependencies]
blast-stress-solver = {
  version = "0.1.0",
  default-features = false,
  features = ["scenarios", "rapier"],
  optional = true,
}
```

### Feature gating

When the `destructibles` feature is OFF the wasm module still exposes
the destructibles JS API via a no-op stub backend.  Pass
`VIBE_NO_DESTRUCTIBLES=1` to `scripts/build-shared-wasm.sh` to build
without the feature for faster iteration.

The split lives in three files under `shared/src/`:

- `destructibles.rs` — thin wrapper that re-exports either the real
  or stub backend based on `cfg(feature = "destructibles")`.
- `destructibles_real.rs` — the real implementation gated on
  `cfg(all(target_arch = "wasm32", feature = "destructibles"))`.
- `destructibles_stub.rs` — the no-op backend gated on
  `cfg(all(target_arch = "wasm32", not(feature = "destructibles")))`.

`shared/src/wasm_api.rs` imports from `crate::destructibles::*`
without caring which backend is active. `shared/src/wasm_api.rs` exposes
`spawnDestructible`, `despawnDestructible`, `stepDestructibles`,
`getDestructibleChunkCount`, `getDestructibleChunkTransforms`, and
`drainDestructibleFractureEvents` via `#[wasm_bindgen]`. The step
routine is folded into the main `tick` path after
`step_vehicle_pipeline` so fractures respond to the same tick of
contacts vehicles collided with.

## Impact-driven fracturing

Contact forces from vehicles and dynamic bodies are routed into the
Blast stress solver via Rapier's `ChannelEventCollector`:

1. **Colliders opt in** to `CONTACT_FORCE_EVENTS` (vehicle chassis,
   dynamic bodies, chunk colliders).
2. **Persistent mpsc channels** on `WasmSimWorld` carry events from
   `PhysicsPipeline::step` to the destructibles drain methods.
3. **`drain_contact_forces`** turns each `ContactForceEvent` into a
   splash-falloff `DestructibleSet::add_force` call (splash radius 2m,
   quadratic falloff).
4. **`drain_collision_events`** updates the support-contact tracker so
   statically-supported chunks don't separate under their own weight.

Force injection is gated by a minimum impact force (`500 N`) and
partner velocity (`1.5 m/s`) to prevent resting bodies from slowly
cracking structures.

## Practice mode

Trail data lives in `worlds/trail.world.json`. It does **not** contain
destructibles — the shared physics test suite loads that file and
would otherwise spawn fixed Blast colliders underneath the test
vehicles. Practice destructibles are instead injected at runtime
inside `client/src/scene/GameWorld.tsx` via `PRACTICE_DESTRUCTIBLES`
when `isPracticeMode(mode)` is true.

## Build order

`make setup-wasm` (and `npm run build:wasm`) drives
`scripts/build-shared-wasm.sh`:

```sh
# Builds with --features destructibles by default.
# Set VIBE_NO_DESTRUCTIBLES=1 to skip.
./scripts/build-shared-wasm.sh
```

No post-processors, no wasm-binary patching.  Rerunning after an
incremental Rust change is safe and fast.

## Non-negotiable invariants

- The Blast dep **must** stay under
  `[target.'cfg(target_arch = "wasm32")'.dependencies]` *and*
  `optional = true`.  Moving it to top-level or non-optional
  dependencies will try to compile the Blast C++ backend on every
  server / CI machine.
- `destructibles.rs`, `destructibles_real.rs`, `destructibles_stub.rs`,
  `wasm_api.rs`, and `wasm_cxa_stubs.rs` are all
  `#![cfg(target_arch = "wasm32")]` only.  Don't drop the gate.
- The `destructibles_real.rs` file is additionally gated on
  `feature = "destructibles"`, and `destructibles_stub.rs` on
  `not(feature = "destructibles")`.  Keep both gates in sync with
  `shared/src/lib.rs`.
- The shared physics test suite (`worldDocumentPhysics.test.ts`)
  loads the **default** `trail.world.json`. Do not add
  destructibles to that file — use `PRACTICE_DESTRUCTIBLES` in
  `GameWorld.tsx` instead.

## Known impact

- Wasm bundle size grows by the Blast C++ backend + libc++
  archive (~0.5 MB extra after `wasm-opt`).
- First wasm build after a fresh clone downloads the crate from
  crates.io and links the prebuilt static library (~2 MB download).
  Incremental rebuilds of just `shared/src/*.rs` stay fast.

## Runtime knobs

Material brittleness is tuned in
`shared/src/destructibles.rs` via `BASE_*_ELASTIC` /
`BASE_*_FATAL` and `{WALL,TOWER}_MATERIAL_SCALE`. Lower scale = more
brittle. The defaults were chosen so a trail car at practice-mode
speed reliably cracks the wall and topples the tower without driving
the solver into degenerate states.
