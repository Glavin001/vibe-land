# Blast Stress Solver Integration

Vibe-land's practice mode ships two breakable structures — a wall and a
tower — powered by the NVIDIA Blast stress solver. This doc explains
how that dependency is wired in, what the wasm toolchain requires, and
how to maintain it.

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
  vibe-land-specific edit to the upstream PhysX tree — see
  [Patch contents](#patch-contents) below.
- **Vendor path**: `third_party/physx/` is in `.gitignore`.
- **Re-pin**: edit `scripts/blast-pinned-sha.txt`, then
  `make blast-update`. If upstream moved code that patches touched,
  regenerate the patch (see [Regenerating the patch](#regenerating-the-patch)).

## Crate wiring

`shared/Cargo.toml` declares the dep under the wasm32 block so it's
only compiled for the browser target:

```toml
[target.'cfg(target_arch = "wasm32")'.dependencies]
blast-stress-solver = {
  path = "../third_party/physx/blast/blast-stress-solver-rs",
  default-features = false,
  features = ["scenarios", "rapier"],
}
```

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

## Why the wasm toolchain needs care

The Blast C++ backend is built with clang against `wasm32-wasi`
headers, which means the resulting object files reference dozens of
libc / libc++ symbols (`malloc`, `fwrite`, `abort`, `strcmp`,
`newlocale`, …). `wasm32-unknown-unknown` has no libc, so those
references would normally either:

1. become unresolved `env.*` imports that the browser can't satisfy,
   or
2. force us to link wasi-libc — which drags in
   `wasi_snapshot_preview1` imports.

**Option 2 is a trap**: once wasm-bindgen sees any
`wasi_snapshot_preview1` import it wraps every export in a
`command_export` shim that calls
`__wasm_call_ctors → real_export → __wasm_call_dtors`.
`__wasm_call_dtors` walks wasi-libc's atexit / stdio tables, which
were never initialised in library mode, and every
`__wbindgen_malloc` call traps.

### The fix: Rust stubs for every libc symbol

The `blast-stress-solver` crate ships
[`src/wasm_runtime_shims.rs`](../third_party/physx/blast/blast-stress-solver-rs/src/wasm_runtime_shims.rs),
which provides `#[no_mangle] extern "C"` definitions for every libc
symbol the Blast C++ backend references:

- `malloc` / `free` / `realloc` forward to Rust's global allocator via
  a 16-byte size header so `free` can reconstruct the original
  `Layout`.
- `abort` emits a wasm `unreachable` trap.
- `strcmp`, `memchr`, `wcslen`, `wmemchr`, and the ASCII character
  class helpers (`toupper`, `tolower`, `isdigit_l`, …) are
  implemented in pure Rust.
- Stdio (`fwrite`, `vfprintf`, `fprintf`, `snprintf`, `getc`, …),
  locale (`newlocale`, `uselocale`, `freelocale`), numeric parsing
  (`strtoll`, `strtod_l`, …), and multibyte / wide-char routines are
  no-op stubs — the stress solver never actually invokes them, but
  libc++'s STL error paths still emit references.
- `__cxa_atexit` returns success without registering anything (in
  library mode we never run exit handlers).

[`src/wasm_cxa_stubs.rs`](../third_party/physx/blast/blast-stress-solver-rs/src/wasm_cxa_stubs.rs)
provides trap-only stubs for `__cxa_allocate_exception` /
`__cxa_throw`, which libc++ still references from STL
`throw_bad_alloc`-style helpers even with `-fno-exceptions`. Hitting
either stub indicates the Blast backend entered an unexpected error
path and we'd rather crash loudly than silently corrupt state.

The net result: the final cdylib has **zero** `env.*` imports and
**zero** `wasi_snapshot_preview1.*` imports. wasm-bindgen emits a
normal library module — no post-processing, no binary patching.

You can verify this by running `wasm-objdump -j Import -x
client/src/wasm/pkg/vibe_land_shared_bg.wasm` after a build; only
wasm-bindgen glue imports should appear.

## Patch contents

`patches/blast-stress-solver.patch` carries these vibe-land-specific
edits to the upstream PhysX tree:

1. `blast-stress-solver-rs/build.rs` — probe for `wasi-sysroot` /
   `libc++-*-dev-wasm32` headers and pass the right
   `--sysroot`/`-isystem` flags when building for
   `wasm32-unknown-unknown`. Also link `c++abi` for the tiny exception
   surface libc++ still references under `-fno-exceptions`.
2. `blast-stress-solver-rs/src/wasm_runtime_shims.rs` — Rust
   stubs for every libc symbol libc++ pulls in (see above).
3. `blast-stress-solver-rs/src/wasm_cxa_stubs.rs` — trap stubs for
   `__cxa_allocate_exception` / `__cxa_throw`.
4. `blast-stress-solver-rs/src/lib.rs` — `#[cfg(target_arch =
   "wasm32")]` gates for the two new modules.
5. `blast/include/shared/NvFoundation/NvPreprocessor.h` — wasm /
   clang compatibility macros.
6. `blast/source/sdk/globals/NvBlastGlobals.cpp` — tiny fix for
   an `inline`-related clang error.
7. `blast/source/shared/NsFoundation/include/NsArray.h` — wasm
   compatibility tweak.

All of these are intended to be upstreamed to `Glavin001/PhysX` as
proper fixes; none of them are binary post-processing or runtime
workarounds.

## Build order

`make setup-wasm` is a single step:

```sh
cd shared && wasm-pack build --target web --out-dir ../client/src/wasm/pkg
```

No post-processors, no wasm-binary patching. Rerunning after an
incremental Rust change is safe and fast.

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
- `blast-stress-solver-rs` must **not** link wasi-libc. Doing so
  re-introduces the `__wasm_call_dtors` trap we fixed by providing
  pure-Rust shims. If upstream ever adds a new libc symbol reference
  that we haven't stubbed, the right fix is to add another stub to
  `wasm_runtime_shims.rs`, not to fall back to wasi-libc.

## Known impact

- Wasm bundle size grows by the Blast C++ backend + libc++
  archive (~0.5 MB extra after `wasm-opt`).
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
