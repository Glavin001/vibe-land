---
name: vehicle-qa
description: Reproduce a player's report about destructible vehicles (flicker, parts in two places, wheels falling off, cars breaking too easily or not at all) with automated tests before fixing it, and prove the fix with the same tests. Covers the live browser scenario runner, the GPU physics tests, tape replay frame by frame, and pixel flicker detection.
---

# Vehicle QA: reproduce, then fix

A report is not understood until a test reproduces it. Pick the fastest layer
that shows it, keep the slower ones as confirmation.

## 1. Live, real client and server: `client/e2e/vehicle-qa.mjs`

Drives /city in headless Chromium (Metal) against the fleet server
(`garage-vehicle-server` launch entry, port 4001) and the dev client (3003).
Steps: reset the city, join beside a fleet car, set the shot mode, aim, fire,
meteor, enter a car and steer it to a point. Records per rendered frame where
each car and every loose part is DRAWN (position and orientation, from the
instance matrices), and the server's view of each car after each step, plus a
screenshot per step and optionally a video.

```bash
cd client && node e2e/vehicle-qa.mjs --list
node e2e/vehicle-qa.mjs cannonball-wreck --video      # one run
node e2e/vehicle-qa-suite.mjs --repeat 4 cannonball-wreck   # live physics is not deterministic
```

Scenarios live in `client/e2e/vehicle-scenarios.mjs`; add the report as a new
one. Checks: `drawnFlicker` (position A->B->A), `spinFlicker` (orientation
A->B->A three or more times on one part: rocking, what a player calls
"phantom" / "two places at once"), `carFlicker`, `partsOff`, `wheelsOn`.
Reports land in `target/vehicle-qa/<scenario>/report.json` with the rocking
parts, where they were and the nearest ball.

Position checks alone miss the 2026-09-29 phantom: pieces rocked between two
orientations with steady positions. `drawnFlicker` follows each part's drawn
geometry centre, not its origin: parts are authored in the car's frame, so a
part spinning at PhysX's 100 rad/s limit swings its origin a metre where the
part itself barely moves.

**Server or renderer?** The report also has `receivedSpin`: the same rocking
count over what the client *received* (`vehicleRig` detached poses). Received
rocking equal to drawn rocking puts the fault in the server's physics; drawn
rocking with a quiet received stream puts it in the client.

**Rebuild the server.** The `garage-vehicle-server` launch entry runs
`--no-build`; after a bridge or server change, `cargo build --release -p
web-fps-server --features native-destruction --bin web-fps-server` (with the
PHYSX_ROOT/CARGO_TARGET_DIR below) before restarting it, or the live run tests
old code. `strings target/garage-vehicles/release/web-fps-server | grep <env>`
confirms a new switch is in.

## 2. Physics only, deterministic, seconds: GPU tests

`server/src/physx_runtime/vehicle_destruction_tests.rs`, run under the GPU
lock (stop the server first):

| test | reproduces |
|---|---|
| `garage_loose_pieces_do_not_flip_flop` | loose pieces rocking after the city cannonball (10.65 t, 60 m/s); `VIBE_SPIN_SHOTS`, `VIBE_SPIN_REST_TICKS`, `VIBE_SPIN_TRACE=<part> VIBE_SPIN_TRACE_FROM=<tick>` traces one piece's body tick by tick |
| `garage_car_drives_over_debris` | driving over concrete blocks (`VIBE_DEBRIS_HALF/DENSITY/SPEED`) |
| `garage_car_drives_through_wreck` | driving through a meteor-shattered car |
| `garage_car_crashes_into_car`, `garage_cars_in_one_scene_break_independently` | multi-car scenes |
| `vehicle_hulls_do_not_interpenetrate_at_rest` | authoring: hull overlap (no GPU) |
| `garage_vehicle_destruction_is_rigid_body_correct` | the correctness suite (`scripts/perf/garage-destruction-test.sh`); `VIBE_SUNK_TRACE=1` prints the deepest sunk hull per tick |
| `city_fleet_tests::city_cannonballed_buggy_pieces_do_not_rock`, `city_wreck_pieces_do_not_rock` | the car inside the real city stage (production arena, city world, city step), cannonballed or meteored; `VIBE_CITY_FLEET_VARIANT=n` another wreck, `VIBE_CITY_TRACE_PART=<part> VIBE_CITY_TRACE_FROM/TICKS` one piece's body tick by tick; reports rocking pieces, A-B-A jumps, rejected steps and step times |

The city matters: pieces wedge against buildings the garage does not have.
One wreck is one sample: judge a physics change over several variants (the
2026-09-30 depenetration fix was chosen over 5 variants x 2 cars).

```bash
scripts/perf/gpu-run.sh garage-destruction-test env VIBE_VEHICLE_BUILD_FIXTURES=$PWD/target/vehicle-build-fixtures.json \
  CUMETAL_CACHE_DIR=$PWD/target/cumetal-cache-vehicles VIBE_DESTRUCTION_MODELS=desert,derby,monster,circuit,buggy \
  cargo test --release -p web-fps-server --features native-destruction --bin web-fps-server <test> -- --ignored --nocapture --test-threads=1
```
(with `PHYSX_ROOT=../PhysX/out/install/garage-multihull CARGO_TARGET_DIR=target/garage-vehicles`). Environment switches
are the A/B: run the same test with and without one and compare.

## 3. The player's own tape

A session tape (`debug-reports/session-*/client.vltape`) starts after the
join, so add the car assets first, then replay it in /cityreplay:

```bash
cd client && npx tsx scripts/tape-add-vehicle-assets.ts <in.vltape> public/<name>.vltape
node e2e/tape-frames.mjs <name>.vltape <fromMs> <toMs>      # consecutive frames, grass off
node e2e/frame-flicker.mjs ../target/tape-frames/<dir>        # pixels drawn A, B, A
npx tsx scripts/vehicle-tape-spin-flips.ts <tape>            # orientation flips in the stream
```
Look at the frames and the heat map yourself: that is what the player saw.

## Before claiming a fix

The same test must fail on the old behaviour and pass on the new one (an env
switch that restores the old behaviour makes this one command), and the
correctness suite must not regress.
