---
name: run-locally
description: Run the vibe-land stack on a dev box — game server, client, the city world, and the full orchestration stack — plus the WebTransport certificate requirements that make it connect, and the Apple Silicon setup (PhysX on Metal through CuMetal, the GPU lock, the play server). Use when starting the app locally, when the page loads but the game will not connect, when a local city needs resetting, or before running anything on the Mac.
---

# Running vibe-land locally

## The two things that trip people up

**1. WebTransport needs a secure context.** A browser refuses to open a
WebTransport session from an insecure origin. `localhost` is exempt — anything
else is not. That is why running the client locally against a rented box works
while serving the same page over plain HTTP from that box does not.

**2. The certificate pin is strict.** `serverCertificateHashes` requires ECDSA
P-256, and Chrome refuses any certificate valid for more than 14 days *or*
already expired. **The page still loads either way** — it just says "Not Secure"
— so an expired cert presents as "the game will not connect", with
`QUIC_TLS_CERTIFICATE_UNKNOWN` buried in the console and nothing wrong
server-side.

```bash
./scripts/check-wt-cert.sh        # non-zero if expired or expiring soon
```

Run this first whenever a local session stops connecting. A 14-day cert is a
scheduled outage unless something watches it.

## Client

```bash
cd client
npm install
npm run dev          # predev builds the wasm packages automatically
```

`npm run build:wasm` builds two wasm packages — `shared` and
`research/destruction-codec`. It needs `wasm-pack` (auto-installed by
`ensure:wasm-pack`) and **`clang`**, because `zstd` compiles through `cc-rs` and
gcc cannot target wasm32. On a Mac, Apple's clang cannot target wasm32 either;
see [macOS](#macos-apple-silicon).

The dev server proxies to the game server. Override with `.env` at the repo root:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SERVER_HOST` | `localhost` | game server host — **point this at a rented box** |
| `SERVER_PORT` | `4001` | game server HTTP port |
| `CLIENT_PORT` | `3001` | vite port (`.env.example`, which `make setup` copies, sets 5555) |
| `WT_CERT_PEM` | — | set it and the dev server switches to HTTPS |

Pointing `SERVER_HOST`/`SERVER_PORT` at a remote box is the supported way to
play against a rented server from a local client.

## Game server

For the destructible city, use the script rather than `cargo run`:

```bash
./scripts/run-city-server.sh            # restart on the release build
./scripts/run-city-server.sh --status   # up? and how did the last one die
./scripts/run-city-server.sh --stop
./scripts/run-city-server.sh --debug
```

**Reset without restarting.** `CityRuntime::reset` releases every
destructible and its PhysX actors and rebuilds the city in the same process.
Trigger it with the stats overlay's RESET CITY button or
`curl -X POST http://<host>:<port>/city-reset/city-default` (202, "reset
queued"; it runs on the next tick). A crash on the first player move after a
reset (the character controller kept a pointer to a freed fragment) was fixed
in 1425a742. A restart is still the clean slate when the process itself is in
doubt, and the benches start a fresh server per run so two runs never share
rubble. (The script's own header still says restart is the only reset; that
predates `CityRuntime::reset`.)

The script also records `EXIT_STATUS`. A city server that segfaults under load
looks identical to one that exited cleanly if you only check whether the process
is gone — that is what caught a SIGSEGV a liveness check was reporting as
"server not running".

**Release is the default deliberately.** Debug builds carry 10–20× overhead on
every CPU phase of the tick, which is enough to make an in-budget server look
hopelessly slow. A profile taken from one sent this project chasing
optimizations it did not need.

`scripts/run-city-server.sh` is Linux-only; on a Mac use
`scripts/perf/play-server.sh` (see [macOS](#macos-apple-silicon)).

Without a GPU, the CPU backend runs the ordinary matches but **not `/city`**:

```bash
VIBE_PHYSICS_BACKEND=rapier cargo run -p web-fps-server
```

Since 5ef03de3 a server on any backend other than `physx_gpu` (or built
without a city feature) refuses city matches. It logs `/city matches will be
refused` at startup, and the client shows the reason. `VIBE_CITY_SYNTHETIC=1`
serves the physics-free synthetic city instead: it is for protocol tests and
has no colliders, so shots and meteors hit nothing.

## Full orchestration stack

Exercises the real control plane against a real game server, faking only the
Vast marketplace:

```bash
./scripts/dev-orchestration.sh up       # start everything, wait for READY
./scripts/dev-orchestration.sh status
./scripts/dev-orchestration.sh logs
./scripts/dev-orchestration.sh down
```

## Local R2 (MinIO)

```bash
npm run r2:up      # docker compose up -d
npm run r2:test
npm run r2:down
```

## Choosing a city

The default scene is small. Bigger ones cost more per tick — see
`docs/PERFORMANCE-ON-SMALL-GPUS.md` before scaling up.

| Scene | chunks | bonds | note |
| --- | ---: | ---: | --- |
| `high-rise-3f-local.json` | 318 | 1,083 | **default**, all cuboid |
| `high-rise-10f-local.json` | 1,032 | 3,624 | largest all-cuboid pack |
| `fractured-district.json` | 15,918 | 48,670 | ~34% convex hull |
| `fractured-downtown.json` | 24,105 | 74,543 | ~30% convex hull |

```bash
VIBE_CITY_SCENE=high-rise-10f-local.json VIBE_CITY_GRID=4 ./scripts/run-city-server.sh
```

**Hull chunks render as axis-aligned boxes** on the client, so the two large
scenes look like interpenetrating slabs even though the colliders are correct
(`server/src/city.rs:118`). Physics is right; visuals are not. Prefer all-cuboid
packs unless you specifically want the scale.

`VIBE_CITY_GRID` is the grid edge in buildings (1–16, default 4), so a grid of 4
is 16 buildings.

## Tests

```bash
cd client && npm run lint      # tsc --noEmit
cd client && npm test          # vitest
cd control-plane && npm test   # guards the fleet reaper — it spends money
cargo check && cargo fmt --all --check
cargo test
```

`cargo fmt --all --check` currently fails on the base branch (1,531 diffs across
123 files at 6d299b4b). CI runs fmt **before** `cargo test`, so a fmt failure means the test
suite never ran — do not read a red Rust job as a test failure without checking
which step died.

## E2E

```bash
cd client && npm run e2e
```

City specs need a running server and are gated behind `E2E_CITY=1`:

```bash
E2E_CITY=1 E2E_CITY_WIRE=3 E2E_SKIP_WEB_SERVER=1 \
E2E_BASE_URL=https://127.0.0.1:6006 \
npx playwright test --config e2e/playwright.config.ts city-frame-profile
```

**To target a remote box, set `E2E_CITY_WT_URL=off`.** The default rewrites
`/session-config` to `127.0.0.1:4434` for a local stack, which would point the
run at nothing. The suite fails loudly if the session does not connect over
WebTransport. The client has no WebSocket fallback (it is disabled; a whole
investigation was once run against the wrong wire), so a WebTransport failure
shows "WebTransport unavailable; WebSocket transport is disabled".

## netlab

The netcode measurement harness — turns "I see rubber-banding" into a
reproducible run with a layer verdict:

```bash
cd client
npm run netlab -- list-scenarios
npm run netlab -- run --scenario city-strafe --stack dev
npm run netlab -- run --scenario city-strafe --stack dev --impair lte
npm run netlab -- compare <baselineIterDir> <impairedIterDir>
```

24 scenarios live in `client/netlab/scenarios/`. Read `report.md` first.

## macOS (Apple Silicon)

PhysX's GPU pipeline runs on the Mac through CuMetal, which runs PhysX's CUDA
kernels on Metal. Only PhysX's native destruction stage runs there (build with
`--features native-destruction`), and its GPU stress solver runs in FP32 at a
tolerance of 1e-3. The Blast features (`destruction`, `cuda-stress`,
`blast-core`) are Linux-only, and so are `scripts/perf/bench.sh`,
`scripts/perf/profile.sh` and `city_bench.rs`, which build them.

### What the Mac build links

| | checkout | branch |
| --- | --- | --- |
| PhysX fork (`Glavin001/PhysX`) | `/Users/glavin/Development/PhysX` | `codex/cumetal-destruction` |
| CuMetal | `/Users/glavin/Development/cuda-metal` | `codex/physx-metal-integration` |

Every build on the machine links one shared package,
`PhysX/out/install/macos-cumetal/release`, built with
`tools/scripts/build-destruction-sdk.py`. How to build it is in the PhysX
repo's `docs/destruction/BUILD.md` ("macOS package for external consumers");
do not duplicate it here. Its `out/sdk-artifacts.json` names the PhysX
revision it was built from.

`physx-bridge` finds `../PhysX` relative to the checkout, so the main checkout
needs no variable. **A worktree does**: from `.claude/worktrees/<name>` the
build panics with "no PhysX destruction SDK". Set
`PHYSX_DESTRUCTION_SDK=/Users/glavin/Development/PhysX` (or `PHYSX_ROOT` to the
install prefix). Use your own `CARGO_TARGET_DIR` under `target/`, never
`target/release` or `target/play`, which other harnesses and the play server
run from.

**After a package rebuild, rebuild every server and test binary.** A package
with a new destruction-scene version changes the stage's structs (v18 grew
`PxDestructionStressDesc`), and a binary built against the old one crashes
against the new dylibs. `cargo build` notices by itself (`build.rs` reruns
when the package's static libraries, destruction header or GPU runtime
change). A binary run without cargo does not: `play-server.sh --no-build`,
`city-bench.sh --no-build`, or a test binary passed as `BENCH_BIN`.

### Playing locally

```bash
scripts/perf/play-server.sh              # --no-build reuses target/play
cd client && CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm@21/bin/clang \
  AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm@21/bin/llvm-ar npm run dev
```

`play-server.sh` builds `--release --features native-destruction` into
`target/play`, refuses to start if :4001 is taken, then waits for the GPU lock
as `user-play`: **if a benchmark holds the lock, the server does not start
until it finishes.** It runs with `VIBE_PHYSICS_BACKEND=physx_gpu` and
`CUMETAL_CACHE_DIR=target/cumetal-cache`, on :4001 and WebTransport :4002, and
logs to `target/play/server-<time>.log`. Ctrl-C stops it and frees the lock.

The client's port is `CLIENT_PORT` from the repo's `.env`: 3003 on this Mac
(what `play-server.sh` assumes), 5555 from `.env.example`, 3001 with no `.env`.
With no `WT_CERT_PEM` the page is plain HTTP, which is fine: `localhost` is a
secure context, and Chrome pins the server's self-signed certificate by hash.
Open `http://localhost:3003/city`.

Without the LLVM override the WASM build stops at `zstd-sys` with "No
available targets are compatible with triple wasm32-unknown-unknown": Apple's
clang has no wasm32 target.

**A second instance** on its own ports, beside a running game:

```bash
lsof -nP -iTCP:6901 -iUDP:6902 -iTCP:3693        # must print nothing
bash -c '/Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh my-label env \
  BIND_ADDR=127.0.0.1:6901 WT_BIND_ADDR=0.0.0.0:6902 WT_HOST=127.0.0.1 WEB_BIND_ADDR= \
  VIBE_PHYSICS_BACKEND=physx_gpu CUMETAL_CACHE_DIR=/Users/glavin/Development/vibe-land/target/cumetal-cache \
  <your CARGO_TARGET_DIR>/release/web-fps-server'
(cd client && CLIENT_PORT=3693 SERVER_PORT=6901 SERVER_HOST=127.0.0.1 \
  CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm@21/bin/clang \
  AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm@21/bin/llvm-ar npm run dev)
```

Set all three addresses. The server reads the repo `.env` from a path fixed at
compile time (`server/../.env` of the tree it was built in), so a binary built
in a worktree with no `.env` falls back to :4001, :4002 and
`WT_HOST=localhost`, which may resolve to `::1` first.

**Stop only your own server.** There is no `/proc` on macOS, and
`pgrep -x web-fps-server` matches every server on the machine: the play
server, benchmark servers, other worktrees'. Kill the server by its port,
`kill $(lsof -tiTCP:6901 -sTCP:LISTEN)`; its `gpu-run.sh` then exits and
frees the lock. (Killing the `gpu-run.sh` shell instead leaves the server
running and the lock held until it exits.) To read a running server's
environment: `ps -E -ww -o command= -p <pid> | tr ' ' '\n' | grep VIBE_`.

**Do not run `scripts/run-city-server.sh` on a Mac.** It first kills every
`web-fps-server` (`pgrep -x`), the play server and running benchmarks
included, and then exits on `PHYSX_LIB_DIR: unbound variable`, because
`physics-env.sh` sets no library path on Darwin. Its defaults (:4003, :4434,
a fixed public `WT_PUBLIC_URL`, `.certs/`) are the Linux box's anyway.

### The GPU lock

`scripts/perf/gpu-run.sh <label> <cmd...>` runs one GPU job at a time on the
machine. Timing on one Apple GPU means nothing when two jobs overlap, so every
GPU test, server, benchmark and rendering browser runs under it. Builds are
CPU-only: run them before taking the lock.

- **Use the main checkout's copy**,
  `/Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh`. The lock is a
  directory under the script's own `target/perf-tools/`, so a worktree's copy
  locks nothing anyone else sees.
- **Never break it.** Do not delete the lock directory or kill its owner. A
  lock whose owner has exited is reclaimed by the next waiter. Waiters poll
  every 2 s, in no particular order. See who holds it:
  `cat /Users/glavin/Development/vibe-land/target/perf-tools/gpu.lock/owner`.
- **Launch benchmarks from bash.** zsh's `BG_NICE` runs `&` jobs at nice +5
  (`zsh -c 'sleep 1 & ps -o nice= -p $!'` prints 5; bash prints 0), which
  slows the process being timed.

### Metal pipelines, warm-up and keep-alive

Since PhysX 04ff3ac4 the package ships a Metal pipeline archive beside
`libcumetal.dylib` (`lib/cumetal-pipeline-archive`), and a first run no longer
compiles PhysX's kernels. Measured 2026-09-25 on package b5b18ecb: with an
empty `CUMETAL_CACHE_DIR`, a release server answered `/healthz` in 0.5 s, and a
bot's first join (which builds the city) finished as fast as with a warm
cache. A package without the archive compiles them on first use, tens of
seconds. CuMetal's own cache is `~/Library/Caches/io.cumetal/kernels`, or
`CUMETAL_CACHE_DIR`; the repo's harnesses all set
`CUMETAL_CACHE_DIR=/Users/glavin/Development/vibe-land/target/cumetal-cache`.

Still run once untimed after a package change: first-use costs and GPU clocks
settle during it (`meteor-bench.sh` has a `warmup` arm for this;
`perf_bench`'s `fracture_cold` measures the cold case on purpose).

The bridge sets `CUMETAL_GPU_KEEPALIVE_US=250` on macOS unless the environment
sets it (`physx_bridge.cc`): between 60 Hz ticks the GPU otherwise drops into
a low-power state and each tick pays about a millisecond to wake it. `0` turns
it off (`scripts/perf/gpu-run.sh idle scripts/perf/mac-idle.sh <tag> 0`
measures idle without it, on :4001).

### Local play shares the GPU

The server and the browser share one GPU, and the server yields. A rendering
browser multiplied the post-impact tick overruns about 11× (681 ms to 7,882 ms
over budget, sim rate 0.96 to 0.69;
`docs/meteor-impact-analysis-2026-09-24.md`, follow-up section). A slow tick
in local play is therefore not evidence of a server regression; compare with
a headless run. The mitigation is `?maxFps=30` on the page URL (off by
default, 10-240) plus a lower DPR cap, the stats overlay's DPR CAP button
(TIER, 1.5, 1.0; stored as `vibe.render.dprCap`). It was measured on
`/cityreplay` (0.94 sim rate at 1536x1229), not yet in live play.

### Opt-in knobs

All are off (or unchanged) by default; set them on the server's environment.

| Variable | Effect |
| --- | --- |
| `VIBE_CITY_NATIVE_REST_SLEEP=1` | Puts clusters of resting rubble to sleep by pose (6dcd4755). Soak-tested with `scripts/perf/rest-soak/` (bfbb2648); off until a long live session has run with it. |
| `VIBE_CITY_NATIVE_FRAGMENT_DEPEN_VELOCITY=<m/s>` | Caps new fragments' depenetration speed (scene v18; 0 is off). Changes where rubble comes to rest; not recommended. |
| `VIBE_PHYSX_STABILIZATION=0` | Turns PhysX stabilization off for the scene (it is on by default). Stops rubble rocking, but piles creep and tilt differently. |
| `VIBE_PHYSX_SOLVER=tgs` | TGS instead of PGS. Not measured on the city. |
| `VIBE_PHYSX_POSITION_ITERS`, `VIBE_PHYSX_VELOCITY_ITERS` | Solver iterations for dynamic bodies, chunks included (default 4 and 1). Raising them did not stop the rocking. |

The stress solve itself is tuned by `VIBE_CITY_NATIVE_STRESS_TOLERANCE`
(default 1e-3) and `VIBE_CITY_NATIVE_STRESS_ITERATIONS` (default 16).

### CuMetal diagnostics

There is no `nvidia-smi`, `compute-sanitizer` or `CUDA_LAUNCH_BLOCKING` on the
Mac. CuMetal reads its switches once, at process start:

| Variable | What it prints or changes |
| --- | --- |
| `CUMETAL_TRACE_SYNC=1` | A `CUMETAL_SYNC reason=... wait_us=...` line for each host wait that blocked (stream or event sync, pinned-host drain, synchronous copy), and `CUMETAL_DRAIN kernel=...` for each drain before a kernel that binds pinned host memory. |
| `CUMETAL_TRACE_COMMITS=1` | A `CUMETAL_COMMIT` line per command buffer: dispatch count, kernels, commit and GPU start/end times. It changes no batching but costs time: for attribution, not timing. |
| `CUMETAL_COOPERATIVE_RESIDENT_GRID=0` | Forces cooperative launches back to one resident threadgroup (by default the grid is sized from the GPU's core count). For A/B only. |

`CUMETAL_TRACE_SYNC` needs cuda-metal 780264d or later; an older
`libcumetal.dylib` in the package ignores it.

### Recording a session

RECORD TAPE on the `/city` stats overlay records a paired client and server
capture into `debug-reports/session-<id>/` (`client.vltape`, `server/`,
`session.json`) under the server's working directory, which is the repo root
for `play-server.sh`; `VIBE_DEBUG_REPORTS_DIR` moves it. The tools that read
it are in [perf-measure](../perf-measure/SKILL.md#on-a-mac).

### Checked on this Mac, and what was not

Checked on 2026-09-25 (vibe-land 6d299b4b, PhysX package b5b18ecb): the server
and bridge test builds in a worktree, with and without
`PHYSX_DESTRUCTION_SDK`; the client WASM build with and without the LLVM
override; a server on the side ports under the lock (`/healthz`,
`/session-config`, the vite proxy, a `city-bots` join, `/city-reset` with the
bot in the match); a Rapier server refusing
`/city`; the bridge's default GPU tests; `run-city-server.sh`'s failure on
Darwin (the sourced `physics-env.sh`, without running the script, which would
have killed live servers); zsh's nice +5. Not run: `play-server.sh` itself
(it builds `target/play` and binds 4001/4002, which belong to the owner's
play session), a browser join over WebTransport (a `city-bots` join was
checked instead), and a RECORD TAPE session.
