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

`shared/Cargo.toml` declares the dep as **optional** under the wasm32
block so it's only compiled for the browser target *and* only when
the `destructibles` Cargo feature is enabled:

```toml
[features]
destructibles = ["dep:blast-stress-solver"]

[target.'cfg(target_arch = "wasm32")'.dependencies]
blast-stress-solver = {
  path = "../third_party/physx/blast/blast-stress-solver-rs",
  default-features = false,
  features = ["scenarios", "rapier"],
  optional = true,
}
```

### Why optional + stub crate

Cargo eagerly resolves every path dependency during metadata
resolution — even when the target `cfg` or Cargo feature that gates
it is off.  That means `cargo check`, `cargo metadata`, and
`wasm-pack build` all need a valid `Cargo.toml` at
`third_party/physx/blast/blast-stress-solver-rs/`, even on machines
that have no intention of ever compiling the real Blast backend
(e.g. Vercel preview builds, fresh dev boxes that haven't run
`make setup`).

To keep the build resolvable everywhere we ship a tiny placeholder
crate at [`stubs/blast-stress-solver-rs/`](../stubs/blast-stress-solver-rs)
and drop it into place via
[`scripts/ensure-blast-stub.sh`](../scripts/ensure-blast-stub.sh)
whenever `third_party/physx/` is missing.  The stub is idempotent
and a no-op when the real clone is already present.

`scripts/build-shared-wasm.sh` then decides whether to pass
`--features destructibles` to `wasm-pack build`:

- **Real PhysX clone present** (`third_party/physx/.git` exists):
  builds with `--features destructibles`, compiling the real Blast
  C++ backend into the wasm bundle.
- **Stub only**: builds without the feature, so the optional dep is
  never touched, and `destructibles.rs` re-exports a no-op backend
  from `destructibles_stub.rs`.  The JS destructibles API on
  `WasmSimWorld` stays intact (every method is still exported) —
  calls simply don't do anything and the client sees an empty
  registry.

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

`make setup-wasm` (and `npm run build:wasm`) drives two scripts:

```sh
# 1. Place the stub crate if third_party/physx is missing.
./scripts/ensure-blast-stub.sh

# 2. Auto-detects whether the real PhysX clone is available and
#    passes `--features destructibles` accordingly.
./scripts/build-shared-wasm.sh
```

No post-processors, no wasm-binary patching.  Rerunning after an
incremental Rust change is safe and fast.  Switching between
stub and real backends is a full rebuild (Cargo feature change) but
the stub build is effectively instantaneous.

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
  `[target.'cfg(target_arch = "wasm32")'.dependencies]` *and*
  `optional = true`.  Moving it to top-level or non-optional
  dependencies will try to compile the Blast C++ backend on every
  server / CI machine — none of them have the wasi C++ toolchain.
- `destructibles.rs`, `destructibles_real.rs`, `destructibles_stub.rs`,
  `wasm_api.rs`, and `wasm_cxa_stubs.rs` are all
  `#![cfg(target_arch = "wasm32")]` only.  Don't drop the gate.
- The `destructibles_real.rs` file is additionally gated on
  `feature = "destructibles"`, and `destructibles_stub.rs` on
  `not(feature = "destructibles")`.  Keep both gates in sync with
  `shared/src/lib.rs`.
- Fresh clones without `make setup` still build via the stub
  placeholder — the real destructible structures just don't show up
  until `scripts/setup-blast.sh` has run.
- `stubs/blast-stress-solver-rs/` is a **checked-in** placeholder
  crate.  Do **not** add any real symbols to it; its only job is to
  satisfy cargo's path resolution when the real tree is missing.
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
