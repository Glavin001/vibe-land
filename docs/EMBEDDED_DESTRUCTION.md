# Embedded PhysX destruction: playable integration prototype

This branch builds Vibe-land against the native `PxDestructionScene` pipeline.
PhysX Direct GPU API is **disabled**; GPU rigid-body simulation, native CUDA
stress, native sleeping, and one internal correction are enabled. The game calls
one `World::step()` (or begin/end pair); `destruction_tick()` then consumes accepted
observations. It must not perform an external rewind or a second stress solve.
The engine permits at most two physics passes and two stress passes per tick.

The C++ adapter lives in `physx-bridge/src/embedded_{destruction,observation}.cc`.
`create_destructible` authors persistent geometry, materials and bonds. Native
PhysX owns motion splitting and correction. Accepted cluster events and ordinary
CPU actor/query observations feed the existing Rust ownership and network codecs.
The CPU network consumer still inspects cluster snapshots; it does not run stress.
The native feature does not compile the legacy external adapter/solver sources.

## Build and run on this instance

Tested engine commit: `6ef3fd47` on `physx-2/codex/gpu-destruction`.
Build the engine SDK/GPU runtime first using its repository build instructions.
Then from this checkout:

```bash
export PHYSX_DESTRUCTION_SDK=/root/workspace/physx-2
export CARGO_TARGET_DIR="$PHYSX_DESTRUCTION_SDK/out/vibe-native"
cargo build --release -p web-fps-server --bin web-fps-server --features embedded-destruction
(cd client && npm run build)
python3 scripts/generate-embedded-demo.py
scripts/run-embedded-city.sh
```

The launcher reads this instance's public IP/mappings, checks free ports, creates
an expiring P-256 development certificate, and verifies the native health marker.
It never stops another process. Ports: HTTPS 8384, WebTransport UDP 4435, HTTP
loopback 4005. PID, logs and certificate are in `/tmp/vibe-embedded-city`. It
requires existing Vast mappings for these ports. Do not publish the private key.

Open the printed `/city?portal=true&match=city-default` URL in Chrome/Edge.
Accept the development HTTPS certificate, click to join, use WASD/mouse and fire.
Escape releases the mouse; **RESET CITY** rebuilds the structure and streams a
fresh bootstrap. Reset currently rebuilds destruction, not ordinary projectiles.

This prototype weapon launches visible **18,000 kg, radius 0.5 m spheres at
40 m/s**, subject to the ordinary sphere damping already in the bridge. These are
demolition rounds, not rifle bullets. Spawn overlap and muzzle ray checks prevent
starting rounds inside a wall. The actual shot origin/direction comes from the
player; no damage is preauthored. Existing player hitscan combat remains separate.

The default building has **444 chunks and 896 bonds**, with the native demo's
panel/frame materials. The game shot path, damping and controller differ from the
frozen engine regression; do not compare their fracture counts as equal-input runs.
`VIBE_CITY_GRID` can author more copies, subject to the current 64-structure wire
limit. Larger playable scenes have not been qualified by this integration test.

The new `embedded-four-buildings.json` asset contains four **disconnected** copies
of the same building (1,776 chunks / 3,584 bonds). An 8×8 grid of this asset fits
within the existing 64 asset IDs and contains **256 independent buildings,
113,664 chunks and 229,376 bonds**. It does not join their bond graphs or share
one motion state across the four buildings. Regenerate with:

```bash
python3 scripts/generate-embedded-demo.py --four-buildings
# Only when intentionally replacing this checkout's owned running demo:
VIBE_CITY_SCENE=embedded-four-buildings.json VIBE_CITY_GRID=8 scripts/run-embedded-city.sh
```

The layout/manifest gate checks all IDs, translated geometry, unchanged material
inputs, four exact 444-node connected components per asset, and full binary
manifest round-trip. Building pitch is **17.96 m**, leaving the game's standard
10 m street between collision faces. This differs from the standalone native
bombardment layout; equal chunk/bond counts alone do not make a matched benchmark.
The asset now passes a **600-step native game-consumer bombardment** at 256
buildings, after fixing a retained contact-report crash in engine correction.
It has not passed large-scene browser/endurance or real-time performance gates.
The public deployment remains on the tested single-building scene.

## Reproducible native consumer timing

[Generated 4/64/256-building report](reports/embedded-scale-2026-09-08/report.md)
includes every step, disjoint CPU/GPU boundary timings at the actual peak,
recorded physical command tapes, compressed raw samples and build receipts.
Run `embedded_city_bench` only while the GPU is otherwise idle:

```bash
cargo build --release -p vibe-land-destruction --features embedded-destruction --example embedded_city_bench
# OUTPUT_DIR, tile-grid edge, steps, projectile waves (0..3)
"$CARGO_TARGET_DIR/release/examples/embedded_city_bench" /tmp/NEW-capture/256-buildings 8 600 3
python3 scripts/report-embedded-city-bench.py /tmp/NEW-capture /tmp/NEW-report
```

The benchmark includes projectile insertion, native physics/stress/correction
and accepted game event/snapshot processing. It excludes renderer/network work.
It rejects output reuse and writes accepted rows incrementally so a later crash
cannot erase the preceding samples. Only complete runs produce final reports.
The report generator checks row counts, peak identity, deadline counts and that
phase intervals sum to each complete advance. Do not use its native aggregate
to infer a kernel-level compute/bandwidth bottleneck.

## Validation and limitations

The [follow-up browser retest](reports/embedded-playable-2026-09-08/self-test-followup.md)
found and fixed a reset/re-impact GPU bounds-lifetime crash and verifies two full
browser cycles plus three native reset/reconnect/re-impact cycles.

[Recorded qualification](reports/embedded-playable-2026-09-08/report.md) includes
native tests, a frozen physics regression, real-browser play, settling and reset.
Run the browser check against an otherwise idle demo server:

```bash
cd client
node e2e/embedded-playable.mjs
```

It rewrites only the WebTransport host/port for local hairpin testing, retaining
`/game`. The advertised public URL is unchanged for real players. Timed browser
input is a functional test, not a deterministic simulation benchmark.

Known remaining work:

- One earlier shooting run produced escaped debris; its cause is unconfirmed.
  The later 30-second settling test passed. This is not endurance qualification.
- Native game timing fields need integration: legacy `city.solve_ms` and similar
  zero fields do **not** measure native stress. Native work currently falls inside
  the complete PhysX step/fetch timing. No 8 ms or whole-game 60 Hz claim is made.
- General joints, vehicles using unsupported constraints, CCD correction,
  synthetic explosions/loads, and incremental runtime asset insertion are not
  supported by this bridge. Explicit unsupported commands fail. City reset works.
- Runtime projectile removal/TTL and reusable network handles are unfinished;
  projectile count grows as players fire. Capacity exhaustion reports an error.
- Chunk material/crushing configuration, sparse CPU observation, exhaustive
  re-fracture rendering tests, and large-scale performance remain unfinished.
- Ordinary queries and moving character-controller correction were exercised;
  walking/climbing on every kind of moving debris has not been qualified.

Artificial pose freezing and the old kill-floor freezing shortcut are disabled
for this native path. Supported material laws and solver convergence are not
relaxed to make the browser demo pass.
