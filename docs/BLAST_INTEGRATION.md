# Blast Stress Solver Integration

Vibe-land's practice mode ships two breakable structures — a wall and a
tower — powered by the NVIDIA Blast stress solver. This doc explains
how that dependency is wired in, why the toolchain requires multiple
post-processing steps, and how to maintain it.

## Summary

- **What**: `blast-stress-solver`, an in-development Rust crate in
  [`Glavin001/PhysX`](https://github.com/Glavin001/PhysX) on branch
  `claude/rust-stress-solver-backend-NST8X`, is pulled in as a path
  dependency of the `shared` crate.
- **Where it runs**: only inside the browser wasm bundle
  (`client/src/wasm/pkg/vibe_land_shared_bg.wasm`). Native
  `cargo check` / `cargo build -p web-fps-server` never touches the
  Blast C++ sources.
- **What it adds**: a `DestructibleRegistry` living on
  `WasmSimWorld` that owns one Blast `DestructibleSet` per world
  instance, drives fractures from the existing Rapier contact
  pipeline, and streams per-chunk transforms to the client every
  frame through `getDestructibleChunkTransforms`.

## Vendoring

The upstream PhysX repo is large (>1 GB full clone) and cannot live in
vibe-land's history. `scripts/setup-blast.sh` clones it into
`third_party/physx/` at a pinned commit, applies
`patches/blast-stress-solver.patch`, and is idempotent so subsequent
`make setup` runs are no-ops.

- **Pinned SHA**: `scripts/blast-pinned-sha.txt` (single line, no
  trailing whitespace).
- **Patch file**: `patches/blast-stress-solver.patch`. Carries every
  vibe-land-specific edit to the upstream PhysX tree — build.rs
  changes, the wasi-libc feature, and the
  `wasm_cxa_stubs.rs` trap stubs.
- **Vendor path**: `third_party/physx/` is in `.gitignore`.
- **Re-pin**: edit `scripts/blast-pinned-sha.txt`, then
  `make blast-update`. If upstream moved code that patches touched,
  regenerate the patch (see below).

## Crate wiring

`shared/Cargo.toml` declares the dep under the wasm32 block so it's
only compiled for the browser target:

```toml
[target.'cfg(target_arch = "wasm32")'.dependencies]
blast-stress-solver = {
  path = "../third_party/physx/blast/blast-stress-solver-rs",
  default-features = false,
  features = ["scenarios", "rapier", "wasi-libc"],
}
```

The `wasi-libc` feature is added by our patch; see below.

`shared/src/destructibles.rs` is gated
`#![cfg(target_arch = "wasm32")]` and wraps the Blast API for the rest
of the shared crate. `shared/src/wasm_api.rs` exposes
`spawnDestructible`, `despawnDestructible`, `stepDestructibles`,
`getDestructibleChunkCount`, `getDestructibleInstanceCount`,
`getDestructibleChunkTransforms`, and
`drainDestructibleFractureEvents` via `#[wasm_bindgen]`. The step
routine is folded into the main `tick` path after
`step_vehicle_pipeline` so fractures respond to the same tick of
contacts vehicles collided with.

Trail data lives in `worlds/trail.world.json`. It does **not** contain
destructibles — the shared physics test suite loads that file and
would otherwise spawn fixed Blast colliders underneath the test
vehicles. Practice destructibles are instead injected at runtime
inside `client/src/scene/GameWorld.tsx` via `PRACTICE_DESTRUCTIBLES`
when `isPracticeMode(mode)` is true.

## Why the toolchain is weird

The Blast C++ backend drags in libc++ and wasi-libc on
`wasm32-unknown-unknown`. Getting from there to a wasm module the
browser can actually instantiate requires three separate
post-processing steps:

### 1. `build.rs` → statically link wasi-libc

Clang-built libc++ references `malloc`, `fwrite`, `abort`,
`vfprintf`, etc., which would otherwise become unresolved `env`
imports in the final wasm (roughly 50 of them). We fix this in
`third_party/physx/blast/blast-stress-solver-rs/build.rs` by
probing for `/usr/lib/wasm32-wasi/libc.a` and emitting the right
`cargo:rustc-link-search` / `cargo:rustc-link-lib` lines when the
`wasi-libc` cargo feature is on.

Also probed: `libclang_rt.builtins-wasm32.a`, for compiler builtins
like `__multi3` that libc++ pulls in.

Install on Debian/Ubuntu:

```sh
sudo apt install wasi-libc libc++-18-dev-wasm32
```

### 2. `wasm_cxa_stubs.rs` → trap stubs for C++ EH

Even with `-fno-exceptions`, libc++ still references
`__cxa_allocate_exception` / `__cxa_throw` from STL error paths
(`std::vector::_M_throw_bad_alloc`, etc.). We provide
trap-on-call stubs in
`third_party/physx/blast/blast-stress-solver-rs/src/wasm_cxa_stubs.rs`.
If either symbol fires in practice it means the Blast backend hit an
unexpected error path — investigate rather than paper over.

### 3. `scripts/patch-wasi-stubs.mjs` → rewrite wasi import statements

Once the wasm still imports from `wasi_snapshot_preview1` (because
libc++'s error paths and `locale_t` init use `fd_write`,
`proc_exit`, etc.), wasm-bindgen's generated ESM glue does
`import * as importN from "wasi_snapshot_preview1"`. Neither
Vite/Rollup nor Vitest can resolve that module name. The script
rewrites those imports to reference a small inline no-op stub
object defined at the top of the glue file.

Runs automatically from `make setup-wasm`. Idempotent.

### 4. `scripts/patch-wasm-dtors.mjs` → neutralise
  `__funcs_on_exit` / `__stdio_exit`

Once wasm-bindgen sees wasi imports it wraps every exported helper
in a `command_export` shim that calls
`__wasm_call_ctors → real_export → __wasm_call_dtors`.
`__wasm_call_dtors` in turn calls `__funcs_on_exit` and
`__stdio_exit`, which walk wasi-libc's atexit table and close stdio
handles. In our library-mode environment the atexit table is never
initialised, so every `__wbindgen_malloc` / `__wbindgen_free` call
traps with `null function or function signature mismatch`.

We can't override those libc symbols from Rust: `rust-lld` rejects
duplicate strong definitions, and the
`--allow-multiple-definition` link arg emitted from a dependency's
`build.rs` doesn't propagate to the cdylib link step. So we edit
the wasm binary in place after wasm-bindgen runs, rewriting the
function bodies of `__funcs_on_exit` and `__stdio_exit` to be
`[locals_count=0, nop*, end]` — same byte count, no-op semantics.
Section offsets don't shift, so nothing else needs to be touched.

Runs automatically from `make setup-wasm`. Idempotent (skips
already-neutralised bodies).

## Build order

`make setup-wasm` encodes the full pipeline:

```sh
wasm-pack build --target web --out-dir ../client/src/wasm/pkg
node scripts/patch-wasi-stubs.mjs    # rewrite ESM wasi imports
node scripts/patch-wasm-dtors.mjs    # neutralise dtors bodies
```

Each step is idempotent so re-running `make setup-wasm` after an
incremental Rust change is safe.

## Regenerating the patch

After editing files under `third_party/physx/` (e.g. to fix an
upstream compatibility issue), regenerate the patch file from inside
the vendor tree:

```sh
cd third_party/physx
git add -A
git diff --cached HEAD > ../../patches/blast-stress-solver.patch
git restore --staged .
```

Verify it still applies cleanly in reverse (which is how
`setup-blast.sh` detects an already-applied patch):

```sh
cd third_party/physx
git apply --reverse --check ../../patches/blast-stress-solver.patch
```

## Non-negotiable invariants

- The Blast dep **must** stay under
  `[target.'cfg(target_arch = "wasm32")'.dependencies]`. Moving it
  to top-level dependencies will try to compile the Blast C++
  backend on every server / CI machine — none of them have the
  wasi C++ toolchain.
- `destructibles.rs` and `wasm_cxa_stubs.rs` are
  `#![cfg(target_arch = "wasm32")]` only. Don't drop the gate.
- Fresh clones must run `make setup` (which invokes
  `setup-blast.sh`) before the first `make setup-wasm`, or the
  path dependency will error out.
- The shared physics test suite (`worldDocumentPhysics.test.ts`)
  loads the **default** `trail.world.json`. Do not add
  destructibles to that file — use `PRACTICE_DESTRUCTIBLES` in
  `GameWorld.tsx` instead.

## Known impact

- Wasm bundle size grows by the Blast C++ backend + libc++ / wasi-libc
  archives (~0.5 MB extra after `wasm-opt`).
- First wasm build after a fresh clone takes ~60s (Blast C++ sources).
- Incremental rebuilds of just `shared/src/*.rs` stay fast — cc-rs
  caches the Blast object files under `target/wasm32-*/`.

## Runtime knobs

Material brittleness is tuned in
`shared/src/destructibles.rs` via `BASE_*_ELASTIC` /
`BASE_*_FATAL` and `{WALL,TOWER}_MATERIAL_SCALE`. Lower scale = more
brittle. The defaults were chosen so a trail car at practice-mode
speed reliably cracks the wall and topples the tower without driving
the solver into degenerate states.
